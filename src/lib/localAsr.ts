// Free transcription: decodes each audio chunk and runs Whisper in a web worker.
import type { Segment, Word } from './types';

export type AsrQuality = 'fast' | 'accurate';

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
    const size = quality === 'accurate' ? 'small' : 'base';
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
                const end = (c.timestamp[1] ?? c.timestamp[0] + 0.3) + offset;
                words.push({ text, start, end: Math.max(end, start + 0.05) });
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
        w.postMessage({ id, audio, model: modelFor(language, quality), language }, [audio.buffer]);
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
