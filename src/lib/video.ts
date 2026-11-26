import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { bleepSpans } from './censor';
import { buildAss, captionSize, captionY, displayWords, emojiEvents, groupWords } from './captions';
import { drawFreezeText, drawHookTitleText, drawReplayBadge, drawSticker, emojiPng, pipBox, pipMaskPngs, textOverlayPng, WATERMARK_CYCLE, WATERMARK_SECONDS, watermarkMargins, watermarkPng, zoomTarget } from './draw';
import { allShakes, allSfx, allZooms, replayLength } from './fx';
import { sfxWav } from './sfx';
import { coverBox, cropPath, cropWindow, outputSize, posAt, type Box } from './geometry';
import { FONT_FILES, getTemplate, perLine } from './templates';
import { keptSegments, outputDuration, segmentsOf, styleAt, toOutput, toOutputClamped, toSource } from './timeline';
import type { Brand, Clip, Project, StyleSettings, Word, Zoom } from './types';

// All video work happens in the user's browser with ffmpeg.wasm, so videos never have to be
// uploaded to a server. Only small audio chunks are sent off for transcription.
//
// Speed: one ffmpeg.wasm engine uses one processor core. To export faster, a clip is cut into
// pieces that several engines render at the same time (one per core), then joined. The sound is
// rendered once in a single pass, so there are no clicks where pieces meet.

type Engine = {
    ff: Promise<FFmpeg>;
    mounted: File | null;
    progress: number;
    /** seconds of output this job makes (0 = not tracked) */
    expected: number;
    /** jobs run so far, and jobs running now */
    uses: number;
    active: number;
};
/** An engine that has run this many jobs is replaced by a fresh one before the next job.
 *  The video engine slowly wears out: after ~60 jobs in a row on a big video (e.g. reading the
 *  audio of a long stream piece by piece) it can crash the whole tab. A fresh engine never does. */
const ENGINE_JOBS = 15;
const pool: (Engine | undefined)[] = [];
let progressListener: (() => void) | null = null;
const INPUT_DIR = '/input';

/** How many engines to run at once (leave one core for the page itself). */
export function parallelism(): number {
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    return Math.max(1, Math.min(4, cores - 1));
}

async function createEngine(index: number): Promise<FFmpeg> {
    const ff = new FFmpeg();
    ff.on('progress', ({ progress }) => {
        const e = pool[index];
        // ffmpeg's own number is relative to the whole source file, which is useless for a piece
        // of a long video; render jobs track their real progress from the log instead
        if (e && !e.expected) e.progress = Math.min(1, Math.max(0, progress));
        progressListener?.();
    });
    ff.on('log', ({ message }) => {
        const e = pool[index];
        const m = e?.expected ? message.match(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/) : null;
        if (e && m) {
            e.progress = Math.min(0.99, Math.max(0, (+m[1] * 3600 + +m[2] * 60 + +m[3]) / e.expected));
            progressListener?.();
        }
        if ((globalThis as { __clipsmithDebug?: boolean }).__clipsmithDebug) console.log(`[ffmpeg ${index}]`, message);
    });
    const base = `${location.origin}/ffmpeg`;
    await ff.load({
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm')
    });
    await ff.createDir('/fonts');
    for (const f of FONT_FILES) await ff.writeFile(`/fonts/${f}`, await fetchFile(`/fonts/${f}`));
    return ff;
}

function engineAt(i: number): Engine {
    let e = pool[i];
    if (!e) {
        const ff = createEngine(i);
        const engine: Engine = { ff, mounted: null, progress: 0, expected: 0, uses: 0, active: 0 };
        e = engine;
        pool[i] = e;
        ff.then((f) => {
            // count every job this engine runs, wherever it comes from
            const exec = f.exec.bind(f);
            f.exec = async (...a: Parameters<FFmpeg['exec']>) => {
                engine.active++;
                try {
                    return await exec(...a);
                } finally {
                    engine.active--;
                    engine.uses++;
                }
            };
        }).catch(() => (pool[i] = undefined));
    }
    return e;
}

/** Replace a worn-out engine with a fresh one (only while it is idle). */
async function freshen(i: number) {
    const e = pool[i];
    if (!e || e.uses < ENGINE_JOBS || e.active > 0) return;
    pool[i] = undefined;
    try {
        (await e.ff).terminate();
    } catch {
        /* already gone */
    }
}

export function getFFmpeg(): Promise<FFmpeg> {
    return engineAt(0).ff;
}

/** Mount the source video into an engine without copying it into memory (works for big files). */
async function mountOn(i: number, file: File): Promise<{ ff: FFmpeg; input: string }> {
    await freshen(i);
    const e = engineAt(i);
    const ff = await e.ff;
    if (e.mounted !== file) {
        if (e.mounted) {
            await ff.unmount(INPUT_DIR).catch(() => {});
            await ff.deleteDir(INPUT_DIR).catch(() => {});
        }
        await ff.createDir(INPUT_DIR).catch(() => {});
        await ff.mount(FFFSType.WORKERFS, { files: [file] }, INPUT_DIR);
        e.mounted = file;
    }
    return { ff, input: `${INPUT_DIR}/${file.name}` };
}

export const CHUNK_SECONDS = 600;

/** Extract small mono mp3 audio chunks for transcription (each `pad` seconds longer at both ends). */
export async function extractAudioChunks(
    file: File,
    duration: number,
    onProgress: (ratio: number) => void,
    chunkSeconds = CHUNK_SECONDS,
    pad = 0
): Promise<{ offset: number; blob: Blob }[]> {
    const count = Math.max(1, Math.ceil(duration / chunkSeconds));
    const chunks: { offset: number; blob: Blob }[] = [];
    for (let i = 0; i < count; i++) {
        const { ff, input } = await mountOn(0, file);
        const offset = Math.max(0, i * chunkSeconds - pad);
        const len = chunkSeconds + pad + (i * chunkSeconds - offset);
        progressListener = () => onProgress((i + (pool[0]?.progress ?? 0)) / count);
        const out = `/chunk_${i}.mp3`;
        const code = await ff.exec(['-ss', String(offset), '-t', String(len), '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-y', out]);
        if (code !== 0) throw new Error('Could not read the audio track. Is this a valid video file?');
        const data = await ff.readFile(out);
        await ff.deleteFile(out);
        chunks.push({ offset, blob: new Blob([data as Uint8Array], { type: 'audio/mpeg' }) });
    }
    progressListener = null;
    onProgress(1);
    return chunks;
}

/** Audio of chosen stretches only (e.g. the clips), as 16 kHz mono mp3 pieces. */
export async function extractAudioRanges(file: File, ranges: { start: number; end: number }[], onProgress: (ratio: number) => void): Promise<{ offset: number; blob: Blob }[]> {
    const out: { offset: number; blob: Blob }[] = [];
    for (let i = 0; i < ranges.length; i++) {
        const { ff, input } = await mountOn(0, file);
        const r = ranges[i];
        onProgress(i / ranges.length);
        const path = `/range_${i}.mp3`;
        const code = await ff.exec(['-ss', String(r.start), '-t', String(r.end - r.start), '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-y', path]);
        if (code !== 0) throw new Error('Could not read the audio track. Is this a valid video file?');
        const data = await ff.readFile(path);
        await ff.deleteFile(path);
        out.push({ offset: r.start, blob: new Blob([data as Uint8Array], { type: 'audio/mpeg' }) });
    }
    onProgress(1);
    return out;
}

// ---------- helpers ----------

/** ffmpeg expression for a piecewise-linear crop path (pixels), in part time `t`. */
function cropExpr(points: { t: number; x: number }[], maxX: number): string {
    if (points.length === 1) return (points[0].x * maxX).toFixed(1);
    const px = points.map((p) => ({ t: p.t, x: p.x * maxX }));
    let expr = px[px.length - 1].x.toFixed(1);
    for (let i = px.length - 1; i >= 1; i--) {
        const a = px[i - 1];
        const b = px[i];
        const span = Math.max(0.001, b.t - a.t);
        const seg = `${a.x.toFixed(1)}+(${(b.x - a.x).toFixed(1)})*(t-${a.t.toFixed(3)})/${span.toFixed(3)}`;
        expr = `if(lt(t,${b.t.toFixed(3)}),${seg},${expr})`;
    }
    return `clip(${expr},0,${maxX.toFixed(1)})`;
}

function dataUrlBytes(url: string): Uint8Array {
    const b64 = url.split(',')[1] ?? '';
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

const audioCache = new WeakMap<File, boolean>();

/** Does the video have a sound track? (read from ffmpeg's log) */
async function hasAudio(file: File): Promise<boolean> {
    const known = audioCache.get(file);
    if (known !== undefined) return known;
    const { ff, input } = await mountOn(0, file);
    let found = false;
    const onLog = ({ message }: { message: string }) => {
        if (/Stream #.*Audio:/.test(message)) found = true;
    };
    ff.on('log', onLog);
    await ff.exec(['-hide_banner', '-i', input, '-t', '0.01', '-f', 'null', '-']).catch(() => 0);
    ff.off('log', onLog);
    audioCache.set(file, found);
    return found;
}

const even = (v: number) => Math.max(2, Math.floor(v / 2) * 2);
const hex = (c: string) => '0x' + c.replace('#', '').slice(0, 6);
const f3 = (n: number) => n.toFixed(3);
const between = (spans: { start: number; end: number }[]) => spans.map((s) => `between(t,${s.start.toFixed(2)},${s.end.toFixed(2)})`).join('+') || '0';
export type Quality = 720 | 1080 | 1440;
/** frames per second of the render in progress (30, or 60 when asked for) */
let FPS = 30;
const snap = (t: number) => Math.round(t * FPS) / FPS;

/** Moves every event in an .ass file earlier by `offset` seconds (dropping ones that end before 0). */
function shiftAss(ass: string, offset: number): string {
    if (!offset) return ass;
    const toS = (t: string) => {
        const [h, m, s] = t.split(':');
        return +h * 3600 + +m * 60 + parseFloat(s);
    };
    const fmt = (v: number) => {
        const s = Math.max(0, v);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = Math.floor(s % 60);
        const cs = Math.floor((s - Math.floor(s)) * 100);
        return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
    };
    return ass
        .split('\n')
        .flatMap((line) => {
            const m = line.match(/^Dialogue: (\d+),([^,]+),([^,]+),(.*)$/);
            if (!m) return [line];
            const end = toS(m[3]) - offset;
            if (end <= 0) return [];
            return [`Dialogue: ${m[1]},${fmt(toS(m[2]) - offset)},${fmt(end)},${m[4]}`];
        })
        .join('\n');
}

export type RenderOptions = {
    file: File;
    clip: Clip;
    words: Word[];
    style: StyleSettings;
    brand: Brand;
    /** short side of the output in pixels */
    quality: Quality;
    /** 60 for smooth 60 fps (for 60 fps recordings); 30 otherwise */
    fps?: 30 | 60;
    videoWidth: number;
    videoHeight: number;
    speakers?: { t: number; speaker: number }[];
    music?: Project['music'];
    onProgress: (ratio: number) => void;
};

/** Pictures and captions every piece needs (made once, then copied into each engine). */
type Assets = { files: { path: string; data: Uint8Array }[]; ass: string };

async function prepareAssets(o: RenderOptions, W: number, H: number): Promise<Assets> {
    const { clip, style } = o;
    const tpl = getTemplate(style.template);
    const files: Assets['files'] = [];
    if (clip.hookTitle?.text.trim() && clip.hookTitle.seconds > 0) files.push({ path: '/title.png', data: await textOverlayPng(W, H, (ctx) => drawHookTitleText(ctx, clip.hookTitle!.text, style)) });
    if (clip.freeze && clip.freeze.seconds > 0 && clip.freeze.text.trim()) files.push({ path: '/freeze.png', data: await textOverlayPng(W, H, (ctx) => drawFreezeText(ctx, clip.freeze!.text, style)) });
    if (o.brand.logo) files.push({ path: '/logo.png', data: dataUrlBytes(o.brand.logo) });
    if (o.brand.watermark?.text.trim()) files.push({ path: '/wm.png', data: await watermarkPng(o.brand.watermark, W) });
    if (style.layout === 'pip' || segmentsOf(clip).some((sg) => sg.layout === 'pip')) {
        const m = await pipMaskPngs(style, W, H);
        files.push({ path: '/pipmask.png', data: m.mask }, { path: '/piprim.png', data: m.rim });
    }
    if (replayLength(clip) > 0) files.push({ path: '/replay.png', data: await textOverlayPng(W, H, (ctx) => drawReplayBadge(ctx)) });
    for (let i = 0; i < (clip.stickers ?? []).length; i++) files.push({ path: `/sticker_${i}.png`, data: await textOverlayPng(W, H, (ctx) => drawSticker(ctx, clip.stickers![i])) });
    if (style.emojis && tpl.id !== 'none') {
        const groups = groupWords(displayWords(o.words, clip, style, o.speakers, true), perLine(style));
        const events = emojiEvents(clip, groups).slice(0, 10);
        const es = Math.round(captionSize(tpl, style, W) * 1.6);
        for (let i = 0; i < events.length; i++) {
            const scales = style.emojiAnim ? [0.6, 1.2, 1] : [1];
            for (let k = 0; k < scales.length; k++) files.push({ path: `/emoji_${i}_${k}.png`, data: await emojiPng(events[i].emoji, even(es * scales[k])) });
        }
    }
    return { files, ass: buildAss(o.words, clip, style, W, H, o.speakers) };
}

type Timing = { total: number; replay: number; freeze: number; full: number };

function timing(clip: Clip): Timing {
    const total = outputDuration(clip);
    const replay = replayLength(clip);
    const freeze = clip.freeze && clip.freeze.seconds > 0 ? clip.freeze.seconds : 0;
    return { total, replay, freeze, full: snap(total + replay + freeze) };
}

/** A zoom in a piece's own time (seconds from the piece start). */
type PieceZoom = Zoom;

/** Framing filters (crop / follow speaker / fit / facecam split) with zooms and shakes. */
function layout(
    o: RenderOptions,
    g: string[],
    v: string,
    W: number,
    H: number,
    zooms: PieceZoom[],
    shakeAll: string | null,
    cropPoints: { t: number; x: number }[],
    style: StyleSettings,
    addInput: (path: string) => string
): string {
    const vw = o.videoWidth;
    const vh = o.videoHeight;
    /**
     * zoompan for one picture (`region`: the main picture or the facecam). `area` is the part of the
     * source this picture shows (after cropping to fill), so a zoom aimed at a point (the eyes)
     * can be centred on it; `fitMap` is used instead for the "fit" layout.
     */
    const zp = (w: number, h: number, region: 'main' | 'cam' = 'main', area?: Box, fitMap?: (px: number, py: number) => [number, number]) => {
        const ft = `in/${FPS}`;
        const mine = zooms.filter((z) => {
            const t = zoomTarget(z, style);
            return t === 'both' || t === region;
        });
        // the facecam bubble never shook, so it still doesn't
        const shake = region === 'cam' && style.layout === 'pip' ? null : shakeAll;
        if (!mine.length && !shake) return '';
        let zexpr = '1';
        let xexpr = 'iw/2-(iw/zoom/2)';
        let yexpr = 'ih/2-(ih/zoom/2)';
        for (const z of mine) {
            const on = `between(${ft},${z.start.toFixed(2)},${z.end.toFixed(2)})`;
            const sc = z.ease ? `(1+${(z.scale - 1).toFixed(3)}*(3-2*min(1,max(0,(${ft}-${z.start.toFixed(2)})/${z.ease.toFixed(2)})))*pow(min(1,max(0,(${ft}-${z.start.toFixed(2)})/${z.ease.toFixed(2)})),2))` : z.scale.toFixed(3);
            zexpr = `if(${on},${sc},${zexpr})`;
            if (z.fx !== undefined && z.fy !== undefined && (area || fitMap)) {
                let lx: number;
                let ly: number;
                if (fitMap) [lx, ly] = fitMap(z.fx * vw, z.fy * vh);
                else {
                    lx = (z.fx * vw - area!.x) / area!.w;
                    ly = (z.fy * vh - area!.y) / area!.h;
                }
                lx = Math.min(1, Math.max(0, lx));
                ly = Math.min(1, Math.max(0, ly));
                xexpr = `if(${on},${lx.toFixed(4)}*iw-iw/zoom/2,${xexpr})`;
                yexpr = `if(${on},${ly.toFixed(4)}*ih-ih/zoom/2,${yexpr})`;
            }
        }
        const zz = shake ? `if(${shake},max(1.1,${zexpr}),${zexpr})` : zexpr;
        const jx = shake ? `+if(${shake},iw*0.022*sin(in*2.7),0)` : '';
        const jy = shake ? `+if(${shake},ih*0.022*cos(in*3.1),0)` : '';
        return `,zoompan=z='${zz}':x='max(0,min(iw-iw/zoom,${xexpr}${jx}))':y='max(0,min(ih-ih/zoom,${yexpr}${jy}))':d=1:s=${w}x${h}:fps=${FPS}`;
    };
    // where the "follow speaker" crop sits in the middle of this piece (for aiming zooms)
    const midCropX = (maxX: number) => {
        if (!cropPoints.length) return maxX * style.cropX;
        const mid = zooms.length ? (zooms[0].start + zooms[0].end) / 2 : 0;
        return posAt(cropPoints, mid) * maxX;
    };
    if (style.layout === 'fit') {
        g.push(`[${v}]split[fa][fb]`);
        g.push(`[fa]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=luma_radius=28:luma_power=2,eq=brightness=-0.07[bg]`);
        g.push(`[fb]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg]`);
        const fit = Math.min(W / vw, H / vh);
        const fitMap = (px: number, py: number): [number, number] => [((W - vw * fit) / 2 + px * fit) / W, ((H - vh * fit) / 2 + py * fit) / H];
        g.push(`[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1${zp(W, H, 'main', undefined, fitMap)}[v0]`);
    } else if (style.layout === 'split') {
        const fc = style.facecam ?? { x: 0, y: 0, w: 0.3, h: 0.3 };
        const TH = even(H * (style.splitRatio ?? 0.4));
        const BH = H - TH;
        const ar = W / BH;
        const gw = even(Math.min(vw, vh * ar));
        const gh = even(Math.min(vh, vw / ar));
        g.push(`[${v}]split[fa][fb]`);
        g.push(`[fa]crop=${even(fc.w * vw)}:${even(fc.h * vh)}:${Math.round(fc.x * vw)}:${Math.round(fc.y * vh)},scale=${W}:${TH}:force_original_aspect_ratio=increase,crop=${W}:${TH},setsar=1${zp(W, TH, 'cam', coverBox({ x: Math.round(fc.x * vw), y: Math.round(fc.y * vh), w: even(fc.w * vw), h: even(fc.h * vh) }, W / TH))}[top]`);
        g.push(`[fb]crop=${gw}:${gh}:${Math.round((vw - gw) * style.cropX)}:${Math.round((vh - gh) / 2)},scale=${W}:${BH}:force_original_aspect_ratio=increase,crop=${W}:${BH},setsar=1${zp(W, BH, 'main', coverBox({ x: Math.round((vw - gw) * style.cropX), y: Math.round((vh - gh) / 2), w: gw, h: gh }, W / BH))}[bot]`);
        g.push(`[top][bot]vstack=inputs=2,drawbox=x=0:y=${TH - 2}:w=${W}:h=4:color=black:t=fill[v0]`);
    } else if (style.layout === 'pip') {
        // full gameplay with the facecam in a round (or rounded) bubble with a white rim
        const fc = style.facecam ?? { x: 0, y: 0, w: 0.3, h: 0.3 };
        const b = pipBox(style, W, H);
        const { cw, ch, y } = cropWindow(vw, vh, style.aspect);
        const mask = addInput('/pipmask.png');
        const rim = addInput('/piprim.png');
        g.push(`[${v}]split[fa][fb]`);
        g.push(`[fb]crop=${even(cw)}:${even(ch)}:${Math.round((vw - cw) * style.cropX)}:${Math.round(y)},scale=${W}:${H}:flags=bicubic,setsar=1${zp(W, H, 'main', { x: Math.round((vw - cw) * style.cropX), y: Math.round(y), w: even(cw), h: even(ch) })}[bg]`);
        g.push(`[fa]crop=${even(fc.w * vw)}:${even(fc.h * vh)}:${Math.round(fc.x * vw)}:${Math.round(fc.y * vh)},scale=${b.s}:${b.s}:force_original_aspect_ratio=increase,crop=${b.s}:${b.s},setsar=1${zp(b.s, b.s, 'cam', coverBox({ x: Math.round(fc.x * vw), y: Math.round(fc.y * vh), w: even(fc.w * vw), h: even(fc.h * vh) }, 1))},format=yuva420p[pc]`);
        g.push(`[${mask}]format=gray,scale=${b.s}:${b.s}[pm]`);
        g.push(`[pc][pm]alphamerge[pa]`);
        g.push(`[pa][${rim}]overlay=0:0:shortest=1[pip]`);
        g.push(`[bg][pip]overlay=${b.x}:${b.y}:shortest=1[v0]`);
    } else {
        const { cw, ch, y } = cropWindow(vw, vh, style.aspect);
        const maxX = Math.max(0, vw - cw);
        g.push(`[${v}]crop=w=${even(cw)}:h=${even(ch)}:x='${cropExpr(cropPoints, maxX)}':y=${Math.round(y)},scale=${W}:${H}:flags=bicubic,setsar=1${zp(W, H, 'main', { x: midCropX(maxX), y: Math.round(y), w: even(cw), h: even(ch) })}[v0]`);
    }
    return 'v0';
}

/** Logo, freeze text and progress bar: shared by the main pieces and the replay. */
function finishing(o: RenderOptions, g: string[], inputs: string[], v: string, n: number, W: number, H: number, ws: number, freezeAt: number | null, tm: Timing): { v: string; n: number } {
    const { style } = o;
    if (freezeAt !== null && o.clip.freeze?.text.trim()) {
        inputs.push('-i', '/freeze.png');
        g.push(`[${v}][${n}:v]overlay=0:0:enable='gte(t,${freezeAt.toFixed(2)})'[vfz]`);
        v = 'vfz';
        n++;
    }
    if (o.brand.logo) {
        inputs.push('-i', '/logo.png');
        const lw = Math.round(W * o.brand.logoSize);
        const m = Math.round(W * 0.04);
        g.push(`[${n}:v]scale=${lw}:-1[lg]`);
        g.push(`[${v}][lg]overlay=${o.brand.logoCorner.endsWith('l') ? m : `W-w-${m}`}:${o.brand.logoCorner.startsWith('t') ? m : `H-h-${m}`}[vl]`);
        v = 'vl';
        n++;
    }
    const wm = o.brand.watermark;
    if (wm?.text.trim()) {
        inputs.push('-i', '/wm.png');
        const { m, mb } = watermarkMargins(W, H);
        const xs = (c: string) => (c.endsWith('l') ? `${m}` : `W-w-${m}`);
        const ys = (c: string) => (c.startsWith('t') ? `${m}` : `H-h-${mb}`);
        let x: string;
        let y: string;
        if (wm.moving) {
            // jumps corner every few seconds, counted in the finished video's time like the preview
            const idx = `mod(floor((t+${ws.toFixed(3)})/${WATERMARK_SECONDS}),4)`;
            const pick = (f: (c: string) => string) => WATERMARK_CYCLE.reduceRight((acc, c, i) => `if(eq(${idx},${i}),${f(c)},${acc})`, f(WATERMARK_CYCLE[0]));
            x = pick(xs);
            y = pick(ys);
        } else {
            x = xs(wm.corner);
            y = ys(wm.corner);
        }
        g.push(`[${v}][${n}:v]overlay=x='${x}':y='${y}'[vwm]`);
        v = 'vwm';
        n++;
    }
    if (style.progressBar) {
        const bh = even(Math.max(4, H * 0.008));
        inputs.push('-f', 'lavfi', '-i', `color=c=${hex(style.highlight)}:s=${W}x${bh}:r=${FPS}`);
        g.push(`[${v}]drawbox=x=0:y=${H - bh}:w=${W}:h=${bh}:color=white@0.25:t=fill[vpb]`);
        g.push(`[vpb][${n}:v]overlay=x='-w+w*(t+${ws.toFixed(3)})/${tm.full.toFixed(3)}':y=${H - bh}:shortest=1[vp]`);
        v = 'vp';
        n++;
    }
    return { v, n };
}

/**
 * H.264 settings for uploading. TikTok and YouTube always re-compress, so the upload should carry as
 * much detail as possible: a low CRF (high quality) with the fast "ultrafast" preset measured 2.8x
 * faster than "veryfast" at CRF 22 and clearly better (SSIM 0.998 vs 0.987); files are bigger, which
 * is fine for uploads. Standard HD colour tags so phones and platforms show the colours right.
 */
export function videoCodecArgs(quality: Quality, fps: number): string[] {
    const crf = quality === 720 ? 19 : 17;
    const maxrate = quality === 720 ? 16 : quality === 1080 ? 30 : 45; // Mbit/s ceiling so files stay reasonable
    return [
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(crf),
        '-maxrate', `${maxrate}M`, '-bufsize', `${maxrate * 2}M`,
        '-pix_fmt', 'yuv420p', '-g', String(fps * 2),
        '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
        '-r', String(fps), '-video_track_timescale', '15360'
    ];
}
export const AUDIO_ARGS = ['-c:a', 'aac', '-b:a', '256k', '-ar', '48000'];

const encodeArgs = (o: RenderOptions, len: number, out: string) => ['-an', '-t', f3(len), ...videoCodecArgs(o.quality, FPS), '-y', out];

/**
 * Video-only command for the piece of the main clip between output times ws and we.
 * Every time value is shifted so the piece starts at 0.
 */
function videoPartCommand(o: RenderOptions, input: string, ws: number, we: number, W: number, H: number, freezeHere: boolean, out: string): string[] {
    const { clip, style } = o;
    const tm = timing(clip);
    const tpl = getTemplate(style.template);
    const segs = keptSegments(clip);
    const outT = (src: number) => toOutputClamped(clip, src, segs);
    const rel = (t: number) => t - ws;
    const partLen = we - ws;
    const videoEnd = Math.min(we, tm.total);

    // source ranges that land inside [ws, videoEnd)
    const pieces: { s: number; e: number }[] = [];
    let acc = 0;
    for (const s of segs) {
        const os = acc;
        const oe = acc + (s.end - s.start);
        acc = oe;
        const a = Math.max(os, ws);
        const b = Math.min(oe, videoEnd);
        if (b - a > 0.001) pieces.push({ s: s.start + (a - os), e: s.start + (b - os) });
    }
    if (!pieces.length) {
        const last = segs[segs.length - 1];
        pieces.push({ s: Math.max(last.start, last.end - 0.1), e: last.end });
    }
    const srcFrom = pieces[0].s;
    const srcTo = pieces[pieces.length - 1].e;
    const inputs: string[] = ['-ss', f3(srcFrom), '-t', f3(srcTo - srcFrom + 0.05), '-i', input];
    const g: string[] = [];
    let n = 1;
    pieces.forEach((p, i) => g.push(`[0:v]trim=start=${f3(p.s - srcFrom)}:end=${f3(p.e - srcFrom)},setpts=PTS-STARTPTS[vs${i}]`));
    let v = 'vs0';
    if (pieces.length > 1) {
        g.push(`${pieces.map((_, i) => `[vs${i}]`).join('')}concat=n=${pieces.length}:v=1:a=0[vcat]`);
        v = 'vcat';
    }
    g.push(`[${v}]fps=${FPS},setsar=1[vf]`);
    v = 'vf';

    const zooms: PieceZoom[] = allZooms(clip)
        .map((z) => ({ ...z, start: rel(outT(z.start)), end: rel(outT(z.end)) }))
        .filter((z) => z.end > 0 && z.start < partLen && z.end - z.start > 0.05);
    const shakeTimes = allShakes(clip).filter((s) => s.kind !== 'flash').map((s) => rel(outT(s.t))).filter((a) => a > -0.5 && a < partLen);
    const shake = shakeTimes.length ? shakeTimes.map((a) => `between(in/${FPS},${a.toFixed(2)},${(a + 0.45).toFixed(2)})`).join('+') : null;
    // every piece has a single framing (pieces are split where a part's layout changes)
    const ls = styleAt(clip, style, toSource(clip, (ws + Math.max(ws, Math.min(we, tm.total) - 0.01)) / 2, segs));
    const cropPoints = cropPath(clip, ls, o.videoWidth, o.videoHeight).map((p) => ({ t: rel(outT(Math.max(clip.start, p.t))), x: p.x }));
    const addInput = (path: string) => {
        inputs.push('-loop', '1', '-i', path);
        return `${n++}:v`;
    };
    v = layout(o, g, v, W, H, zooms, shake, cropPoints, ls, addInput);

    for (const [i, s] of allShakes(clip).filter((s) => s.kind !== 'shake').entries()) {
        const a = rel(outT(s.t));
        if (a < -0.2 || a > partLen) continue;
        g.push(`[${v}]drawbox=x=0:y=0:w=iw:h=ih:color=white@0.6:t=fill:enable='between(t,${a.toFixed(2)},${(a + 0.09).toFixed(2)})'[vfl${i}]`);
        v = `vfl${i}`;
    }
    if (freezeHere && tm.freeze) {
        g.push(`[${v}]tpad=stop_mode=clone:stop_duration=${(tm.freeze + 0.2).toFixed(2)}[vz]`);
        v = 'vz';
    }
    g.push(`[${v}]subtitles=/subs.ass:fontsdir=/fonts[vs]`);
    v = 'vs';

    const overlayImage = (path: string, enable: string, label: string, pos = '0:0') => {
        inputs.push('-i', path);
        g.push(`[${v}][${n}:v]overlay=${pos}${enable ? `:enable='${enable}'` : ''}[${label}]`);
        v = label;
        n++;
    };
    if (clip.hookTitle?.text.trim() && clip.hookTitle.seconds > 0 && ws < clip.hookTitle.seconds) {
        overlayImage('/title.png', `between(t,0,${rel(Math.min(tm.total, clip.hookTitle.seconds)).toFixed(2)})`, 'vt');
    }
    (clip.stickers ?? []).forEach((st, i) => {
        const a = rel(outT(st.start));
        const b = rel(outT(st.end));
        if (b <= 0 || a >= partLen || b - a < 0.05) return;
        overlayImage(`/sticker_${i}.png`, `between(t,${a.toFixed(2)},${b.toFixed(2)})`, `vst${i}`);
    });
    if (style.emojis && tpl.id !== 'none') {
        const groups = groupWords(displayWords(o.words, clip, style, o.speakers, true), perLine(style));
        const events = emojiEvents(clip, groups).slice(0, 10);
        const size = Math.round(captionSize(tpl, style, W));
        const es = Math.round(size * 1.6);
        const centerY = Math.round(captionY(style) * H - size * 0.6 - es * 0.6);
        events.forEach((ev, i) => {
            const frames = style.emojiAnim
                ? [
                      { from: ev.start, to: ev.start + 0.06, bob: false },
                      { from: ev.start + 0.06, to: ev.start + 0.16, bob: false },
                      { from: ev.start + 0.16, to: ev.end, bob: true }
                  ]
                : [{ from: ev.start, to: ev.end, bob: false }];
            frames.forEach((f, k) => {
                const a = rel(f.from);
                const b = rel(f.to);
                if (b <= 0 || a >= partLen) return;
                const y = f.bob ? `${centerY}-h/2+${(es * 0.06).toFixed(1)}*sin(3*PI*(t-${a.toFixed(2)}))` : `${centerY}-h/2`;
                overlayImage(`/emoji_${i}_${k}.png`, `between(t,${a.toFixed(2)},${b.toFixed(2)})`, `ve${i}_${k}`, `x=(W-w)/2:y='${y}'`);
            });
        });
    }
    const fin = finishing(o, g, inputs, v, n, W, H, ws, freezeHere && tm.freeze ? rel(tm.total) : null, tm);
    return [...inputs, '-filter_complex', g.join(';'), '-map', `[${fin.v}]`, ...encodeArgs(o, partLen, out)];
}

/** The instant replay: a moment slowed down and zoomed in, played after the clip (then the freeze ending). */
function replayCommand(o: RenderOptions, input: string, W: number, H: number, out: string): string[] {
    const { clip, style } = o;
    const tm = timing(clip);
    const r = clip.replay!;
    const len = tm.replay + tm.freeze;
    const inputs: string[] = ['-ss', f3(r.start), '-t', f3(r.end - r.start + 0.05), '-i', input];
    const g: string[] = [`[0:v]trim=start=0:end=${f3(r.end - r.start)},setpts=(PTS-STARTPTS)/${r.speed.toFixed(3)},fps=${FPS},setsar=1[vr]`];
    let n = 1;
    const rs = styleAt(clip, style, r.start);
    const pos = cropPath(clip, rs, o.videoWidth, o.videoHeight);
    const at = pos.reduce((best, p) => (p.t <= r.start ? p : best), pos[0]);
    const addInput = (path: string) => {
        inputs.push('-loop', '1', '-i', path);
        return `${n++}:v`;
    };
    let v = layout(o, g, 'vr', W, H, [{ start: 0, end: 100000, scale: 1.18 }], null, [{ t: 0, x: at.x }], rs, addInput);
    if (tm.freeze) {
        g.push(`[${v}]tpad=stop_mode=clone:stop_duration=${(tm.freeze + 0.2).toFixed(2)}[vz]`);
        v = 'vz';
    }
    inputs.push('-i', '/replay.png');
    g.push(`[${v}][${n}:v]overlay=0:0:enable='lt(t,${tm.replay.toFixed(2)})'[vrb]`);
    v = 'vrb';
    n++;
    const fin = finishing(o, g, inputs, v, n, W, H, tm.total, tm.freeze ? tm.replay : null, tm);
    return [...inputs, '-filter_complex', g.join(';'), '-map', `[${fin.v}]`, ...encodeArgs(o, len, out)];
}

/** The whole soundtrack in one pass: cuts, bleeps, replay, freeze silence, sound effects, music. */
function audioCommand(o: RenderOptions, input: string, out: string, sfxFiles: { path: string; at: number }[], musicPath: string | null, hasSource: boolean): string[] {
    const { clip, style } = o;
    const tm = timing(clip);
    const segs = keptSegments(clip);
    const g: string[] = [];
    const inputs: string[] = [];
    let n = 0;
    let a: string;
    if (hasSource) {
        inputs.push('-ss', f3(clip.start), '-t', f3(clip.end - clip.start), '-i', input);
        n = 1;
        a = '0:a';
        if (segs.length > 1 || segs[0].start > clip.start + 0.01 || segs[0].end < clip.end - 0.01) {
            segs.forEach((s, i) => g.push(`[0:a]atrim=start=${f3(s.start - clip.start)}:end=${f3(s.end - clip.start)},asetpts=PTS-STARTPTS[as${i}]`));
            g.push(`${segs.map((_, i) => `[as${i}]`).join('')}concat=n=${segs.length}:v=0:a=1[acat]`);
            a = 'acat';
        }
        g.push(`[${a}]aresample=48000,aformat=channel_layouts=stereo[amain]`);
        a = 'amain';
        if (style.censor === 'bleep') {
            const spans = bleepSpans(o.words.filter((w) => w.end > clip.start && w.start < clip.end))
                .map((s) => ({ start: toOutput(clip, s.start, segs), end: toOutput(clip, Math.min(s.end, clip.end), segs) }))
                .filter((s): s is { start: number; end: number } => s.start !== null && s.end !== null && s.end > s.start);
            if (spans.length) {
                inputs.push('-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000'); // note: sine plays at 1/8 volume by default
                g.push(`[${a}]volume=volume=0:enable='${between(spans)}'[am]`);
                g.push(`[${n}:a]volume=1.8,volume=volume=0:enable='lt(${between(spans)},1)',aformat=channel_layouts=stereo[bp]`);
                g.push(`[am][bp]amix=inputs=2:duration=first:dropout_transition=0,volume=2[ab]`);
                a = 'ab';
                n++;
            }
        }
        if (tm.replay > 0 && clip.replay) {
            const r = clip.replay;
            g.push(`[0:a]atrim=start=${f3(r.start - clip.start)}:end=${f3(r.end - clip.start)},asetpts=PTS-STARTPTS,atempo=${Math.max(0.5, Math.min(2, r.speed)).toFixed(3)},aresample=48000,aformat=channel_layouts=stereo[arep]`);
            g.push(`[${a}][arep]concat=n=2:v=0:a=1[awr]`);
            a = 'awr';
        }
    } else {
        inputs.push('-f', 'lavfi', '-t', f3(tm.full), '-i', 'anullsrc=r=48000:cl=stereo');
        n = 1;
        a = '0:a';
    }
    g.push(`[${a}]apad=whole_dur=${f3(tm.full)}[apad]`);
    a = 'apad';

    // sound effects: each delayed to its moment and padded to full length so the mix level never jumps
    if (sfxFiles.length) {
        const vol = (style.sfxVolume ?? 0.8).toFixed(2);
        const labels: string[] = [];
        sfxFiles.forEach((s, i) => {
            inputs.push('-i', s.path);
            const ms = Math.max(0, Math.round(s.at * 1000));
            g.push(`[${n}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}|${ms},volume=${vol},apad=whole_dur=${f3(tm.full)}[sx${i}]`);
            labels.push(`[sx${i}]`);
            n++;
        });
        g.push(`[${a}]${labels.join('')}amix=inputs=${labels.length + 1}:duration=first:dropout_transition=0,volume=${labels.length + 1}[asfx]`);
        a = 'asfx';
    }

    // background music: looped, and ducked under speech if asked
    if (musicPath && o.music) {
        inputs.push('-stream_loop', '-1', '-i', musicPath);
        g.push(`[${n}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${o.music.volume.toFixed(2)}[mus]`);
        if (o.music.duck) {
            g.push(`[${a}]asplit=2[voice][sc]`);
            g.push(`[mus][sc]sidechaincompress=threshold=0.02:ratio=12:attack=20:release=400[duck]`);
            g.push(`[voice][duck]amix=inputs=2:duration=first:dropout_transition=0,volume=2[amus]`);
        } else g.push(`[${a}][mus]amix=inputs=2:duration=first:dropout_transition=0,volume=2[amus]`);
        a = 'amus';
        n++;
    }
    return [...inputs, '-filter_complex', g.join(';'), '-map', `[${a}]`, '-t', f3(tm.full), ...AUDIO_ARGS, '-y', out];
}

/**
 * Builds the finished clip: removes cut parts, frames it (crop / speaker tracking / fit / facecam
 * split), zooms, shakes, captions, title, stickers, emoji, logo, progress bar, replay, freeze,
 * bleeps, sound effects and music. The clip is rendered as pieces in parallel and joined.
 */
// one render at a time, whoever asks (export queue, compilation...): renders share the engines
// and the frame rate setting, so two at once would spoil each other
let renderChain: Promise<unknown> = Promise.resolve();
export function renderClip(o: RenderOptions): Promise<Blob> {
    const run = renderChain.then(() => renderClipNow(o));
    renderChain = run.catch(() => undefined);
    return run;
}

async function renderClipNow(o: RenderOptions): Promise<Blob> {
    const { clip, style } = o;
    const { W, H } = outputSize(style.aspect, o.quality);
    if (keptSegments(clip).length === 0) throw new Error('Everything in this clip is cut. Restore part of it in the timeline.');
    FPS = o.fps ?? 30;
    const tm = timing(clip);
    const hasSource = await hasAudio(o.file);
    const assets = await prepareAssets(o, W, H);

    // main part (+ freeze when there's no replay): first split where a part's framing changes,
    // then split long stretches so every processor core gets a piece
    const mainLen = snap(tm.total + (tm.replay ? 0 : tm.freeze));
    const runs: { start: number; end: number; key: string }[] = [];
    let acc = 0;
    for (const sg of segmentsOf(clip)) {
        const key = `${sg.layout ?? style.layout}|${sg.cropX ?? style.cropX}|${sg.splitRatio ?? style.splitRatio}`;
        const len = sg.end - sg.start;
        const last = runs[runs.length - 1];
        if (last && last.key === key) last.end = acc + len;
        else runs.push({ start: acc, end: acc + len, key });
        acc += len;
    }
    runs[runs.length - 1].end = mainLen;
    const target = Math.max(4, mainLen / parallelism());
    const bounds: number[] = [0];
    for (const r of runs) {
        const n = Math.max(1, Math.floor((r.end - r.start) / target));
        for (let k = 1; k <= n; k++) {
            const b = snap(k === n ? r.end : r.start + ((r.end - r.start) * k) / n);
            if (b - bounds[bounds.length - 1] >= 1 / FPS) bounds.push(b);
        }
    }
    bounds[bounds.length - 1] = mainLen;
    const nParts = bounds.length - 1;
    const jobList: { kind: 'part' | 'replay'; i: number }[] = Array.from({ length: nParts }, (_, i) => ({ kind: 'part' as const, i }));
    if (tm.replay) jobList.push({ kind: 'replay', i: nParts });
    const engines = Math.max(1, Math.min(parallelism(), jobList.length));
    let finished = 0;

    const report = () => {
        let active = 0;
        for (let e = 0; e < engines; e++) {
            const pr = pool[e]?.progress ?? 0;
            if (pr < 1) active += pr;
        }
        o.onProgress(Math.min(0.95, ((finished + active) / jobList.length) * 0.9));
    };
    progressListener = report;

    const runJob = async (engine: number, make: (input: string) => string[], ass: string | null, out: string, seconds: number): Promise<Uint8Array> => {
        const { ff, input } = await mountOn(engine, o.file);
        engineAt(engine).progress = 0;
        engineAt(engine).expected = Math.max(0.5, seconds);
        // writeFile hands the bytes over to the engine (the buffer is moved, not copied), so give each engine its own copy
        for (const f of assets.files) await ff.writeFile(f.path, f.data.slice());
        if (ass !== null) await ff.writeFile('/subs.ass', new TextEncoder().encode(ass));
        const code = await ff.exec(make(input));
        if (code !== 0) throw new Error('Rendering failed. Try 720p, or turn off some effects, then try again.');
        const data = (await ff.readFile(out)) as Uint8Array;
        await ff.deleteFile(out);
        engineAt(engine).progress = 1;
        engineAt(engine).expected = 0;
        finished++;
        report();
        return data;
    };

    try {
        // a small job queue: each engine takes the next piece when it's free
        const parts: Uint8Array[] = new Array(jobList.length);
        let next = 0;
        await Promise.all(
            Array.from({ length: engines }, async (_, e) => {
                while (next < jobList.length) {
                    const job = jobList[next++];
                    if (job.kind === 'part') {
                        const i = job.i;
                        parts[i] = await runJob(e, (input) => videoPartCommand(o, input, bounds[i], bounds[i + 1], W, H, !tm.replay && i === nParts - 1, `/part_${i}.mp4`), shiftAss(assets.ass, bounds[i]), `/part_${i}.mp4`, bounds[i + 1] - bounds[i] + (!tm.replay && i === nParts - 1 ? tm.freeze : 0));
                    } else parts[job.i] = await runJob(e, (input) => replayCommand(o, input, W, H, '/replay.mp4'), null, '/replay.mp4', tm.replay + tm.freeze);
                }
            })
        );

        // sound in one pass, then join everything on the first engine (no re-encoding)
        const { ff, input } = await mountOn(0, o.file);
        const sfx: { path: string; at: number }[] = [];
        for (const [i, s] of allSfx(clip).entries()) {
            const at = toOutput(clip, s.t);
            if (at === null) continue;
            const path = `/sfx_${i}.wav`;
            await ff.writeFile(path, await sfxWav(s.kind));
            sfx.push({ path, at });
        }
        let musicPath: string | null = null;
        if (o.music?.blob) {
            musicPath = '/music.' + (o.music.name.split('.').pop() || 'mp3');
            await ff.writeFile(musicPath, new Uint8Array(await o.music.blob.arrayBuffer()));
        }
        const withAudio = hasSource || sfx.length > 0 || !!musicPath;
        if (withAudio) {
            const code = await ff.exec(audioCommand(o, input, '/audio.m4a', sfx, musicPath, hasSource));
            if (code !== 0) throw new Error('Could not process the sound. Try turning off the bleep, sound effects or music, then export again.');
        }
        const list: string[] = [];
        for (let i = 0; i < parts.length; i++) {
            await ff.writeFile(`/join_${i}.mp4`, parts[i]);
            list.push(`file '/join_${i}.mp4'`);
        }
        await ff.writeFile('/join.txt', new TextEncoder().encode(list.join('\n')));
        const out = '/out.mp4';
        const code = await ff.exec([
            '-f', 'concat', '-safe', '0', '-i', '/join.txt',
            ...(withAudio ? ['-i', '/audio.m4a', '-map', '0:v', '-map', '1:a'] : []),
            '-c', 'copy', '-t', f3(tm.full), '-movflags', '+faststart', '-y', out
        ]);
        for (let i = 0; i < parts.length; i++) await ff.deleteFile(`/join_${i}.mp4`).catch(() => {});
        for (const s of sfx) await ff.deleteFile(s.path).catch(() => {});
        if (musicPath) await ff.deleteFile(musicPath).catch(() => {});
        if (code !== 0) throw new Error('Could not join the video pieces. Please try again.');
        const data = (await ff.readFile(out)) as Uint8Array;
        await ff.deleteFile(out);
        if (withAudio) await ff.deleteFile('/audio.m4a').catch(() => {});
        o.onProgress(1);
        return new Blob([data], { type: 'video/mp4' });
    } finally {
        progressListener = null;
        for (let e = 0; e < pool.length; e++) if (pool[e]) pool[e]!.expected = 0;
        FPS = 30;
    }
}

/** Renders a title card (number + title) as a short video piece, for compilations. */
export async function renderCard(png: Uint8Array, seconds: number, quality: Quality, withAudio: boolean): Promise<Uint8Array> {
    const ff = await getFFmpeg();
    await ff.writeFile('/card.png', png);
    const code = await ff.exec([
        '-loop', '1', '-t', f3(seconds), '-i', '/card.png',
        ...(withAudio ? ['-f', 'lavfi', '-t', f3(seconds), '-i', 'anullsrc=r=48000:cl=stereo'] : []),
        ...videoCodecArgs(quality, 30),
        ...(withAudio ? AUDIO_ARGS : []),
        '-t', f3(seconds), '-y', '/card.mp4'
    ]);
    if (code !== 0) throw new Error('Could not make the title card.');
    const data = (await ff.readFile('/card.mp4')) as Uint8Array;
    await ff.deleteFile('/card.mp4');
    return data;
}

/** Joins finished clips (and title cards) into one video without re-encoding. */
export async function joinVideos(parts: Uint8Array[]): Promise<Blob> {
    const ff = await getFFmpeg();
    const list: string[] = [];
    for (let i = 0; i < parts.length; i++) {
        await ff.writeFile(`/comp_${i}.mp4`, parts[i]);
        list.push(`file '/comp_${i}.mp4'`);
    }
    await ff.writeFile('/comp.txt', new TextEncoder().encode(list.join('\n')));
    const code = await ff.exec(['-f', 'concat', '-safe', '0', '-i', '/comp.txt', '-c', 'copy', '-movflags', '+faststart', '-y', '/comp.mp4']);
    for (let i = 0; i < parts.length; i++) await ff.deleteFile(`/comp_${i}.mp4`).catch(() => {});
    if (code !== 0) throw new Error('Could not join the clips.');
    const data = (await ff.readFile('/comp.mp4')) as Uint8Array;
    await ff.deleteFile('/comp.mp4');
    return new Blob([data], { type: 'video/mp4' });
}
