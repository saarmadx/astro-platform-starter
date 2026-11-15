import { useEffect, useMemo, useRef, useState } from 'react';
import { findAudioEvents } from '../lib/audio';
import { chatPrompt, splitForChat } from '../lib/prompts';
import { displayWords, groupWords } from '../lib/captions';
import { drawScene } from '../lib/draw';
import { outputSize } from '../lib/geometry';
import { skipCut } from '../lib/timeline';
import { renderClip } from '../lib/video';
import type { Brand, ContentMode, Picker, Project } from '../lib/types';
import { MODES, PICKERS } from './Home';
import type { LoadedVideo } from './Studio';
import { Bar, fmt, scoreTone } from './ui';

type Props = {
    project: Project;
    video?: LoadedVideo;
    progress?: { label: string; ratio: number };
    error?: string;
    brand: Brand;
    onOpenClip: (clipId: string) => void;
    onAttach: (f: File) => void;
    onRegenerate: (options: Project['options']) => void;
    onDelete: () => void;
    onChange: (p: Project) => void;
    onPaste: (answer: string) => Promise<void>;
};

export function saveBlob(blob: Blob, name: string) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 20_000);
}

export const safeName = (t: string) => t.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'clip';

export default function ProjectView({ project, video, progress, error, brand, onOpenClip, onAttach, onRegenerate, onDelete, onChange, onPaste }: Props) {
    const [sort, setSort] = useState<'score' | 'time'>('score');
    const [batch, setBatch] = useState<{ i: number; n: number; ratio: number } | null>(null);
    const [batchError, setBatchError] = useState('');
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [reel, setReel] = useState(false);
    const busy = !!progress;

    const clips = useMemo(() => [...project.clips].sort((a, b) => (sort === 'score' ? b.score - a.score : a.start - b.start)), [project.clips, sort]);

    async function exportAll() {
        if (!video || !project.transcript) return;
        setBatchError('');
        try {
            for (let i = 0; i < clips.length; i++) {
                setBatch({ i, n: clips.length, ratio: 0 });
                const blob = await renderClip({
                    file: video.file,
                    clip: clips[i],
                    words: project.transcript.words,
                    style: project.style,
                    brand,
                    quality: 720,
                    videoWidth: project.width,
                    videoHeight: project.height,
                    speakers: project.speakers,
                    onProgress: (ratio) => setBatch({ i, n: clips.length, ratio })
                });
                saveBlob(blob, `${String(i + 1).padStart(2, '0')} ${safeName(clips[i].title)}.mp4`);
            }
            const notes = clips
                .map((c, i) => {
                    const tags = c.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ');
                    return `${String(i + 1).padStart(2, '0')}. ${c.title}\nScore: ${c.score}\n\n${c.description}\n\n${tags}\n`;
                })
                .join('\n------------------------------\n\n');
            saveBlob(new Blob([notes], { type: 'text/plain' }), `${safeName(project.name)} - titles and descriptions.txt`);
        } catch (e) {
            setBatchError((e as Error).message);
        } finally {
            setBatch(null);
        }
    }

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div className="min-w-0">
                    <input
                        className="w-full bg-transparent text-2xl font-bold outline-none focus:underline"
                        value={project.name}
                        onChange={(e) => onChange({ ...project, name: e.target.value })}
                        aria-label="Project name"
                    />
                    <p className="text-sm text-muted">
                        {fmt(project.duration)} source · {project.clips.length} clips · {project.style.aspect}
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <div className="flex rounded-xl bg-white/[0.05] p-1 text-sm">
                        {(['score', 'time'] as const).map((s) => (
                            <button key={s} onClick={() => setSort(s)} className={`rounded-lg px-3 py-1 ${sort === s ? 'bg-white/15' : 'text-muted'}`}>
                                {s === 'score' ? 'Best first' : 'In order'}
                            </button>
                        ))}
                    </div>
                    <select
                        className="input !w-auto !py-2 text-sm"
                        value={project.options.mode ?? 'viral'}
                        onChange={(e) => onChange({ ...project, options: { ...project.options, mode: e.target.value as ContentMode } })}
                        aria-label="Type of moments to find"
                    >
                        {MODES.map((m) => (
                            <option key={m.id} value={m.id}>
                                {m.label}
                            </option>
                        ))}
                    </select>
                    <select
                        className="input !w-auto !py-2 text-sm"
                        value={project.options.picker ?? 'laughs'}
                        onChange={(e) => onChange({ ...project, options: { ...project.options, picker: e.target.value as Picker } })}
                        aria-label="How to pick clips"
                    >
                        {PICKERS.map((m) => (
                            <option key={m.id} value={m.id}>
                                {m.label}
                            </option>
                        ))}
                    </select>
                    <button className="btn-ghost" disabled={busy || !video} onClick={() => onRegenerate(project.options)}>
                        Find new clips
                    </button>
                    <button className="btn-ghost" disabled={!video || clips.length === 0} onClick={() => setReel(true)}>
                        ▶ Watch all
                    </button>
                    <button className="btn-accent !py-2 text-sm" disabled={busy || !video || !!batch || clips.length === 0} onClick={exportAll}>
                        {batch ? `Exporting ${batch.i + 1}/${batch.n} · ${Math.round(batch.ratio * 100)}%` : 'Export all'}
                    </button>
                </div>
            </div>

            {!video && (
                <label className="panel flex cursor-pointer flex-wrap items-center justify-between gap-3 border-amber-300/40 p-4">
                    <span className="text-sm">
                        To preview and export, select the original video again: <b className="break-all">{project.fileName}</b>
                    </span>
                    <span className="btn-ghost">Select video</span>
                    <input type="file" accept="video/*,.mkv" className="sr-only" onChange={(e) => e.target.files?.[0] && onAttach(e.target.files[0])} />
                </label>
            )}

            {progress && (
                <div className="panel flex flex-col gap-3 p-5">
                    <div className="flex items-center gap-3">
                        <span className="size-5 animate-spin rounded-full border-2 border-white/15 border-t-accent" />
                        <span className="font-semibold">{progress.label}…</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-white/10">
                        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
                    </div>
                    <p className="text-xs text-muted">Keep this tab open. A one-hour video usually takes a few minutes.</p>
                </div>
            )}
            {(project.status === 'transcribing' || project.status === 'clipping') && !progress && (
                <section className="panel flex flex-wrap items-center justify-between gap-3 border-amber-300/40 p-5">
                    <div>
                        <p className="font-semibold">Processing stopped</p>
                        <p className="text-sm text-muted">
                            The page was closed or refreshed while it was working.
                            {project.partial ? ` Captions are saved up to ${Math.round((project.partial.nextChunk * 120) / 60)} min, so it continues from there.` : ''}
                        </p>
                    </div>
                    <button className="btn-accent !py-2" disabled={!video} onClick={() => onRegenerate(project.options)}>
                        {video ? 'Continue' : 'Select the video first (above)'}
                    </button>
                </section>
            )}

            {project.status === 'awaiting-paste' && project.transcript && !progress && <PastePanel project={project} onPaste={onPaste} />}
            {reel && video && <ReelPreview project={project} clips={clips} video={video} brand={brand} onClose={() => setReel(false)} onOpen={onOpenClip} />}

            {(error || batchError) && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-200">{error || batchError}</p>}

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {clips.map((c, i) => (
                    <button key={c.id} onClick={() => onOpenClip(c.id)} className="panel group flex flex-col overflow-hidden text-left transition hover:border-accent/50">
                        <div className={`relative overflow-hidden bg-black ${project.style.aspect === '16:9' ? 'aspect-video' : project.style.aspect === '1:1' ? 'aspect-square' : 'aspect-[9/12]'}`}>
                            {c.thumb ? <img src={c.thumb} alt="" className="h-full w-full object-cover transition group-hover:scale-105" /> : <div className="h-full w-full animate-pulse bg-white/5" />}
                            <span className={`absolute top-3 left-3 rounded-lg px-2 py-1 text-sm font-extrabold ${scoreTone(c.score)}`}>{c.score}</span>
                            <span className="absolute right-3 bottom-3 rounded-md bg-black/70 px-1.5 py-0.5 text-xs font-semibold tabular-nums">{fmt(c.end - c.start)}</span>
                            <span className="absolute bottom-3 left-3 rounded-md bg-black/70 px-1.5 py-0.5 text-xs text-white/80">#{i + 1}</span>
                            {c.category && <span className="absolute top-3 right-3 rounded-md bg-black/70 px-2 py-1 text-xs font-semibold">{c.category}</span>}
                        </div>
                        <div className="flex grow flex-col gap-2 p-4">
                            <p className="leading-snug font-semibold">{c.title}</p>
                            <p className="line-clamp-2 text-sm text-muted">“{c.hook}”</p>
                            <div className="mt-auto flex flex-col gap-1 pt-2">
                                <Bar label="Hook" value={c.subscores.hook} />
                                <Bar label="Flow" value={c.subscores.flow} />
                                <Bar label={c.category === 'Funny' ? 'Funny' : 'Value'} value={c.subscores.value} />
                                <Bar label="Shareable" value={c.subscores.shareability} />
                            </div>
                        </div>
                    </button>
                ))}
            </div>

            {project.status === 'ready' && clips.length === 0 && <p className="text-muted">No clips yet.</p>}

            <div className="mt-6 flex justify-end">
                {confirmDelete ? (
                    <div className="flex items-center gap-2 text-sm">
                        <span className="text-muted">Delete this project?</span>
                        <button className="btn-ghost !border-red-400/50 !text-red-300" onClick={onDelete}>Delete</button>
                        <button className="btn-ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
                    </div>
                ) : (
                    <button className="text-sm text-muted hover:text-red-300" onClick={() => setConfirmDelete(true)}>Delete project</button>
                )}
            </div>
        </div>
    );
}

/** Free clip picking: copy a prompt into a Claude chat, paste the answer back. Long videos are split into parts. */
function PastePanel({ project, onPaste }: { project: Project; onPaste: (answer: string) => Promise<void> }) {
    const parts = useMemo(() => {
        const t = project.transcript!;
        const o = project.options;
        const opts = { mode: o.mode ?? 'funny', minSeconds: o.minSeconds, maxSeconds: o.maxSeconds, maxClips: o.maxClips, topic: o.topic };
        const chunks = splitForChat(t.segments, findAudioEvents(t.energy, t.words));
        const perPart = Math.max(2, Math.ceil(o.maxClips / chunks.length) + 1);
        return chunks.map((c, i) => chatPrompt(c.segments, c.events, { ...opts, maxClips: chunks.length > 1 ? perPart : o.maxClips }, { index: i, count: chunks.length }));
    }, [project.transcript, project.options]);
    const [answers, setAnswers] = useState<string[]>(() => parts.map(() => ''));
    const [copied, setCopied] = useState<number | null>(null);
    const [err, setErr] = useState('');
    const [busy, setBusy] = useState(false);

    async function copy(i: number) {
        try {
            await navigator.clipboard.writeText(parts[i]);
            setCopied(i);
        } catch {
            setErr('Copying failed. Click inside the grey box, press Ctrl+A then Ctrl+C.');
        }
    }

    async function create() {
        setErr('');
        setBusy(true);
        try {
            // merge all pasted answers into one list
            const lists = answers.filter((a) => a.trim()).map((a) => {
                const m = a.match(/\[[\s\S]*\]/);
                return m ? m[0].trim().slice(1, -1).trim() : '';
            });
            await onPaste(lists.length > 1 ? `[${lists.filter(Boolean).join(',')}]` : answers.find((a) => a.trim()) ?? '');
        } catch (e) {
            setErr((e as Error).message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="panel flex flex-col gap-5 p-5 sm:p-6">
            <div>
                <h2 className="text-xl font-bold">Captions are ready. Now let Claude pick the clips (free)</h2>
                <p className="mt-1 text-sm text-muted">
                    Uses your normal Claude chat, so it costs nothing extra.
                    {parts.length > 1 ? ` Your video is long, so it is split into ${parts.length} parts. Do each part in its own new chat; you can create clips after any of them.` : ''}
                </p>
            </div>
            {parts.map((prompt, i) => (
                <div key={i} className={`flex flex-col gap-3 ${parts.length > 1 ? 'rounded-xl border border-white/10 p-4' : ''}`}>
                    {parts.length > 1 && <p className="font-semibold">Part {i + 1} of {parts.length} {answers[i].trim() ? '✓' : ''}</p>}
                    <ol className="flex flex-col gap-3 text-sm">
                        <li className="flex flex-wrap items-center gap-2">
                            <b>1.</b>
                            <button className="btn-accent !py-2" onClick={() => copy(i)}>{copied === i ? 'Copied ✓' : 'Copy prompt'}</button>
                            <span className="text-xs text-muted">{Math.round(prompt.length / 1000)}k characters</span>
                        </li>
                        <li>
                            <b>2.</b> Open a <b>new chat</b> at <a href="https://claude.ai/new" target="_blank" rel="noreferrer">claude.ai</a>, paste it (Ctrl+V) and send.
                        </li>
                        <li className="flex flex-col gap-2">
                            <span><b>3.</b> Copy Claude’s whole answer and paste it here:</span>
                            <textarea
                                value={answers[i]}
                                onChange={(e) => setAnswers(answers.map((a, k) => (k === i ? e.target.value : a)))}
                                className="input h-24 font-mono text-xs"
                                placeholder='[{"title": "...", "start": 12.3, ...}]'
                                aria-label={parts.length > 1 ? `Claude's answer for part ${i + 1}` : "Claude's answer"}
                            />
                        </li>
                    </ol>
                    <textarea readOnly value={prompt} className="input h-12 font-mono text-[10px] opacity-60" aria-label="Prompt" onFocus={(e) => e.currentTarget.select()} />
                </div>
            ))}
            {err && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-200">{err}</p>}
            <button className="btn-accent" disabled={!answers.some((a) => a.trim()) || busy} onClick={create}>{busy ? 'Creating clips…' : 'Create my clips'}</button>
        </section>
    );
}

/** Plays every clip back to back, like scrolling Shorts. */
function ReelPreview({ project, clips, video, brand, onClose, onOpen }: { project: Project; clips: Project['clips']; video: LoadedVideo; brand: Brand; onClose: () => void; onOpen: (id: string) => void }) {
    const [i, setI] = useState(0);
    const vRef = useRef<HTMLVideoElement>(null);
    const cRef = useRef<HTMLCanvasElement>(null);
    const logo = useMemo(() => {
        if (!brand.logo) return null;
        const img = new Image();
        img.src = brand.logo;
        return img;
    }, [brand.logo]);
    const clip = clips[i];
    const groups = useMemo(() => groupWords(displayWords(project.transcript?.words ?? [], clip, project.style, project.speakers, false), project.style.wordsPerLine), [clip, project]);
    const size = outputSize(project.style.aspect, 540);
    const ref = useRef({ clip, groups, i });
    ref.current = { clip, groups, i };

    useEffect(() => {
        const v = vRef.current;
        if (!v) return;
        v.currentTime = clip.start;
        v.play().catch(() => {});
    }, [i]);

    useEffect(() => {
        let raf = 0;
        const loop = () => {
            const v = vRef.current;
            const c = cRef.current;
            const r = ref.current;
            if (v && c) {
                const skip = skipCut(r.clip, v.currentTime);
                if (skip !== v.currentTime) v.currentTime = skip;
                if (v.currentTime >= r.clip.end) setI((x) => (x + 1 < clips.length ? x + 1 : x));
                drawScene(c.getContext('2d')!, v, v.currentTime, { clip: r.clip, style: project.style, brand, groups: r.groups, logo });
            }
            raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown' || e.key === 'ArrowRight') setI((x) => Math.min(clips.length - 1, x + 1));
            if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
        };
        window.addEventListener('keydown', onKey);
        return () => {
            cancelAnimationFrame(raf);
            window.removeEventListener('keydown', onKey);
        };
    }, []);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center gap-4 bg-black/90 p-4" onClick={onClose}>
            <div className="flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
                <div className="overflow-hidden rounded-2xl border border-white/15" style={{ height: 'min(78vh, 720px)', aspectRatio: `${size.W} / ${size.H}`, maxWidth: '92vw' }}>
                    <canvas ref={cRef} width={size.W} height={size.H} className="h-full w-full" onClick={() => (vRef.current?.paused ? vRef.current.play() : vRef.current?.pause())} />
                </div>
                <p className="max-w-sm text-center font-semibold">{clip.title}</p>
                <div className="flex items-center gap-2 text-sm">
                    <button className="btn-ghost" disabled={i === 0} onClick={() => setI(i - 1)}>↑ Previous</button>
                    <span className="text-muted tabular-nums">{i + 1} / {clips.length}</span>
                    <button className="btn-ghost" disabled={i >= clips.length - 1} onClick={() => setI(i + 1)}>Next ↓</button>
                    <button className="btn-ghost" onClick={() => onOpen(clip.id)}>Edit this clip</button>
                    <button className="btn-ghost" onClick={onClose}>Close</button>
                </div>
            </div>
            <video ref={vRef} src={video.url} playsInline className="pointer-events-none fixed top-0 left-0 size-px opacity-0" />
        </div>
    );
}
