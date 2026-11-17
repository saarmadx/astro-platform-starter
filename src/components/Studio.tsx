import { useCallback, useEffect, useRef, useState } from 'react';
import { findClips, transcribeVideo } from '../lib/api';
import { projectEvents } from '../lib/audio';
import { parseChatAnswer, pickByLaughs } from '../lib/freepick';
import { chatSpikes, parseChat } from '../lib/chat';
import { analyseClip } from '../lib/faces';
import { cancelTranscription, cleanWords } from '../lib/localAsr';
import { DEFAULT_BRAND, deleteProject, listProjects, loadBrand, saveBrand, saveProject } from '../lib/store';
import type { Brand, Clip, Project, StyleSettings } from '../lib/types';
import BrandKit from './BrandKit';
import Editor from './Editor';
import { Home as HomeIcon, Palette, Scissors } from 'lucide-react';
import Home, { type NewProjectInput } from './Home';
import ProjectView from './ProjectView';

export type View = { name: 'home' } | { name: 'brand' } | { name: 'project'; id: string } | { name: 'editor'; id: string; clipId: string };

export type LoadedVideo = { file: File; url: string };

const ACCESS_KEY = 'clipsmith.accessCode';

export const DEFAULT_STYLE: StyleSettings = {
    template: 'punch',
    highlight: '#c8ff3d',
    position: 'bottom',
    wordsPerLine: 3,
    emojis: true,
    keywordHighlight: true,
    aspect: '9:16',
    layout: 'auto',
    cropX: 0.5
};

function readMeta(url: string): Promise<{ duration: number; width: number; height: number }> {
    return new Promise((resolve, reject) => {
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.onloadedmetadata = () => resolve({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
        v.onerror = () => reject(new Error('This file could not be opened as a video. Try an MP4.'));
        v.src = url;
    });
}

export default function Studio() {
    const [view, setView] = useState<View>({ name: 'home' });
    const [projects, setProjects] = useState<Project[]>([]);
    const [videos, setVideos] = useState<Record<string, LoadedVideo>>({});
    const [progress, setProgress] = useState<Record<string, { label: string; ratio: number }>>({});
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [brand, setBrandState] = useState<Brand>(DEFAULT_BRAND);
    const [accessCode, setAccessCodeState] = useState('');
    const projectsRef = useRef<Project[]>([]);
    projectsRef.current = projects;

    useEffect(() => {
        // older projects may hold speech-model glitches (long repeat runs); clean them on load
        listProjects()
            .then((ps) => setProjects(ps.map((p) => (p.transcript ? { ...p, transcript: { ...p.transcript, words: cleanWords(p.transcript.words) } } : p))))
            .catch(() => {});
        setBrandState(loadBrand());
        try {
            setAccessCodeState(localStorage.getItem(ACCESS_KEY) ?? '');
        } catch {}
    }, []);

    const setAccessCode = (c: string) => {
        setAccessCodeState(c);
        try {
            localStorage.setItem(ACCESS_KEY, c);
        } catch {}
    };
    const setBrand = (b: Brand) => {
        setBrandState(b);
        saveBrand(b);
    };

    const update = useCallback((p: Project) => {
        setProjects((ps) => {
            const exists = ps.some((x) => x.id === p.id);
            return exists ? ps.map((x) => (x.id === p.id ? p : x)) : [p, ...ps];
        });
        saveProject(p);
    }, []);

    const runTokens = useRef<Record<string, number>>({});
    const setStep = (id: string, label: string, ratio: number) => setProgress((pr) => ({ ...pr, [id]: { label, ratio } }));

    /** transcribe (if needed) -> find clips -> reframe + thumbnails */
    const runPromises = useRef<Record<string, Promise<void>>>({});
    function run(project: Project, file: File, url: string, retranscribe: boolean): Promise<void> {
        const job = runJob(project, file, url, retranscribe);
        runPromises.current[project.id] = job;
        return job;
    }

    async function runJob(project: Project, file: File, url: string, retranscribe: boolean) {
        // a newer run for the same project (e.g. after switching caption speed) replaces this one
        const token = (runTokens.current[project.id] ?? 0) + 1;
        runTokens.current[project.id] = token;
        const live = () => runTokens.current[project.id] === token;
        const save = (x: Project) => live() && update(x);
        const step = (label: string, r: number) => live() && setStep(project.id, label, r);
        let p = { ...project };
        const o = p.options;
        setErrors((e) => ({ ...e, [p.id]: '' }));
        try {
            if (!p.transcript || retranscribe) {
                p = { ...p, status: 'transcribing' };
                save(p);
                step('Loading video engine', 0.02);
                const key = `${o.asr ?? 'local'}|${o.language ?? 'english'}|${o.asrQuality ?? 'fast'}`;
                const resume = p.partial && p.partial.key === key ? p.partial : undefined;
                const transcript = await transcribeVideo(
                    file,
                    p.duration,
                    accessCode,
                    (label, r) => step(label, 0.05 + r * 0.45),
                    { asr: o.asr ?? 'local', language: o.language ?? 'english', quality: o.asrQuality ?? 'fast' },
                    resume,
                    (state) => {
                        p = { ...p, partial: { key, ...state } };
                        save(p);
                    },
                    () => !live()
                );
                if (transcript.words.length === 0) throw new Error('No speech was found in this video. Check that the video language is set correctly.');
                p = { ...p, transcript, partial: undefined };
                save(p);
            }
            const picker = o.picker ?? 'laughs';
            if (picker === 'chat') {
                // wait for the creator to paste Claude's answer (see ProjectView)
                p = { ...p, status: 'awaiting-paste' };
                save(p);
                return;
            }
            p = { ...p, status: 'clipping' };
            save(p);
            let clips: Clip[];
            if (picker === 'laughs') {
                step('Finding the biggest laughs', 0.55);
                clips = pickByLaughs(p.transcript!, projectEvents(p), o, p.duration);
                if (clips.length === 0) throw new Error('No laughs or loud reactions were found. Try "With Claude chat" to pick clips from what is said.');
            } else {
                step('AI is finding the best moments', 0.55);
                clips = await findClips(p.transcript!, o, accessCode);
                if (clips.length === 0) throw new Error('The AI did not find any clips. Try a different clip length.');
            }
            if (live()) await finish(p, clips, url);
        } catch (e) {
            if (!live()) return;
            p = { ...p, status: 'error' };
            save(p);
            const msg = e instanceof Error ? e.message : String(e);
            setErrors((er) => ({ ...er, [p.id]: /FS error|ErrnoError/.test(msg) ? 'The video engine had a hiccup. Click “Continue” to try again.' : msg }));
        } finally {
            if (live()) setProgress((pr) => {
                const n = { ...pr };
                delete n[p.id];
                return n;
            });
        }
    }

    /** reframe each clip around the speaker and grab thumbnails */
    async function finish(project: Project, found: Clip[], url: string) {
        const clips = [...found];
        let p: Project = { ...project, clips, status: 'clipping' };
        update(p);
        for (let i = 0; i < clips.length; i++) {
            setStep(p.id, `Reframing clip ${i + 1} of ${clips.length}`, 0.7 + (0.3 * i) / clips.length);
            try {
                const res = await analyseClip(url, clips[i].start, clips[i].end, p.style.aspect);
                clips[i] = { ...clips[i], track: res.track, thumb: res.thumb };
                p = { ...p, clips: [...clips], thumb: p.thumb ?? res.thumb };
                update(p);
            } catch {
                /* reframing is optional; keep the clip centred */
            }
        }
        p = { ...p, status: 'ready' };
        update(p);
    }

    /** clips pasted back from a Claude chat */
    async function pasteClips(id: string, answer: string) {
        const p = projectsRef.current.find((x) => x.id === id);
        const vid = videos[id];
        if (!p) return;
        const clips = parseChatAnswer(answer, p.duration); // throws a readable error
        if (!vid) {
            update({ ...p, clips, status: 'ready' });
            return;
        }
        try {
            await finish(p, clips, vid.url);
        } finally {
            setProgress((pr) => {
                const n = { ...pr };
                delete n[id];
                return n;
            });
        }
    }

    async function createProject(input: NewProjectInput) {
        const url = URL.createObjectURL(input.file);
        const meta = await readMeta(url);
        const project: Project = {
            id: `p${Date.now().toString(36)}`,
            name: input.file.name.replace(/\.[^.]+$/, ''),
            fileName: input.file.name,
            fileSize: input.file.size,
            duration: meta.duration,
            width: meta.width,
            height: meta.height,
            createdAt: Date.now(),
            status: 'transcribing',
            clips: [],
            style: { ...DEFAULT_STYLE, aspect: input.aspect, template: input.template, highlight: input.highlight },
            options: input.options,
            chat: input.chatFile ? { name: input.chatFile.name, spikes: chatSpikes(parseChat(await input.chatFile.text())) } : undefined
        };
        setVideos((v) => ({ ...v, [project.id]: { file: input.file, url } }));
        update(project);
        setView({ name: 'project', id: project.id });
        run(project, input.file, url, true);
    }

    async function attachVideo(id: string, file: File) {
        const p = projectsRef.current.find((x) => x.id === id);
        if (!p) return;
        if (file.name !== p.fileName || file.size !== p.fileSize) {
            setErrors((e) => ({ ...e, [id]: `That is a different file. Choose "${p.fileName}".` }));
            return;
        }
        setErrors((e) => ({ ...e, [id]: '' }));
        setVideos((v) => ({ ...v, [id]: { file, url: URL.createObjectURL(file) } }));
    }

    /** Captioning too slow: stop it and start again with a lighter caption setting. */
    async function switchCaptions(id: string) {
        const p = projectsRef.current.find((x) => x.id === id);
        const vid = videos[id];
        if (!p || !vid) return;
        // stop the current run, and wait until it has really stopped (it may be busy reading the audio)
        runTokens.current[id] = (runTokens.current[id] ?? 0) + 1;
        setStep(id, 'Switching to faster captions', 0.03);
        const order = ['best', 'accurate', 'fast', 'fastest'] as const;
        const cur = p.options.asrQuality ?? 'fast';
        const next = order[Math.min(order.length - 1, order.indexOf(cur) + 1)];
        cancelTranscription();
        await runPromises.current[id]?.catch(() => {});
        const np: Project = { ...p, options: { ...p.options, asrQuality: next }, partial: undefined, transcript: undefined };
        update(np);
        run(np, vid.file, vid.url, true);
    }

    function regenerate(id: string, options: Project['options']) {
        const p = projectsRef.current.find((x) => x.id === id);
        const vid = videos[id];
        if (!p || !vid) return;
        const next = { ...p, options };
        update(next);
        run(next, vid.file, vid.url, !p.transcript);
    }

    async function removeProject(id: string) {
        await deleteProject(id);
        setProjects((ps) => ps.filter((p) => p.id !== id));
        setView({ name: 'home' });
    }

    const current = view.name === 'project' || view.name === 'editor' ? projects.find((p) => p.id === view.id) : undefined;

    return (
        <div className="flex min-h-screen">
            <aside className={`sticky ${view.name === 'editor' ? '!hidden' : ''} top-0 hidden h-screen w-60 shrink-0 flex-col gap-1 border-r border-white/10 bg-surface/60 p-4 md:flex`}>
                <a href="/" className="mb-6 flex items-center gap-2 px-2 text-lg font-extrabold no-underline">
                    <span className="grid size-8 place-items-center rounded-lg bg-accent text-ink"><Scissors size={16} strokeWidth={2.5} /></span>
                    Clipsmith
                </a>
                <NavButton active={view.name === 'home'} onClick={() => setView({ name: 'home' })}>
                    <HomeIcon size={15} className="mr-2.5 opacity-70" />Home
                </NavButton>
                <NavButton active={view.name === 'brand'} onClick={() => setView({ name: 'brand' })}>
                    <Palette size={15} className="mr-2.5 opacity-70" />Brand kit
                </NavButton>
                <p className="mt-6 px-3 text-xs font-semibold tracking-wider text-muted uppercase">Recent projects</p>
                <div className="flex flex-col gap-0.5 overflow-y-auto">
                    {projects.slice(0, 12).map((p) => (
                        <NavButton key={p.id} active={current?.id === p.id} onClick={() => setView({ name: 'project', id: p.id })}>
                            <span className="truncate">{p.name}</span>
                        </NavButton>
                    ))}
                    {projects.length === 0 && <p className="px-3 text-sm text-muted">None yet</p>}
                </div>
            </aside>

            <div className="flex min-w-0 grow flex-col">
                <div className={`flex items-center justify-between border-b border-white/10 px-4 py-3 md:hidden ${view.name === 'editor' ? '!hidden' : ''}`}>
                    <a href="/" className="flex items-center gap-2 font-extrabold no-underline">
                        <span className="grid size-7 place-items-center rounded-lg bg-accent text-ink">✂</span>Clipsmith
                    </a>
                    <div className="flex gap-1">
                        <button className="btn-ghost !px-3 !py-1.5" onClick={() => setView({ name: 'home' })}>Home</button>
                        <button className="btn-ghost !px-3 !py-1.5" onClick={() => setView({ name: 'brand' })}>Brand</button>
                    </div>
                </div>

                <main className={view.name === 'editor' ? 'w-full grow' : 'mx-auto w-full max-w-7xl grow px-4 py-6 sm:px-8'}>
                    {view.name === 'home' && (
                        <Home projects={projects} running={progress} onCreate={createProject} onOpen={(id) => setView({ name: 'project', id })} onOpenClip={(id, clipId) => setView({ name: 'editor', id, clipId })} onRestore={(ps) => ps.forEach((p) => update({ ...p, status: p.status === 'transcribing' || p.status === 'clipping' ? 'error' : p.status }))} accessCode={accessCode} setAccessCode={setAccessCode} />
                    )}
                    {view.name === 'brand' && <BrandKit brand={brand} setBrand={setBrand} />}
                    {view.name === 'project' && current && (
                        <ProjectView
                            project={current}
                            video={videos[current.id]}
                            progress={progress[current.id]}
                            error={errors[current.id]}
                            brand={brand}
                            onOpenClip={(clipId) => setView({ name: 'editor', id: current.id, clipId })}
                            onAttach={(f) => attachVideo(current.id, f)}
                            onRegenerate={(o) => regenerate(current.id, o)}
                            onDelete={() => removeProject(current.id)}
                            onPaste={(answer) => pasteClips(current.id, answer)}
                            onSwitchCaptions={() => switchCaptions(current.id)}
                            onChange={update}
                        />
                    )}
                    {view.name === 'editor' && current && (
                        <Editor
                            project={current}
                            clipId={view.clipId}
                            video={videos[current.id]}
                            brand={brand}
                            onChange={update}
                            onBack={() => setView({ name: 'project', id: current.id })}
                            onSelectClip={(clipId) => setView({ name: 'editor', id: current.id, clipId })}
                            onAttach={(f) => attachVideo(current.id, f)}
                            attachError={errors[current.id]}
                        />
                    )}
                    {(view.name === 'project' || view.name === 'editor') && !current && <p className="text-muted">This project no longer exists.</p>}
                </main>
            </div>
        </div>
    );
}

function NavButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
        <button onClick={onClick} className={`flex w-full items-center rounded-lg px-3 py-2 text-left text-sm font-medium transition ${active ? 'bg-white/10 text-white' : 'text-muted hover:bg-white/5 hover:text-white'}`}>
            {children}
        </button>
    );
}
