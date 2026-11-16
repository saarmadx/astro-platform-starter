import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { bleepSpans } from './censor';
import { buildAss, captionSize, captionY, displayWords, emojiEvents, groupWords } from './captions';
import { drawFreezeText, drawHookTitleText, emojiPng, textOverlayPng } from './draw';
import { cropPath, cropWindow, outputSize } from './geometry';
import { FONT_FILES, getTemplate } from './templates';
import { keptSegments, outputDuration, toOutput, toOutputClamped } from './timeline';
import type { Brand, Clip, StyleSettings, Word } from './types';

// All video work happens in the user's browser with ffmpeg.wasm, so videos never have to be
// uploaded to a server. Only small audio chunks are sent off for transcription.
//
// Speed: one ffmpeg.wasm engine uses one processor core. To export faster, a clip is cut into
// pieces that several engines render at the same time (one per core), then joined. The sound is
// rendered once in a single pass, so there are no clicks where pieces meet.

type Engine = { ff: Promise<FFmpeg>; mounted: File | null; progress: number };
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
        if (e) e.progress = Math.min(1, Math.max(0, progress));
        progressListener?.();
    });
    ff.on('log', ({ message }) => {
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
        e = { ff, mounted: null, progress: 0 };
        pool[i] = e;
        ff.catch(() => (pool[i] = undefined));
    }
    return e;
}

export function getFFmpeg(): Promise<FFmpeg> {
    return engineAt(0).ff;
}

/** Mount the source video into an engine without copying it into memory (works for big files). */
async function mountOn(i: number, file: File): Promise<{ ff: FFmpeg; input: string }> {
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
    const { ff, input } = await mountOn(0, file);
    const count = Math.max(1, Math.ceil(duration / chunkSeconds));
    const chunks: { offset: number; blob: Blob }[] = [];
    for (let i = 0; i < count; i++) {
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
const FPS = 30;
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
    quality: 720 | 1080;
    videoWidth: number;
    videoHeight: number;
    speakers?: { t: number; speaker: number }[];
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
    if (style.emojis && tpl.id !== 'none') {
        const groups = groupWords(displayWords(o.words, clip, style, o.speakers, true), style.wordsPerLine);
        const events = emojiEvents(clip, groups).slice(0, 10);
        const es = Math.round(captionSize(tpl, style, W) * 1.6);
        for (let i = 0; i < events.length; i++) {
            const scales = style.emojiAnim ? [0.6, 1.2, 1] : [1];
            for (let k = 0; k < scales.length; k++) files.push({ path: `/emoji_${i}_${k}.png`, data: await emojiPng(events[i].emoji, even(es * scales[k])) });
        }
    }
    return { files, ass: buildAss(o.words, clip, style, W, H, o.speakers) };
}

/**
 * Video-only command for the piece of the finished clip between output times ws and we.
 * Every time value is shifted so the piece starts at 0.
 */
function videoPartCommand(o: RenderOptions, input: string, ws: number, we: number, W: number, H: number, isLast: boolean, out: string): string[] {
    const { clip, style } = o;
    const tpl = getTemplate(style.template);
    const vw = o.videoWidth;
    const vh = o.videoHeight;
    const segs = keptSegments(clip);
    const total = outputDuration(clip);
    const freeze = clip.freeze && clip.freeze.seconds > 0 ? clip.freeze.seconds : 0;
    const outT = (src: number) => toOutputClamped(clip, src, segs);
    const rel = (t: number) => t - ws; // output time -> time inside this piece
    const partLen = we - ws;
    const videoEnd = Math.min(we, total); // the rest of this piece (if any) is the freeze ending

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
        // this piece is all freeze: start from the very last frame
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

    const zooms = (clip.zooms ?? [])
        .map((z) => ({ start: rel(outT(z.start)), end: rel(outT(z.end)), scale: z.scale }))
        .filter((z) => z.end > 0 && z.start < partLen && z.end - z.start > 0.05);
    const zoom = (w: number, h: number) => {
        if (!zooms.length) return '';
        let expr = '1';
        for (const z of zooms) expr = `if(between(in/${FPS},${z.start.toFixed(2)},${z.end.toFixed(2)}),${z.scale.toFixed(3)},${expr})`;
        return `,zoompan=z='${expr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${w}x${h}:fps=${FPS}`;
    };

    if (style.layout === 'fit') {
        g.push(`[${v}]split[fa][fb]`);
        g.push(`[fa]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=luma_radius=28:luma_power=2,eq=brightness=-0.07[bg]`);
        g.push(`[fb]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg]`);
        g.push(`[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1${zoom(W, H)}[v0]`);
    } else if (style.layout === 'split') {
        const fc = style.facecam ?? { x: 0, y: 0, w: 0.3, h: 0.3 };
        const TH = even(H * (style.splitRatio ?? 0.4));
        const BH = H - TH;
        const ar = W / BH;
        const gw = even(Math.min(vw, vh * ar));
        const gh = even(Math.min(vh, vw / ar));
        g.push(`[${v}]split[fa][fb]`);
        g.push(`[fa]crop=${even(fc.w * vw)}:${even(fc.h * vh)}:${Math.round(fc.x * vw)}:${Math.round(fc.y * vh)},scale=${W}:${TH}:force_original_aspect_ratio=increase,crop=${W}:${TH},setsar=1${zoom(W, TH)}[top]`);
        g.push(`[fb]crop=${gw}:${gh}:${Math.round((vw - gw) * style.cropX)}:${Math.round((vh - gh) / 2)},scale=${W}:${BH}:force_original_aspect_ratio=increase,crop=${W}:${BH},setsar=1${zoom(W, BH)}[bot]`);
        g.push(`[top][bot]vstack=inputs=2,drawbox=x=0:y=${TH - 2}:w=${W}:h=4:color=black:t=fill[v0]`);
    } else {
        const { cw, ch, y } = cropWindow(vw, vh, style.aspect);
        const maxX = Math.max(0, vw - cw);
        const points = cropPath(clip, style, vw, vh).map((p) => ({ t: rel(outT(Math.max(clip.start, p.t))), x: p.x }));
        g.push(`[${v}]crop=w=${even(cw)}:h=${even(ch)}:x='${cropExpr(points, maxX)}':y=${Math.round(y)},scale=${W}:${H}:flags=bicubic,setsar=1${zoom(W, H)}[v0]`);
    }
    v = 'v0';

    if (isLast && freeze) {
        g.push(`[${v}]tpad=stop_mode=clone:stop_duration=${(freeze + 0.2).toFixed(2)}[vz]`);
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
        overlayImage('/title.png', `between(t,0,${rel(Math.min(total, clip.hookTitle.seconds)).toFixed(2)})`, 'vt');
    }
    if (freeze && clip.freeze?.text.trim() && we > total) overlayImage('/freeze.png', `gte(t,${rel(total).toFixed(2)})`, 'vfz');

    if (o.brand.logo) {
        inputs.push('-i', '/logo.png');
        const lw = Math.round(W * o.brand.logoSize);
        const m = Math.round(W * 0.04);
        g.push(`[${n}:v]scale=${lw}:-1[lg]`);
        g.push(`[${v}][lg]overlay=${o.brand.logoCorner.endsWith('l') ? m : `W-w-${m}`}:${o.brand.logoCorner.startsWith('t') ? m : `H-h-${m}`}[vl]`);
        v = 'vl';
        n++;
    }

    if (style.emojis && tpl.id !== 'none') {
        const groups = groupWords(displayWords(o.words, clip, style, o.speakers, true), style.wordsPerLine);
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

    if (style.progressBar) {
        const bh = even(Math.max(4, H * 0.008));
        inputs.push('-f', 'lavfi', '-i', `color=c=${hex(style.highlight)}:s=${W}x${bh}:r=${FPS}`);
        g.push(`[${v}]drawbox=x=0:y=${H - bh}:w=${W}:h=${bh}:color=white@0.25:t=fill[vpb]`);
        g.push(`[vpb][${n}:v]overlay=x='-w+w*(t+${ws.toFixed(3)})/${(total + freeze).toFixed(3)}':y=${H - bh}:shortest=1[vp]`);
        v = 'vp';
        n++;
    }

    return [
        ...inputs,
        '-filter_complex', g.join(';'),
        '-map', `[${v}]`, '-an',
        '-t', f3(partLen),
        '-c:v', 'libx264', '-preset', o.quality === 1080 ? 'veryfast' : 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p',
        '-r', String(FPS), '-video_track_timescale', '15360',
        '-y', out
    ];
}

/** The whole soundtrack in one pass: cut parts removed, bleeps, silence for the freeze ending. */
function audioCommand(o: RenderOptions, input: string, out: string): string[] {
    const { clip, style } = o;
    const segs = keptSegments(clip);
    const total = outputDuration(clip);
    const freeze = clip.freeze && clip.freeze.seconds > 0 ? clip.freeze.seconds : 0;
    const inputs = ['-ss', f3(clip.start), '-t', f3(clip.end - clip.start), '-i', input];
    const g: string[] = [];
    let a = '0:a';
    let n = 1;
    if (segs.length > 1 || segs[0].start > clip.start + 0.01 || segs[0].end < clip.end - 0.01) {
        segs.forEach((s, i) => g.push(`[0:a]atrim=start=${f3(s.start - clip.start)}:end=${f3(s.end - clip.start)},asetpts=PTS-STARTPTS[as${i}]`));
        g.push(`${segs.map((_, i) => `[as${i}]`).join('')}concat=n=${segs.length}:v=0:a=1[acat]`);
        a = 'acat';
    }
    if (style.censor === 'bleep') {
        const spans = bleepSpans(o.words.filter((w) => w.end > clip.start && w.start < clip.end))
            .map((s) => ({ start: toOutput(clip, s.start, segs), end: toOutput(clip, Math.min(s.end, clip.end), segs) }))
            .filter((s): s is { start: number; end: number } => s.start !== null && s.end !== null && s.end > s.start);
        if (spans.length) {
            inputs.push('-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000'); // note: sine plays at 1/8 volume by default
            g.push(`[${a}]volume=volume=0:enable='${between(spans)}'[am]`);
            g.push(`[${n}:a]volume=1.8,volume=volume=0:enable='lt(${between(spans)},1)'[bp]`);
            g.push(`[am][bp]amix=inputs=2:duration=first:dropout_transition=0,volume=2[ab]`);
            a = 'ab';
            n++;
        }
    }
    g.push(`[${a}]aresample=48000,aformat=channel_layouts=stereo,apad=pad_dur=${(freeze + 0.5).toFixed(2)}[aout]`);
    return [...inputs, '-filter_complex', g.join(';'), '-map', '[aout]', '-t', f3(total + freeze), '-c:a', 'aac', '-b:a', '160k', '-y', out];
}

/**
 * Builds the finished clip: removes cut parts, frames it (crop / speaker tracking / fit / facecam
 * split), punch-in zooms, captions, title and freeze text, logo, emoji, progress bar and bleeps.
 * The clip is rendered as pieces in parallel (one per processor core) and joined.
 */
export async function renderClip(o: RenderOptions): Promise<Blob> {
    const { clip, style } = o;
    const { W, H } = outputSize(style.aspect, o.quality);
    if (keptSegments(clip).length === 0) throw new Error('Everything in this clip is cut. Restore part of it in the timeline.');
    const total = outputDuration(clip);
    const freeze = clip.freeze && clip.freeze.seconds > 0 ? clip.freeze.seconds : 0;
    const full = snap(total + freeze);
    const audio = await hasAudio(o.file);
    const assets = await prepareAssets(o, W, H);

    // pieces of at least ~4 seconds, one per engine
    const nParts = Math.max(1, Math.min(parallelism(), Math.floor(full / 4)));
    const bounds: number[] = [0];
    for (let i = 1; i < nParts; i++) bounds.push(snap((full * i) / nParts));
    bounds.push(full);

    const report = () => {
        let done = 0;
        for (let i = 0; i < nParts; i++) done += pool[i]?.progress ?? 0;
        o.onProgress(Math.min(0.95, (done / nParts) * 0.92));
    };
    progressListener = report;

    const dbg = (m: string) => (globalThis as { __clipsmithDebug?: boolean }).__clipsmithDebug && console.log(`[ffmpeg ${m}`);
    const renderPart = async (i: number): Promise<Uint8Array> => {
        dbg(`${i}] piece starting`);
        const { ff, input } = await mountOn(i, o.file);
        dbg(`${i}] engine ready, input mounted`);
        engineAt(i).progress = 0;
        // writeFile hands the bytes over to the engine (the buffer is moved, not copied), so give each engine its own copy
        for (const f of assets.files) await ff.writeFile(f.path, f.data.slice());
        await ff.writeFile('/subs.ass', new TextEncoder().encode(shiftAss(assets.ass, bounds[i])));
        const out = `/part_${i}.mp4`;
        const code = await ff.exec(videoPartCommand(o, input, bounds[i], bounds[i + 1], W, H, i === nParts - 1, out));
        if (code !== 0) throw new Error('Rendering failed. Try 720p, or turn off some effects, then try again.');
        const data = (await ff.readFile(out)) as Uint8Array;
        await ff.deleteFile(out);
        engineAt(i).progress = 1;
        report();
        return data;
    };

    try {
        const parts = await Promise.all(Array.from({ length: nParts }, (_, i) => renderPart(i)));

        // sound in one pass, then join everything on the first engine (no re-encoding)
        const { ff, input } = await mountOn(0, o.file);
        if (audio) {
            const code = await ff.exec(audioCommand(o, input, '/audio.m4a'));
            if (code !== 0) throw new Error('Could not process the sound. Try turning off the bleep, then export again.');
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
            ...(audio ? ['-i', '/audio.m4a', '-map', '0:v', '-map', '1:a'] : []),
            '-c', 'copy', '-t', f3(full), '-movflags', '+faststart', '-y', out
        ]);
        for (let i = 0; i < parts.length; i++) await ff.deleteFile(`/join_${i}.mp4`).catch(() => {});
        if (code !== 0) throw new Error('Could not join the video pieces. Please try again.');
        const data = (await ff.readFile(out)) as Uint8Array;
        await ff.deleteFile(out);
        if (audio) await ff.deleteFile('/audio.m4a').catch(() => {});
        o.onProgress(1);
        return new Blob([data], { type: 'video/mp4' });
    } finally {
        progressListener = null;
    }
}
