import { useMemo, useState } from 'react';
import { renderClip } from '../lib/video';
import type { Brand, Project } from '../lib/types';
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
};

export function saveBlob(blob: Blob, name: string) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 20_000);
}

export const safeName = (t: string) => t.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'clip';

export default function ProjectView({ project, video, progress, error, brand, onOpenClip, onAttach, onRegenerate, onDelete, onChange }: Props) {
    const [sort, setSort] = useState<'score' | 'time'>('score');
    const [batch, setBatch] = useState<{ i: number; n: number; ratio: number } | null>(null);
    const [batchError, setBatchError] = useState('');
    const [confirmDelete, setConfirmDelete] = useState(false);
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
                    onProgress: (ratio) => setBatch({ i, n: clips.length, ratio })
                });
                saveBlob(blob, `${String(i + 1).padStart(2, '0')} ${safeName(clips[i].title)}.mp4`);
            }
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
                    <button className="btn-ghost" disabled={busy || !video} onClick={() => onRegenerate(project.options)}>
                        Find new clips
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
            {(error || batchError) && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-200">{error || batchError}</p>}

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {clips.map((c, i) => (
                    <button key={c.id} onClick={() => onOpenClip(c.id)} className="panel group flex flex-col overflow-hidden text-left transition hover:border-accent/50">
                        <div className={`relative overflow-hidden bg-black ${project.style.aspect === '16:9' ? 'aspect-video' : project.style.aspect === '1:1' ? 'aspect-square' : 'aspect-[9/12]'}`}>
                            {c.thumb ? <img src={c.thumb} alt="" className="h-full w-full object-cover transition group-hover:scale-105" /> : <div className="h-full w-full animate-pulse bg-white/5" />}
                            <span className={`absolute top-3 left-3 rounded-lg px-2 py-1 text-sm font-extrabold ${scoreTone(c.score)}`}>{c.score}</span>
                            <span className="absolute right-3 bottom-3 rounded-md bg-black/70 px-1.5 py-0.5 text-xs font-semibold tabular-nums">{fmt(c.end - c.start)}</span>
                            <span className="absolute bottom-3 left-3 rounded-md bg-black/70 px-1.5 py-0.5 text-xs text-white/80">#{i + 1}</span>
                        </div>
                        <div className="flex grow flex-col gap-2 p-4">
                            <p className="leading-snug font-semibold">{c.title}</p>
                            <p className="line-clamp-2 text-sm text-muted">“{c.hook}”</p>
                            <div className="mt-auto flex flex-col gap-1 pt-2">
                                <Bar label="Hook" value={c.subscores.hook} />
                                <Bar label="Flow" value={c.subscores.flow} />
                                <Bar label="Value" value={c.subscores.value} />
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
