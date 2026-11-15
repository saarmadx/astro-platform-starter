import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { buildAss } from './captions';
import type { Clip, ExportSettings, Word } from './types';

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
            await ff.writeFile('/fonts/Montserrat-ExtraBold.ttf', await fetchFile('/fonts/Montserrat-ExtraBold.ttf'));
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
    onProgress: (ratio: number) => void
): Promise<{ offset: number; blob: Blob }[]> {
    const ff = await getFFmpeg();
    const input = await mountInput(ff, file);
    const count = Math.max(1, Math.ceil(duration / CHUNK_SECONDS));
    const chunks: { offset: number; blob: Blob }[] = [];
    for (let i = 0; i < count; i++) {
        const offset = i * CHUNK_SECONDS;
        progressHandler = (r) => onProgress((i + r) / count);
        const out = `/chunk_${i}.mp3`;
        const code = await ff.exec(['-ss', String(offset), '-t', String(CHUNK_SECONDS), '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-y', out]);
        if (code !== 0) throw new Error('Could not read the audio track. Is this a valid video file?');
        const data = await ff.readFile(out);
        await ff.deleteFile(out);
        chunks.push({ offset, blob: new Blob([data as Uint8Array], { type: 'audio/mpeg' }) });
    }
    progressHandler = null;
    onProgress(1);
    return chunks;
}

/** Cut one clip, crop it to 9:16, burn in animated captions, return an MP4 blob. */
export async function renderClip(
    file: File,
    clip: Clip,
    words: Word[],
    settings: ExportSettings,
    onProgress: (ratio: number) => void
): Promise<Blob> {
    const ff = await getFFmpeg();
    const input = await mountInput(ff, file);
    const duration = clip.end - clip.start;

    const ass = buildAss(words, clip.start, clip.end, settings.captionStyle, settings.highlightColor, settings.wordsPerLine);
    await ff.writeFile('/subs.ass', new TextEncoder().encode(ass));

    const x = Math.min(1, Math.max(0, settings.cropX)).toFixed(3);
    const filters = [
        // crop the widest 9:16 window that fits, positioned by cropX
        `crop=w='min(iw\\,ih*9/16)':h='min(ih\\,iw*16/9)':x='(iw-ow)*${x}':y='(ih-oh)/2'`,
        'scale=720:1280:flags=bicubic',
        'setsar=1'
    ];
    if (settings.captionStyle !== 'none') filters.push('subtitles=/subs.ass:fontsdir=/fonts');

    progressHandler = onProgress;
    const out = '/out.mp4';
    const code = await ff.exec([
        '-ss', clip.start.toFixed(3), '-i', input, '-t', duration.toFixed(3),
        '-vf', filters.join(','),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', out
    ]);
    progressHandler = null;
    if (code !== 0) throw new Error('Rendering failed. Try a shorter clip or a different video.');
    const data = await ff.readFile(out);
    await ff.deleteFile(out);
    onProgress(1);
    return new Blob([data as Uint8Array], { type: 'video/mp4' });
}
