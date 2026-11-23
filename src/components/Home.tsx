import { useEffect, useMemo, useRef, useState } from 'react';
import { TEMPLATES } from '../lib/templates';
import { LANGUAGES } from '../lib/localAsr';
import type { Aspect, AsrEngine, AsrQuality, ContentMode, Picker, Project } from '../lib/types';
import { TemplateSwatch } from './ui';
import { BUILT_IN_TEMPLATES, loadPresets, type Preset } from '../lib/presets';

export type NewProjectInput = {
    file: File;
    chatFile?: File;
    aspect: Aspect;
    template: string;
    highlight: string;
    options: Project['options'];
    /** captions-only: keep the video's own shape */
    keepShape?: boolean;
    /** a look applied to every clip */
    preset?: Preset;
};

const LONG_MINUTES = 40;
/** Video length in minutes, read from the file's header (0 if the browser can't tell). */
function videoMinutes(f: File): Promise<number> {
    return new Promise((res) => {
        const v = document.createElement('video');
        const url = URL.createObjectURL(f);
        const done = (m: number) => { URL.revokeObjectURL(url); v.removeAttribute('src'); res(m); };
        const t = setTimeout(() => done(0), 8000);
        v.preload = 'metadata';
        v.onloadedmetadata = () => { clearTimeout(t); done(Number.isFinite(v.duration) ? v.duration / 60 : 0); };
        v.onerror = () => { clearTimeout(t); done(0); };
        v.src = url;
    });
}

const LENGTHS = [
    { id: 'auto', label: 'Auto', min: 15, max: 90 },
    { id: 'short', label: 'Under 30s', min: 10, max: 30 },
    { id: 'mid', label: '30–60s', min: 30, max: 60 },
    { id: 'long', label: '60–90s', min: 60, max: 90 }
];

export const MODES: { id: ContentMode; label: string; hint: string }[] = [
    { id: 'viral', label: 'Most viral', hint: 'Best of everything' },
    { id: 'funny', label: 'Funny', hint: 'Jokes, banter, reactions' },
    { id: 'gaming', label: '🎮 Gaming', hint: 'Rage, fails, chaos, hype' },
    { id: 'insightful', label: 'Insightful', hint: 'Advice and facts' },
    { id: 'story', label: 'Stories', hint: 'Anecdotes with a payoff' },
    { id: 'hot-takes', label: 'Hot takes', hint: 'Bold opinions, debates' }
];

export const PICKERS: { id: Picker; label: string; hint: string }[] = [
    { id: 'chat', label: 'With Claude chat', hint: 'Free · smartest · copy & paste once' },
    { id: 'laughs', label: 'Laugh detector', hint: 'Free · automatic · needs audible laughs' },
    { id: 'api', label: 'Claude API', hint: 'Paid · automatic · needs a key' }
];

const ASPECTS: { id: Aspect; label: string; hint: string }[] = [
    { id: '9:16', label: '9:16', hint: 'Shorts, TikTok, Reels' },
    { id: '1:1', label: '1:1', hint: 'Feed posts' },
    { id: '16:9', label: '16:9', hint: 'YouTube, X' }
];

type Props = {
    projects: Project[];
    running: Record<string, { label: string; ratio: number }>;
    onCreate: (inputs: NewProjectInput[]) => Promise<void>;
    onOpen: (id: string) => void;
    onOpenClip: (projectId: string, clipId: string) => void;
    onRestore: (projects: Project[]) => void;
    accessCode: string;
    setAccessCode: (c: string) => void;
};

export default function Home({ projects, running, onCreate, onOpen, onOpenClip, onRestore, accessCode, setAccessCode }: Props) {
    const [files, setFiles] = useState<File[]>([]);
    const file = files[0] ?? null;
    const [presetName, setPresetName] = useState('');
    const [savedPresets, setSavedPresets] = useState<Preset[]>([]);
    useEffect(() => setSavedPresets(loadPresets()), []);
    const allPresets = [...BUILT_IN_TEMPLATES, ...savedPresets];
    const [job, setJob] = useState<'clips' | 'captions'>('clips');
    const [keepShape, setKeepShape] = useState(true);
    const captionsOnly = job === 'captions';
    const [length, setLength] = useState('auto');
    const [maxClips, setMaxClips] = useState(10);
    const [aspect, setAspect] = useState<Aspect>('9:16');
    const [template, setTemplate] = useState('punch');
    const [topic, setTopic] = useState('');
    const [mode, setMode] = useState<ContentMode>('funny');
    const [picker, setPicker] = useState<Picker>('chat');
    const [asr, setAsr] = useState<AsrEngine>('local');
    const [language, setLanguage] = useState('english');
    const [asrQuality, setAsrQuality] = useState<AsrQuality>('fast');
    const [speedBoost, setSpeedBoost] = useState(false);
    // optional face zoom on awkward silences, off unless you switch it on (remembered)
    const [faceZoom, setFaceZoomState] = useState(false);
    useEffect(() => {
        try {
            setFaceZoomState(localStorage.getItem('clipsmith.faceZoom') === '1');
        } catch {
            /* no storage: stays off */
        }
    }, []);
    const setFaceZoom = (on: boolean) => {
        setFaceZoomState(on);
        try {
            localStorage.setItem('clipsmith.faceZoom', on ? '1' : '0');
        } catch {
            /* not important */
        }
    };
    const boostTouched = useRef(false);
    const [longestMin, setLongestMin] = useState(0);
    const [gpu, setGpu] = useState<boolean | null>(null);
    const [f16, setF16] = useState(false);
    const [chatFile, setChatFile] = useState<File | null>(null);
    const [backupMsg, setBackupMsg] = useState('');

    // check once whether free captions can use the graphics card (much faster)
    useEffect(() => {
        const nav = navigator as Navigator & { gpu?: { requestAdapter: () => Promise<{ features: Set<string> } | null> } };
        (nav.gpu ? nav.gpu.requestAdapter().catch(() => null) : Promise.resolve(null)).then((a) => {
            const half = !!a?.features.has('shader-f16');
            setGpu(!!a);
            setF16(half);
            // "Best" is a big download, so it is never the default; "Accurate" is a good balance
            // "Accurate" gives by far the best words and timing, so it's the default everywhere
            setAsrQuality('accurate');
        });
    }, []);

    const topClips = useMemo(
        () =>
            projects
                .filter((p) => p.status === 'ready')
                .flatMap((p) => p.clips.map((c) => ({ p, c })))
                .sort((a, b) => b.c.score - a.c.score)
                .slice(0, 8),
        [projects]
    );
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    // how long the picked videos are, to protect long streams from running out of memory
    useEffect(() => {
        let alive = true;
        setLongestMin(0);
        Promise.all(files.map((f) => videoMinutes(f))).then((m) => alive && setLongestMin(Math.max(0, ...m)));
        return () => { alive = false; };
    }, [files]);
    const longVideo = longestMin >= LONG_MINUTES;
    const lowMemory = ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 4;
    // a long stream with the heavy caption model is what makes Chrome run out of memory,
    // so Speed boost switches on by itself (unless you turned it off yourself)
    useEffect(() => {
        if (longVideo && !boostTouched.current && asr === 'local' && !captionsOnly && (asrQuality === 'accurate' || asrQuality === 'best')) setSpeedBoost(true);
    }, [longVideo, asr, captionsOnly, asrQuality]);

    function pick(list?: FileList | File[] | null) {
        const all = Array.from(list ?? []);
        if (!all.length) return;
        const ok = all.filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|mkv|webm|m4v)$/i.test(f.name));
        if (!ok.length) {
            setError('Please choose a video file (MP4, MOV, WebM or MKV).');
            return;
        }
        setError(ok.length < all.length ? `Skipped ${all.length - ok.length} file(s) that are not videos.` : '');
        setFiles(ok);
    }

    async function start() {
        if (!file) return;
        const len = LENGTHS.find((l) => l.id === length)!;
        const tpl = TEMPLATES.find((t) => t.id === template)!;
        setBusy(true);
        try {
            const preset = captionsOnly ? undefined : allPresets.find((p) => p.name === presetName);
            await onCreate(
                files.map((f) => ({
                    file: f,
                    // a chat replay belongs to one stream, so it is only used for a single video
                    chatFile: files.length === 1 ? chatFile ?? undefined : undefined,
                    aspect,
                    template,
                    highlight: tpl.defaultHighlight,
                    keepShape: captionsOnly && keepShape,
                    preset,
                    options: { minSeconds: len.min, maxSeconds: len.max, maxClips, topic, mode, picker, asr, language, asrQuality, captionsOnly, speedBoost: speedBoost && asr === 'local' && !captionsOnly, faceZoom: faceZoom && !captionsOnly }
                }))
            );
            // a batch stays on this page: get ready for the next one
            setBusy(false);
            setFiles([]);
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
                        <div className="flex w-fit gap-1 rounded-xl bg-black/30 p-1" role="tablist" aria-label="What to make">
                            {[
                                { id: 'clips', label: '✂ Find clips' },
                                { id: 'captions', label: '💬 Captions only' }
                            ].map((j) => (
                                <button key={j.id} role="tab" aria-selected={job === j.id} onClick={() => setJob(j.id as 'clips' | 'captions')} className={`rounded-lg px-4 py-2 text-sm font-bold transition ${job === j.id ? 'bg-accent text-ink' : 'text-muted hover:text-white'}`}>
                                    {j.label}
                                </button>
                            ))}
                        </div>
                        <div>
                            <h1 className="!text-3xl sm:!text-4xl">{captionsOnly ? 'Add captions to your whole video' : 'Turn one long video into viral clips'}</h1>
                            <p className="mt-2 text-muted">{captionsOnly ? 'No cutting: you get the same video back with animated captions burned in, plus a captions file (.srt) and the transcript (.txt).' : 'AI finds the best moments, reframes them around the speaker, and adds animated captions.'}</p>
                        </div>
                        <label
                            className={`flex min-h-48 cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-6 text-center transition ${file ? 'border-accent/60 bg-accent/5' : 'border-white/15 bg-white/[0.03] hover:border-accent/60'}`}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                                e.preventDefault();
                                pick(e.dataTransfer.files);
                            }}
                        >
                            <input type="file" accept="video/*,.mkv" multiple className="sr-only" onChange={(e) => pick(e.target.files)} />
                            <span className="grid size-14 place-items-center rounded-full bg-accent text-2xl text-ink">↑</span>
                            {files.length > 1 ? (
                                <>
                                    <span className="font-semibold">{files.length} videos</span>
                                    <span className="max-w-full text-left text-xs text-muted">
                                        {files.slice(0, 5).map((f) => (
                                            <span key={f.name} className="block truncate">• {f.name}</span>
                                        ))}
                                        {files.length > 5 && <span className="block">…and {files.length - 5} more</span>}
                                    </span>
                                    <span className="text-sm text-muted">Processed one after another · click to change</span>
                                </>
                            ) : file ? (
                                <>
                                    <span className="font-semibold break-all">{file.name}</span>
                                    <span className="text-sm text-muted">{(file.size / 1048576).toFixed(0)} MB · click to change</span>
                                </>
                            ) : (
                                <>
                                    <span className="font-semibold">Drop a video or click to upload</span>
                                    <span className="text-sm text-muted">Streams, podcasts and talks work best · pick several to batch them</span>
                                </>
                            )}
                        </label>
                        {error && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-200">{error}</p>}
                        {longVideo && asr === 'local' && (
                            <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-100" data-long-warning>
                                <b className="text-amber-50">Long video ({Math.round(longestMin)} min).</b>{' '}
                                {!captionsOnly && speedBoost
                                    ? '⚡ Speed boost is on, so it uses much less memory and is faster. Your clips still get Accurate captions.'
                                    : !captionsOnly && (asrQuality === 'accurate' || asrQuality === 'best')
                                      ? 'Accurate captions on a long stream need a lot of memory and Chrome may close the tab.'
                                      : 'This takes a while.'}{' '}
                                Close other tabs and games while it works. If the tab closes, open the project, pick the same video and click Continue: it carries on where it stopped.
                                {(lowMemory || longestMin >= 90) && ' For streams over 1.5 hours, splitting the recording into parts is safest.'}
                                {!captionsOnly && !speedBoost && (asrQuality === 'accurate' || asrQuality === 'best') && (
                                    <button className="mt-2 block rounded-lg bg-amber-400/20 px-2 py-1 font-semibold text-amber-50 hover:bg-amber-400/30" onClick={() => { boostTouched.current = true; setSpeedBoost(true); }}>
                                        ⚡ Turn on Speed boost
                                    </button>
                                )}
                            </div>
                        )}
                        <button className="btn-accent" disabled={!file || busy} onClick={start}>
                            {busy ? 'Starting…' : files.length > 1 ? (captionsOnly ? `Add captions to ${files.length} videos` : `Get clips from ${files.length} videos`) : captionsOnly ? 'Add captions' : 'Get clips in 1 click'}
                        </button>
                        <p className="text-xs text-muted">Only clip videos you own or have permission to use. Your video stays in your browser; only the audio is sent for transcription.</p>
                    </div>

                    <div className="flex flex-col gap-5 border-t border-white/10 bg-white/[0.02] p-5 sm:p-8 lg:border-t-0 lg:border-l">
                        <Option label="Language spoken in the video">
                            <select className="input" value={language} onChange={(e) => setLanguage(e.target.value)}>
                                {LANGUAGES.map((l) => (
                                    <option key={l.id} value={l.id}>
                                        {l.label}
                                    </option>
                                ))}
                            </select>
                        </Option>
                        {!captionsOnly && (<>
                        <Option label="Template (applied to every clip)">
                            <div className="grid grid-cols-2 gap-2">
                                {[{ name: '', builtIn: true } as Preset & { name: string }, ...allPresets].map((p) => (
                                    <button key={p.name || 'none'} onClick={() => setPresetName(p.name)} className={`rounded-xl border px-3 py-2 text-left ${presetName === p.name ? 'border-accent bg-accent/10' : 'border-white/10 hover:bg-white/5'}`}>
                                        <span className="block truncate text-sm font-bold">{p.name || 'None'}</span>
                                        <span className="block truncate text-xs text-muted">{p.name ? (p.builtIn ? templateHint(p) : 'Your saved preset') : 'Set up each clip yourself'}</span>
                                    </button>
                                ))}
                            </div>
                        </Option>
                        <Option label="How to pick clips">
                            <div className="grid gap-2 sm:grid-cols-3">
                                {PICKERS.map((m) => (
                                    <button key={m.id} onClick={() => setPicker(m.id)} className={`rounded-xl border px-3 py-2 text-left ${picker === m.id ? 'border-accent bg-accent/10' : 'border-white/10 hover:bg-white/5'}`}>
                                        <span className="block text-sm font-bold">{m.label}</span>
                                        <span className="block text-xs text-muted">{m.hint}</span>
                                    </button>
                                ))}
                            </div>
                        </Option>
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
                        </>)}
                        <Option label="Aspect ratio">
                            <div className={`grid gap-2 ${captionsOnly ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3'}`}>
                                {captionsOnly && (
                                    <button onClick={() => setKeepShape(true)} className={`rounded-xl border px-2 py-2 text-left ${keepShape ? 'border-accent bg-accent/10' : 'border-white/10 hover:bg-white/5'}`}>
                                        <span className="block font-bold">Same</span>
                                        <span className="block text-xs text-muted">As the video</span>
                                    </button>
                                )}
                                {ASPECTS.map((a) => (
                                    <button key={a.id} onClick={() => { setAspect(a.id); setKeepShape(false); }} className={`rounded-xl border px-2 py-2 text-left ${aspect === a.id && !(captionsOnly && keepShape) ? 'border-accent bg-accent/10' : 'border-white/10 hover:bg-white/5'}`}>
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
                        {!captionsOnly && (<>
                        <Option label="Stream chat replay (optional)">
                            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-white/10 px-3 py-2 text-sm hover:bg-white/5">
                                <span className="min-w-0 truncate">{chatFile ? `💬 ${chatFile.name}` : 'Add the chat file to find moments where chat exploded'}</span>
                                <span className="text-xs text-accent">{chatFile ? 'Change' : 'Choose'}</span>
                                <input type="file" accept=".json,.txt,.log,application/json,text/plain" className="sr-only" onChange={(e) => setChatFile(e.target.files?.[0] ?? null)} />
                            </label>
                            <span className="text-xs text-muted">Twitch chat JSON (TwitchDownloader), YouTube live chat JSON (yt-dlp) or a text log with timestamps.</span>
                        </Option>
                        <Option label="Effects (optional)">
                            <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-white/10 px-3 py-2 text-sm hover:bg-white/5">
                                <input type="checkbox" className="mt-1 accent-[var(--color-accent)]" checked={faceZoom} onChange={(e) => setFaceZoom(e.target.checked)} data-face-zoom />
                                <span>
                                    <b>😶 Face zoom on awkward silences</b>
                                    <span className="block text-xs text-muted">When nobody talks for a moment, it slowly zooms in on the face, aimed at the eyes and mouth (works on faces that are only eyes and a mouth too). You can switch it off per clip in the editor.</span>
                                </span>
                            </label>
                        </Option>
                        <Option label="Game or topic (optional, also added as a hashtag)">
                            <input className="input" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. GTA 6" />
                        </Option>
                        </>)}
                        <details className="text-sm">
                            <summary className="cursor-pointer text-muted">Caption settings</summary>
                            <div className="mt-3 flex flex-col gap-3">
                                <Segmented
                                    value={asr}
                                    onChange={(v) => setAsr(v as AsrEngine)}
                                    items={[{ id: 'local', label: 'Free (on your PC)' }, { id: 'openai', label: 'OpenAI (paid, faster)' }]}
                                />
                                {asr === 'local' && (
                                    <Segmented
                                        value={asrQuality}
                                        onChange={(v) => setAsrQuality(v as AsrQuality)}
                                        items={[
                                            { id: 'fastest', label: 'Fastest' },
                                            { id: 'fast', label: 'Balanced' },
                                            { id: 'accurate', label: 'Accurate (recommended)' },
                                            ...(gpu && f16 ? [{ id: 'best', label: 'Best (big download)' }] : [])
                                        ]}
                                    />
                                )}
                                {asr === 'local' && !captionsOnly && (
                                    <label className="flex items-start gap-2 rounded-lg bg-white/[0.04] px-3 py-2 text-xs">
                                        <input type="checkbox" className="mt-0.5 accent-[var(--color-accent)]" checked={speedBoost} onChange={(e) => { boostTouched.current = true; setSpeedBoost(e.target.checked); }} />
                                        <span>
                                            <b className="text-white">⚡ Speed boost for long videos (optional)</b>
                                            <span className="block text-muted">Quick captions to find the moments, then Accurate captions only for your clips. Much faster on long streams; the clips get the same caption quality.</span>
                                        </span>
                                    </label>
                                )}
                                {gpu === true && <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">✓ Your computer can use its graphics card, so captions will be fast. “Accurate” is selected (about 250 MB, downloaded once).{f16 ? ' “Best” is a little more accurate but a ~1.4 GB download.' : ''}</p>}
                                {gpu === false && <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-100">Your browser can’t use the graphics card here, so free captions run on the processor. “Accurate” is selected because it gives the best words and timing; it takes about as long as the video. Balanced or Fastest are quicker but less precise. Up-to-date Chrome or Edge can help.</p>}
                                <p className="text-xs text-muted">Free captions run on your computer. The first time, the speech model downloads once (about 40 MB for Fastest, 250 MB for Accurate, ~1.4 GB for Best). You can fix any misheard words afterwards in the editor.</p>
                            </div>
                        </details>
                        <details className="text-sm">
                            <summary className="cursor-pointer text-muted">Access code</summary>
                            <input className="input mt-2" type="password" value={accessCode} onChange={(e) => setAccessCode(e.target.value)} placeholder="Only if your site uses one" />
                        </details>
                    </div>
                </div>
            </section>

            {topClips.length > 1 && projects.filter((p) => p.status === 'ready').length > 1 && (
                <section>
                    <h2 className="mb-1 text-xl font-bold">Best clips across all your videos</h2>
                    <p className="mb-4 text-sm text-muted">Your highest-scoring moments from every project, ready to post first.</p>
                    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                        {topClips.map(({ p, c }) => (
                            <button key={`${p.id}-${c.id}`} onClick={() => onOpenClip(p.id, c.id)} className="panel overflow-hidden text-left transition hover:border-accent/50">
                                <div className="relative aspect-video bg-black/40">
                                    {c.thumb && <img src={c.thumb} alt="" className="h-full w-full object-cover" />}
                                    <span className="absolute top-2 left-2 rounded-md bg-accent px-1.5 text-xs font-extrabold text-ink">{c.score}</span>
                                </div>
                                <div className="p-3">
                                    <p className="line-clamp-2 text-sm font-semibold">{c.title}</p>
                                    <p className="truncate text-xs text-muted">{p.name}</p>
                                </div>
                            </button>
                        ))}
                    </div>
                </section>
            )}

            <section>
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-xl font-bold">Your projects</h2>
                    <div className="flex flex-wrap gap-2">
                        <button
                            className="btn-ghost !py-1.5"
                            disabled={!projects.length}
                            onClick={() => {
                                // music files are left out to keep the backup small
                                const data = JSON.stringify({ app: 'clipsmith', version: 1, projects: projects.map((p) => ({ ...p, music: undefined })) });
                                const a = document.createElement('a');
                                a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
                                a.download = `clipsmith-backup-${new Date().toISOString().slice(0, 10)}.json`;
                                a.click();
                                setTimeout(() => URL.revokeObjectURL(a.href), 10000);
                                setBackupMsg(`Saved a backup of ${projects.length} project${projects.length > 1 ? 's' : ''}. Keep the file somewhere safe.`);
                            }}
                        >
                            ⬇ Back up projects
                        </button>
                        <label className="btn-ghost cursor-pointer !py-1.5">
                            ⬆ Restore backup
                            <input
                                type="file"
                                accept=".json,application/json"
                                className="sr-only"
                                onChange={async (e) => {
                                    const f = e.target.files?.[0];
                                    if (!f) return;
                                    try {
                                        const data = JSON.parse(await f.text());
                                        if (data.app !== 'clipsmith' || !Array.isArray(data.projects)) throw new Error();
                                        onRestore(data.projects as Project[]);
                                        setBackupMsg(`Restored ${data.projects.length} project${data.projects.length > 1 ? 's' : ''}. Select each video again when you open it.`);
                                    } catch {
                                        setBackupMsg('That file is not a ClipHeist backup.');
                                    }
                                }}
                            />
                        </label>
                    </div>
                </div>
                {backupMsg && <p className="mb-3 text-sm text-accent">{backupMsg}</p>}
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
                                        {statusText(p, running[p.id])} · {new Date(p.createdAt).toLocaleDateString()}
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

function statusText(p: Project, run?: { label: string; ratio: number }) {
    if (p.status === 'ready') return `${p.clips.length} clips`;
    if (p.status === 'error') return 'Needs attention';
    if (p.status === 'awaiting-paste') return 'Your turn: paste Claude’s answer';
    if (run?.label.startsWith('Waiting in line')) return 'In line, waiting';
    if (run) return `Working… ${Math.round(run.ratio * 100)}%`;
    return 'Stopped – open to continue';
}

function templateHint(p: Preset): string {
    const bits: string[] = [];
    if (p.style.layout === 'split') bits.push('facecam on top');
    if (p.style.layout === 'pip') bits.push('facecam bubble');
    if (p.fx.transition && p.fx.transition.kind !== 'none') bits.push(`${p.fx.transition.kind} cuts`);
    if (p.fx.replay) bits.push('replay');
    if (p.fx.silences) bits.push('no pauses');
    if (p.fx.sfx) bits.push('sounds');
    return bits.join(' · ') || 'Title + zooms';
}
