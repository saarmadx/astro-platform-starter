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

/** ffmpeg expression for a piecewise-linear crop path (pixels), in output time `t`. */
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
async function hasAudio(ff: FFmpeg, file: File, input: string): Promise<boolean> {
    const known = audioCache.get(file);
    if (known !== undefined) return known;
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
const between = (spans: { start: number; end: number }[]) => spans.map((s) => `between(t,${s.start.toFixed(2)},${s.end.toFixed(2)})`).join('+') || '0';

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

/**
 * Builds the finished clip: removes cut parts, frames it (crop / speaker tracking / fit / facecam
 * split), punch-in zooms, captions + title + freeze text, logo, emoji, progress bar and bleeps.
 */
export async function renderClip(o: RenderOptions): Promise<Blob> {
    const ff = await getFFmpeg();
    const input = await mountInput(ff, o.file);
    const { clip, style } = o;
    const { W, H } = outputSize(style.aspect, o.quality);
    const tpl = getTemplate(style.template);
    const vw = o.videoWidth;
    const vh = o.videoHeight;
    const audio = await hasAudio(ff, o.file, input);
    const segs = keptSegments(clip);
    if (segs.length === 0) throw new Error('Everything in this clip is cut. Restore part of it in the timeline.');
    const total = outputDuration(clip);
    const freeze = clip.freeze && clip.freeze.seconds > 0 ? clip.freeze.seconds : 0;
    const outT = (src: number) => toOutputClamped(clip, src, segs);

    await ff.writeFile('/subs.ass', new TextEncoder().encode(buildAss(o.words, clip, style, W, H, o.speakers)));

    const inputs: string[] = ['-ss', clip.start.toFixed(3), '-t', (clip.end - clip.start).toFixed(3), '-i', input];
    const g: string[] = [];
    let n = 1;
    let a = audio ? '0:a' : '';

    // 1) keep only the parts that were not cut
    let v = '0:v';
    if (segs.length > 1 || segs[0].start > clip.start + 0.01 || segs[0].end < clip.end - 0.01) {
        const parts: string[] = [];
        segs.forEach((s, i) => {
            const st = (s.start - clip.start).toFixed(3);
            const en = (s.end - clip.start).toFixed(3);
            g.push(`[0:v]trim=start=${st}:end=${en},setpts=PTS-STARTPTS[vs${i}]`);
            if (audio) g.push(`[0:a]atrim=start=${st}:end=${en},asetpts=PTS-STARTPTS[as${i}]`);
            parts.push(audio ? `[vs${i}][as${i}]` : `[vs${i}]`);
        });
        g.push(`${parts.join('')}concat=n=${segs.length}:v=1:a=${audio ? 1 : 0}${audio ? '[vcat][acat]' : '[vcat]'}`);
        v = 'vcat';
        if (audio) a = 'acat';
    }
    g.push(`[${v}]fps=30,setsar=1[vf]`);
    v = 'vf';

    // punch-in zooms, as a zoompan filter for a region of size w x h (time from frame number at 30 fps)
    const zooms = (clip.zooms ?? [])
        .map((z) => ({ start: outT(z.start), end: outT(z.end), scale: z.scale }))
        .filter((z) => z.end - z.start > 0.05);
    const zoom = (w: number, h: number) => {
        if (!zooms.length) return '';
        let expr = '1';
        for (const z of zooms) expr = `if(between(in/30,${z.start.toFixed(2)},${z.end.toFixed(2)}),${z.scale.toFixed(3)},${expr})`;
        return `,zoompan=z='${expr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${w}x${h}:fps=30`;
    };

    // 2) framing
    if (style.layout === 'fit') {
        g.push(`[${v}]split[fa][fb]`);
        g.push(`[fa]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=luma_radius=28:luma_power=2,eq=brightness=-0.07[bg]`);
        g.push(`[fb]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg]`);
        g.push(`[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1${zoom(W, H)}[v0]`);
    } else if (style.layout === 'split') {
        const fc = style.facecam ?? { x: 0, y: 0, w: 0.3, h: 0.3 };
        const TH = even(H * (style.splitRatio ?? 0.4));
        const BH = H - TH;
        const fw = even(fc.w * vw);
        const fh = even(fc.h * vh);
        const ar = W / BH;
        const gw = even(Math.min(vw, vh * ar));
        const gh = even(Math.min(vh, vw / ar));
        const gx = Math.round((vw - gw) * style.cropX);
        const gy = Math.round((vh - gh) / 2);
        g.push(`[${v}]split[fa][fb]`);
        g.push(`[fa]crop=${fw}:${fh}:${Math.round(fc.x * vw)}:${Math.round(fc.y * vh)},scale=${W}:${TH}:force_original_aspect_ratio=increase,crop=${W}:${TH},setsar=1${zoom(W, TH)}[top]`);
        g.push(`[fb]crop=${gw}:${gh}:${gx}:${gy},scale=${W}:${BH}:force_original_aspect_ratio=increase,crop=${W}:${BH},setsar=1${zoom(W, BH)}[bot]`);
        g.push(`[top][bot]vstack=inputs=2,drawbox=x=0:y=${TH - 2}:w=${W}:h=4:color=black:t=fill[v0]`);
    } else {
        const { cw, ch, y } = cropWindow(vw, vh, style.aspect);
        const maxX = Math.max(0, vw - cw);
        const points = cropPath(clip, style, vw, vh).map((p) => ({ t: outT(Math.max(clip.start, p.t)), x: p.x }));
        g.push(`[${v}]crop=w=${even(cw)}:h=${even(ch)}:x='${cropExpr(points, maxX)}':y=${Math.round(y)},scale=${W}:${H}:flags=bicubic,setsar=1${zoom(W, H)}[v0]`);
    }
    v = 'v0';

    // 3) freeze the last frame
    if (freeze) {
        g.push(`[${v}]tpad=stop_mode=clone:stop_duration=${freeze.toFixed(2)}[vz]`);
        v = 'vz';
    }

    // 4) captions, hook title and freeze text (all in the .ass file)
    g.push(`[${v}]subtitles=/subs.ass:fontsdir=/fonts[vs]`);
    v = 'vs';

    // 4b) hook title and freeze text, drawn exactly like the preview
    if (clip.hookTitle?.text.trim() && clip.hookTitle.seconds > 0) {
        await ff.writeFile('/title.png', await textOverlayPng(W, H, (ctx) => drawHookTitleText(ctx, clip.hookTitle!.text, style)));
        inputs.push('-i', '/title.png');
        const end = Math.min(total, clip.hookTitle.seconds).toFixed(2);
        g.push(`[${v}][${n}:v]overlay=0:0:enable='between(t,0,${end})'[vt]`);
        v = 'vt';
        n++;
    }
    if (freeze && clip.freeze?.text.trim()) {
        await ff.writeFile('/freeze.png', await textOverlayPng(W, H, (ctx) => drawFreezeText(ctx, clip.freeze!.text, style)));
        inputs.push('-i', '/freeze.png');
        g.push(`[${v}][${n}:v]overlay=0:0:enable='gte(t,${total.toFixed(2)})'[vfz]`);
        v = 'vfz';
        n++;
    }

    // 5) logo
    if (o.brand.logo) {
        await ff.writeFile('/logo.png', dataUrlBytes(o.brand.logo));
        inputs.push('-i', '/logo.png');
        const lw = Math.round(W * o.brand.logoSize);
        const m = Math.round(W * 0.04);
        const x = o.brand.logoCorner.endsWith('l') ? `${m}` : `W-w-${m}`;
        const y = o.brand.logoCorner.startsWith('t') ? `${m}` : `H-h-${m}`;
        g.push(`[${n}:v]scale=${lw}:-1[lg]`);
        g.push(`[${v}][lg]overlay=${x}:${y}[vl]`);
        v = 'vl';
        n++;
    }

    // 6) emoji (pop in, then gently float when animated)
    if (style.emojis && tpl.id !== 'none') {
        const groups = groupWords(displayWords(o.words, clip, style, o.speakers, true), style.wordsPerLine);
        const events = emojiEvents(clip, groups).slice(0, 10);
        const size = Math.round(captionSize(tpl, style, W));
        const es = Math.round(size * 1.6);
        const centerY = Math.round(captionY(style) * H - size * 0.6 - es * 0.6);
        for (let i = 0; i < events.length; i++) {
            const ev = events[i];
            const frames = style.emojiAnim
                ? [
                      { scale: 0.6, from: ev.start, to: ev.start + 0.06 },
                      { scale: 1.2, from: ev.start + 0.06, to: ev.start + 0.16 },
                      { scale: 1, from: ev.start + 0.16, to: ev.end, bob: true }
                  ]
                : [{ scale: 1, from: ev.start, to: ev.end }];
            for (let k = 0; k < frames.length; k++) {
                const f = frames[k];
                const px = even(es * f.scale);
                await ff.writeFile(`/emoji_${i}_${k}.png`, await emojiPng(ev.emoji, px));
                inputs.push('-i', `/emoji_${i}_${k}.png`);
                const y = f.bob ? `${centerY}-h/2+${(es * 0.06).toFixed(1)}*sin(3*PI*(t-${f.from.toFixed(2)}))` : `${centerY}-h/2`;
                g.push(`[${v}][${n}:v]overlay=x=(W-w)/2:y='${y}':enable='between(t,${f.from.toFixed(2)},${f.to.toFixed(2)})'[ve${i}_${k}]`);
                v = `ve${i}_${k}`;
                n++;
            }
        }
    }

    // 7) progress bar
    if (style.progressBar) {
        const bh = even(Math.max(4, H * 0.008));
        inputs.push('-f', 'lavfi', '-i', `color=c=${hex(style.highlight)}:s=${W}x${bh}:r=30`);
        const dur = (total + freeze).toFixed(3);
        g.push(`[${v}]drawbox=x=0:y=${H - bh}:w=${W}:h=${bh}:color=white@0.25:t=fill[vpb]`);
        g.push(`[vpb][${n}:v]overlay=x='-w+w*t/${dur}':y=${H - bh}:shortest=1[vp]`);
        v = 'vp';
        n++;
    }

    // 8) audio: bleeps and padding for the freeze
    if (audio) {
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
        if (freeze) {
            g.push(`[${a}]apad=pad_dur=${freeze.toFixed(2)}[apd]`);
            a = 'apd';
        }
    }

    const mapA = audio ? (a === '0:a' ? ['-map', '0:a'] : ['-map', `[${a}]`]) : [];
    progressHandler = o.onProgress;
    const out = '/out.mp4';
    const args = [
        ...inputs,
        '-filter_complex', g.join(';'),
        '-map', `[${v}]`, ...mapA,
        '-t', (total + freeze).toFixed(3),
        '-c:v', 'libx264', '-preset', o.quality === 1080 ? 'veryfast' : 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p',
        ...(audio ? ['-c:a', 'aac', '-b:a', '160k'] : []),
        '-movflags', '+faststart', '-y', out
    ];
    (globalThis as { __clipsmithLastRender?: string[] }).__clipsmithLastRender = args; // handy when debugging an export
    const code = await ff.exec(args);
    progressHandler = null;
    if (code !== 0) throw new Error('Rendering failed. Try 720p, or turn off some effects, then try again.');
    const data = await ff.readFile(out);
    await ff.deleteFile(out);
    o.onProgress(1);
    return new Blob([data as Uint8Array], { type: 'video/mp4' });
}
