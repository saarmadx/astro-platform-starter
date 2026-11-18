import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Captions as CaptionsIcon, ChevronLeft, ChevronRight, Download, Image as ImageIcon, LayoutPanelTop, Layers, Play, Send, Sparkles } from 'lucide-react';
import { projectEvents } from '../lib/audio';
import { bleepSpans } from '../lib/censor';
import { buildSrt, displayWords, groupWords } from '../lib/captions';
import { drawScene, drawVideoLayer, roundRect, stickerBox, wrap } from '../lib/draw';
import { allSfx, autoReplay, autoSfx, autoShakes, cutTimes, PIP_DEFAULT, replayLength } from '../lib/fx';
import { playSfx, SFX_KINDS } from '../lib/sfx';
import { analyseClip, detectFacecam } from '../lib/faces';
import { outputSize } from '../lib/geometry';
import { DEFAULT_SPEAKER_COLORS, TEMPLATES, TITLE_FONT } from '../lib/templates';
import { ensureSegs, outputDuration, removeRanges, segmentsOf, silenceCuts, skipCut, toOutputClamped, toSource, withSegs } from '../lib/timeline';
import { titleIdeas } from '../lib/titles';
import { fixPrompt, parseFixes, replacePhrase } from '../lib/fixwords';
import type { Aspect, Brand, CaptionPosition, Clip, Layout, Project, SfxKind, StyleSettings, Word } from '../lib/types';
import { renderClip } from '../lib/video';
import { applyFx, currentFx, loadPresets, savePresets, type Preset } from '../lib/presets';
import { Segmented } from './Home';
import { safeName, saveBlob } from './ProjectView';
import type { LoadedVideo } from './Studio';
import Timeline, { LAYOUTS, timecode, type Selection, type TimelineApi } from './Timeline';
import { Bar, scoreTone, TemplateSwatch } from './ui';

type Props = {
    project: Project;
    clipId: string;
    video?: LoadedVideo;
    brand: Brand;
    onChange: (p: Project) => void;
    onBack: () => void;
    onSelectClip: (id: string) => void;
    onAttach: (f: File) => void;
    attachError?: string;
};

type Tab = 'captions' | 'layout' | 'effects' | 'post' | 'thumbnail' | 'export';
const TABS: { id: Tab; label: string; icon: typeof Play }[] = [
    { id: 'captions', label: 'Captions', icon: CaptionsIcon },
    { id: 'layout', label: 'Layout', icon: LayoutPanelTop },
    { id: 'effects', label: 'Effects', icon: Sparkles },
    { id: 'post', label: 'Post', icon: Send },
    { id: 'thumbnail', label: 'Thumbnail', icon: ImageIcon },
    { id: 'export', label: 'Export', icon: Download }
];

export default function Editor({ project, clipId, video, brand, onChange, onBack, onSelectClip, onAttach, attachError }: Props) {
    const ordered = useMemo(() => [...project.clips].sort((a, b) => b.score - a.score), [project.clips]);
    const clip = project.clips.find((c) => c.id === clipId) ?? ordered[0];
    const idx = ordered.findIndex((c) => c.id === clip?.id);
    const style = project.style;
    const words = project.transcript?.words ?? [];

    const [tab, setTab] = useState<Tab>('captions');
    const [time, setTime] = useState(clip?.start ?? 0);
    const [playing, setPlaying] = useState(false);
    const [selection, setSelection] = useState<Selection>(null);
    const [quality, setQuality] = useState<720 | 1080>(720);
    const [rendering, setRendering] = useState<number | null>(null);
    const [renderError, setRenderError] = useState('');
    const [busy, setBusy] = useState('');
    const [copied, setCopied] = useState(false);
    const [thumbs, setThumbs] = useState<{ t: number; url: string }[]>([]);
    const history = useRef<Clip[]>([]);
    const [historyLen, setHistoryLen] = useState(0);

    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const logoRef = useRef<HTMLImageElement | null>(null);
    const freezeRef = useRef<number | null>(null); // performance.now() when the freeze ending started
    const replayRef = useRef(false); // true while the preview plays the instant replay
    const lastTimeRef = useRef(0);
    const lastStateRef = useRef(0);
    const selectedStickerRef = useRef<number | null>(null);
    const stickerDrag = useRef<null | { i: number; dx: number; dy: number }>(null);
    const future = useRef<Clip[]>([]);
    const [futureLen, setFutureLen] = useState(0);
    const timelineRef = useRef<TimelineApi>(null);
    // the newest project, so several changes in a row each build on the one before
    // (otherwise the second change is made from an old copy and silently undoes the first)
    const latest = useRef(project);
    latest.current = project;
    // the timeline only re-renders when the clip or selection changes: its callbacks never change identity
    const fns = useRef<Record<string, (...a: any[]) => any>>({});
    const tl = useMemo(() => {
        const call = (k: string) => (...a: any[]) => fns.current[k]?.(...a);
        return { seekOut: call('seekOut'), togglePlay: call('togglePlay'), play: call('play'), pause: call('pause'), beginEdit: call('beginEdit'), update: call('update'), undo: call('undo'), redo: call('redo'), select: call('select'), outTime: call('outTime') };
    }, []);

    useEffect(() => {
        if (!brand.logo) {
            logoRef.current = null;
            return;
        }
        const img = new Image();
        img.src = brand.logo;
        logoRef.current = img;
    }, [brand.logo]);

    const groups = useMemo(
        () => (clip ? groupWords(displayWords(words, clip, style, project.speakers, false), style.wordsPerLine) : []),
        [words, clip?.start, clip?.end, clip?.cuts, clip?.segs, clip?.keywords, style, project.speakers]
    );
    const events = useMemo(() => projectEvents(project), [project.transcript, project.chat]);
    const bleeps = useMemo(() => (style.censor === 'bleep' && clip ? bleepSpans(words.filter((w) => w.end > clip.start && w.start < clip.end)) : []), [style.censor, words, clip?.start, clip?.end]);
    const preview = outputSize(style.aspect, 540);

    // ---------- preview loop: skip cuts, loop, hold the freeze ending ----------
    const musicUrl = useMemo(() => (project.music ? URL.createObjectURL(project.music.blob) : ''), [project.music?.blob]);
    useEffect(() => () => { if (musicUrl) URL.revokeObjectURL(musicUrl); }, [musicUrl]);
    const musicRef = useRef<HTMLAudioElement>(null);
    const sceneRef = useRef({ clip, style, brand, groups, music: project.music, words });
    sceneRef.current = { clip, style, brand, groups, music: project.music, words };
    useEffect(() => {
        let raf = 0;
        const loop = () => {
            const v = videoRef.current;
            const c = canvasRef.current;
            const s = sceneRef.current;
            if (v && c && s.clip) {
                let freezing: number | null = null;
                const startFreezeOrLoop = () => {
                    if (s.clip.freeze && s.clip.freeze.seconds > 0) {
                        v.pause();
                        freezeRef.current = performance.now();
                        freezing = 0;
                    } else v.currentTime = s.clip.start;
                };
                if (freezeRef.current !== null) {
                    const fz = s.clip.freeze?.seconds ?? 0;
                    const prog = (performance.now() - freezeRef.current) / 1000 / Math.max(0.1, fz);
                    if (prog >= 1) {
                        freezeRef.current = null;
                        v.currentTime = s.clip.start;
                        v.play().catch(() => {});
                    } else freezing = prog;
                } else if (replayRef.current) {
                    // instant replay: slowed down, then the freeze ending or back to the start
                    const r = s.clip.replay;
                    if (!r || v.currentTime >= r.end || v.paused) {
                        replayRef.current = false;
                        v.playbackRate = 1;
                        if (!v.paused) startFreezeOrLoop();
                    }
                } else if (!v.paused) {
                    const skip = skipCut(s.clip, v.currentTime);
                    if (skip !== v.currentTime) v.currentTime = skip;
                    if (v.currentTime >= s.clip.end) {
                        const r = s.clip.replay;
                        if (r && r.end > r.start) {
                            replayRef.current = true;
                            v.currentTime = r.start;
                            v.playbackRate = r.speed;
                        } else startFreezeOrLoop();
                    } else if (v.currentTime < s.clip.start - 0.5) v.currentTime = s.clip.start;
                    // sound effects the playhead just passed
                    const prev = lastTimeRef.current;
                    if (v.currentTime > prev && v.currentTime - prev < 0.5) {
                        for (const fx of allSfx(s.clip)) if (fx.t > prev && fx.t <= v.currentTime) playSfx(fx.kind, s.style.sfxVolume ?? 0.8).catch(() => {});
                    }
                }
                lastTimeRef.current = v.currentTime;
                // background music follows the video, quieter while someone talks
                const m = musicRef.current;
                if (m && s.music) {
                    const active = !v.paused;
                    if (active && m.paused) m.play().catch(() => {});
                    if (!active && !m.paused) m.pause();
                    const talking = s.music.duck && s.words.some((w) => v.currentTime >= w.start && v.currentTime < w.end + 0.3);
                    m.volume = Math.min(1, s.music.volume * (talking ? 0.3 : 1));
                } else if (m && !m.paused) m.pause();
                const ctx = c.getContext('2d');
                if (ctx) {
                    drawScene(ctx, v, v.currentTime, { clip: s.clip, style: s.style, brand: s.brand, groups: s.groups, logo: logoRef.current, freezing, replaying: replayRef.current });
                    const sel = selectedStickerRef.current;
                    const st = sel !== null ? s.clip.stickers?.[sel] : undefined;
                    if (st && !replayRef.current && freezing === null) {
                        const b = stickerBox(ctx, st);
                        ctx.save();
                        ctx.strokeStyle = '#c8ff3d';
                        ctx.lineWidth = 3;
                        ctx.setLineDash([8, 6]);
                        ctx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
                        ctx.restore();
                    }
                }
                // the timeline playhead moves every frame without re-rendering; React state updates a few times a second
                const len = outputDuration(s.clip);
                const r = s.clip.replay;
                const outT = freezing !== null ? len + replayLength(s.clip) + freezing * (s.clip.freeze?.seconds ?? 0) : replayRef.current && r ? len + (v.currentTime - r.start) / Math.max(0.1, r.speed) : toOutputClamped(s.clip, v.currentTime);
                timelineRef.current?.setPlayhead(outT);
                const now = performance.now();
                if (v.paused || now - lastStateRef.current > 200) {
                    lastStateRef.current = now;
                    setTime(v.currentTime);
                }
            }
            raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(raf);
    }, []);

    // older clips (cut list) are turned into separate parts once, when opened
    useEffect(() => {
        if (clip && !clip.segs?.length) onChange({ ...project, clips: project.clips.map((c) => (c.id === clip.id ? ensureSegs(c) : c)) });
    }, [clip?.id]);

    useEffect(() => {
        const v = videoRef.current;
        if (v && clip) v.currentTime = clip.start;
        setSelection(null);
        history.current = [];
        setHistoryLen(0);
        future.current = [];
        setFutureLen(0);
        replayRef.current = false;
    }, [clip?.id, video?.url]);

    // ---------- timeline thumbnails ----------
    useEffect(() => {
        if (!video || !clip) return;
        let cancelled = false;
        (async () => {
            const v = document.createElement('video');
            v.muted = true;
            v.src = video.url;
            await new Promise((r) => (v.onloadeddata = r));
            const from = Math.max(0, clip.start - 10);
            const to = Math.min(project.duration, clip.end + 10);
            const step = Math.max(0.75, (to - from) / 80);
            const c = document.createElement('canvas');
            c.width = 96;
            c.height = Math.round((96 * v.videoHeight) / v.videoWidth) || 54;
            const out: { t: number; url: string }[] = [];
            for (let t = from; t < to && !cancelled; t += step) {
                await new Promise<void>((r) => {
                    v.onseeked = () => r();
                    v.currentTime = t;
                });
                c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
                out.push({ t, url: c.toDataURL('image/jpeg', 0.6) });
                // new thumbnails replace old ones as they're made, so the strip never goes blank
                if (out.length % 6 === 0 && !cancelled) {
                    const upTo = t;
                    setThumbs((prev) => [...out, ...prev.filter((x) => x.t > upTo + step / 2)].sort((x, y) => x.t - y.t));
                }
            }
            if (!cancelled) setThumbs(out);
            v.removeAttribute('src');
            v.load();
        })();
        return () => {
            cancelled = true;
        };
    }, [clip?.id, video?.url, Math.floor((clip?.start ?? 0) / 15), Math.ceil((clip?.end ?? 0) / 15)]);

    selectedStickerRef.current = selection?.type === 'sticker' ? selection.i : null;
    if (!clip) return <p className="text-muted">This clip no longer exists.</p>;

    // ---------- updates ----------
    const commit = (p: Project) => {
        latest.current = p;
        onChange(p);
    };
    const setStyle = (patch: Partial<StyleSettings>) => commit({ ...latest.current, style: { ...latest.current.style, ...patch } });
    const setClip = (patch: Partial<Clip>) => commit({ ...latest.current, clips: latest.current.clips.map((c) => (c.id === clip.id ? { ...c, ...patch } : c)) });
    const editClip = (patch: Partial<Clip>) => {
        history.current = [...history.current.slice(-49), clip];
        setHistoryLen(history.current.length);
        future.current = [];
        setFutureLen(0);
        setClip(patch);
    };
    const redo = () => {
        const next = future.current.pop();
        setFutureLen(future.current.length);
        if (!next) return;
        history.current.push(clip);
        setHistoryLen(history.current.length);
        commit({ ...latest.current, clips: latest.current.clips.map((c) => (c.id === clip.id ? next : c)) });
    };
    const undo = () => {
        const prev = history.current.pop();
        setHistoryLen(history.current.length);
        if (prev) {
            future.current.push(clip);
            setFutureLen(future.current.length);
        }
        if (prev) commit({ ...latest.current, clips: latest.current.clips.map((c) => (c.id === clip.id ? prev : c)) });
    };

    function seek(t: number) {
        const v = videoRef.current;
        freezeRef.current = null;
        if (replayRef.current && v) v.playbackRate = 1;
        replayRef.current = false;
        if (v) v.currentTime = Math.max(0, Math.min(project.duration, t));
    }
    function togglePlay() {
        const v = videoRef.current;
        if (!v) return;
        if (v.paused) {
            if (v.currentTime >= clip.end - 0.02 || v.currentTime < clip.start) v.currentTime = clip.start;
            v.play().catch(() => {});
        } else v.pause();
    }
    /** select the part under the playhead, so layout changes go to that part only */
    function selectPartHere() {
        if (segmentsOf(clip).length < 2 || selection?.type === 'segs') return;
        const v = videoRef.current;
        const t = v ? v.currentTime : clip.start;
        const segs = segmentsOf(clip);
        const sg = segs.find((x) => t >= x.start && t < x.end) ?? segs.find((x) => x.start >= t) ?? segs[segs.length - 1];
        setSelection({ type: 'segs', ids: [sg.id] });
    }
    /** seek in sequence time (the finished video) */
    function seekOut(outT: number) {
        const len = outputDuration(clip);
        seek(toSource(clip, Math.max(0, Math.min(len - 0.01, outT))));
        timelineRef.current?.setPlayhead(Math.max(0, Math.min(len, outT)));
    }
    fns.current = {
        seekOut,
        togglePlay,
        play: () => { const v = videoRef.current; if (v?.paused) togglePlay(); },
        pause: () => videoRef.current?.pause(),
        beginEdit: () => {
            history.current = [...history.current.slice(-49), clip];
            setHistoryLen(history.current.length);
            future.current = [];
            setFutureLen(0);
        },
        update: setClip,
        undo,
        redo,
        select: (sel: Selection) => {
            setSelection(sel);
            if (sel?.type === 'segs') setTab('layout');
            if (sel?.type === 'sticker') setTab('effects');
        },
        outTime: () => toOutputClamped(clip, videoRef.current?.currentTime ?? clip.start)
    };

    /** Replace the words of one caption block with new text, spread across the same time. */
    function editCaption(gi: number, text: string) {
        const g = groups[gi];
        if (!g || !project.transcript) return;
        const all = [...project.transcript.words];
        const first = g[0].index;
        const last = g[g.length - 1].index;
        const start = all[first].start;
        const end = all[last].end;
        const parts = text.trim().split(/\s+/).filter(Boolean);
        const totalChars = parts.reduce((a, w) => a + w.length + 1, 0) || 1;
        let t = start;
        const fresh: Word[] = parts.map((w) => {
            const d = ((end - start) * (w.length + 1)) / totalChars;
            const word = { text: w, start: t, end: t + d };
            t += d;
            return word;
        });
        all.splice(first, last - first + 1, ...fresh);
        commit({ ...latest.current, transcript: { ...project.transcript, words: all } });
    }

    function removeSilences() {
        const found = silenceCuts(clip, words);
        if (!found.length) {
            setBusy('No pauses long enough to remove.');
            setTimeout(() => setBusy(''), 2000);
            return;
        }
        editClip(withSegs(clip, removeRanges(segmentsOf(clip), found)));
        setBusy(`Removed ${found.length} pause${found.length > 1 ? 's' : ''}.`);
        setTimeout(() => setBusy(''), 2500);
    }

    function setSpeakerHere(speaker: number) {
        const list = [...(project.speakers ?? []).filter((s) => Math.abs(s.t - time) > 0.05), { t: time, speaker }].sort((a, b) => a.t - b.t);
        commit({ ...latest.current, speakers: list });
    }

    async function reframe() {
        if (!video) return;
        setBusy('Finding the speaker…');
        try {
            const res = await analyseClip(video.url, clip.start, clip.end, style.aspect);
            setClip({ track: res.track, thumb: res.thumb });
        } finally {
            setBusy('');
        }
    }

    async function findFacecam() {
        if (!video) return;
        setBusy('Looking for the facecam…');
        try {
            const r = await detectFacecam(video.url, project.duration);
            if (r) setStyle({ facecam: r, layout: 'split' });
            setBusy(r ? 'Facecam found.' : 'No facecam found. Drag the box over it yourself.');
        } catch {
            setBusy('Could not search the video.');
        }
        setTimeout(() => setBusy(''), 3000);
    }

    async function exportClip() {
        if (!video) return;
        setRenderError('');
        setRendering(0);
        try {
            const blob = await renderClip({ file: video.file, clip, words, style, brand, quality, videoWidth: project.width, videoHeight: project.height, speakers: project.speakers, music: project.music, onProgress: setRendering });
            saveBlob(blob, `${safeName(clip.title)}.mp4`);
        } catch (e) {
            setRenderError((e as Error).message);
        } finally {
            setRendering(null);
        }
    }

    const tags = clip.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ');
    const uploadText = `${clip.title}\n\n${clip.description}\n\n${tags}`;
    const outLen = outputDuration(clip);
    const outNow = toOutputClamped(clip, time);
    const selCaption = selection?.type === 'caption' ? groups[selection.i] : null;
    const selZoom = selection?.type === 'zoom' ? (clip.zooms ?? [])[selection.i] : null;
    const colors = style.speakerColors ?? DEFAULT_SPEAKER_COLORS;

    return (
        <div className="ed-root">
            <header className="ed-header">
                <button className="ed-hbtn" onClick={onBack} title="Back to all clips" aria-label="Back to all clips"><ArrowLeft size={17} /></button>
                <span className="ed-logo">✂</span>
                <div className="ed-hsep" />
                {!project.options.captionsOnly && <span className={`rounded-md px-1.5 py-0.5 text-xs font-extrabold ${scoreTone(clip.score)}`} title="Virality score">{clip.score}</span>}
                <input className="ed-title" value={clip.title} onChange={(e) => setClip({ title: e.target.value })} aria-label="Clip title" />
                <span className="hidden truncate text-xs text-white/40 xl:inline">{project.name}</span>
                <div className="ml-auto flex items-center gap-1.5">
                    <span className="hidden text-xs text-white/40 sm:inline">Clip {idx + 1} of {ordered.length}</span>
                    <button className="ed-hbtn" disabled={idx <= 0} onClick={() => onSelectClip(ordered[idx - 1].id)} title="Previous clip" aria-label="Previous clip"><ChevronLeft size={17} /></button>
                    <button className="ed-hbtn" disabled={idx >= ordered.length - 1} onClick={() => onSelectClip(ordered[idx + 1].id)} title="Next clip" aria-label="Next clip"><ChevronRight size={17} /></button>
                    <button className="ed-export" onClick={() => setTab('export')}><Download size={15} /> Export</button>
                </div>
            </header>

            {!video && (
                <label className="mx-3 mt-3 flex cursor-pointer flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300/20 bg-amber-300/[0.06] p-3">
                    <span className="text-sm">
                        Select the original video to preview and export: <b className="break-all">{project.fileName}</b>
                        {attachError && <span className="block text-red-300">{attachError}</span>}
                    </span>
                    <span className="btn-ghost">Select video</span>
                    <input type="file" accept="video/*,.mkv" className="sr-only" onChange={(e) => e.target.files?.[0] && onAttach(e.target.files[0])} />
                </label>
            )}

            <div className="ed-main">
                {/* program monitor */}
                <section className="ed-monitor">
                    <div className="ed-monitor-bar">
                        <span className="font-semibold text-white/70">Program</span>
                        <span className="text-white/35">{style.aspect} · {outLen.toFixed(1)}s</span>
                    </div>
                    <div className="ed-stage">
                    <div className="ed-frame" style={{ aspectRatio: `${preview.W} / ${preview.H}` }}>
                        <canvas
                            ref={canvasRef}
                            width={preview.W}
                            height={preview.H}
                            className="block h-full w-full touch-none"
                            onPointerDown={(e) => {
                                const c = canvasRef.current!;
                                const r = c.getBoundingClientRect();
                                const px = ((e.clientX - r.left) / r.width) * c.width;
                                const py = ((e.clientY - r.top) / r.height) * c.height;
                                const ctx = c.getContext('2d')!;
                                const list = clip.stickers ?? [];
                                for (let i = list.length - 1; i >= 0; i--) {
                                    const st = list[i];
                                    if (time < st.start || time >= st.end) continue;
                                    const b = stickerBox(ctx, st);
                                    if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) {
                                        selectedStickerRef.current = i;
                                        setSelection({ type: 'sticker', i });
                                        stickerDrag.current = { i, dx: px / c.width - st.x, dy: py / c.height - st.y };
                                        c.setPointerCapture(e.pointerId);
                                        return;
                                    }
                                }
                                togglePlay();
                            }}
                            onPointerMove={(e) => {
                                const d = stickerDrag.current;
                                if (!d) return;
                                const c = canvasRef.current!;
                                const r = c.getBoundingClientRect();
                                const x = Math.min(0.97, Math.max(0.03, (e.clientX - r.left) / r.width - d.dx));
                                const y = Math.min(0.97, Math.max(0.03, (e.clientY - r.top) / r.height - d.dy));
                                setClip({ stickers: (clip.stickers ?? []).map((st, k) => (k === d.i ? { ...st, x, y } : st)) });
                            }}
                            onPointerUp={() => (stickerDrag.current = null)}
                        />
                        {!playing && video && freezeRef.current === null && (
                            <button className="ed-bigplay" onClick={togglePlay} aria-label="Play">
                                <span><Play size={26} fill="currentColor" /></span>
                            </button>
                        )}
                        <video ref={videoRef} src={video?.url} playsInline preload="auto" className="pointer-events-none fixed top-0 left-0 size-px opacity-0" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
                        {musicUrl && <audio ref={musicRef} src={musicUrl} loop preload="auto" />}
                    </div>
                    </div>
                    <div className="ed-monitor-foot">
                        <span className="font-mono tabular-nums text-white/80">{timecode(outNow)}</span>
                        <span className="truncate text-white/45">{busy || (selection?.type === 'segs' ? `${selection.ids.length} part${selection.ids.length > 1 ? 's' : ''} selected` : 'Click the video to play or pause')}</span>
                    </div>
                </section>

                {/* inspector */}
                <section className="ed-inspector">
                    <div className="ed-tabs" role="tablist">
                        {TABS.map((t) => (
                            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => { setTab(t.id); if (t.id === 'layout') selectPartHere(); }} className={`ed-tab ${tab === t.id ? 'ed-tab-on' : ''}`}>
                                <t.icon size={15} />
                                <span>{t.label}</span>
                            </button>
                        ))}
                    </div>
                    <div className="ed-panel">
                        {tab === 'captions' && (
                            <>
                                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 xl:grid-cols-6">
                                    {TEMPLATES.map((t) => (
                                        <TemplateSwatch key={t.id} template={t} highlight={t.id === style.template ? style.highlight : t.defaultHighlight} selected={style.template === t.id} onClick={() => setStyle({ template: t.id, highlight: t.defaultHighlight })} />
                                    ))}
                                </div>
                                <div className="grid gap-5 sm:grid-cols-2">
                                    <Field label="Highlight colour">
                                        <div className="flex flex-wrap gap-2">
                                            {['#c8ff3d', '#ffd60a', '#ff4d6d', '#7c5cff', '#2ee6d6', '#ff9f1c', '#ffffff'].map((c) => (
                                                <button key={c} onClick={() => setStyle({ highlight: c })} className={`size-7 rounded-full border-2 ${style.highlight === c ? 'border-white' : 'border-transparent'}`} style={{ background: c }} aria-label={`Highlight ${c}`} />
                                            ))}
                                            <input type="color" value={style.highlight} onChange={(e) => setStyle({ highlight: e.target.value })} className="size-7 cursor-pointer rounded-full bg-transparent" aria-label="Custom colour" />
                                        </div>
                                    </Field>
                                    <Field label="Position">
                                        <Segmented value={style.position} onChange={(v) => setStyle({ position: v as CaptionPosition })} items={[{ id: 'top', label: 'Top' }, { id: 'middle', label: 'Middle' }, { id: 'bottom', label: 'Bottom' }]} />
                                    </Field>
                                    <Field label={`Words on screen: ${style.wordsPerLine}`}>
                                        <input type="range" min={1} max={6} value={style.wordsPerLine} onChange={(e) => setStyle({ wordsPerLine: +e.target.value })} className="w-full accent-[var(--color-accent)]" />
                                    </Field>
                                    <Field label="Swear words">
                                        <Segmented value={style.censor ?? 'off'} onChange={(v) => setStyle({ censor: v as StyleSettings['censor'] })} items={[{ id: 'off', label: 'Show' }, { id: 'captions', label: 'f***' }, { id: 'bleep', label: 'f*** + bleep' }]} />
                                    </Field>
                                </div>
                                <Toggle label="Highlight keywords" hint={clip.keywords.length ? clip.keywords.join(', ') : 'No keywords for this clip'} checked={style.keywordHighlight} onChange={(v) => setStyle({ keywordHighlight: v })} />
                                <Toggle label="Auto emoji" hint={clip.emojis.length ? clip.emojis.map((e) => `${e.emoji} ${e.word}`).join('  ') : 'No emoji for this clip'} checked={style.emojis} onChange={(v) => setStyle({ emojis: v })} />
                                <Toggle label="Animated emoji" hint="Emoji pop in and float" checked={!!style.emojiAnim} onChange={(v) => setStyle({ emojiAnim: v })} />
                                <FixWords project={project} onChange={onChange} />
                                <TranslatePanel clip={clip} groups={groups} style={style} setStyle={setStyle} setClip={setClip} />
                                <div className="flex flex-col gap-2 rounded-xl bg-white/[0.04] p-3">
                                    <p className="text-sm font-semibold">Speaker colours</p>
                                    <p className="text-xs text-muted">Move the playhead to where someone starts talking, then pick who it is. Their captions take that colour until the next change.</p>
                                    <div className="flex flex-wrap items-center gap-2">
                                        {colors.map((c, i) => (
                                            <span key={i} className="flex items-center gap-1">
                                                <button className="tl-btn" onClick={() => setSpeakerHere(i)} style={{ color: c }}>
                                                    Speaker {i + 1}
                                                </button>
                                                <input type="color" value={c} onChange={(e) => setStyle({ speakerColors: colors.map((x, k) => (k === i ? e.target.value : x)) })} className="size-6 cursor-pointer bg-transparent" aria-label={`Speaker ${i + 1} colour`} />
                                            </span>
                                        ))}
                                        {(project.speakers?.length ?? 0) > 0 && (
                                            <button className="text-xs text-muted hover:text-red-300" onClick={() => commit({ ...latest.current, speakers: [] })}>
                                                Clear
                                            </button>
                                        )}
                                    </div>
                                </div>
                                <p className="text-xs text-muted">Caption settings apply to every clip in this project. To fix a caption, click it in the Captions row of the timeline.</p>
                            </>
                        )}

                        {tab === 'layout' && (
                            <>
                                <PartInspector clip={clip} style={style} selection={selection} editClip={editClip} setClip={setClip} />
                                <Field label="Aspect ratio">
                                    <Segmented value={style.aspect} onChange={(v) => setStyle({ aspect: v as Aspect })} items={[{ id: '9:16', label: '9:16' }, { id: '1:1', label: '1:1' }, { id: '16:9', label: '16:9' }]} />
                                </Field>
                                {segmentsOf(clip).length > 1 ? (
                                    // with several parts, the only way to change a layout is per part (or all parts on purpose)
                                    selection?.type !== 'segs' && (
                                        <div className="ed-card">
                                            <p className="text-sm font-semibold">Set every part at once</p>
                                            <p className="text-xs text-white/50">This clip is cut into {segmentsOf(clip).length} parts. To change only one, click it on the V1 track instead.</p>
                                            <Segmented
                                                value=""
                                                onChange={(v) => editClip(withSegs(clip, segmentsOf(clip).map((sg) => ({ ...sg, layout: v as Layout }))))}
                                                items={[{ id: 'auto', label: 'Follow' }, { id: 'split', label: 'Facecam' }, { id: 'pip', label: 'PiP' }, { id: 'manual', label: 'Fixed' }, { id: 'fit', label: 'Fit' }]}
                                            />
                                        </div>
                                    )
                                ) : (
                                    <Field label="Layout">
                                        <Segmented
                                            value={style.layout}
                                            onChange={(v) => setStyle({ layout: v as Layout })}
                                            items={[{ id: 'auto', label: 'Follow' }, { id: 'split', label: 'Facecam' }, { id: 'pip', label: 'PiP' }, { id: 'manual', label: 'Fixed' }, { id: 'fit', label: 'Fit' }]}
                                        />
                                    </Field>
                                )}
                                {style.layout === 'auto' && (
                                    <div className="flex flex-col gap-2 text-sm">
                                        <p className="text-muted">{clip.track ? 'The frame follows the main speaker’s face.' : 'No face was found in this clip yet, so it stays centred.'}</p>
                                        <button className="btn-ghost" disabled={!video} onClick={reframe}>Re-detect speaker</button>
                                    </div>
                                )}
                                {(style.layout === 'pip' || segmentsOf(clip).some((sg) => sg.layout === 'pip')) && <PipSettingsPanel style={style} setStyle={setStyle} />}
                                {(['split', 'pip'] as Layout[]).some((l) => style.layout === l || segmentsOf(clip).some((sg) => sg.layout === l)) && (
                                    <>
                                        <p className="text-sm font-semibold">Facecam box</p>
                                        <FacecamPicker video={videoRef.current} facecam={style.facecam ?? { x: 0, y: 0, w: 0.3, h: 0.3 }} onChange={(r) => setStyle({ facecam: r })} />
                                        <button className="btn-ghost" disabled={!video} onClick={findFacecam}>Find the facecam automatically</button>
                                        <Field label={`Facecam height: ${Math.round((style.splitRatio ?? 0.4) * 100)}%`}>
                                            <input type="range" min={0.25} max={0.55} step={0.01} value={style.splitRatio ?? 0.4} onChange={(e) => setStyle({ splitRatio: +e.target.value })} className="w-full accent-[var(--color-accent)]" />
                                        </Field>
                                        <Field label="Gameplay position">
                                            <input type="range" min={0} max={1} step={0.01} value={style.cropX} onChange={(e) => setStyle({ cropX: +e.target.value })} className="w-full accent-[var(--color-accent)]" />
                                        </Field>
                                    </>
                                )}
                                {style.layout === 'manual' && (
                                    <Field label="Position">
                                        <input type="range" min={0} max={1} step={0.01} value={style.cropX} onChange={(e) => setStyle({ cropX: +e.target.value })} className="w-full accent-[var(--color-accent)]" />
                                    </Field>
                                )}
                                {style.layout === 'fit' && <p className="text-sm text-muted">Shows the whole frame with a blurred copy filling the space around it.</p>}
                            </>
                        )}

                        {tab === 'effects' && (
                            <>
                                <div className="flex flex-col gap-2 rounded-xl bg-white/[0.04] p-3">
                                    <Toggle
                                        label="Hook title at the top"
                                        hint="A bold headline for the first seconds to stop the scroll"
                                        checked={!!clip.hookTitle && clip.hookTitle.seconds > 0}
                                        onChange={(on) => editClip({ hookTitle: on ? { text: clip.hookTitle?.text || clip.title, seconds: clip.hookTitle?.seconds || 3 } : clip.hookTitle ? { ...clip.hookTitle, seconds: 0 } : undefined })}
                                    />
                                    {clip.hookTitle && clip.hookTitle.seconds > 0 && (
                                        <>
                                            <input className="input text-sm" value={clip.hookTitle.text} onChange={(e) => setClip({ hookTitle: { ...clip.hookTitle!, text: e.target.value } })} aria-label="Hook title text" />
                                            <Field label={`Shows for ${clip.hookTitle.seconds.toFixed(1)}s`}>
                                                <input type="range" min={1} max={10} step={0.5} value={clip.hookTitle.seconds} onChange={(e) => setClip({ hookTitle: { ...clip.hookTitle!, seconds: +e.target.value } })} className="w-full accent-[var(--color-accent)]" />
                                            </Field>
                                        </>
                                    )}
                                </div>
                                <div className="flex flex-col gap-2 rounded-xl bg-white/[0.04] p-3">
                                    <p className="text-sm font-semibold">Zooms</p>
                                    <p className="text-xs text-muted">Punch-in zooms on the big moments. Add one at the playhead with Z, then drag it in the Effects row.</p>
                                    <div className="flex flex-wrap gap-2">
                                        <button className="tl-btn" onClick={() => editClip({ zooms: [...(clip.zooms ?? []), { start: Math.max(clip.start, Math.min(time, clip.end - 0.5)), end: Math.min(clip.end, Math.max(clip.start, time) + 1.5), scale: 1.25 }].sort((a, b) => a.start - b.start) })}>
                                            + Zoom at playhead
                                        </button>
                                        <button
                                            className="tl-btn"
                                            onClick={() => {
                                                const laughs = events.filter((e) => e.type === 'reaction' && e.start > clip.start + 1 && e.start < clip.end);
                                                const auto = laughs.map((e) => ({ start: Math.max(clip.start, e.start - 1.2), end: Math.min(clip.end, e.start + 0.8), scale: 1.3 }));
                                                if (auto.length) editClip({ zooms: auto });
                                                else {
                                                    setBusy('No laughs found in this clip to zoom on.');
                                                    setTimeout(() => setBusy(''), 2500);
                                                }
                                            }}
                                        >
                                            ✨ Auto-zoom on laughs
                                        </button>
                                        {(clip.zooms?.length ?? 0) > 0 && <button className="tl-btn" onClick={() => editClip({ zooms: [] })}>Remove all</button>}
                                    </div>
                                    {selZoom && (
                                        <Field label={`Selected zoom strength: ${selZoom.scale.toFixed(2)}×`}>
                                            <input
                                                type="range"
                                                min={1.05}
                                                max={1.8}
                                                step={0.05}
                                                value={selZoom.scale}
                                                onChange={(e) => setClip({ zooms: (clip.zooms ?? []).map((z, i) => (selection?.type === 'zoom' && i === selection.i ? { ...z, scale: +e.target.value } : z)) })}
                                                className="w-full accent-[var(--color-accent)]"
                                            />
                                        </Field>
                                    )}
                                </div>
                                <div className="flex flex-col gap-2 rounded-xl bg-white/[0.04] p-3">
                                    <p className="text-sm font-semibold">Jump cuts</p>
                                    <p className="text-xs text-muted">Removes pauses between words so the clip moves faster. Each kept piece becomes its own part on V1. Undo with Ctrl+Z.</p>
                                    <div className="flex gap-2">
                                        <button className="tl-btn" onClick={removeSilences}>⏩ Remove silences</button>
                                        {segmentsOf(clip).length > 1 && <button className="tl-btn" onClick={() => editClip(withSegs(clip, [{ ...segmentsOf(clip)[0], start: clip.start, end: clip.end }]))}>Restore everything</button>}
                                    </div>
                                </div>
                                <div className="flex flex-col gap-2 rounded-xl bg-white/[0.04] p-3">
                                    <p className="text-sm font-semibold">Transitions at cuts</p>
                                    <p className="text-xs text-muted">
                                        {cutTimes(clip).length
                                            ? `Adds an effect at each of the ${cutTimes(clip).length} cut${cutTimes(clip).length > 1 ? 's' : ''} between parts, so jumps feel deliberate.`
                                            : 'Cut the clip into parts first (C or Ctrl+K in the timeline, or Remove silences). Every cut then gets this effect.'}
                                    </p>
                                    <Segmented
                                        value={clip.transition?.kind ?? 'none'}
                                        onChange={(v) => editClip({ transition: { kind: v as NonNullable<Clip['transition']>['kind'], sound: clip.transition?.sound ?? null } })}
                                        items={[{ id: 'none', label: 'None' }, { id: 'flash', label: '✦ Flash' }, { id: 'shake', label: '⚡ Shake' }, { id: 'zoom', label: '🔍 Punch zoom' }]}
                                    />
                                    <Field label="Sound at each cut">
                                        <Segmented
                                            value={clip.transition?.sound ?? 'none'}
                                            onChange={(v) => {
                                                const sound = v === 'none' ? null : (v as SfxKind);
                                                if (sound) playSfx(sound, style.sfxVolume ?? 0.8).catch(() => {});
                                                editClip({ transition: { kind: clip.transition?.kind ?? 'none', sound } });
                                            }}
                                            items={[{ id: 'none', label: 'None' }, ...SFX_KINDS.map((k) => ({ id: k.id, label: `${k.icon} ${k.label}` }))]}
                                        />
                                    </Field>
                                </div>
                                <div className="flex flex-col gap-2 rounded-xl bg-white/[0.04] p-3">
                                    <Toggle
                                        label="Freeze-frame ending"
                                        hint="Hold the last frame with a line of text"
                                        checked={!!clip.freeze && clip.freeze.seconds > 0}
                                        onChange={(on) => editClip({ freeze: on ? { seconds: clip.freeze?.seconds || 1.5, text: clip.freeze?.text ?? 'He never recovered 💀' } : undefined })}
                                    />
                                    {clip.freeze && clip.freeze.seconds > 0 && (
                                        <>
                                            <input className="input text-sm" value={clip.freeze.text} onChange={(e) => setClip({ freeze: { ...clip.freeze!, text: e.target.value } })} aria-label="Freeze text" />
                                            <Field label={`Length: ${clip.freeze.seconds.toFixed(1)}s`}>
                                                <input type="range" min={0.5} max={5} step={0.5} value={clip.freeze.seconds} onChange={(e) => setClip({ freeze: { ...clip.freeze!, seconds: +e.target.value } })} className="w-full accent-[var(--color-accent)]" />
                                            </Field>
                                        </>
                                    )}
                                </div>
                                <Toggle label="Progress bar" hint="A thin bar at the bottom that fills as the clip plays (all clips)" checked={!!style.progressBar} onChange={(v) => setStyle({ progressBar: v })} />

                                <div className="flex flex-col gap-2 rounded-xl bg-white/[0.04] p-3">
                                    <Toggle
                                        label="Sound effects"
                                        hint="Booms on laughs, whooshes on zooms. Drag them in the Audio row."
                                        checked={(clip.sfx?.length ?? 0) > 0}
                                        onChange={(on) => {
                                            if (!on) return editClip({ sfx: [] });
                                            const auto = autoSfx(clip, events);
                                            editClip({ sfx: auto.length ? auto : [{ t: Math.min(clip.end - 0.5, clip.start + 1), kind: 'whoosh' }] });
                                        }}
                                    />
                                    {(clip.sfx?.length ?? 0) > 0 && (
                                        <>
                                            <div className="flex flex-wrap gap-1.5">
                                                {SFX_KINDS.map((k) => (
                                                    <button key={k.id} className="tl-btn" title={`Add a ${k.label} at the playhead`} onClick={() => { playSfx(k.id, style.sfxVolume ?? 0.8); editClip({ sfx: [...(clip.sfx ?? []), { t: Math.max(clip.start, Math.min(clip.end, time)), kind: k.id as SfxKind }].sort((a, b) => a.t - b.t) }); }}>
                                                        {k.icon} + {k.label}
                                                    </button>
                                                ))}
                                            </div>
                                            <Field label={`Effects volume: ${Math.round((style.sfxVolume ?? 0.8) * 100)}%`}>
                                                <input type="range" min={0.1} max={1.5} step={0.05} value={style.sfxVolume ?? 0.8} onChange={(e) => setStyle({ sfxVolume: +e.target.value })} className="w-full accent-[var(--color-accent)]" />
                                            </Field>
                                        </>
                                    )}
                                </div>

                                <div className="flex flex-col gap-2 rounded-xl bg-white/[0.04] p-3">
                                    <Toggle
                                        label="Instant replay"
                                        hint="Replays the funniest moment slowed down and zoomed in, after the clip"
                                        checked={!!clip.replay}
                                        onChange={(on) => editClip({ replay: on ? autoReplay(clip, events) : undefined })}
                                    />
                                    {clip.replay && (
                                        <>
                                            <p className="text-xs text-muted">
                                                Replays {(clip.replay.end - clip.replay.start).toFixed(1)}s ({replayLength(clip).toFixed(1)}s slowed down).
                                            </p>
                                            <div className="flex flex-wrap gap-2">
                                                <button className="tl-btn" onClick={() => editClip({ replay: { ...clip.replay!, start: Math.max(clip.start, time - 2.4), end: Math.min(clip.end, time + 0.4) } })}>
                                                    Replay the moment at the playhead
                                                </button>
                                            </div>
                                            <Field label={`Speed: ${Math.round(clip.replay.speed * 100)}%`}>
                                                <input type="range" min={0.5} max={1} step={0.05} value={clip.replay.speed} onChange={(e) => setClip({ replay: { ...clip.replay!, speed: +e.target.value } })} className="w-full accent-[var(--color-accent)]" />
                                            </Field>
                                        </>
                                    )}
                                </div>

                                <div className="flex flex-col gap-2 rounded-xl bg-white/[0.04] p-3">
                                    <Toggle
                                        label="Screen shake & flash"
                                        hint="Shakes the frame on the loudest moments (⚡ in the Effects row)"
                                        checked={(clip.shakes?.length ?? 0) > 0}
                                        onChange={(on) => {
                                            if (!on) return editClip({ shakes: [] });
                                            const auto = autoShakes(clip, events);
                                            editClip({ shakes: auto.length ? auto : [{ t: Math.max(clip.start, Math.min(clip.end, time)), kind: 'both' }] });
                                        }}
                                    />
                                    {(clip.shakes?.length ?? 0) > 0 && (
                                        <div className="flex flex-wrap gap-1.5">
                                            <button className="tl-btn" onClick={() => editClip({ shakes: [...(clip.shakes ?? []), { t: time, kind: 'shake' as const }].sort((a, b) => a.t - b.t) })}>⚡ + Shake at playhead</button>
                                            <button className="tl-btn" onClick={() => editClip({ shakes: [...(clip.shakes ?? []), { t: time, kind: 'flash' as const }].sort((a, b) => a.t - b.t) })}>✦ + Flash at playhead</button>
                                        </div>
                                    )}
                                </div>

                                <StickersPanel clip={clip} time={time} selection={selection} setSelection={setSelection} editClip={editClip} setClip={setClip} />
                                <MusicPanel project={project} onChange={onChange} />
                                <PresetsPanel project={project} clip={clip} events={events} words={words} onChange={onChange} />
                            </>
                        )}

                        {tab === 'post' && (
                            <>
                                <div className="flex flex-col gap-1.5">
                                    <Bar label="Hook" value={clip.subscores.hook} />
                                    <Bar label="Flow" value={clip.subscores.flow} />
                                    <Bar label={clip.category === 'Funny' ? 'Funny' : 'Value'} value={clip.subscores.value} />
                                    <Bar label="Shareable" value={clip.subscores.shareability} />
                                </div>
                                <p className="text-sm text-muted">{clip.reason}</p>
                                <ImprovePanel clip={clip} words={words} setClip={editClip} />
                                <Field label="Title ideas (click one to use it)">
                                    <div className="flex flex-col gap-1.5">
                                        {titleIdeas(clip).map((t) => (
                                            <button key={t} onClick={() => setClip({ title: t })} className="rounded-lg bg-white/[0.05] px-3 py-2 text-left text-sm hover:bg-white/10">
                                                {t}
                                            </button>
                                        ))}
                                    </div>
                                </Field>
                                <Field label="Description">
                                    <textarea className="input min-h-20 text-sm" value={clip.description} onChange={(e) => setClip({ description: e.target.value })} />
                                </Field>
                                <Field label="Hashtags">
                                    <input className="input text-sm" value={clip.hashtags.join(' ')} onChange={(e) => setClip({ hashtags: e.target.value.split(/\s+/).filter(Boolean) })} />
                                </Field>
                                <button
                                    className="btn-ghost"
                                    onClick={() => {
                                        navigator.clipboard
                                            .writeText(uploadText)
                                            .then(() => {
                                                setCopied(true);
                                                setTimeout(() => setCopied(false), 1500);
                                            })
                                            .catch(() => {});
                                    }}
                                >
                                    {copied ? 'Copied' : 'Copy title, description and hashtags'}
                                </button>
                            </>
                        )}

                        {tab === 'thumbnail' && <ThumbnailMaker video={videoRef.current} clip={clip} style={style} events={events} onSeek={seek} />}

                        {tab === 'export' && (
                            <>
                                <p className="text-sm text-muted">
                                    Final length: <b className="text-white">{outLen.toFixed(1)}s</b>
                                    {clip.freeze?.seconds ? ` + ${clip.freeze.seconds}s freeze` : ''}
                                    {clip.end - clip.start - outLen > 0.05 ? ` (${(clip.end - clip.start - outLen).toFixed(1)}s cut out)` : ''}
                                </p>
                                <Field label="Quality">
                                    <Segmented value={String(quality)} onChange={(v) => setQuality(+v as 720 | 1080)} items={[{ id: '720', label: '720p · faster' }, { id: '1080', label: '1080p · sharper' }]} />
                                </Field>
                                {renderError && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-200">{renderError}</p>}
                                <button className="btn-accent" disabled={!video || rendering !== null} onClick={exportClip}>
                                    {rendering !== null ? `Rendering… ${Math.round(rendering * 100)}%` : 'Export MP4'}
                                </button>
                                <button className="btn-ghost" onClick={() => saveBlob(new Blob([buildSrt(words, clip, style, project.speakers)], { type: 'text/plain' }), `${safeName(clip.title)}.srt`)}>
                                    Download captions (.srt)
                                </button>
                                <button className="btn-ghost" onClick={() => saveBlob(new Blob([transcriptText(words, clip)], { type: 'text/plain' }), `${safeName(clip.title)} transcript.txt`)}>
                                    Download transcript (.txt)
                                </button>
                                {project.options.captionsOnly && <p className="text-xs text-muted">The .srt file can be uploaded to YouTube as subtitles, so viewers can switch them on and off. The MP4 has the captions burned in.</p>}
                                <p className="text-xs text-muted">Rendering runs on your device. 720p takes about a minute per clip; effects and 1080p take longer.</p>
                            </>
                        )}
                    </div>
                </section>
            </div>

            <div className="ed-timeline">
            <Timeline
                ref={timelineRef}
                clip={clip}
                style={style}
                duration={project.duration}
                playing={playing}
                groups={groups}
                energy={project.transcript?.energy}
                events={events}
                bleeps={bleeps}
                thumbs={thumbs}
                hasMusic={!!project.music}
                selection={selection}
                setSelection={tl.select}
                getOutTime={tl.outTime}
                onSeekOut={tl.seekOut}
                onTogglePlay={tl.togglePlay}
                onPlay={tl.play}
                onPause={tl.pause}
                onBeginEdit={tl.beginEdit}
                onUpdate={tl.update}
                onUndo={tl.undo}
                onRedo={tl.redo}
                canUndo={historyLen > 0}
                canRedo={futureLen > 0}
            />
            </div>

            {selCaption && selection?.type === 'caption' && (
                <CaptionEditor
                    key={`${selection.i}-${selCaption[0].index}`}
                    text={selCaption.map((w) => project.transcript?.words[w.index]?.text ?? w.text).join(' ')}
                    onSave={(t) => editCaption(selection.i, t)}
                    onClose={() => setSelection(null)}
                />
            )}
        </div>
    );
}

/** Fix misheard words across the whole video: find & replace, or a list of fixes from a Claude chat. */
function FixWords({ project, onChange }: { project: Project; onChange: (p: Project) => void }) {
    const [find, setFind] = useState('');
    const [replace, setReplace] = useState('');
    const [msg, setMsg] = useState('');
    const [open, setOpen] = useState(false);
    const [hint, setHint] = useState('');
    const [answer, setAnswer] = useState('');
    const words = project.transcript?.words ?? [];

    function apply(pairs: { wrong: string; right: string }[]) {
        if (!project.transcript) return;
        let ws = project.transcript.words;
        let total = 0;
        for (const p of pairs) {
            const r = replacePhrase(ws, p.wrong, p.right);
            ws = r.words;
            total += r.count;
        }
        onChange({ ...project, transcript: { ...project.transcript, words: ws } });
        setMsg(total ? `Fixed ${total} place${total > 1 ? 's' : ''}.` : 'Not found in the captions.');
    }

    return (
        <div className="flex flex-col gap-2 rounded-xl bg-white/[0.04] p-3">
            <p className="text-sm font-semibold">Fix caption words</p>
            <p className="text-xs text-muted">Fix a misheard word or phrase everywhere in this video at once.</p>
            <div className="flex flex-wrap gap-2">
                <input className="input min-w-0 flex-1 !py-1.5 text-sm" placeholder="Wrong, e.g. label key" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Find" />
                <input className="input min-w-0 flex-1 !py-1.5 text-sm" placeholder="Right, e.g. Lambo key" value={replace} onChange={(e) => setReplace(e.target.value)} aria-label="Replace with" />
                <button className="tl-btn" disabled={!find.trim()} onClick={() => apply([{ wrong: find, right: replace }])}>Replace everywhere</button>
            </div>
            <button className="self-start text-xs font-semibold text-accent" onClick={() => setOpen(!open)}>
                {open ? '▾' : '▸'} Let Claude find misheard names and slang (free)
            </button>
            {open && (
                <div className="flex flex-col gap-2 text-xs">
                    <input className="input !py-1.5 text-sm" placeholder="Optional: who's in it, what game, special names…" value={hint} onChange={(e) => setHint(e.target.value)} />
                    <div className="flex flex-wrap items-center gap-2">
                        <span>1.</span>
                        <button
                            className="tl-btn"
                            onClick={() => navigator.clipboard.writeText(fixPrompt(words, hint)).then(() => setMsg('Prompt copied. Paste it into a new Claude chat.')).catch(() => setMsg('Copying failed.'))}
                        >
                            Copy prompt
                        </button>
                        <span className="text-muted">2. Paste it into a new chat at claude.ai and send. 3. Paste the answer below.</span>
                    </div>
                    <textarea className="input h-20 font-mono text-xs" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder='[{"wrong":"label key","right":"Lambo key"}]' aria-label="Claude's fixes" />
                    <button
                        className="tl-btn self-start"
                        disabled={!answer.trim()}
                        onClick={() => {
                            try {
                                apply(parseFixes(answer));
                                setAnswer('');
                            } catch (e) {
                                setMsg((e as Error).message);
                            }
                        }}
                    >
                        Apply all fixes
                    </button>
                </div>
            )}
            {msg && <p className="text-xs text-accent">{msg}</p>}
        </div>
    );
}

function CaptionEditor({ text, onSave, onClose }: { text: string; onSave: (t: string) => void; onClose: () => void }) {
    const [value, setValue] = useState(text);
    return (
        <div className="panel flex flex-wrap items-center gap-2 p-3">
            <span className="text-sm font-semibold">Edit caption</span>
            <input
                autoFocus
                className="input min-w-0 grow text-sm"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        onSave(value);
                        onClose();
                    }
                    if (e.key === 'Escape') onClose();
                }}
            />
            <button className="btn-accent !py-2 text-sm" onClick={() => { onSave(value); onClose(); }}>Save</button>
            <button className="btn-ghost !py-2" onClick={onClose}>Cancel</button>
        </div>
    );
}

/** Drag a box over the facecam on a still frame of the video. */
function FacecamPicker({ video, facecam, onChange }: { video: HTMLVideoElement | null; facecam: { x: number; y: number; w: number; h: number }; onChange: (r: { x: number; y: number; w: number; h: number }) => void }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const boxRef = useRef<HTMLDivElement>(null);
    const drag = useRef<null | { mode: 'move' | 'size'; sx: number; sy: number; orig: typeof facecam }>(null);

    useEffect(() => {
        const draw = () => {
            const c = canvasRef.current;
            if (c && video && video.videoWidth) c.getContext('2d')!.drawImage(video, 0, 0, c.width, c.height);
        };
        draw();
        const id = setInterval(draw, 500);
        return () => clearInterval(id);
    }, [video]);

    const ar = video?.videoWidth ? video.videoWidth / video.videoHeight : 16 / 9;
    const onMove = (e: React.PointerEvent) => {
        const d = drag.current;
        const host = boxRef.current?.parentElement;
        if (!d || !host) return;
        const r = host.getBoundingClientRect();
        const dx = (e.clientX - d.sx) / r.width;
        const dy = (e.clientY - d.sy) / r.height;
        const o = d.orig;
        if (d.mode === 'move') onChange({ ...o, x: Math.min(1 - o.w, Math.max(0, o.x + dx)), y: Math.min(1 - o.h, Math.max(0, o.y + dy)) });
        else onChange({ ...o, w: Math.min(1 - o.x, Math.max(0.05, o.w + dx)), h: Math.min(1 - o.y, Math.max(0.05, o.h + dy)) });
    };
    const start = (mode: 'move' | 'size') => (e: React.PointerEvent) => {
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { mode, sx: e.clientX, sy: e.clientY, orig: facecam };
    };
    return (
        <div className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-muted">Drag the box over the facecam</span>
            <div className="relative w-full overflow-hidden rounded-lg bg-black" style={{ aspectRatio: String(ar) }} onPointerMove={onMove} onPointerUp={() => (drag.current = null)}>
                <canvas ref={canvasRef} width={480} height={Math.round(480 / ar)} className="absolute inset-0 h-full w-full" />
                <div
                    ref={boxRef}
                    onPointerDown={start('move')}
                    className="absolute cursor-move border-2 border-accent bg-accent/15"
                    style={{ left: `${facecam.x * 100}%`, top: `${facecam.y * 100}%`, width: `${facecam.w * 100}%`, height: `${facecam.h * 100}%` }}
                >
                    <span className="absolute top-0 left-0 bg-accent px-1 text-[10px] font-bold text-ink">FACECAM</span>
                    <span onPointerDown={start('size')} className="absolute -right-1.5 -bottom-1.5 size-4 cursor-nwse-resize rounded-sm bg-accent" />
                </div>
            </div>
        </div>
    );
}

/** Makes a cover image from a frame of the clip with big text. */
function ThumbnailMaker({ video, clip, style, events, onSeek }: { video: HTMLVideoElement | null; clip: Clip; style: StyleSettings; events: { start: number; type: string }[]; onSeek: (t: number) => void }) {
    const [format, setFormat] = useState<'16:9' | '9:16'>('16:9');
    const [text, setText] = useState(clip.title.toUpperCase());
    const [color, setColor] = useState(style.highlight);
    const [pos, setPos] = useState<'top' | 'bottom'>('bottom');
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const W = format === '16:9' ? 1280 : 1080;
    const H = format === '16:9' ? 720 : 1920;

    useEffect(() => {
        const draw = () => {
            const c = canvasRef.current;
            if (!c || !video) return;
            const ctx = c.getContext('2d')!;
            if (format === '9:16') drawVideoLayer(ctx, video, video.currentTime, clip, { ...style, aspect: '9:16' as Aspect });
            else {
                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, W, H);
                if (video.videoWidth) {
                    const s = Math.max(W / video.videoWidth, H / video.videoHeight);
                    ctx.drawImage(video, (W - video.videoWidth * s) / 2, (H - video.videoHeight * s) / 2, video.videoWidth * s, video.videoHeight * s);
                }
            }
            const g = ctx.createLinearGradient(0, pos === 'bottom' ? H * 0.45 : H * 0.55, 0, pos === 'bottom' ? H : 0);
            g.addColorStop(0, 'rgba(0,0,0,0)');
            g.addColorStop(1, 'rgba(0,0,0,0.75)');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, W, H);
            const size = format === '16:9' ? 96 : 120;
            ctx.font = `${size}px ${TITLE_FONT.css}, 'Arial Black', sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.lineJoin = 'round';
            const lines = wrap(ctx, text, W * 0.88).slice(0, 3);
            const lh = size * 1.08;
            const blockH = lines.length * lh;
            let y = pos === 'bottom' ? H - blockH - H * 0.06 + lh / 2 : H * 0.07 + lh / 2;
            lines.forEach((l, i) => {
                ctx.strokeStyle = '#000';
                ctx.lineWidth = size * 0.22;
                ctx.strokeText(l, W / 2, y);
                ctx.fillStyle = i === lines.length - 1 ? color : '#fff';
                ctx.fillText(l, W / 2, y);
                y += lh;
            });
            void roundRect;
        };
        draw();
        const id = setInterval(draw, 300);
        return () => clearInterval(id);
    }, [video, format, text, color, pos, clip, style]);

    const funniest = events.filter((e) => e.type === 'reaction' && e.start > clip.start && e.start < clip.end)[0];
    return (
        <>
            <div className="flex flex-wrap gap-2">
                <Segmented value={format} onChange={(v) => setFormat(v as '16:9' | '9:16')} items={[{ id: '16:9', label: 'Video thumbnail 16:9' }, { id: '9:16', label: 'Short cover 9:16' }]} />
            </div>
            <canvas ref={canvasRef} width={W} height={H} className="mx-auto w-full max-w-md rounded-lg border border-white/10" style={{ maxHeight: 420, width: 'auto', maxWidth: '100%' }} />
            <p className="text-xs text-muted">The picture uses the frame at the playhead. Move it in the timeline, or:</p>
            <div className="flex flex-wrap gap-2">
                {funniest && <button className="tl-btn" onClick={() => onSeek(Math.max(clip.start, funniest.start - 0.3))}>😂 Jump to the funniest frame</button>}
                <button className="tl-btn" onClick={() => onSeek(clip.start + (clip.end - clip.start) / 2)}>Middle of the clip</button>
            </div>
            <Field label="Text">
                <input className="input text-sm" value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
            <div className="flex flex-wrap items-center gap-3">
                <Segmented value={pos} onChange={(v) => setPos(v as 'top' | 'bottom')} items={[{ id: 'top', label: 'Text top' }, { id: 'bottom', label: 'Text bottom' }]} />
                <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="size-8 cursor-pointer bg-transparent" aria-label="Last line colour" />
            </div>
            <button
                className="btn-accent"
                onClick={() => canvasRef.current?.toBlob((b) => b && saveBlob(b, `${safeName(clip.title)} thumbnail.png`), 'image/png')}
            >
                Download thumbnail (PNG)
            </button>
        </>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-2">
            <span className="text-sm font-semibold text-muted">{label}</span>
            {children}
        </div>
    );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
    return (
        <label className="flex cursor-pointer items-start justify-between gap-3">
            <span className="min-w-0">
                <span className="block text-sm font-semibold">{label}</span>
                <span className="block truncate text-xs text-muted">{hint}</span>
            </span>
            <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-1 size-5 shrink-0 accent-[var(--color-accent)]" />
        </label>
    );
}

// ---------- optional effect panels ----------

function StickersPanel({
    clip,
    time,
    selection,
    setSelection,
    editClip,
    setClip
}: {
    clip: Clip;
    time: number;
    selection: Selection;
    setSelection: (s: Selection) => void;
    editClip: (p: Partial<Clip>) => void;
    setClip: (p: Partial<Clip>) => void;
}) {
    const list = clip.stickers ?? [];
    const update = (i: number, patch: Partial<NonNullable<Clip['stickers']>[number]>) => setClip({ stickers: list.map((s, k) => (k === i ? { ...s, ...patch } : s)) });
    return (
        <div className="flex flex-col gap-2 rounded-xl bg-white/[0.04] p-3">
            <div className="flex items-center justify-between gap-2">
                <span>
                    <span className="block text-sm font-semibold">Text stickers</span>
                    <span className="block text-xs text-muted">Text anywhere on the video. Drag it on the preview to move it.</span>
                </span>
                <button
                    className="tl-btn"
                    onClick={() => {
                        const st = { id: `st${Date.now().toString(36)}`, text: '😂 NO WAY', start: Math.max(clip.start, Math.min(time, clip.end - 1)), end: Math.min(clip.end, Math.max(clip.start, time) + 2.5), x: 0.5, y: 0.3, size: 0.07, color: '#ffffff', box: false };
                        editClip({ stickers: [...list, st] });
                        setSelection({ type: 'sticker', i: list.length });
                    }}
                >
                    + Add text
                </button>
            </div>
            {list.map((st, i) => (
                <div key={st.id} className={`flex flex-col gap-2 rounded-lg p-2 ${selection?.type === 'sticker' && selection.i === i ? 'bg-accent/10 ring-1 ring-accent' : 'bg-white/[0.03]'}`} onClick={() => setSelection({ type: 'sticker', i })}>
                    <div className="flex gap-2">
                        <input className="input min-w-0 flex-1 !py-1.5 text-sm" value={st.text} onChange={(e) => update(i, { text: e.target.value })} aria-label="Sticker text" />
                        <input type="color" value={st.color} onChange={(e) => update(i, { color: e.target.value })} className="size-8 cursor-pointer bg-transparent" aria-label="Sticker colour" />
                        <button className="tl-btn" onClick={(e) => { e.stopPropagation(); editClip({ stickers: list.filter((_, k) => k !== i) }); setSelection(null); }} aria-label="Delete sticker">🗑</button>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted">
                        <span>Size</span>
                        <input type="range" min={0.03} max={0.16} step={0.005} value={st.size} onChange={(e) => update(i, { size: +e.target.value })} className="flex-1 accent-[var(--color-accent)]" />
                        <label className="flex items-center gap-1"><input type="checkbox" checked={st.box} onChange={(e) => update(i, { box: e.target.checked })} className="accent-[var(--color-accent)]" /> White box</label>
                    </div>
                </div>
            ))}
        </div>
    );
}

function MusicPanel({ project, onChange }: { project: Project; onChange: (p: Project) => void }) {
    const m = project.music;
    return (
        <div className="flex flex-col gap-2 rounded-xl bg-white/[0.04] p-3">
            <div className="flex items-center justify-between gap-2">
                <span>
                    <span className="block text-sm font-semibold">Background music</span>
                    <span className="block text-xs text-muted">Use your own music file (all clips in this project). Only use music you have the rights to.</span>
                </span>
                <label className="tl-btn cursor-pointer">
                    {m ? 'Change' : '+ Add music'}
                    <input
                        type="file"
                        accept="audio/*"
                        className="sr-only"
                        onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) onChange({ ...project, music: { name: f.name, blob: f, volume: m?.volume ?? 0.25, duck: m?.duck ?? true } });
                        }}
                    />
                </label>
            </div>
            {m && (
                <>
                    <p className="truncate text-xs">🎵 {m.name}</p>
                    <div className="flex items-center gap-3 text-xs text-muted">
                        <span>Volume</span>
                        <input type="range" min={0.05} max={1} step={0.05} value={m.volume} onChange={(e) => onChange({ ...project, music: { ...m, volume: +e.target.value } })} className="flex-1 accent-[var(--color-accent)]" />
                        <span className="w-8 tabular-nums">{Math.round(m.volume * 100)}%</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                        <label className="flex items-center gap-2"><input type="checkbox" checked={m.duck} onChange={(e) => onChange({ ...project, music: { ...m, duck: e.target.checked } })} className="accent-[var(--color-accent)]" /> Quieter while people talk</label>
                        <button className="text-muted hover:text-red-300" onClick={() => onChange({ ...project, music: undefined })}>Remove</button>
                    </div>
                </>
            )}
        </div>
    );
}

function PresetsPanel({ project, clip, events, words, onChange }: { project: Project; clip: Clip; events: Parameters<typeof autoSfx>[1]; words: Word[]; onChange: (p: Project) => void }) {
    const [presets, setPresets] = useState<Preset[]>(() => loadPresets());
    const [name, setName] = useState('');
    const [msg, setMsg] = useState('');
    const flash = (m: string) => {
        setMsg(m);
        setTimeout(() => setMsg(''), 2500);
    };
    return (
        <div className="flex flex-col gap-2 rounded-xl border border-accent/30 bg-accent/5 p-3">
            <p className="text-sm font-semibold">Apply to every clip</p>
            <button
                className="tl-btn self-start"
                onClick={() => {
                    const fx = currentFx(clip);
                    onChange({ ...project, clips: project.clips.map((c) => (c.id === clip.id ? c : applyFx(c, fx, events, words))) });
                    flash(`Applied this clip's effects to ${project.clips.length - 1} other clip${project.clips.length === 2 ? '' : 's'}.`);
                }}
            >
                ✨ Use this clip’s effects on all clips
            </button>
            <p className="text-xs text-muted">Copies which effects are switched on (title, freeze, sound effects, shakes, replay, zooms on laughs, jump cuts). Each clip gets its own auto-placed version.</p>
            <p className="mt-1 text-sm font-semibold">Presets</p>
            <div className="flex gap-2">
                <input className="input min-w-0 flex-1 !py-1.5 text-sm" placeholder="Name, e.g. My gaming style" value={name} onChange={(e) => setName(e.target.value)} />
                <button
                    className="tl-btn"
                    disabled={!name.trim()}
                    onClick={() => {
                        const next = [...presets.filter((p) => p.name !== name.trim()), { name: name.trim(), style: project.style, fx: currentFx(clip) }];
                        setPresets(next);
                        savePresets(next);
                        setName('');
                        flash('Preset saved.');
                    }}
                >
                    Save look
                </button>
            </div>
            {presets.map((p) => (
                <div key={p.name} className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    <button
                        className="tl-btn"
                        onClick={() => {
                            onChange({ ...project, style: { ...project.style, ...p.style, facecam: project.style.facecam ?? p.style.facecam }, clips: project.clips.map((c) => applyFx(c, p.fx, events, words)) });
                            flash(`Applied “${p.name}” to all clips.`);
                        }}
                    >
                        Apply to all clips
                    </button>
                    <button
                        className="text-xs text-muted hover:text-red-300"
                        onClick={() => {
                            const next = presets.filter((x) => x.name !== p.name);
                            setPresets(next);
                            savePresets(next);
                        }}
                    >
                        Delete
                    </button>
                </div>
            ))}
            {msg && <p className="text-xs text-accent">{msg}</p>}
        </div>
    );
}

/** Translated captions via a free Claude chat. */
function TranslatePanel({ clip, groups, style, setStyle, setClip }: { clip: Clip; groups: { text: string; start: number; end: number }[][]; style: StyleSettings; setStyle: (p: Partial<StyleSettings>) => void; setClip: (p: Partial<Clip>) => void }) {
    const [lang, setLang] = useState(clip.translation?.language ?? 'Spanish');
    const [answer, setAnswer] = useState('');
    const [msg, setMsg] = useState('');
    const [open, setOpen] = useState(!!clip.translation);
    const times = groups.map((g, i) => ({ start: g[0].start, end: groups[i + 1] ? Math.min(groups[i + 1][0].start, g[g.length - 1].end + 0.6) : g[g.length - 1].end + 0.4 }));
    const lines = groups.map((g) => g.map((w) => w.text).join(' '));
    const prompt = `Translate these video captions into ${lang}. Keep the meaning, slang and jokes natural for viewers who speak ${lang}, and keep each line short like the original. There are ${lines.length} lines; reply with ONLY a JSON array of exactly ${lines.length} strings, in the same order.\n\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}`;
    return (
        <div className="flex flex-col gap-2 rounded-xl bg-white/[0.04] p-3">
            <button className="flex items-center justify-between text-left" onClick={() => setOpen(!open)}>
                <span>
                    <span className="block text-sm font-semibold">Translated captions</span>
                    <span className="block text-xs text-muted">{clip.translation ? `${clip.translation.language} captions added` : 'Reach viewers in other languages (free, via Claude chat)'}</span>
                </span>
                <span className="text-muted">{open ? '▾' : '▸'}</span>
            </button>
            {open && (
                <>
                    {clip.translation && (
                        <Segmented value={style.captionLang ?? 'original'} onChange={(v) => setStyle({ captionLang: v as StyleSettings['captionLang'] })} items={[{ id: 'original', label: 'Original' }, { id: 'translated', label: clip.translation.language }, { id: 'both', label: 'Both' }]} />
                    )}
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                        <input className="input !w-36 !py-1.5 text-sm" value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Language" />
                        <button className="tl-btn" onClick={() => navigator.clipboard.writeText(prompt).then(() => setMsg('Prompt copied. Paste it into a new Claude chat.')).catch(() => setMsg('Copying failed.'))}>
                            1. Copy prompt
                        </button>
                        <span className="text-muted">2. Paste into claude.ai · 3. Paste the answer:</span>
                    </div>
                    <textarea className="input h-16 font-mono text-xs" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder='["...", "..."]' aria-label="Translated lines" />
                    <div className="flex gap-2">
                        <button
                            className="tl-btn"
                            disabled={!answer.trim()}
                            onClick={() => {
                                try {
                                    const a = answer.indexOf('[');
                                    const b = answer.lastIndexOf(']');
                                    const arr = JSON.parse(answer.slice(a, b + 1)) as unknown[];
                                    if (!Array.isArray(arr) || !arr.length) throw new Error();
                                    setClip({ translation: { language: lang, lines: times.map((t, i) => ({ ...t, text: String(arr[i] ?? '') })).filter((l) => l.text.trim()) } });
                                    setStyle({ captionLang: style.captionLang && style.captionLang !== 'original' ? style.captionLang : 'both' });
                                    setAnswer('');
                                    setMsg(arr.length === lines.length ? 'Translation added.' : `Added, but Claude returned ${arr.length} lines for ${lines.length}; check the timing.`);
                                } catch {
                                    setMsg('That answer could not be read. Copy Claude’s whole answer including [ and ].');
                                }
                            }}
                        >
                            Add translation
                        </button>
                        {clip.translation && <button className="text-xs text-muted hover:text-red-300" onClick={() => setClip({ translation: undefined })}>Remove</button>}
                    </div>
                    {msg && <p className="text-xs text-accent">{msg}</p>}
                </>
            )}
        </div>
    );
}

/** Ask a free Claude chat to improve this one clip (trim points, title, hook, hashtags). */
function ImprovePanel({ clip, words, setClip }: { clip: Clip; words: Word[]; setClip: (p: Partial<Clip>) => void }) {
    const [answer, setAnswer] = useState('');
    const [msg, setMsg] = useState('');
    const ctx = words.filter((w) => w.end > clip.start - 30 && w.start < clip.end + 15);
    const lines: string[] = [];
    for (let i = 0; i < ctx.length; i += 10) {
        const part = ctx.slice(i, i + 10);
        lines.push(`[${part[0].start.toFixed(1)}] ${part.map((w) => w.text).join(' ')}`);
    }
    const prompt = `You are a top short-form video editor. Improve this clip for YouTube Shorts / TikTok so a stranger watches it to the end and laughs or shares it.

Current clip: ${clip.start.toFixed(1)}s to ${clip.end.toFixed(1)}s, title "${clip.title}".

Transcript around it (times in seconds):
${lines.join('\n')}

Pick the best start and end (start right at the hook or setup, end right after the payoff or laugh), and write a better title, the hook line, a short description, hashtags, 3-6 keywords (single spoken words), 2-4 emoji tied to spoken words, and 3 alternative titles.
Reply with ONLY a JSON object like:
{"start":12.3,"end":41.0,"title":"...","hook":"...","description":"...","hashtags":["..."],"keywords":["..."],"emojis":[{"word":"...","emoji":"😂"}],"altTitles":["...","...","..."]}`;
    return (
        <div className="flex flex-col gap-2 rounded-xl border border-accent/30 bg-accent/5 p-3">
            <p className="text-sm font-semibold">Improve this clip with Claude (free)</p>
            <p className="text-xs text-muted">Better trim points, title, hook and hashtags for just this clip.</p>
            <div className="flex flex-wrap items-center gap-2 text-xs">
                <button className="tl-btn" onClick={() => navigator.clipboard.writeText(prompt).then(() => setMsg('Prompt copied. Paste it into a new Claude chat.')).catch(() => setMsg('Copying failed.'))}>1. Copy prompt</button>
                <span className="text-muted">2. Paste into claude.ai · 3. Paste the answer:</span>
            </div>
            <textarea className="input h-16 font-mono text-xs" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder='{"start": 12.3, "end": 41.0, "title": "..."}' aria-label="Claude's suggestion" />
            <button
                className="tl-btn self-start"
                disabled={!answer.trim()}
                onClick={() => {
                    try {
                        const o = JSON.parse(answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1));
                        const patch: Partial<Clip> = {};
                        if (typeof o.start === 'number' && typeof o.end === 'number' && o.end - o.start >= 3) {
                            patch.start = Math.max(0, o.start);
                            patch.end = o.end;
                        }
                        for (const k of ['title', 'hook', 'description'] as const) if (typeof o[k] === 'string') patch[k] = o[k];
                        for (const k of ['hashtags', 'keywords', 'altTitles'] as const) if (Array.isArray(o[k])) patch[k] = o[k].map(String);
                        if (Array.isArray(o.emojis)) patch.emojis = o.emojis.filter((e: any) => e?.word && e?.emoji).map((e: any) => ({ word: String(e.word), emoji: String(e.emoji) }));
                        setClip(patch);
                        setAnswer('');
                        setMsg('Clip improved.');
                    } catch {
                        setMsg('That answer could not be read. Copy Claude’s whole answer including { and }.');
                    }
                }}
            >
                Apply
            </button>
            {msg && <p className="text-xs text-accent">{msg}</p>}
        </div>
    );
}

/** Layout settings for the parts selected on V1 of the timeline. */
function PartInspector({ clip, style, selection, editClip, setClip }: { clip: Clip; style: StyleSettings; selection: Selection; editClip: (p: Partial<Clip>) => void; setClip: (p: Partial<Clip>) => void }) {
    const segs = segmentsOf(clip);
    const ids = selection?.type === 'segs' ? selection.ids : [];
    const sel = segs.filter((s) => ids.includes(s.id));
    if (!sel.length)
        return (
            <div className="ed-card ed-hint">
                <Layers size={16} className="shrink-0 text-accent" />
                <p>
                    <b>Different layout for each moment:</b> cut the video with <kbd>C</kbd> (razor) or <kbd>Ctrl+K</kbd>, then click a part on the <b>V1</b> track to give it its own layout, like facecam + gameplay for one moment and full screen for the next.
                </p>
            </div>
        );
    const first = sel[0];
    const same = sel.every((s) => s.layout === first.layout);
    const current = same ? first.layout ?? 'default' : '';
    const effective = same ? first.layout ?? style.layout : null;
    const crop = first.cropX ?? style.cropX;
    const update = (patch: (s: (typeof segs)[number]) => (typeof segs)[number], undoable = true) => {
        const next = withSegs(clip, segs.map((s) => (ids.includes(s.id) ? patch(s) : s)));
        undoable ? editClip(next) : setClip(next);
    };
    const len = sel.reduce((a, s) => a + s.end - s.start, 0);
    return (
        <div className="ed-card ed-card-accent">
            <div className="flex items-center justify-between">
                <p className="flex items-center gap-2 text-sm font-semibold">
                    <Layers size={15} className="text-accent" />
                    {sel.length > 1 ? `Layout for ${sel.length} selected parts` : `Layout for part ${segs.indexOf(first) + 1} only`}
                </p>
                <span className="font-mono text-xs text-white/45">{len.toFixed(1)}s</span>
            </div>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {LAYOUTS.map((l) => (
                    <button key={l.id} className={`ed-choice ${current === l.id ? 'ed-choice-on' : ''}`} onClick={() => update((s) => ({ ...s, layout: l.id === 'default' ? undefined : l.id }))}>
                        <LayoutGlyph id={l.id === 'default' ? style.layout : l.id} />
                        <span>
                            {l.label}
                            {l.id === 'default' && <small className="block text-white/40">now: {LAYOUTS.find((x) => x.id === style.layout)?.label}</small>}
                        </span>
                    </button>
                ))}
            </div>
            {(effective === 'split' || effective === 'manual' || effective === 'pip') && (
                <Field label={effective === 'manual' ? 'Position for this part' : 'Gameplay position for this part'}>
                    <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={crop}
                        onPointerDown={() => update((s) => s)}
                        onChange={(e) => update((s) => ({ ...s, cropX: +e.target.value }), false)}
                        className="w-full accent-[var(--color-accent)]"
                    />
                </Field>
            )}
            {(effective === 'split' || effective === 'pip') && !style.facecam && <p className="text-xs text-amber-200">Set the facecam box below so this part knows where your face is.</p>}
            <p className="text-xs text-white/45">Tip: shift-click parts to select several. Right-click a part for the same options.</p>
        </div>
    );
}

function LayoutGlyph({ id }: { id: Layout | 'default' }) {
    return (
        <span className="ed-glyph" aria-hidden>
            {id === 'pip' ? (
                <span className="relative block h-full w-full bg-white/35">
                    <i className="absolute top-0.5 left-0.5 size-2 rounded-full bg-accent" />
                </span>
            ) : id === 'split' ? (
                <>
                    <i style={{ height: '40%' }} className="bg-accent/70" />
                    <i style={{ height: '60%' }} className="bg-white/35" />
                </>
            ) : id === 'fit' ? (
                <>
                    <i style={{ height: '30%' }} className="bg-white/10" />
                    <i style={{ height: '40%' }} className="bg-white/45" />
                    <i style={{ height: '30%' }} className="bg-white/10" />
                </>
            ) : (
                <i style={{ height: '100%' }} className={id === 'auto' ? 'bg-sky-300/50' : 'bg-white/45'} />
            )}
        </span>
    );
}

/** Plain transcript of the clip's kept parts, a new paragraph after each long pause. */
function transcriptText(words: Word[], clip: Clip): string {
    const segs = segmentsOf(clip);
    const kept = words.filter((w) => segs.some((s) => w.start >= s.start - 0.05 && w.start < s.end));
    let out = '';
    kept.forEach((w, i) => {
        const gap = i > 0 ? w.start - kept[i - 1].end : 0;
        out += i === 0 ? w.text.trim() : (gap > 1.5 ? '\n\n' : ' ') + w.text.trim();
    });
    return out + '\n';
}

function PipSettingsPanel({ style, setStyle }: { style: StyleSettings; setStyle: (p: Partial<StyleSettings>) => void }) {
    const pp = style.pip ?? PIP_DEFAULT;
    const set = (patch: Partial<typeof pp>) => setStyle({ pip: { ...pp, ...patch } });
    return (
        <div className="ed-card">
            <p className="text-sm font-semibold">Facecam bubble (PiP)</p>
            <Field label="Corner">
                <Segmented value={pp.corner} onChange={(v) => set({ corner: v as typeof pp.corner })} items={[{ id: 'tl', label: '↖ Top left' }, { id: 'tr', label: '↗ Top right' }, { id: 'bl', label: '↙ Bottom left' }, { id: 'br', label: '↘ Bottom right' }]} />
            </Field>
            <Field label="Shape">
                <Segmented value={pp.shape} onChange={(v) => set({ shape: v as typeof pp.shape })} items={[{ id: 'circle', label: '● Circle' }, { id: 'rounded', label: '▢ Rounded' }]} />
            </Field>
            <Field label={`Size: ${Math.round(pp.size * 100)}% of the width`}>
                <input type="range" min={0.2} max={0.55} step={0.01} value={pp.size} onChange={(e) => set({ size: +e.target.value })} className="w-full accent-[var(--color-accent)]" />
            </Field>
        </div>
    );
}
