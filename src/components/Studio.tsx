import { useCallback, useEffect, useRef, useState } from 'react';
import { clipRanges, findClips, recaptionRanges, transcribeVideo } from '../lib/api';
import { projectEvents } from '../lib/audio';
import { parseChatAnswer, pickByLaughs } from '../lib/freepick';
import { chatSpikes, parseChat } from '../lib/chat';
import { analyseClip, closeVideo, detectFacecam, openVideo } from '../lib/faces';
import { applyFx } from '../lib/presets';
import { makeFaceZooms, withFaceZooms } from '../lib/facezoom';
import { loadStylePrefs } from '../lib/stylePrefs';
import { cancelTranscription, cleanWords } from '../lib/localAsr';
import { DEFAULT_BRAND, deleteProject, listProjects, loadBrand, saveBrand, saveProject } from '../lib/store';
import type { Aspect, Brand, Clip, Project, StyleSettings } from '../lib/types';
import BrandKit from './BrandKit';
import Editor from './Editor';
import { CalendarDays, Home as HomeIcon, Palette, Scissors } from 'lucide-react';
import Planner from './Planner';
import Home, { type NewProjectInput } from './Home';
import ProjectView from './ProjectView';
import { ExportQueuePanel } from './ui';

export type View = { name: 'home' } | { name: 'brand' } | { name: 'planner' } | { name: 'project'; id: string } | { name: 'editor'; id: string; clipId: string };

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
    // the latest videos, for steps that run long after they were started (e.g. after captions finish)
    const videosRef = useRef(videos);
    videosRef.current = videos;
    const [progress, setProgress] = useState<Record<string, { label: string; ratio: number }>>({});
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [brand, setBrandState] = useState<Brand>(DEFAULT_BRAND);
    const [accessCode, setAccessCodeState] = useState('');
    const projectsRef = useRef<Project[]>([]);
    projectsRef.current = projects;

    useEffect(() => {
        // older projects may hold speech-model glitches (long repeat runs); clean them on load
        listProjects()
            .then((ps) => {
                const loaded = ps.map((p) => (p.transcript ? { ...p, transcript: { ...p.transcript, words: cleanWords(p.transcript.words) } } : p));
                // a project made before loading finished is kept
                const made = projectsRef.current.filter((x) => !loaded.some((l) => l.id === x.id));
                projectsRef.current = [...made, ...loaded];
                setProjects(projectsRef.current);
            })
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
        // keep the ref current straight away, so the next change (even in the same moment) builds on this one
        const ps = projectsRef.current;
        const next = ps.some((x) => x.id === p.id) ? ps.map((x) => (x.id === p.id ? p : x)) : [p, ...ps];
        projectsRef.current = next;
        setProjects(next);
        saveProject(p);
    }, []);
    /**
     * Change part of a project, on top of its newest version. Work that runs in the background
     * (thumbnails, captions, face zoom...) must use this, so it never undoes what you change in
     * the editor meanwhile. Does nothing if the project was deleted.
     */
    const patch = useCallback((id: string, change: (cur: Project) => Project): Project | undefined => {
        const cur = projectsRef.current.find((x) => x.id === id);
        if (!cur) return undefined;
        const next = change(cur);
        update(next);
        return next;
    }, [update]);

    const runTokens = useRef<Record<string, number>>({});
    const setStep = (id: string, label: string, ratio: number) => {
        // remember the last step, so "Processing stopped" can say where it stopped if the tab closes
        try {
            localStorage.setItem(`clipsmith.lastStep.${id}`, label);
        } catch {
            /* storage full or blocked: not important */
        }
        setProgress((pr) => ({ ...pr, [id]: { label, ratio } }));
    };

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
        // only the fields this job owns are written, on top of the newest saved version
        const save = (fields: Partial<Project>) => {
            p = { ...p, ...fields };
            if (live()) patch(project.id, (cur) => ({ ...cur, ...fields }));
        };
        const step = (label: string, r: number) => live() && setStep(project.id, label, r);
        let p = { ...project };
        const o = p.options;
        setErrors((e) => ({ ...e, [p.id]: '' }));
        // stopped while making thumbnails: the clips are already there, so only finish that step
        if (!retranscribe && p.status === 'clipping' && p.clips.length && p.transcript) {
            try {
                await reframe(p, url);
            } finally {
                setProgress((pr) => {
                    const n = { ...pr };
                    delete n[p.id];
                    return n;
                });
            }
            return;
        }
        try {
            if (!p.transcript || retranscribe) {
                save({ status: 'transcribing' });
                step('Loading video engine', 0.02);
                // speed boost (optional): a quick first pass is enough to find the moments
                const boost = !!o.speedBoost && (o.asr ?? 'local') === 'local' && !o.captionsOnly;
                const quality = boost ? (o.asrQuality === 'fastest' ? 'fastest' : 'fast') : o.asrQuality ?? 'fast';
                const key = `${o.asr ?? 'local'}|${o.language ?? 'english'}|${quality}`;
                const resume = p.partial && p.partial.key === key ? p.partial : undefined;
                const transcript = await transcribeVideo(
                    file,
                    p.duration,
                    accessCode,
                    (label, r) => step(label, 0.05 + r * 0.45),
                    { asr: o.asr ?? 'local', language: o.language ?? 'english', quality },
                    resume,
                    (state) => {
                        save({ partial: { key, ...state } });
                    },
                    () => !live()
                );
                if (transcript.words.length === 0) throw new Error('No speech was found in this video. Check that the video language is set correctly.');
                save({ transcript, partial: undefined });
            }
            if (o.captionsOnly) {
                // captions only: one "clip" that is the whole video, opened straight in the editor
                const whole: Clip = {
                    id: 'whole',
                    title: p.name,
                    start: 0,
                    end: p.duration,
                    hook: '',
                    score: 100,
                    subscores: { hook: 0, flow: 0, value: 0, shareability: 0 },
                    reason: 'The whole video with captions',
                    category: 'Captions',
                    description: '',
                    hashtags: [],
                    keywords: [],
                    emojis: []
                };
                save({ clips: [whole], status: 'ready' });
                if (live()) setView((v) => (v.name === 'project' && v.id === p.id ? { name: 'editor', id: p.id, clipId: 'whole' } : v));
                return;
            }
            const picker = o.picker ?? 'laughs';
            if (picker === 'chat') {
                // wait for the creator to paste Claude's answer (see ProjectView)
                save({ status: 'awaiting-paste' });
                return;
            }
            save({ status: 'clipping' });
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
            save({ status: 'error' });
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
        let style = project.style;
        let searched = false;
        // a layout with a facecam needs to know where the facecam is
        if (['split', 'pip'].includes(style.layout) && !style.facecam) {
            setStep(project.id, 'Looking for the facecam', 0.66);
            const fc = await detectFacecam(url, project.duration).catch(() => null);
            searched = true;
            // no facecam found: fall back to following the speaker instead of a wrong crop
            style = fc ? { ...style, facecam: fc } : { ...style, layout: 'auto' };
        }
        const tag = (project.options.topic ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        const events = projectEvents(project);
        const words = project.transcript?.words ?? [];
        const clips = found.map((c) => {
            let n = tag && !c.hashtags.some((h) => h.replace('#', '').toLowerCase() === tag) ? { ...c, hashtags: [tag, ...c.hashtags] } : c;
            if (project.options.fx) n = applyFx(n, project.options.fx, events, words);
            return n;
        });
        const found2 = style;
        const p = patch(project.id, (cur) => ({ ...cur, status: 'clipping', clips, style: searched ? { ...cur.style, layout: found2.layout, facecam: found2.facecam } : cur.style }));
        if (!p) return; // deleted meanwhile
        await reframe(p, url);
        if (p.options.speedBoost && (p.options.asr ?? 'local') === 'local' && !p.options.captionsOnly) await recaption(p.id, 'clips');
        if (p.options.faceZoom) await faceZoomAll(p.id, url);
    }

    /** optional: slow zoom on the eyes at awkward silences, in every clip (after the final captions) */
    async function faceZoomAll(id: string, url: string) {
        const start = projectsRef.current.find((x) => x.id === id);
        if (!start?.transcript) return;
        const ids = start.clips.map((c) => c.id);
        let video: HTMLVideoElement | null = null;
        try {
            video = await openVideo(url);
            for (let i = 0; i < ids.length; i++) {
                setStep(id, `Face zoom on awkward silences: clip ${i + 1} of ${ids.length}`, 0.9 + (0.1 * i) / ids.length);
                // always read the newest version: the clip may have been edited (or deleted) meanwhile
                const cur = projectsRef.current.find((x) => x.id === id);
                const clip = cur?.clips.find((c) => c.id === ids[i]);
                if (!cur?.transcript || !clip) continue;
                try {
                    const r = await makeFaceZooms(video, clip, cur.transcript.words, cur.transcript.energy, cur.style, cur.style.faceAim);
                    if (!r.total) continue;
                    patch(id, (now) => ({ ...now, clips: now.clips.map((c) => (c.id === ids[i] ? { ...c, zooms: withFaceZooms(c, r.zooms) } : c)) }));
                } catch {
                    /* optional: the clip still works without it */
                }
            }
        } catch {
            /* the video couldn't be read: no face zooms, everything else is fine */
        } finally {
            if (video) closeVideo(video);
        }
    }

    /** thumbnails, and the speaker-following crop when the layout uses it. Optional: never blocks the clips. */
    async function reframe(project: Project, url: string) {
        const id = project.id;
        const ids = project.clips.map((c) => c.id);
        // only "follow speaker" uses the face track; other layouts just need thumbnails (much faster)
        const needTrack = project.style.layout === 'auto';
        let video: HTMLVideoElement | null = null;
        try {
            video = await openVideo(url);
            for (let i = 0; i < ids.length; i++) {
                setStep(id, `${needTrack ? 'Reframing' : 'Making thumbnails for'} clip ${i + 1} of ${ids.length}`, 0.7 + (0.3 * i) / ids.length);
                const clip = projectsRef.current.find((x) => x.id === id)?.clips.find((c) => c.id === ids[i]);
                if (!clip) continue;
                try {
                    const res = await analyseClip(url, clip.start, clip.end, project.style.aspect, { video, track: needTrack, budgetMs: 30000 });
                    // only the thumbnail and the face track are written, on top of any edits made meanwhile
                    patch(id, (cur) => ({ ...cur, thumb: cur.thumb ?? res.thumb, clips: cur.clips.map((c) => (c.id === ids[i] ? { ...c, track: res.track ?? c.track, thumb: res.thumb } : c)) }));
                } catch {
                    /* reframing is optional; keep the clip centred */
                }
            }
        } catch {
            /* the video couldn't be read for thumbnails: the clips still work */
        } finally {
            if (video) closeVideo(video);
        }
        patch(id, (cur) => ({ ...cur, status: 'ready' }));
    }

    /** clips pasted back from a Claude chat */
    async function pasteClips(id: string, answer: string) {
        const p = projectsRef.current.find((x) => x.id === id);
        const vid = videos[id];
        if (!p) return;
        const clips = parseChatAnswer(answer, p.duration); // throws a readable error
        if (!vid) {
            patch(id, (cur) => ({ ...cur, clips, status: 'ready' }));
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

    // videos are processed one after another so a batch doesn't overload the PC
    const queue = useRef<Promise<void>>(Promise.resolve());
    async function createProjects(inputs: NewProjectInput[]) {
        const made: { project: Project; file: File; url: string }[] = [];
        for (const input of inputs) made.push(await makeProject(input));
        if (made.length === 1) setView({ name: 'project', id: made[0].project.id });
        else setView({ name: 'home' });
        for (const m of made) {
            setStep(m.project.id, 'Waiting in line (starts when the video before it is done)', 0);
            queue.current = queue.current.then(() => run(projectsRef.current.find((x) => x.id === m.project.id) ?? m.project, m.file, m.url, true)).catch(() => {});
        }
    }

    async function makeProject(input: NewProjectInput): Promise<{ project: Project; file: File; url: string }> {
        const url = URL.createObjectURL(input.file);
        const meta = await readMeta(url);
        const remembered = loadStylePrefs();
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
            style: {
                ...DEFAULT_STYLE,
                // your last choices (emojis, facecam box and height, position...) carry over
                ...remembered,
                template: input.template,
                // a colour you picked stays when you keep the same caption style
                highlight: remembered.template === input.template && remembered.highlight ? remembered.highlight : input.highlight,
                // a template's look (a saved preset keeps its own caption style and facecam box)
                ...(input.preset?.style ?? {}),
                aspect: input.keepShape ? closestAspect(meta.width, meta.height) : input.aspect,
                // captions only in the video's own shape: show the whole frame, nothing cropped
                ...(input.keepShape ? { layout: 'fit' as const } : {})
            },
            options: { ...input.options, fx: input.preset?.fx },
            chat: input.chatFile ? { name: input.chatFile.name, spikes: chatSpikes(parseChat(await input.chatFile.text())) } : undefined
        };
        setVideos((v) => ({ ...v, [project.id]: { file: input.file, url } }));
        update(project);
        return { project, file: input.file, url };
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
        const np = patch(id, (now) => ({ ...now, options: { ...now.options, asrQuality: next }, partial: undefined, transcript: undefined }));
        if (np) run(np, vid.file, vid.url, true);
    }

    function regenerate(id: string, options: Project['options']) {
        const p = projectsRef.current.find((x) => x.id === id);
        const vid = videos[id];
        if (!p || !vid) return;
        const next = patch(id, (cur) => ({ ...cur, options }));
        if (next) run(next, vid.file, vid.url, !p.transcript);
    }

    /** new captions for an existing project (fixed timing, Accurate model); clips and edits stay */
    async function recaption(id: string, scope: 'clips' | 'all' = 'all') {
        const p = projectsRef.current.find((x) => x.id === id);
        const vid = videosRef.current[id];
        if (!p || !vid) return;
        setErrors((e) => ({ ...e, [id]: '' }));
        setStep(id, 'Redoing captions', 0.02);
        try {
            const engine = { asr: p.options.asr ?? 'local', language: p.options.language ?? 'english', quality: (p.options.asr ?? 'local') === 'local' ? ('accurate' as const) : p.options.asrQuality ?? 'fast' };
            const transcript =
                scope === 'clips' && p.transcript && p.clips.length
                    ? await recaptionRanges(vid.file, p.transcript, clipRanges(p.clips, p.duration), engine.language, (label, r) => setStep(id, label, r))
                    : await transcribeVideo(vid.file, p.duration, accessCode, (label, r) => setStep(id, label, r), engine);
            if (transcript.words.length === 0) throw new Error('No speech was found. Check that the video language is set correctly.');
            patch(id, (cur) => ({ ...cur, transcript, captionShift: 0, partial: undefined, options: scope === 'all' ? { ...cur.options, asrQuality: engine.quality } : cur.options }));
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setErrors((er) => ({ ...er, [id]: `Redoing captions failed: ${msg}` }));
        } finally {
            setProgress((pr) => {
                const n = { ...pr };
                delete n[id];
                return n;
            });
        }
    }

    async function removeProject(id: string) {
        await deleteProject(id);
        runTokens.current[id] = (runTokens.current[id] ?? 0) + 1; // stop its background work
        projectsRef.current = projectsRef.current.filter((p) => p.id !== id);
        setProjects(projectsRef.current);
        setView({ name: 'home' });
    }

    const current = view.name === 'project' || view.name === 'editor' ? projects.find((p) => p.id === view.id) : undefined;

    return (
        <div className="flex min-h-screen">
            <aside className={`sticky ${view.name === 'editor' ? '!hidden' : ''} top-0 hidden h-screen w-60 shrink-0 flex-col gap-1 border-r border-white/10 bg-surface/60 p-4 md:flex`}>
                <a href="/" className="mb-6 flex items-center gap-2 px-2 text-lg font-extrabold no-underline">
                    <span className="grid size-8 place-items-center rounded-lg bg-accent text-ink"><Scissors size={16} strokeWidth={2.5} /></span>
                    ClipHeist
                </a>
                <NavButton active={view.name === 'home'} onClick={() => setView({ name: 'home' })}>
                    <HomeIcon size={15} className="mr-2.5 opacity-70" />Home
                </NavButton>
                <NavButton active={view.name === 'planner'} onClick={() => setView({ name: 'planner' })}>
                    <CalendarDays size={15} className="mr-2.5 opacity-70" />Post planner
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
                        <span className="grid size-7 place-items-center rounded-lg bg-accent text-ink">✂</span>ClipHeist
                    </a>
                    <div className="flex gap-1">
                        <button className="btn-ghost !px-3 !py-1.5" onClick={() => setView({ name: 'home' })}>Home</button>
                        <button className="btn-ghost !px-3 !py-1.5" onClick={() => setView({ name: 'planner' })}>Plan</button>
                        <button className="btn-ghost !px-3 !py-1.5" onClick={() => setView({ name: 'brand' })}>Brand</button>
                    </div>
                </div>

                <main className={view.name === 'editor' ? 'w-full grow' : 'mx-auto w-full max-w-7xl grow px-4 py-6 sm:px-8'}>
                    {view.name === 'home' && (
                        <Home projects={projects} running={progress} onCreate={createProjects} onOpen={(id) => setView({ name: 'project', id })} onOpenClip={(id, clipId) => setView({ name: 'editor', id, clipId })} onRestore={(ps) => ps.forEach((p) => update({ ...p, status: p.status === 'transcribing' || p.status === 'clipping' ? 'error' : p.status }))} accessCode={accessCode} setAccessCode={setAccessCode} />
                    )}
                    {view.name === 'brand' && <BrandKit brand={brand} setBrand={setBrand} />}
                    {view.name === 'planner' && <Planner projects={projects} onOpenClip={(id, clipId) => setView({ name: 'editor', id, clipId })} />}
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
                            onRecaption={(scope) => recaption(current.id, scope)}
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
            <ExportQueuePanel />
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

function closestAspect(w: number, h: number): Aspect {
    const r = w / Math.max(1, h);
    return r > 1.4 ? '16:9' : r < 0.75 ? '9:16' : '1:1';
}
