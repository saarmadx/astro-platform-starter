import { useEffect, useMemo, useRef, useState } from 'react';
import { projectEvents } from '../lib/audio';
import { chatPrompt, splitForChat } from '../lib/prompts';
import { displayWords, groupWords } from '../lib/captions';
import { drawScene } from '../lib/draw';
import { outputSize } from '../lib/geometry';
import { skipCut } from '../lib/timeline';
import { joinVideos, renderCard, renderClip } from '../lib/video';
import { chatSpikes, parseChat } from '../lib/chat';
import { textOverlayPng, wrap } from '../lib/draw';
import { TITLE_FONT } from '../lib/templates';
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
    onRecaption: (scope: 'clips' | 'all') => void;
    onDelete: () => void;
    onChange: (p: Project) => void;
    onPaste: (answer: string) => Promise<void>;
    onSwitchCaptions: () => void;
};

export function saveBlob(blob: Blob, name: string) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 20_000);
}

export const safeName = (t: string) => t.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'clip';

export default function ProjectView({ project, video, progress, error, brand, onOpenClip, onAttach, onRegenerate, onRecaption, onDelete, onChange, onPaste, onSwitchCaptions }: Props) {
    const [sort, setSort] = useState<'score' | 'time'>('score');
    const [batch, setBatch] = useState<{ i: number; n: number; ratio: number } | null>(null);
    const [batchError, setBatchError] = useState('');
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [reel, setReel] = useState(false);
    const [compile, setCompile] = useState(false);
    const [chatMsg, setChatMsg] = useState('');
    const busy = !!progress;
    const [redoOpen, setRedoOpen] = useState(false);

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
                    music: project.music,
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
                    <div className="relative">
                        <button
                            className="btn-ghost"
                            disabled={busy || !video || !project.transcript || project.status !== 'ready'}
                            title="Makes the captions again with the improved timing and the Accurate setting. Your clips and edits stay."
                            onClick={() => setRedoOpen(!redoOpen)}
                        >
                            🔁 Redo captions
                        </button>
                        {redoOpen && (
                            <div className="absolute top-full left-0 z-30 mt-1 flex w-72 flex-col gap-1 rounded-xl border border-white/10 bg-[#1b1e25] p-2 shadow-2xl">
                                <button className="rounded-lg px-3 py-2 text-left hover:bg-white/10" disabled={clips.length === 0} onClick={() => { setRedoOpen(false); onRecaption('clips'); }}>
                                    <span className="block text-sm font-bold">⚡ Just the clips (fast)</span>
                                    <span className="block text-xs text-muted">Accurate captions for your clips only. Much faster on long videos.</span>
                                </button>
                                <button className="rounded-lg px-3 py-2 text-left hover:bg-white/10" onClick={() => { setRedoOpen(false); onRecaption('all'); }}>
                                    <span className="block text-sm font-bold">Whole video</span>
                                    <span className="block text-xs text-muted">Every minute again. Takes about as long as the video.</span>
                                </button>
                                <p className="px-3 pb-1 text-[11px] text-muted">Your clips and edits stay. Words you fixed by hand in those parts need fixing again.</p>
                            </div>
                        )}
                    </div>
                    <button className="btn-ghost" disabled={!video || clips.length === 0} onClick={() => setReel(true)}>
                        ▶ Watch all
                    </button>
                    <button className="btn-ghost" disabled={!video || clips.length < 2} onClick={() => setCompile(true)} title="Join your best clips into one video">
                        🎬 Compilation
                    </button>
                    <label className="btn-ghost cursor-pointer" title="Add the stream's chat replay to find moments where chat exploded">
                        💬 {project.chat ? 'Chat added' : 'Add chat'}
                        <input
                            type="file"
                            accept=".json,.txt,.log,application/json,text/plain"
                            className="sr-only"
                            onChange={async (e) => {
                                const f = e.target.files?.[0];
                                if (!f) return;
                                const spikes = chatSpikes(parseChat(await f.text()));
                                onChange({ ...project, chat: { name: f.name, spikes } });
                                setChatMsg(spikes.length ? `Found ${spikes.length} moments where chat exploded. Click “Find new clips” to use them.` : 'No chat spikes found in that file (is it a Twitch/YouTube chat replay with timestamps?).');
                            }}
                        />
                    </label>
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
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs text-muted">Keep this tab open. Free captions run on your PC, so long videos take a while.</p>
                        {project.status === 'transcribing' && (project.options.asr ?? 'local') === 'local' && (project.options.asrQuality ?? 'fast') !== 'fastest' && (
                            <button className="btn-ghost !py-1.5 text-xs" onClick={onSwitchCaptions}>
                                Too slow? Switch to faster captions ({({ best: 'Accurate', accurate: 'Balanced', fast: 'Fastest' } as Record<string, string>)[project.options.asrQuality ?? 'fast']})
                            </button>
                        )}
                    </div>
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
            {chatMsg && <p className="rounded-lg bg-sky-500/10 px-3 py-2 text-sm text-sky-100">{chatMsg}</p>}
            {compile && video && <CompilationMaker project={project} clips={clips} video={video} brand={brand} onClose={() => setCompile(false)} />}
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
        const chunks = splitForChat(t.segments, projectEvents(project));
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

/** Joins chosen clips into one video, optionally with a countdown card before each. */
function CompilationMaker({ project, clips, video, brand, onClose }: { project: Project; clips: Project['clips']; video: LoadedVideo; brand: Brand; onClose: () => void }) {
    const [chosen, setChosen] = useState<string[]>(() => clips.slice(0, Math.min(5, clips.length)).map((c) => c.id));
    const [countdown, setCountdown] = useState(true);
    const [quality, setQuality] = useState<720 | 1080>(720);
    const [busy, setBusy] = useState<string | null>(null);
    const [err, setErr] = useState('');
    const picked = clips.filter((c) => chosen.includes(c.id));
    // countdown: weakest first, best last
    const order = countdown ? [...picked].sort((a, b) => a.score - b.score) : picked;

    async function make() {
        setErr('');
        try {
            const { W, H } = outputSize(project.style.aspect, quality);
            const parts: Uint8Array[] = [];
            for (let i = 0; i < order.length; i++) {
                const c = order[i];
                if (countdown) {
                    setBusy(`Title card ${i + 1} of ${order.length}`);
                    const num = order.length - i;
                    const png = await textOverlayPng(W, H, (ctx) => {
                        const g = ctx.createLinearGradient(0, 0, 0, H);
                        g.addColorStop(0, '#14171c');
                        g.addColorStop(1, '#0b0d10');
                        ctx.fillStyle = g;
                        ctx.fillRect(0, 0, W, H);
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillStyle = project.style.highlight;
                        ctx.font = `${W * 0.28}px ${TITLE_FONT.css}, sans-serif`;
                        ctx.fillText(`#${num}`, W / 2, H * 0.4);
                        ctx.fillStyle = '#ffffff';
                        const size = W * 0.065;
                        ctx.font = `${size}px ${TITLE_FONT.css}, 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif`;
                        wrap(ctx, c.title, W * 0.84).slice(0, 3).forEach((l, k) => ctx.fillText(l, W / 2, H * 0.58 + k * size * 1.2));
                    });
                    parts.push(await renderCard(png, 1.5, quality, true));
                }
                setBusy(`Rendering clip ${i + 1} of ${order.length}`);
                const blob = await renderClip({
                    file: video.file,
                    clip: c,
                    words: project.transcript?.words ?? [],
                    style: project.style,
                    brand,
                    quality,
                    videoWidth: project.width,
                    videoHeight: project.height,
                    speakers: project.speakers,
                    music: project.music,
                    onProgress: (r) => setBusy(`Rendering clip ${i + 1} of ${order.length} · ${Math.round(r * 100)}%`)
                });
                parts.push(new Uint8Array(await blob.arrayBuffer()));
            }
            setBusy('Joining everything');
            saveBlob(await joinVideos(parts), `${safeName(project.name)} - compilation.mp4`);
            onClose();
        } catch (e) {
            setErr((e as Error).message);
        } finally {
            setBusy(null);
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => !busy && onClose()}>
            <div className="panel flex max-h-[90vh] w-full max-w-lg flex-col gap-4 overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
                <div>
                    <h2 className="text-xl font-bold">Make a compilation</h2>
                    <p className="text-sm text-muted">Join your best clips into one video, for example a “Top 5 funniest moments”.</p>
                </div>
                <div className="flex flex-col gap-1.5">
                    {clips.map((c) => (
                        <label key={c.id} className="flex items-center gap-3 rounded-lg bg-white/[0.04] px-3 py-2 text-sm">
                            <input type="checkbox" checked={chosen.includes(c.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, c.id] : chosen.filter((x) => x !== c.id))} className="size-4 accent-[var(--color-accent)]" />
                            <span className={`rounded px-1.5 text-xs font-bold ${scoreTone(c.score)}`}>{c.score}</span>
                            <span className="min-w-0 flex-1 truncate">{c.title}</span>
                            <span className="text-xs text-muted tabular-nums">{fmt(c.end - c.start)}</span>
                        </label>
                    ))}
                </div>
                <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={countdown} onChange={(e) => setCountdown(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
                    Countdown with numbered title cards (#{picked.length} … #1, best clip last)
                </label>
                <div className="flex gap-2 text-sm">
                    {([720, 1080] as const).map((q) => (
                        <button key={q} className={`rounded-lg px-3 py-1.5 ${quality === q ? 'bg-accent text-ink' : 'bg-white/[0.06]'}`} onClick={() => setQuality(q)}>{q}p</button>
                    ))}
                </div>
                {err && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-200">{err}</p>}
                <div className="flex gap-2">
                    <button className="btn-accent grow" disabled={picked.length < 2 || !!busy} onClick={make}>{busy ?? `Make video from ${picked.length} clips`}</button>
                    <button className="btn-ghost" disabled={!!busy} onClick={onClose}>Close</button>
                </div>
                <p className="text-xs text-muted">Each clip is exported with its own captions and effects, then everything is joined. This takes about as long as exporting each clip.</p>
            </div>
        </div>
    );
}
