import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { buildAss, emojiEvents, groupWords, wordsInRange, captionY } from './captions';
import { emojiPng } from './draw';
import { cropPath, cropWindow, outputSize } from './geometry';
import { FONT_FILES, getTemplate } from './templates';
import type { Brand, Clip, StyleSettings, Word } from './types';

// All video work happens in the user's browser with ffmpeg.wasm, so videos never have to be
// uploaded to a server. Only small audio chunks are sent off for transcription.

let ffmpegPromise: Promise<FFmpeg> | null = null;
let progressHandler: ((ratio: number) => void) | null = null;
let mountedFile: File | null = null;
const INPUT_DIR = '/input';

export function getFFmpeg(): Promise<FFmpeg> {
    if (!ffmpegPromise) {
        ffmpegPromise = (async () => {
            const ff = new FFmpeg();
            ff.on('progress', ({ progress }) => progressHandler?.(Math.min(1, Math.max(0, progress))));
            const base = `${location.origin}/ffmpeg`;
            await ff.load({
                coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
                wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm')
            });
            await ff.createDir('/fonts');
            for (const f of FONT_FILES) await ff.writeFile(`/fonts/${f}`, await fetchFile(`/fonts/${f}`));
            return ff;
        })();
        ffmpegPromise.catch(() => (ffmpegPromise = null));
    }
    return ffmpegPromise;
}

/** Mount the source video into ffmpeg without copying it into memory (works for big files). */
async function mountInput(ff: FFmpeg, file: File): Promise<string> {
    if (mountedFile !== file) {
        if (mountedFile) {
            await ff.unmount(INPUT_DIR).catch(() => {});
            await ff.deleteDir(INPUT_DIR).catch(() => {});
        }
        await ff.createDir(INPUT_DIR).catch(() => {});
        await ff.mount(FFFSType.WORKERFS, { files: [file] }, INPUT_DIR);
        mountedFile = file;
    }
    return `${INPUT_DIR}/${file.name}`;
}

export const CHUNK_SECONDS = 600;

/** Extract small mono mp3 audio chunks for transcription. */
export async function extractAudioChunks(
    file: File,
    duration: number,
    onProgress: (ratio: number) => void,
    chunkSeconds = CHUNK_SECONDS
): Promise<{ offset: number; blob: Blob }[]> {
    const ff = await getFFmpeg();
    const input = await mountInput(ff, file);
    const count = Math.max(1, Math.ceil(duration / chunkSeconds));
    const chunks: { offset: number; blob: Blob }[] = [];
    for (let i = 0; i < count; i++) {
        const offset = i * chunkSeconds;
        progressHandler = (r) => onProgress((i + r) / count);
        const out = `/chunk_${i}.mp3`;
        const code = await ff.exec(['-ss', String(offset), '-t', String(chunkSeconds), '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-y', out]);
        if (code !== 0) throw new Error('Could not read the audio track. Is this a valid video file?');
        const data = await ff.readFile(out);
        await ff.deleteFile(out);
        chunks.push({ offset, blob: new Blob([data as Uint8Array], { type: 'audio/mpeg' }) });
    }
    progressHandler = null;
    onProgress(1);
    return chunks;
}

/** ffmpeg expression for a piecewise-linear crop path (pixels), in clip-relative time `t`. */
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

export type RenderOptions = {
    file: File;
    clip: Clip;
    words: Word[];
    style: StyleSettings;
    brand: Brand;
    quality: 720 | 1080;
    videoWidth: number;
    videoHeight: number;
    onProgress: (ratio: number) => void;
};

/** Cut one clip, reframe it, burn in captions, emoji and logo, return an MP4 blob. */
export async function renderClip(o: RenderOptions): Promise<Blob> {
    const ff = await getFFmpeg();
    const input = await mountInput(ff, o.file);
    const { clip, style } = o;
    const duration = clip.end - clip.start;
    const { W, H } = outputSize(style.aspect, o.quality);
    const tpl = getTemplate(style.template);

    await ff.writeFile('/subs.ass', new TextEncoder().encode(buildAss(o.words, clip, style, W, H)));

    const inputs: string[] = ['-ss', clip.start.toFixed(3), '-t', duration.toFixed(3), '-i', input];
    const graph: string[] = [];
    let n = 1;

    if (style.layout === 'fit') {
        graph.push(`[0:v]split[a][b]`);
        graph.push(`[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=luma_radius=28:luma_power=2,eq=brightness=-0.07[bg]`);
        graph.push(`[b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg]`);
        graph.push(`[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v0]`);
    } else {
        const { cw, ch, y } = cropWindow(o.videoWidth, o.videoHeight, style.aspect);
        const maxX = Math.max(0, o.videoWidth - cw);
        const points = cropPath(clip, style, o.videoWidth, o.videoHeight).map((p) => ({ t: Math.max(0, p.t - clip.start), x: p.x }));
        const even = (v: number) => Math.floor(v / 2) * 2;
        graph.push(`[0:v]crop=w=${even(cw)}:h=${even(ch)}:x='${cropExpr(points, maxX)}':y=${Math.round(y)},scale=${W}:${H}:flags=bicubic,setsar=1[v0]`);
    }
    let last = 'v0';

    if (tpl.id !== 'none') {
        graph.push(`[${last}]subtitles=/subs.ass:fontsdir=/fonts[v1]`);
        last = 'v1';
    }

    if (o.brand.logo) {
        await ff.writeFile('/logo.png', dataUrlBytes(o.brand.logo));
        inputs.push('-i', '/logo.png');
        const lw = Math.round(W * o.brand.logoSize);
        const m = Math.round(W * 0.04);
        const x = o.brand.logoCorner.endsWith('l') ? `${m}` : `W-w-${m}`;
        const y = o.brand.logoCorner.startsWith('t') ? `${m}` : `H-h-${m}`;
        graph.push(`[${n}:v]scale=${lw}:-1[lg]`);
        graph.push(`[${last}][lg]overlay=${x}:${y}[vl]`);
        last = 'vl';
        n++;
    }

    if (style.emojis && tpl.id !== 'none') {
        const groups = groupWords(wordsInRange(o.words, clip.start, clip.end), style.wordsPerLine);
        const events = emojiEvents(clip, groups).slice(0, 12);
        const size = Math.round(tpl.size * W * (style.aspect === '16:9' ? 0.6 : 1));
        const es = Math.round(size * 1.7);
        const lines = 1;
        const top = Math.round(captionY(style.position) * H - size * 0.6 * lines - es * 1.1);
        for (let i = 0; i < events.length; i++) {
            const ev = events[i];
            await ff.writeFile(`/emoji_${i}.png`, await emojiPng(ev.emoji, es));
            inputs.push('-i', `/emoji_${i}.png`);
            const a = Math.max(0, ev.start - clip.start).toFixed(2);
            const b = Math.max(0, ev.end - clip.start).toFixed(2);
            graph.push(`[${last}][${n}:v]overlay=(W-w)/2:${Math.max(0, top)}:enable='between(t,${a},${b})'[ve${i}]`);
            last = `ve${i}`;
            n++;
        }
    }

    progressHandler = o.onProgress;
    const out = '/out.mp4';
    const code = await ff.exec([
        ...inputs,
        '-filter_complex', graph.join(';'),
        '-map', `[${last}]`, '-map', '0:a?',
        '-c:v', 'libx264', '-preset', o.quality === 1080 ? 'veryfast' : 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-y', out
    ]);
    progressHandler = null;
    if (code !== 0) throw new Error('Rendering failed. Try 720p or a shorter clip.');
    const data = await ff.readFile(out);
    await ff.deleteFile(out);
    o.onProgress(1);
    return new Blob([data as Uint8Array], { type: 'video/mp4' });
}
