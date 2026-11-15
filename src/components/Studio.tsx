import { useCallback, useEffect, useRef, useState } from 'react';
import { findClips, transcribeVideo } from '../lib/api';
import { analyseClip } from '../lib/faces';
import { DEFAULT_BRAND, deleteProject, listProjects, loadBrand, saveBrand, saveProject } from '../lib/store';
import type { Brand, Project, StyleSettings } from '../lib/types';
import BrandKit from './BrandKit';
import Editor from './Editor';
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
        listProjects().then(setProjects).catch(() => {});
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

    const setStep = (id: string, label: string, ratio: number) => setProgress((pr) => ({ ...pr, [id]: { label, ratio } }));

    /** transcribe (if needed) -> find clips -> reframe + thumbnails */
    async function run(project: Project, file: File, url: string, retranscribe: boolean) {
        let p = { ...project };
        setErrors((e) => ({ ...e, [p.id]: '' }));
        try {
            if (!p.transcript || retranscribe) {
                p = { ...p, status: 'transcribing' };
                update(p);
                setStep(p.id, 'Loading video engine', 0.02);
                const transcript = await transcribeVideo(file, p.duration, accessCode, (label, r) => setStep(p.id, label, 0.05 + r * 0.45));
                if (transcript.words.length === 0) throw new Error('No speech was found in this video.');
                p = { ...p, transcript };
                update(p);
            }
            p = { ...p, status: 'clipping' };
            update(p);
            setStep(p.id, 'AI is finding the best moments', 0.55);
            const clips = await findClips(p.transcript!, p.options, accessCode);
            if (clips.length === 0) throw new Error('The AI did not find any clips. Try a different clip length.');
            p = { ...p, clips };
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
        } catch (e) {
            p = { ...p, status: 'error' };
            update(p);
            setErrors((er) => ({ ...er, [p.id]: (e as Error).message }));
        } finally {
            setProgress((pr) => {
                const n = { ...pr };
                delete n[p.id];
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
            options: input.options
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
            <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-1 border-r border-white/10 bg-surface/60 p-4 md:flex">
                <a href="/" className="mb-6 flex items-center gap-2 px-2 text-lg font-extrabold no-underline">
                    <span className="grid size-8 place-items-center rounded-lg bg-accent text-ink">✂</span>
                    Clipsmith
                </a>
                <NavButton active={view.name === 'home'} onClick={() => setView({ name: 'home' })}>
                    Home
                </NavButton>
                <NavButton active={view.name === 'brand'} onClick={() => setView({ name: 'brand' })}>
                    Brand kit
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
                <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 md:hidden">
                    <a href="/" className="flex items-center gap-2 font-extrabold no-underline">
                        <span className="grid size-7 place-items-center rounded-lg bg-accent text-ink">✂</span>Clipsmith
                    </a>
                    <div className="flex gap-1">
                        <button className="btn-ghost !px-3 !py-1.5" onClick={() => setView({ name: 'home' })}>Home</button>
                        <button className="btn-ghost !px-3 !py-1.5" onClick={() => setView({ name: 'brand' })}>Brand</button>
                    </div>
                </div>

                <main className="mx-auto w-full max-w-7xl grow px-4 py-6 sm:px-8">
                    {view.name === 'home' && (
                        <Home projects={projects} onCreate={createProject} onOpen={(id) => setView({ name: 'project', id })} accessCode={accessCode} setAccessCode={setAccessCode} />
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
