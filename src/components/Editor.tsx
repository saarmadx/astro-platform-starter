import { useEffect, useMemo, useRef, useState } from 'react';
import { buildSrt, groupWords, wordsInRange } from '../lib/captions';
import { drawScene } from '../lib/draw';
import { analyseClip } from '../lib/faces';
import { outputSize } from '../lib/geometry';
import { TEMPLATES } from '../lib/templates';
import type { Aspect, Brand, CaptionPosition, Clip, Layout, Project, StyleSettings } from '../lib/types';
import { renderClip } from '../lib/video';
import { Segmented } from './Home';
import { safeName, saveBlob } from './ProjectView';
import type { LoadedVideo } from './Studio';
import { Bar, fmt, scoreTone, TemplateSwatch } from './ui';

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

type Tab = 'captions' | 'layout' | 'text' | 'export';

export default function Editor({ project, clipId, video, brand, onChange, onBack, onSelectClip, onAttach, attachError }: Props) {
    const ordered = useMemo(() => [...project.clips].sort((a, b) => b.score - a.score), [project.clips]);
    const clip = project.clips.find((c) => c.id === clipId) ?? ordered[0];
    const idx = ordered.findIndex((c) => c.id === clip?.id);
    const style = project.style;
    const words = project.transcript?.words ?? [];

    const [tab, setTab] = useState<Tab>('captions');
    const [time, setTime] = useState(clip?.start ?? 0);
    const [playing, setPlaying] = useState(false);
    const [selectedWord, setSelectedWord] = useState<number | null>(null);
    const [editing, setEditing] = useState<{ index: number; text: string } | null>(null);
    const [quality, setQuality] = useState<720 | 1080>(720);
    const [rendering, setRendering] = useState<number | null>(null);
    const [renderError, setRenderError] = useState('');
    const [reframing, setReframing] = useState(false);
    const [copied, setCopied] = useState(false);

    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const logoRef = useRef<HTMLImageElement | null>(null);

    useEffect(() => {
        if (!brand.logo) {
            logoRef.current = null;
            return;
        }
        const img = new Image();
        img.src = brand.logo;
        logoRef.current = img;
    }, [brand.logo]);

    const groups = useMemo(() => (clip ? groupWords(wordsInRange(words, clip.start, clip.end), style.wordsPerLine) : []), [words, clip?.start, clip?.end, style.wordsPerLine]);
    const preview = outputSize(style.aspect, 540);

    // keep the playhead inside the clip and redraw every frame
    const sceneRef = useRef({ clip, style, brand, groups });
    sceneRef.current = { clip, style, brand, groups };
    useEffect(() => {
        let raf = 0;
        const loop = () => {
            const v = videoRef.current;
            const c = canvasRef.current;
            const s = sceneRef.current;
            if (v && c && s.clip) {
                if (!v.paused && (v.currentTime >= s.clip.end || v.currentTime < s.clip.start - 0.5)) v.currentTime = s.clip.start;
                const ctx = c.getContext('2d');
                if (ctx) drawScene(ctx, v, v.currentTime, { clip: s.clip, style: s.style, brand: s.brand, groups: s.groups, logo: logoRef.current });
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
        setSelectedWord(null);
    }, [clip?.id, video?.url]);

    if (!clip) return <p className="text-muted">This clip no longer exists.</p>;

    const setStyle = (patch: Partial<StyleSettings>) => onChange({ ...project, style: { ...style, ...patch } });
    const setClip = (patch: Partial<Clip>) => onChange({ ...project, clips: project.clips.map((c) => (c.id === clip.id ? { ...c, ...patch } : c)) });

    function seek(t: number) {
        const v = videoRef.current;
        if (v) v.currentTime = t;
    }
    function togglePlay() {
        const v = videoRef.current;
        if (!v) return;
        if (v.paused) v.play().catch(() => {});
        else v.pause();
    }

    function setStart(t: number) {
        setClip({ start: Math.max(0, Math.min(t, clip.end - 3)) });
        seek(Math.max(0, Math.min(t, clip.end - 3)));
    }
    function setEnd(t: number) {
        setClip({ end: Math.min(project.duration, Math.max(t, clip.start + 3)) });
    }

    function saveWord() {
        if (!editing || !project.transcript) return;
        const text = editing.text.trim();
        const next = [...project.transcript.words];
        if (text) next[editing.index] = { ...next[editing.index], text };
        else next.splice(editing.index, 1);
        onChange({ ...project, transcript: { ...project.transcript, words: next } });
        setEditing(null);
        setSelectedWord(null);
    }

    async function reframe() {
        if (!video) return;
        setReframing(true);
        try {
            const res = await analyseClip(video.url, clip.start, clip.end, style.aspect);
            setClip({ track: res.track, thumb: res.thumb });
        } finally {
            setReframing(false);
        }
    }

    async function exportClip() {
        if (!video) return;
        setRenderError('');
        setRendering(0);
        try {
            const blob = await renderClip({ file: video.file, clip, words, style, brand, quality, videoWidth: project.width, videoHeight: project.height, onProgress: setRendering });
            saveBlob(blob, `${safeName(clip.title)}.mp4`);
        } catch (e) {
            setRenderError((e as Error).message);
        } finally {
            setRendering(null);
        }
    }

    const tags = clip.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ');
    const uploadText = `${clip.title}\n\n${clip.description}\n\n${tags}`;

    // transcript window: a little context either side of the clip
    const ctxStart = Math.max(0, clip.start - 8);
    const ctxEnd = Math.min(project.duration, clip.end + 8);
    const transcriptWords = words.map((w, i) => ({ w, i })).filter(({ w }) => w.end > ctxStart && w.start < ctxEnd);

    const winStart = Math.max(0, clip.start - 15);
    const winEnd = Math.min(project.duration, clip.end + 15);
    const pct = (t: number) => `${((t - winStart) / (winEnd - winStart)) * 100}%`;

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                    <button className="btn-ghost !px-3" onClick={onBack} aria-label="Back to all clips">
                        ←
                    </button>
                    <span className={`rounded-lg px-2 py-1 text-sm font-extrabold ${scoreTone(clip.score)}`}>{clip.score}</span>
                    {clip.category && <span className="hidden rounded-lg bg-white/10 px-2 py-1 text-xs font-semibold sm:inline">{clip.category}</span>}
                    <input className="min-w-0 grow bg-transparent text-lg font-bold outline-none focus:underline" value={clip.title} onChange={(e) => setClip({ title: e.target.value })} aria-label="Clip title" />
                </div>
                <div className="flex gap-2">
                    <button className="btn-ghost" disabled={idx <= 0} onClick={() => onSelectClip(ordered[idx - 1].id)}>
                        Previous
                    </button>
                    <button className="btn-ghost" disabled={idx >= ordered.length - 1} onClick={() => onSelectClip(ordered[idx + 1].id)}>
                        Next clip
                    </button>
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

            <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,22rem)] lg:grid-cols-[auto_minmax(0,1fr)]">
                {/* transcript */}
                <section className="panel order-3 flex max-h-[70vh] min-h-64 flex-col overflow-hidden lg:col-span-2 xl:order-1 xl:col-span-1">
                    <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                        <h2 className="font-semibold">Transcript</h2>
                        <span className="text-xs text-muted">Click a word to jump · double-click to fix it</span>
                    </div>
                    <div className="overflow-y-auto p-4 leading-8">
                        {transcriptWords.map(({ w, i }) => {
                            const inside = w.end > clip.start && w.start < clip.end;
                            const active = time >= w.start && time < w.end;
                            if (editing?.index === i) {
                                return (
                                    <input
                                        key={i}
                                        autoFocus
                                        className="input !inline-block !w-28 !px-1.5 !py-0.5"
                                        value={editing.text}
                                        onChange={(e) => setEditing({ index: i, text: e.target.value })}
                                        onBlur={saveWord}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') saveWord();
                                            if (e.key === 'Escape') setEditing(null);
                                        }}
                                    />
                                );
                            }
                            return (
                                <span key={i} className="relative inline-block">
                                    <button
                                        onClick={() => {
                                            seek(w.start);
                                            setSelectedWord(selectedWord === i ? null : i);
                                        }}
                                        onDoubleClick={() => setEditing({ index: i, text: w.text })}
                                        className={`rounded px-0.5 transition ${active ? 'bg-accent text-ink' : inside ? 'text-white hover:bg-white/10' : 'text-white/35 hover:text-white/70'} ${selectedWord === i ? 'ring-1 ring-accent' : ''}`}
                                    >
                                        {w.text}
                                    </button>{' '}
                                    {selectedWord === i && (
                                        <span className="absolute top-full left-0 z-10 mt-1 flex gap-1 rounded-lg border border-white/15 bg-ink p-1 text-xs whitespace-nowrap shadow-xl">
                                            <button className="rounded px-2 py-1 hover:bg-white/10" onClick={() => { setStart(w.start); setSelectedWord(null); }}>Start here</button>
                                            <button className="rounded px-2 py-1 hover:bg-white/10" onClick={() => { setEnd(w.end); setSelectedWord(null); }}>End here</button>
                                            <button className="rounded px-2 py-1 hover:bg-white/10" onClick={() => setEditing({ index: i, text: w.text })}>Edit</button>
                                        </span>
                                    )}
                                </span>
                            );
                        })}
                        {transcriptWords.length === 0 && <p className="text-muted">No transcript for this part.</p>}
                    </div>
                </section>

                {/* preview */}
                <section className="order-1 flex flex-col items-center gap-3 xl:order-2">
                    <div
                        className="relative overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl"
                        style={{ width: style.aspect === '16:9' ? 'min(560px, 92vw)' : style.aspect === '1:1' ? 'min(420px, 92vw)' : 'min(320px, 80vw)' }}
                    >
                        <canvas ref={canvasRef} width={preview.W} height={preview.H} className="block h-auto w-full" onClick={togglePlay} />
                        {!playing && video && (
                            <button className="absolute inset-0 grid place-items-center bg-black/10" onClick={togglePlay} aria-label="Play">
                                <span className="grid size-14 place-items-center rounded-full bg-white/90 pl-1 text-xl text-ink">▶</span>
                            </button>
                        )}
                        <video ref={videoRef} src={video?.url} playsInline preload="auto" className="pointer-events-none fixed top-0 left-0 size-px opacity-0" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
                    </div>
                    <div className="w-full max-w-[560px]">
                        <div
                            className="relative h-10 cursor-pointer rounded-lg bg-white/[0.06]"
                            onClick={(e) => {
                                const r = e.currentTarget.getBoundingClientRect();
                                seek(winStart + ((e.clientX - r.left) / r.width) * (winEnd - winStart));
                            }}
                        >
                            <div className="absolute inset-y-0 rounded-lg border-2 border-accent bg-accent/15" style={{ left: pct(clip.start), width: `calc(${pct(clip.end)} - ${pct(clip.start)})` }} />
                            <div className="absolute inset-y-0 w-0.5 bg-white" style={{ left: pct(Math.min(winEnd, Math.max(winStart, time))) }} />
                        </div>
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                            <TrimControl label="Start" value={clip.start} onChange={setStart} />
                            <span className="font-mono text-muted tabular-nums">
                                {fmt(Math.max(0, time - clip.start))} / {fmt(clip.end - clip.start)}
                            </span>
                            <TrimControl label="End" value={clip.end} onChange={setEnd} />
                        </div>
                    </div>
                </section>

                {/* settings */}
                <section className="panel order-2 flex flex-col overflow-hidden xl:order-3">
                    <div className="grid grid-cols-4 border-b border-white/10 text-sm">
                        {(['captions', 'layout', 'text', 'export'] as Tab[]).map((t) => (
                            <button key={t} onClick={() => setTab(t)} className={`py-3 font-semibold capitalize ${tab === t ? 'border-b-2 border-accent text-white' : 'text-muted hover:text-white'}`}>
                                {t === 'text' ? 'Post' : t}
                            </button>
                        ))}
                    </div>
                    <div className="flex flex-col gap-5 p-4">
                        {tab === 'captions' && (
                            <>
                                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-2">
                                    {TEMPLATES.map((t) => (
                                        <TemplateSwatch key={t.id} template={t} highlight={t.id === style.template ? style.highlight : t.defaultHighlight} selected={style.template === t.id} onClick={() => setStyle({ template: t.id, highlight: t.defaultHighlight })} />
                                    ))}
                                </div>
                                <Field label="Highlight colour">
                                    <div className="flex flex-wrap gap-2">
                                        {['#c8ff3d', '#ffd60a', '#ff4d6d', '#7c5cff', '#2ee6d6', '#ffffff'].map((c) => (
                                            <button key={c} onClick={() => setStyle({ highlight: c })} className={`size-8 rounded-full border-2 ${style.highlight === c ? 'border-white' : 'border-transparent'}`} style={{ background: c }} aria-label={`Highlight ${c}`} />
                                        ))}
                                        <input type="color" value={style.highlight} onChange={(e) => setStyle({ highlight: e.target.value })} className="size-8 cursor-pointer rounded-full bg-transparent" aria-label="Custom colour" />
                                    </div>
                                </Field>
                                <Field label="Position">
                                    <Segmented value={style.position} onChange={(v) => setStyle({ position: v as CaptionPosition })} items={[{ id: 'top', label: 'Top' }, { id: 'middle', label: 'Middle' }, { id: 'bottom', label: 'Bottom' }]} />
                                </Field>
                                <Field label={`Words on screen: ${style.wordsPerLine}`}>
                                    <input type="range" min={1} max={6} value={style.wordsPerLine} onChange={(e) => setStyle({ wordsPerLine: +e.target.value })} className="w-full accent-[var(--color-accent)]" />
                                </Field>
                                <Toggle label="Highlight keywords" hint={clip.keywords.length ? clip.keywords.join(', ') : 'No keywords for this clip'} checked={style.keywordHighlight} onChange={(v) => setStyle({ keywordHighlight: v })} />
                                <Toggle label="Auto emoji" hint={clip.emojis.length ? clip.emojis.map((e) => `${e.emoji} ${e.word}`).join('  ') : 'No emoji for this clip'} checked={style.emojis} onChange={(v) => setStyle({ emojis: v })} />
                                <p className="text-xs text-muted">Caption settings apply to every clip in this project.</p>
                            </>
                        )}

                        {tab === 'layout' && (
                            <>
                                <Field label="Aspect ratio">
                                    <Segmented value={style.aspect} onChange={(v) => setStyle({ aspect: v as Aspect })} items={[{ id: '9:16', label: '9:16' }, { id: '1:1', label: '1:1' }, { id: '16:9', label: '16:9' }]} />
                                </Field>
                                <Field label="Framing">
                                    <Segmented value={style.layout} onChange={(v) => setStyle({ layout: v as Layout })} items={[{ id: 'auto', label: 'Follow speaker' }, { id: 'manual', label: 'Manual' }, { id: 'fit', label: 'Fit + blur' }]} />
                                </Field>
                                {style.layout === 'auto' && (
                                    <div className="flex flex-col gap-2 text-sm">
                                        <p className="text-muted">{clip.track ? 'The frame follows the main speaker’s face.' : 'No face was found in this clip yet, so it stays centred.'}</p>
                                        <button className="btn-ghost" disabled={!video || reframing} onClick={reframe}>
                                            {reframing ? 'Finding the speaker…' : 'Re-detect speaker'}
                                        </button>
                                    </div>
                                )}
                                {style.layout === 'manual' && (
                                    <Field label="Position">
                                        <input type="range" min={0} max={1} step={0.01} value={style.cropX} onChange={(e) => setStyle({ cropX: +e.target.value })} className="w-full accent-[var(--color-accent)]" />
                                    </Field>
                                )}
                                {style.layout === 'fit' && <p className="text-sm text-muted">Shows the whole frame with a blurred copy filling the space around it.</p>}
                                <p className="text-xs text-muted">Logo and watermark are set in the Brand kit.</p>
                            </>
                        )}

                        {tab === 'text' && (
                            <>
                                <div className="flex flex-col gap-1.5">
                                    <Bar label="Hook" value={clip.subscores.hook} />
                                    <Bar label="Flow" value={clip.subscores.flow} />
                                    <Bar label={clip.category === 'Funny' ? 'Funny' : 'Value'} value={clip.subscores.value} />
                                    <Bar label="Shareable" value={clip.subscores.shareability} />
                                </div>
                                <p className="text-sm text-muted">{clip.reason}</p>
                                <Field label="Description">
                                    <textarea className="input min-h-24 text-sm" value={clip.description} onChange={(e) => setClip({ description: e.target.value })} />
                                </Field>
                                <Field label="Hashtags">
                                    <input className="input text-sm" value={clip.hashtags.join(' ')} onChange={(e) => setClip({ hashtags: e.target.value.split(/\s+/).filter(Boolean) })} />
                                </Field>
                                <button
                                    className="btn-ghost"
                                    onClick={() => {
                                        navigator.clipboard.writeText(uploadText).then(() => {
                                            setCopied(true);
                                            setTimeout(() => setCopied(false), 1500);
                                        }).catch(() => {});
                                    }}
                                >
                                    {copied ? 'Copied' : 'Copy title, description and hashtags'}
                                </button>
                            </>
                        )}

                        {tab === 'export' && (
                            <>
                                <Field label="Quality">
                                    <Segmented value={String(quality)} onChange={(v) => setQuality(+v as 720 | 1080)} items={[{ id: '720', label: '720p · faster' }, { id: '1080', label: '1080p · sharper' }]} />
                                </Field>
                                {renderError && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-200">{renderError}</p>}
                                <button className="btn-accent" disabled={!video || rendering !== null} onClick={exportClip}>
                                    {rendering !== null ? `Rendering… ${Math.round(rendering * 100)}%` : 'Export MP4'}
                                </button>
                                <button className="btn-ghost" onClick={() => saveBlob(new Blob([buildSrt(words, clip, style.wordsPerLine)], { type: 'text/plain' }), `${safeName(clip.title)}.srt`)}>
                                    Download captions (.srt)
                                </button>
                                <p className="text-xs text-muted">Rendering runs on your device. 720p takes about a minute per clip; 1080p takes longer.</p>
                            </>
                        )}
                    </div>
                </section>
            </div>
        </div>
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

function TrimControl({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
    return (
        <span className="flex items-center gap-1">
            <span className="text-muted">{label}</span>
            <button className="rounded bg-white/[0.07] px-1.5 py-1 hover:bg-white/15" onClick={() => onChange(+(value - 0.5).toFixed(2))} aria-label={`${label} earlier`}>
                −
            </button>
            <span className="w-14 text-center font-mono tabular-nums">{value.toFixed(1)}s</span>
            <button className="rounded bg-white/[0.07] px-1.5 py-1 hover:bg-white/15" onClick={() => onChange(+(value + 0.5).toFixed(2))} aria-label={`${label} later`}>
                +
            </button>
        </span>
    );
}
