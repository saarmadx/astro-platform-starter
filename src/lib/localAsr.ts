// Free transcription: decodes each audio chunk and runs Whisper in a web worker.
import type { Segment, Word } from './types';

import type { AsrQuality } from './types';
export type { AsrQuality };

/** true when the graphics card is used (much faster), false for the processor, null before loading */
export let usingGpu: boolean | null = null;

export const LANGUAGES: { id: string; label: string }[] = [
    { id: 'english', label: 'English' },
    { id: 'spanish', label: 'Spanish' },
    { id: 'portuguese', label: 'Portuguese' },
    { id: 'french', label: 'French' },
    { id: 'german', label: 'German' },
    { id: 'italian', label: 'Italian' },
    { id: 'dutch', label: 'Dutch' },
    { id: 'turkish', label: 'Turkish' },
    { id: 'russian', label: 'Russian' },
    { id: 'arabic', label: 'Arabic' },
    { id: 'persian', label: 'Persian' },
    { id: 'hindi', label: 'Hindi' },
    { id: 'urdu', label: 'Urdu' },
    { id: 'indonesian', label: 'Indonesian' },
    { id: 'japanese', label: 'Japanese' },
    { id: 'korean', label: 'Korean' },
    { id: 'chinese', label: 'Chinese' }
];

export function modelFor(language: string, quality: AsrQuality): string {
    // "best": Whisper large-v3-turbo, the most accurate model that runs in a browser (needs a graphics card)
    if (quality === 'best') return 'onnx-community/whisper-large-v3-turbo';
    const size = quality === 'accurate' ? 'small' : quality === 'fastest' ? 'tiny' : 'base';
    return language === 'english' ? `Xenova/whisper-${size}.en` : `Xenova/whisper-${size}`;
}

let worker: Worker | null = null;
let nextId = 1;

function getWorker(): Worker {
    if (!worker) worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });
    return worker;
}

/** 16 kHz mono samples for Whisper. */
export async function decode16k(blob: Blob): Promise<Float32Array> {
    const Ctx = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
    const ctx = new Ctx(1, 16000, 16000);
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    return buf.getChannelData(0);
}

/** Transcribe one chunk; times are offset to the chunk's place in the video. */
export function transcribeChunk(
    audio: Float32Array,
    offset: number,
    language: string,
    quality: AsrQuality,
    onDownload: (loaded: number, total: number) => void
): Promise<Word[]> {
    const w = getWorker();
    const id = nextId++;
    const downloads: Record<string, { loaded: number; total: number }> = {};
    return new Promise((resolve, reject) => {
        const onMsg = (e: MessageEvent) => {
            const m = e.data;
            if (m.type === 'ready') {
                usingGpu = !!m.gpu;
                return;
            }
            if (m.type === 'download') {
                downloads[m.file] = { loaded: m.loaded, total: m.total };
                const all = Object.values(downloads);
                onDownload(all.reduce((a, d) => a + d.loaded, 0), all.reduce((a, d) => a + d.total, 0));
                return;
            }
            if (m.id !== id) return;
            w.removeEventListener('message', onMsg);
            w.removeEventListener('error', onErr);
            if (m.type === 'error') {
                reject(new Error(`Free captioning failed: ${m.message}. Make sure you are online the first time (the speech model needs to download), and use Chrome or Edge.`));
                return;
            }
            const words: Word[] = [];
            for (const c of m.chunks as { text: string; timestamp: [number, number | null] }[]) {
                const text = c.text.trim();
                if (!text) continue;
                const start = c.timestamp[0] + offset;
                const end = Math.max((c.timestamp[1] ?? c.timestamp[0] + 0.3) + offset, start + 0.05);
                if (m.level === 'segment') {
                    // phrase timings only: spread the words across the phrase by length
                    const parts = text.split(/\s+/);
                    const totalLen = parts.reduce((a, w) => a + w.length + 1, 0);
                    let t = start;
                    for (const w of parts) {
                        const d = ((end - start) * (w.length + 1)) / totalLen;
                        words.push({ text: w, start: t, end: t + d });
                        t += d;
                    }
                } else words.push({ text, start, end });
            }
            resolve(words);
        };
        const onErr = () => {
            w.removeEventListener('message', onMsg);
            w.removeEventListener('error', onErr);
            worker = null;
            reject(new Error('The free speech engine could not start. Use Chrome or Edge, then refresh the page.'));
        };
        w.addEventListener('message', onMsg);
        w.addEventListener('error', onErr);
        w.postMessage({ id, audio, model: modelFor(language, quality), language, precise: quality === 'accurate' || quality === 'best' }, [audio.buffer]);
    });
}

/** Builds sentence-like segments from words (breaks at punctuation, pauses, or length). */
export function segmentsFromWords(words: Word[]): Segment[] {
    const segs: Segment[] = [];
    let cur: Word[] = [];
    const flush = () => {
        if (cur.length) segs.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(' ') });
        cur = [];
    };
    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (cur.length && w.start - cur[cur.length - 1].end > 0.8) flush();
        cur.push(w);
        if (/[.!?]$/.test(w.text) || cur.length >= 28) flush();
    }
    flush();
    return segs;
}

const normWord = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/**
 * Cleans up common speech-model glitches: the model sometimes gets stuck repeating a word
 * or phrase ("okay okay okay…", "give it to me give it to me…") with near-zero timings, and
 * occasionally returns times that run backwards. Real speech rarely repeats a phrase more
 * than a few times in a row, so long repeat runs are cut down to 2.
 */
export function cleanWords(input: Word[]): Word[] {
    // drop broken timings and sort
    let words = input
        .filter((w) => w.text.trim() && isFinite(w.start) && isFinite(w.end))
        .map((w) => ({ ...w, end: Math.max(w.end, w.start + 0.05) }))
        .sort((a, b) => a.start - b.start);

    // collapse repeated phrases of 1 to 8 words occurring 3+ times in a row
    for (let n = 1; n <= 8; n++) {
        const out: Word[] = [];
        let i = 0;
        while (i < words.length) {
            const phrase = words.slice(i, i + n).map((w) => normWord(w.text)).join(' ');
            let reps = 1;
            if (phrase && i + n <= words.length) {
                while (i + (reps + 1) * n <= words.length && words.slice(i + reps * n, i + (reps + 1) * n).map((w) => normWord(w.text)).join(' ') === phrase) reps++;
            }
            if (reps >= 3) {
                out.push(...words.slice(i, i + 2 * n)); // keep two copies, like natural speech
                i += reps * n;
            } else {
                out.push(words[i]);
                i++;
            }
        }
        words = out;
    }

    // a word can't start before the previous one has started
    for (let i = 1; i < words.length; i++) {
        if (words[i].start < words[i - 1].start) words[i] = { ...words[i], start: words[i - 1].start };
        if (words[i - 1].end > words[i].start + 0.5) words[i - 1] = { ...words[i - 1], end: Math.max(words[i - 1].start + 0.05, words[i].start) };
    }
    return words;
}
