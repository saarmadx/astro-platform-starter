import { useEffect, useMemo, useRef, useState } from 'react';
import { findAudioEvents } from '../lib/audio';
import { bleepSpans } from '../lib/censor';
import { buildSrt, displayWords, groupWords } from '../lib/captions';
import { drawScene, drawVideoLayer, roundRect, wrap } from '../lib/draw';
import { analyseClip, detectFacecam } from '../lib/faces';
import { outputSize } from '../lib/geometry';
import { DEFAULT_SPEAKER_COLORS, TEMPLATES, TITLE_FONT } from '../lib/templates';
import { mergeSpans, outputDuration, silenceCuts, skipCut, toOutputClamped } from '../lib/timeline';
import { titleIdeas } from '../lib/titles';
import { fixPrompt, parseFixes, replacePhrase } from '../lib/fixwords';
import type { Aspect, Brand, CaptionPosition, Clip, Layout, Project, StyleSettings, Word } from '../lib/types';
import { renderClip } from '../lib/video';
import { Segmented } from './Home';
import { safeName, saveBlob } from './ProjectView';
import type { LoadedVideo } from './Studio';
import Timeline, { type Selection } from './Timeline';
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
const TABS: { id: Tab; label: string }[] = [
    { id: 'captions', label: 'Captions' },
    { id: 'layout', label: 'Layout' },
    { id: 'effects', label: 'Effects' },
    { id: 'post', label: 'Post' },
    { id: 'thumbnail', label: 'Thumbnail' },
    { id: 'export', label: 'Export' }
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
        [words, clip?.start, clip?.end, clip?.cuts, clip?.keywords, style, project.speakers]
    );
    const events = useMemo(() => (project.transcript ? findAudioEvents(project.transcript.energy, project.transcript.words) : []), [project.transcript]);
    const bleeps = useMemo(() => (style.censor === 'bleep' && clip ? bleepSpans(words.filter((w) => w.end > clip.start && w.start < clip.end)) : []), [style.censor, words, clip?.start, clip?.end]);
    const preview = outputSize(style.aspect, 540);

    // ---------- preview loop: skip cuts, loop, hold the freeze ending ----------
    const sceneRef = useRef({ clip, style, brand, groups });
    sceneRef.current = { clip, style, brand, groups };
    useEffect(() => {
        let raf = 0;
        const loop = () => {
            const v = videoRef.current;
            const c = canvasRef.current;
            const s = sceneRef.current;
            if (v && c && s.clip) {
                let freezing: number | null = null;
                if (freezeRef.current !== null) {
                    const fz = s.clip.freeze?.seconds ?? 0;
                    const prog = (performance.now() - freezeRef.current) / 1000 / Math.max(0.1, fz);
                    if (prog >= 1) {
                        freezeRef.current = null;
                        v.currentTime = s.clip.start;
                        v.play().catch(() => {});
                    } else freezing = prog;
                } else if (!v.paused) {
                    const skip = skipCut(s.clip, v.currentTime);
                    if (skip !== v.currentTime) v.currentTime = skip;
                    if (v.currentTime >= s.clip.end || v.currentTime < s.clip.start - 0.5) {
                        if (s.clip.freeze && s.clip.freeze.seconds > 0 && v.currentTime >= s.clip.end) {
                            v.pause();
                            freezeRef.current = performance.now();
                            freezing = 0;
                        } else v.currentTime = s.clip.start;
                    }
                }
                const ctx = c.getContext('2d');
                if (ctx) drawScene(ctx, v, v.currentTime, { clip: s.clip, style: s.style, brand: s.brand, groups: s.groups, logo: logoRef.current, freezing });
                setTime(v.currentTime);
            }
            raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(raf);
    }, []);

    useEffect(() => {
        const v = videoRef.current;
        if (v && clip) v.currentTime = clip.start;
        setSelection(null);
        history.current = [];
        setHistoryLen(0);
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
            const step = Math.max(1, (to - from) / 30);
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
                if (out.length % 6 === 0 && !cancelled) setThumbs([...out]);
            }
            if (!cancelled) setThumbs(out);
            v.removeAttribute('src');
            v.load();
        })();
        return () => {
            cancelled = true;
        };
    }, [clip?.id, video?.url]);

    if (!clip) return <p className="text-muted">This clip no longer exists.</p>;

    // ---------- updates ----------
    const setStyle = (patch: Partial<StyleSettings>) => onChange({ ...project, style: { ...style, ...patch } });
    const setClip = (patch: Partial<Clip>) => onChange({ ...project, clips: project.clips.map((c) => (c.id === clip.id ? { ...c, ...patch } : c)) });
    const editClip = (patch: Partial<Clip>) => {
        history.current = [...history.current.slice(-49), clip];
        setHistoryLen(history.current.length);
        setClip(patch);
    };
    const undo = () => {
        const prev = history.current.pop();
        setHistoryLen(history.current.length);
        if (prev) onChange({ ...project, clips: project.clips.map((c) => (c.id === clip.id ? prev : c)) });
    };

    function seek(t: number) {
        const v = videoRef.current;
        freezeRef.current = null;
        if (v) v.currentTime = Math.max(0, Math.min(project.duration, t));
    }
    function togglePlay() {
        const v = videoRef.current;
        if (!v) return;
        if (v.paused) {
            if (v.currentTime >= clip.end || v.currentTime < clip.start) v.currentTime = clip.start;
            v.play().catch(() => {});
        } else v.pause();
    }

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
        onChange({ ...project, transcript: { ...project.transcript, words: all } });
    }

    function removeSilences() {
        const found = silenceCuts(clip, words);
        if (!found.length) {
            setBusy('No pauses long enough to remove.');
            setTimeout(() => setBusy(''), 2000);
            return;
        }
        editClip({ cuts: mergeSpans([...(clip.cuts ?? []), ...found]) });
        setBusy(`Removed ${found.length} pause${found.length > 1 ? 's' : ''}.`);
        setTimeout(() => setBusy(''), 2500);
    }

    function setSpeakerHere(speaker: number) {
        const list = [...(project.speakers ?? []).filter((s) => Math.abs(s.t - time) > 0.05), { t: time, speaker }].sort((a, b) => a.t - b.t);
        onChange({ ...project, speakers: list });
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
            const blob = await renderClip({ file: video.file, clip, words, style, brand, quality, videoWidth: project.width, videoHeight: project.height, speakers: project.speakers, onProgress: setRendering });
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
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 grow items-center gap-3">
                    <button className="btn-ghost !px-3" onClick={onBack} aria-label="Back to all clips">←</button>
                    <span className={`rounded-lg px-2 py-1 text-sm font-extrabold ${scoreTone(clip.score)}`}>{clip.score}</span>
                    {clip.category && <span className="hidden rounded-lg bg-white/10 px-2 py-1 text-xs font-semibold sm:inline">{clip.category}</span>}
                    <input className="min-w-0 grow bg-transparent text-lg font-bold outline-none focus:underline" value={clip.title} onChange={(e) => setClip({ title: e.target.value })} aria-label="Clip title" />
                </div>
                <div className="flex gap-2">
                    <button className="btn-ghost" disabled={idx <= 0} onClick={() => onSelectClip(ordered[idx - 1].id)}>Previous</button>
                    <button className="btn-ghost" disabled={idx >= ordered.length - 1} onClick={() => onSelectClip(ordered[idx + 1].id)}>Next clip</button>
                </div>
            </div>

            {!video && (
                <label className="panel flex cursor-pointer flex-wrap items-center justify-between gap-3 p-4">
                    <span className="text-sm">
                        Select the original video to preview and export: <b className="break-all">{project.fileName}</b>
                        {attachError && <span className="block text-red-300">{attachError}</span>}
                    </span>
                    <span className="btn-ghost">Select video</span>
                    <input type="file" accept="video/*,.mkv" className="sr-only" onChange={(e) => e.target.files?.[0] && onAttach(e.target.files[0])} />
                </label>
            )}

            <div className="grid gap-5 lg:grid-cols-[auto_minmax(0,1fr)]">
                {/* preview */}
                <section className="flex flex-col items-center gap-2">
                    <div
                        className="relative overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl"
                        style={{ width: style.aspect === '16:9' ? 'min(520px, 92vw)' : style.aspect === '1:1' ? 'min(400px, 92vw)' : 'min(300px, 78vw)' }}
                    >
                        <canvas ref={canvasRef} width={preview.W} height={preview.H} className="block h-auto w-full" onClick={togglePlay} />
                        {!playing && video && freezeRef.current === null && (
                            <button className="absolute inset-0 grid place-items-center bg-black/10" onClick={togglePlay} aria-label="Play">
                                <span className="grid size-14 place-items-center rounded-full bg-white/90 pl-1 text-xl text-ink">▶</span>
                            </button>
                        )}
                        <video ref={videoRef} src={video?.url} playsInline preload="auto" className="pointer-events-none fixed top-0 left-0 size-px opacity-0" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
                    </div>
                    {busy && <p className="text-xs text-muted">{busy}</p>}
                </section>

                {/* settings */}
                <section className="panel flex min-w-0 flex-col overflow-hidden">
                    <div className="flex overflow-x-auto border-b border-white/10 text-sm">
                        {TABS.map((t) => (
                            <button key={t.id} onClick={() => setTab(t.id)} className={`shrink-0 px-4 py-3 font-semibold ${tab === t.id ? 'border-b-2 border-accent text-white' : 'text-muted hover:text-white'}`}>
                                {t.label}
                            </button>
                        ))}
                    </div>
                    <div className="flex max-h-[62vh] flex-col gap-5 overflow-y-auto p-4">
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
                                            <button className="text-xs text-muted hover:text-red-300" onClick={() => onChange({ ...project, speakers: [] })}>
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
                                <Field label="Aspect ratio">
                                    <Segmented value={style.aspect} onChange={(v) => setStyle({ aspect: v as Aspect })} items={[{ id: '9:16', label: '9:16' }, { id: '1:1', label: '1:1' }, { id: '16:9', label: '16:9' }]} />
                                </Field>
                                <Field label="Layout">
                                    <Segmented
                                        value={style.layout}
                                        onChange={(v) => setStyle({ layout: v as Layout })}
                                        items={[{ id: 'auto', label: 'Follow speaker' }, { id: 'split', label: 'Facecam + gameplay' }, { id: 'manual', label: 'Manual' }, { id: 'fit', label: 'Fit + blur' }]}
                                    />
                                </Field>
                                {style.layout === 'auto' && (
                                    <div className="flex flex-col gap-2 text-sm">
                                        <p className="text-muted">{clip.track ? 'The frame follows the main speaker’s face.' : 'No face was found in this clip yet, so it stays centred.'}</p>
                                        <button className="btn-ghost" disabled={!video} onClick={reframe}>Re-detect speaker</button>
                                    </div>
                                )}
                                {style.layout === 'split' && (
                                    <>
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
                                    <p className="text-xs text-muted">Removes pauses between words so the clip moves faster. Cut parts show striped in the timeline; select one and press Restore to undo.</p>
                                    <div className="flex gap-2">
                                        <button className="tl-btn" onClick={removeSilences}>⏩ Remove silences</button>
                                        {(clip.cuts?.length ?? 0) > 0 && <button className="tl-btn" onClick={() => editClip({ cuts: [], splits: [] })}>Restore everything</button>}
                                    </div>
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
                                    {(clip.cuts?.length ?? 0) > 0 ? ` (${(clip.end - clip.start - outLen).toFixed(1)}s cut out)` : ''}
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
                                <p className="text-xs text-muted">Rendering runs on your device. 720p takes about a minute per clip; effects and 1080p take longer.</p>
                            </>
                        )}
                    </div>
                </section>
            </div>

            <Timeline
                clip={clip}
                duration={project.duration}
                time={time}
                playing={playing}
                groups={groups}
                energy={project.transcript?.energy}
                events={events}
                bleeps={bleeps}
                thumbs={thumbs}
                selection={selection}
                setSelection={setSelection}
                onSeek={seek}
                onTogglePlay={togglePlay}
                onChange={editClip}
                onUndo={undo}
                canUndo={historyLen > 0}
                onRemoveSilences={removeSilences}
                outputTime={outNow}
                outputLength={outLen}
            />

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
