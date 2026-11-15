import { useState } from 'react';
import { TEMPLATES } from '../lib/templates';
import type { Aspect, ContentMode, Project } from '../lib/types';
import { TemplateSwatch } from './ui';

export type NewProjectInput = {
    file: File;
    aspect: Aspect;
    template: string;
    highlight: string;
    options: Project['options'];
};

const LENGTHS = [
    { id: 'auto', label: 'Auto', min: 15, max: 90 },
    { id: 'short', label: 'Under 30s', min: 10, max: 30 },
    { id: 'mid', label: '30–60s', min: 30, max: 60 },
    { id: 'long', label: '60–90s', min: 60, max: 90 }
];

export const MODES: { id: ContentMode; label: string; hint: string }[] = [
    { id: 'viral', label: 'Most viral', hint: 'Best of everything' },
    { id: 'funny', label: 'Funny', hint: 'Jokes, banter, reactions' },
    { id: 'insightful', label: 'Insightful', hint: 'Advice and facts' },
    { id: 'story', label: 'Stories', hint: 'Anecdotes with a payoff' },
    { id: 'hot-takes', label: 'Hot takes', hint: 'Bold opinions, debates' }
];

const ASPECTS: { id: Aspect; label: string; hint: string }[] = [
    { id: '9:16', label: '9:16', hint: 'Shorts, TikTok, Reels' },
    { id: '1:1', label: '1:1', hint: 'Feed posts' },
    { id: '16:9', label: '16:9', hint: 'YouTube, X' }
];

type Props = {
    projects: Project[];
    onCreate: (input: NewProjectInput) => Promise<void>;
    onOpen: (id: string) => void;
    accessCode: string;
    setAccessCode: (c: string) => void;
};

export default function Home({ projects, onCreate, onOpen, accessCode, setAccessCode }: Props) {
    const [file, setFile] = useState<File | null>(null);
    const [length, setLength] = useState('auto');
    const [maxClips, setMaxClips] = useState(10);
    const [aspect, setAspect] = useState<Aspect>('9:16');
    const [template, setTemplate] = useState('punch');
    const [topic, setTopic] = useState('');
    const [mode, setMode] = useState<ContentMode>('funny');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    function pick(f?: File) {
        if (!f) return;
        if (!f.type.startsWith('video/') && !/\.(mp4|mov|mkv|webm|m4v)$/i.test(f.name)) {
            setError('Please choose a video file (MP4, MOV, WebM or MKV).');
            return;
        }
        setError('');
        setFile(f);
    }

    async function start() {
        if (!file) return;
        const len = LENGTHS.find((l) => l.id === length)!;
        const tpl = TEMPLATES.find((t) => t.id === template)!;
        setBusy(true);
        try {
            await onCreate({ file, aspect, template, highlight: tpl.defaultHighlight, options: { minSeconds: len.min, maxSeconds: len.max, maxClips, topic, mode } });
        } catch (e) {
            setError((e as Error).message);
            setBusy(false);
        }
    }

    return (
        <div className="flex flex-col gap-10">
            <section className="panel overflow-hidden">
                <div className="grid gap-0 lg:grid-cols-[1.2fr_1fr]">
                    <div className="flex flex-col gap-4 p-5 sm:p-8">
                        <div>
                            <h1 className="!text-3xl sm:!text-4xl">Turn one long video into viral clips</h1>
                            <p className="mt-2 text-muted">AI finds the best moments, reframes them around the speaker, and adds animated captions.</p>
                        </div>
                        <label
                            className={`flex min-h-48 cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-6 text-center transition ${file ? 'border-accent/60 bg-accent/5' : 'border-white/15 bg-white/[0.03] hover:border-accent/60'}`}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                                e.preventDefault();
                                pick(e.dataTransfer.files[0]);
                            }}
                        >
                            <input type="file" accept="video/*,.mkv" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
                            <span className="grid size-14 place-items-center rounded-full bg-accent text-2xl text-ink">↑</span>
                            {file ? (
                                <>
                                    <span className="font-semibold break-all">{file.name}</span>
                                    <span className="text-sm text-muted">{(file.size / 1048576).toFixed(0)} MB · click to change</span>
                                </>
                            ) : (
                                <>
                                    <span className="font-semibold">Drop a video or click to upload</span>
                                    <span className="text-sm text-muted">Podcasts, interviews, talks and streams work best</span>
                                </>
                            )}
                        </label>
                        {error && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-200">{error}</p>}
                        <button className="btn-accent" disabled={!file || busy} onClick={start}>
                            {busy ? 'Starting…' : 'Get clips in 1 click'}
                        </button>
                        <p className="text-xs text-muted">Only clip videos you own or have permission to use. Your video stays in your browser; only the audio is sent for transcription.</p>
                    </div>

                    <div className="flex flex-col gap-5 border-t border-white/10 bg-white/[0.02] p-5 sm:p-8 lg:border-t-0 lg:border-l">
                        <Option label="What are you looking for?">
                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                                {MODES.map((m) => (
                                    <button key={m.id} onClick={() => setMode(m.id)} className={`rounded-xl border px-3 py-2 text-left ${mode === m.id ? 'border-accent bg-accent/10' : 'border-white/10 hover:bg-white/5'}`}>
                                        <span className="block text-sm font-bold">{m.label}</span>
                                        <span className="block text-xs text-muted">{m.hint}</span>
                                    </button>
                                ))}
                            </div>
                        </Option>
                        <Option label="Clip length">
                            <Segmented value={length} onChange={setLength} items={LENGTHS.map((l) => ({ id: l.id, label: l.label }))} />
                        </Option>
                        <Option label={`Number of clips: ${maxClips}`}>
                            <input type="range" min={1} max={20} value={maxClips} onChange={(e) => setMaxClips(+e.target.value)} className="w-full accent-[var(--color-accent)]" />
                        </Option>
                        <Option label="Aspect ratio">
                            <div className="grid grid-cols-3 gap-2">
                                {ASPECTS.map((a) => (
                                    <button key={a.id} onClick={() => setAspect(a.id)} className={`rounded-xl border px-2 py-2 text-left ${aspect === a.id ? 'border-accent bg-accent/10' : 'border-white/10 hover:bg-white/5'}`}>
                                        <span className="block font-bold">{a.label}</span>
                                        <span className="block text-xs text-muted">{a.hint}</span>
                                    </button>
                                ))}
                            </div>
                        </Option>
                        <Option label="Caption style">
                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
                                {TEMPLATES.filter((t) => t.id !== 'none').map((t) => (
                                    <TemplateSwatch key={t.id} template={t} highlight={t.defaultHighlight} selected={template === t.id} onClick={() => setTemplate(t.id)} />
                                ))}
                            </div>
                        </Option>
                        <Option label="Topics to look for (optional)">
                            <input className="input" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. money tips, funny stories" />
                        </Option>
                        <details className="text-sm">
                            <summary className="cursor-pointer text-muted">Access code</summary>
                            <input className="input mt-2" type="password" value={accessCode} onChange={(e) => setAccessCode(e.target.value)} placeholder="Only if your site uses one" />
                        </details>
                    </div>
                </div>
            </section>

            <section>
                <h2 className="mb-4 text-xl font-bold">Your projects</h2>
                {projects.length === 0 ? (
                    <p className="text-muted">Projects you create appear here, so you can come back and keep editing.</p>
                ) : (
                    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                        {projects.map((p) => (
                            <button key={p.id} onClick={() => onOpen(p.id)} className="panel overflow-hidden text-left transition hover:border-accent/50">
                                <div className="aspect-video bg-black/40">{p.thumb && <img src={p.thumb} alt="" className="h-full w-full object-cover" />}</div>
                                <div className="p-3">
                                    <p className="truncate font-semibold">{p.name}</p>
                                    <p className="text-xs text-muted">
                                        {p.status === 'ready' ? `${p.clips.length} clips` : p.status === 'error' ? 'Needs attention' : 'Processing…'} · {new Date(p.createdAt).toLocaleDateString()}
                                    </p>
                                </div>
                            </button>
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
}

function Option({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-2">
            <span className="text-sm font-semibold text-muted">{label}</span>
            {children}
        </div>
    );
}

export function Segmented({ value, onChange, items }: { value: string; onChange: (v: string) => void; items: { id: string; label: string }[] }) {
    return (
        <div className="flex flex-wrap gap-1 rounded-xl bg-white/[0.05] p-1">
            {items.map((i) => (
                <button key={i.id} onClick={() => onChange(i.id)} className={`grow rounded-lg px-3 py-1.5 text-sm font-medium transition ${value === i.id ? 'bg-accent text-ink' : 'text-muted hover:text-white'}`}>
                    {i.label}
                </button>
            ))}
        </div>
    );
}
