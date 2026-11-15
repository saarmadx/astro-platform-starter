import { useEffect, useMemo, useRef, useState } from 'react';
import { findClips, transcribeVideo } from '../lib/api';
import { groupWords, wordsInRange } from '../lib/captions';
import { renderClip } from '../lib/video';
import type { CaptionStyle, Clip, ExportSettings, Transcript } from '../lib/types';

type Stage = 'upload' | 'processing' | 'results';

const ACCESS_KEY = 'clipsmith.accessCode';

function fmt(t: number) {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

function readVideoDuration(url: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.onloadedmetadata = () => resolve(v.duration);
        v.onerror = () => reject(new Error('This file could not be opened as a video.'));
        v.src = url;
    });
}

function scoreColor(score: number) {
    if (score >= 80) return 'bg-accent text-ink';
    if (score >= 60) return 'bg-amber-300 text-ink';
    return 'bg-white/15 text-white';
}

export default function Studio() {
    const [stage, setStage] = useState<Stage>('upload');
    const [file, setFile] = useState<File | null>(null);
    const [videoUrl, setVideoUrl] = useState('');
    const [duration, setDuration] = useState(0);
    const [error, setError] = useState('');
    const [status, setStatus] = useState({ label: '', ratio: 0 });

    const [minSeconds, setMinSeconds] = useState(20);
    const [maxSeconds, setMaxSeconds] = useState(60);
    const [maxClips, setMaxClips] = useState(8);
    const [topic, setTopic] = useState('');
    const [accessCode, setAccessCode] = useState('');

    const [transcript, setTranscript] = useState<Transcript | null>(null);
    const [clips, setClips] = useState<Clip[]>([]);
    const [selectedId, setSelectedId] = useState('');

    useEffect(() => {
        try {
            setAccessCode(localStorage.getItem(ACCESS_KEY) ?? '');
        } catch {}
    }, []);

    async function pickFile(f: File | undefined) {
        if (!f) return;
        setError('');
        if (!f.type.startsWith('video/') && !/\.(mp4|mov|mkv|webm|m4v)$/i.test(f.name)) {
            setError('Please choose a video file (MP4, MOV, WebM or MKV).');
            return;
        }
        const url = URL.createObjectURL(f);
        try {
            const d = await readVideoDuration(url);
            if (videoUrl) URL.revokeObjectURL(videoUrl);
            setFile(f);
            setVideoUrl(url);
            setDuration(d);
        } catch (e) {
            URL.revokeObjectURL(url);
            setError((e as Error).message);
        }
    }

    async function generate() {
        if (!file) return;
        setError('');
        setStage('processing');
        try {
            localStorage.setItem(ACCESS_KEY, accessCode);
        } catch {}
        try {
            let t = transcript;
            if (!t) {
                setStatus({ label: 'Loading video engine', ratio: 0 });
                t = await transcribeVideo(file, duration, accessCode, (label, ratio) => setStatus({ label, ratio }));
                if (t.words.length === 0) throw new Error('No speech was found in this video.');
                setTranscript(t);
            }
            setStatus({ label: 'AI is finding the best moments', ratio: 0.5 });
            const found = await findClips(t, { minSeconds, maxSeconds, maxClips, topic }, accessCode);
            if (found.length === 0) throw new Error('The AI did not find any good clips. Try a different clip length.');
            setClips(found);
            setSelectedId(found[0].id);
            setStage('results');
        } catch (e) {
            setError((e as Error).message);
            setStage('upload');
        }
    }

    function reset() {
        if (videoUrl) URL.revokeObjectURL(videoUrl);
        setFile(null);
        setVideoUrl('');
        setTranscript(null);
        setClips([]);
        setStage('upload');
    }

    if (stage === 'processing') return <Processing label={status.label} ratio={status.ratio} />;

    if (stage === 'results' && file && transcript) {
        return (
            <Results
                file={file}
                videoUrl={videoUrl}
                transcript={transcript}
                clips={clips}
                setClips={setClips}
                selectedId={selectedId}
                setSelectedId={setSelectedId}
                onRegenerate={() => setStage('upload')}
                onNewVideo={reset}
            />
        );
    }

    return (
        <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[1.3fr_1fr]">
            <section className="panel p-5 sm:p-6">
                <h2 className="text-xl font-bold">1. Add your video</h2>
                <p className="mt-1 text-sm text-muted">Long videos with talking work best: podcasts, interviews, talks, streams.</p>
                <label
                    className="mt-5 flex min-h-56 cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-white/15 bg-white/[0.03] p-6 text-center transition hover:border-accent/60 hover:bg-accent/5"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                        e.preventDefault();
                        pickFile(e.dataTransfer.files[0]);
                    }}
                >
                    <input type="file" accept="video/*,.mkv" className="sr-only" onChange={(e) => pickFile(e.target.files?.[0])} />
                    {file ? (
                        <>
                            <video src={videoUrl} className="max-h-48 rounded-lg" muted />
                            <span className="font-semibold break-all">{file.name}</span>
                            <span className="text-sm text-muted">
                                {fmt(duration)} · {(file.size / 1024 / 1024).toFixed(0)} MB · click to change
                            </span>
                        </>
                    ) : (
                        <>
                            <span className="grid size-14 place-items-center rounded-full bg-accent text-2xl text-ink">↑</span>
                            <span className="font-semibold">Drop a video here or click to browse</span>
                            <span className="text-sm text-muted">MP4, MOV, WebM · stays on your device until you export</span>
                        </>
                    )}
                </label>
                <p className="mt-3 text-xs text-muted">
                    Only clip videos you own or have permission to use. Your video is processed in your browser; only the audio is sent for transcription.
                </p>
            </section>

            <section className="panel flex flex-col gap-4 p-5 sm:p-6">
                <h2 className="text-xl font-bold">2. Choose your clips</h2>
                <div className="grid grid-cols-2 gap-3">
                    <Field label="Min length (s)">
                        <input type="number" min={5} max={170} value={minSeconds} onChange={(e) => setMinSeconds(+e.target.value)} className="input" />
                    </Field>
                    <Field label="Max length (s)">
                        <input type="number" min={10} max={180} value={maxSeconds} onChange={(e) => setMaxSeconds(+e.target.value)} className="input" />
                    </Field>
                </div>
                <Field label={`Number of clips: ${maxClips}`}>
                    <input type="range" min={1} max={15} value={maxClips} onChange={(e) => setMaxClips(+e.target.value)} className="w-full accent-[var(--color-accent)]" />
                </Field>
                <Field label="Focus on a topic (optional)">
                    <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. money advice, funny moments" className="input" />
                </Field>
                <Field label="Access code (if your site uses one)">
                    <input value={accessCode} onChange={(e) => setAccessCode(e.target.value)} type="password" className="input" />
                </Field>
                {error && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-200">{error}</p>}
                <button className="btn-accent mt-auto" disabled={!file} onClick={generate}>
                    {transcript ? 'Find new clips' : 'Generate clips'} →
                </button>
            </section>
        </div>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-muted">{label}</span>
            {children}
        </label>
    );
}

function Processing({ label, ratio }: { label: string; ratio: number }) {
    return (
        <div className="panel mx-auto flex max-w-lg flex-col items-center gap-5 p-8 text-center">
            <div className="size-14 animate-spin rounded-full border-4 border-white/10 border-t-accent" />
            <div>
                <p className="text-lg font-semibold">{label || 'Working'}…</p>
                <p className="mt-1 text-sm text-muted">Keep this tab open. A one-hour video takes a few minutes.</p>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.round(ratio * 100)}%` }} />
            </div>
        </div>
    );
}

type ResultsProps = {
    file: File;
    videoUrl: string;
    transcript: Transcript;
    clips: Clip[];
    setClips: (c: Clip[]) => void;
    selectedId: string;
    setSelectedId: (id: string) => void;
    onRegenerate: () => void;
    onNewVideo: () => void;
};

function Results({ file, videoUrl, transcript, clips, setClips, selectedId, setSelectedId, onRegenerate, onNewVideo }: ResultsProps) {
    const [settings, setSettings] = useState<ExportSettings>({
        captionStyle: 'pop',
        highlightColor: '#c8ff3d',
        cropX: 0.5,
        wordsPerLine: 3
    });
    const [exporting, setExporting] = useState<{ id: string; ratio: number } | null>(null);
    const [exportError, setExportError] = useState('');
    const clip = clips.find((c) => c.id === selectedId) ?? clips[0];

    function updateClip(patch: Partial<Clip>) {
        setClips(clips.map((c) => (c.id === clip.id ? { ...c, ...patch } : c)));
    }

    async function exportClip(c: Clip) {
        setExportError('');
        setExporting({ id: c.id, ratio: 0 });
        try {
            const blob = await renderClip(file, c, transcript.words, settings, (ratio) => setExporting({ id: c.id, ratio }));
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${c.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'clip'}.mp4`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        } catch (e) {
            setExportError((e as Error).message);
        } finally {
            setExporting(null);
        }
    }

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 className="text-2xl font-bold">{clips.length} clips found</h2>
                    <p className="text-sm text-muted break-all">{file.name}</p>
                </div>
                <div className="flex gap-2">
                    <button className="btn-ghost" onClick={onRegenerate}>Change settings</button>
                    <button className="btn-ghost" onClick={onNewVideo}>New video</button>
                </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px_minmax(0,1fr)]">
                {/* clip list */}
                <ul className="order-2 flex flex-col gap-2 lg:order-1 lg:max-h-[78vh] lg:overflow-y-auto lg:pr-1">
                    {clips.map((c, i) => (
                        <li key={c.id}>
                            <button
                                onClick={() => setSelectedId(c.id)}
                                className={`w-full rounded-xl border p-3 text-left transition ${c.id === clip.id ? 'border-accent/70 bg-accent/10' : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]'}`}
                            >
                                <div className="flex items-start gap-3">
                                    <span className={`shrink-0 rounded-md px-2 py-0.5 text-sm font-bold ${scoreColor(c.score)}`}>{c.score}</span>
                                    <div className="min-w-0">
                                        <p className="font-semibold leading-snug">
                                            #{i + 1} {c.title}
                                        </p>
                                        <p className="mt-0.5 text-xs text-muted">
                                            {fmt(c.start)} – {fmt(c.end)} · {Math.round(c.end - c.start)}s
                                        </p>
                                    </div>
                                </div>
                            </button>
                        </li>
                    ))}
                </ul>

                {/* phone preview */}
                <div className="order-1 lg:order-2">
                    <Preview videoUrl={videoUrl} clip={clip} transcript={transcript} settings={settings} />
                </div>

                {/* editor */}
                <div className="order-3 flex flex-col gap-4">
                    <div className="panel flex flex-col gap-3 p-4">
                        <Field label="Title">
                            <input className="input" value={clip.title} onChange={(e) => updateClip({ title: e.target.value })} />
                        </Field>
                        <div className="grid grid-cols-2 gap-3">
                            <Field label={`Start ${fmt(clip.start)}`}>
                                <Nudge value={clip.start} onChange={(v) => updateClip({ start: Math.max(0, Math.min(v, clip.end - 3)) })} />
                            </Field>
                            <Field label={`End ${fmt(clip.end)}`}>
                                <Nudge value={clip.end} onChange={(v) => updateClip({ end: Math.max(v, clip.start + 3) })} />
                            </Field>
                        </div>
                        <p className="text-sm">
                            <span className="font-semibold text-accent">Hook: </span>
                            {clip.hook}
                        </p>
                        <p className="text-sm text-muted">{clip.reason}</p>
                    </div>

                    <div className="panel flex flex-col gap-3 p-4">
                        <p className="font-semibold">Captions & framing</p>
                        <div className="grid grid-cols-4 gap-1.5">
                            {(['pop', 'boxed', 'clean', 'none'] as CaptionStyle[]).map((s) => (
                                <button
                                    key={s}
                                    onClick={() => setSettings({ ...settings, captionStyle: s })}
                                    className={`rounded-lg px-2 py-1.5 text-sm font-medium capitalize ${settings.captionStyle === s ? 'bg-accent text-ink' : 'bg-white/[0.06] hover:bg-white/10'}`}
                                >
                                    {s}
                                </button>
                            ))}
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <Field label="Highlight colour">
                                <input type="color" value={settings.highlightColor} onChange={(e) => setSettings({ ...settings, highlightColor: e.target.value })} className="h-9 w-full cursor-pointer rounded-lg bg-transparent" />
                            </Field>
                            <Field label={`Words per line: ${settings.wordsPerLine}`}>
                                <input type="range" min={1} max={6} value={settings.wordsPerLine} onChange={(e) => setSettings({ ...settings, wordsPerLine: +e.target.value })} className="w-full accent-[var(--color-accent)]" />
                            </Field>
                        </div>
                        <Field label="Framing (move the crop left or right to follow the speaker)">
                            <input type="range" min={0} max={1} step={0.01} value={settings.cropX} onChange={(e) => setSettings({ ...settings, cropX: +e.target.value })} className="w-full accent-[var(--color-accent)]" />
                        </Field>
                    </div>

                    <div className="panel flex flex-col gap-2 p-4">
                        <p className="font-semibold">Upload text</p>
                        <textarea className="input min-h-24 text-sm" value={`${clip.description}\n\n${clip.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')}`} readOnly />
                        <button className="btn-ghost" onClick={() => navigator.clipboard.writeText(`${clip.title}\n\n${clip.description}\n\n${clip.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')}`)}>
                            Copy title + description
                        </button>
                    </div>

                    {exportError && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-200">{exportError}</p>}
                    <button className="btn-accent" disabled={!!exporting} onClick={() => exportClip(clip)}>
                        {exporting?.id === clip.id ? `Rendering… ${Math.round(exporting.ratio * 100)}%` : exporting ? 'Another clip is rendering…' : 'Export MP4 (9:16, 720p)'}
                    </button>
                    <p className="text-xs text-muted">Rendering happens on your device and can take a minute or two per clip.</p>
                </div>
            </div>
        </div>
    );
}

function Nudge({ value, onChange }: { value: number; onChange: (v: number) => void }) {
    return (
        <div className="flex gap-1">
            {[-1, -0.25, 0.25, 1].map((d) => (
                <button key={d} className="flex-1 rounded-lg bg-white/[0.06] py-1.5 text-xs font-medium hover:bg-white/10" onClick={() => onChange(+(value + d).toFixed(2))}>
                    {d > 0 ? `+${d}` : d}s
                </button>
            ))}
        </div>
    );
}

/** Live 9:16 preview that loops the clip and draws the same captions the export will burn in. */
function Preview({ videoUrl, clip, transcript, settings }: { videoUrl: string; clip: Clip; transcript: Transcript; settings: ExportSettings }) {
    const ref = useRef<HTMLVideoElement>(null);
    const [time, setTime] = useState(clip.start);
    const [playing, setPlaying] = useState(false);

    const groups = useMemo(() => groupWords(wordsInRange(transcript.words, clip.start, clip.end), settings.wordsPerLine), [transcript, clip.start, clip.end, settings.wordsPerLine]);

    useEffect(() => {
        const v = ref.current;
        if (!v) return;
        v.currentTime = clip.start;
        setTime(clip.start);
    }, [clip.id, clip.start]);

    useEffect(() => {
        let raf = 0;
        const tick = () => {
            const v = ref.current;
            if (v) {
                if (v.currentTime >= clip.end || v.currentTime < clip.start - 0.5) v.currentTime = clip.start;
                setTime(v.currentTime);
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [clip.start, clip.end]);

    const group = groups.find((g, i) => time >= g[0].start && time < (groups[i + 1]?.[0].start ?? g[g.length - 1].end + 0.4));
    const upper = settings.captionStyle !== 'clean';

    return (
        <div className="mx-auto w-full max-w-[360px]">
            <div className="relative aspect-[9/16] overflow-hidden rounded-[28px] border-4 border-white/10 bg-black shadow-2xl shadow-accent/10">
                <video
                    ref={ref}
                    src={videoUrl}
                    playsInline
                    className="absolute inset-0 h-full w-full object-cover"
                    style={{ objectPosition: `${settings.cropX * 100}% 50%` }}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onClick={(e) => (e.currentTarget.paused ? e.currentTarget.play() : e.currentTarget.pause())}
                />
                {settings.captionStyle !== 'none' && group && (
                    <div className="pointer-events-none absolute inset-x-4 bottom-[28%] text-center">
                        <span
                            className={`caption-${settings.captionStyle} inline-block leading-tight`}
                            style={{ fontFamily: 'Montserrat ExtraBold, sans-serif', fontSize: settings.captionStyle === 'clean' ? 21 : 26 }}
                        >
                            {group.map((w, i) => {
                                const active = time >= w.start && (i + 1 < group.length ? time < group[i + 1].start : true);
                                const style = active && settings.captionStyle !== 'clean' ? { color: settings.highlightColor, transform: 'scale(1.08)' } : undefined;
                                return (
                                    <span key={i} className="inline-block px-[0.2em] transition-transform" style={style}>
                                        {upper ? w.text.toUpperCase() : w.text}
                                    </span>
                                );
                            })}
                        </span>
                    </div>
                )}
                {!playing && (
                    <button className="absolute inset-0 grid place-items-center bg-black/20" onClick={() => ref.current?.play()} aria-label="Play preview">
                        <span className="grid size-16 place-items-center rounded-full bg-white/90 pl-1 text-2xl text-ink">▶</span>
                    </button>
                )}
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
                <div className="h-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, ((time - clip.start) / (clip.end - clip.start)) * 100))}%` }} />
            </div>
        </div>
    );
}
