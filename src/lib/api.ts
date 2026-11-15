import { ENERGY_STEP, findAudioEvents, loudness } from './audio';
import { decode16k, segmentsFromWords, transcribeChunk } from './localAsr';
import { extractAudioChunks } from './video';
import type { Clip, Project, Transcript } from './types';

function headers(accessCode: string): Record<string, string> {
    return accessCode ? { 'x-access-code': accessCode } : {};
}

async function readError(res: Response): Promise<string> {
    try {
        const data = await res.json();
        return data.error ?? `Request failed (${res.status})`;
    } catch {
        return `Request failed (${res.status})`;
    }
}

export async function transcribeVideo(
    file: File,
    duration: number,
    accessCode: string,
    onStatus: (label: string, ratio: number) => void,
    engine: { asr: 'local' | 'openai'; language: string; quality: 'fast' | 'accurate' } = { asr: 'local', language: 'english', quality: 'fast' }
): Promise<Transcript> {
    if (engine.asr === 'local') return transcribeLocally(file, duration, onStatus, engine.language, engine.quality);
    const chunks = await extractAudioChunks(file, duration, (r) => onStatus('Extracting audio', r));
    const result: Transcript = { language: 'unknown', words: [], segments: [], energy: { step: ENERGY_STEP, db: [] } };
    for (let i = 0; i < chunks.length; i++) {
        try {
            // pad or trim so each chunk lines up exactly with its time offset
            const db = await loudness(chunks[i].blob);
            const expected = Math.round((chunks[i].offset - result.energy!.db.length * ENERGY_STEP) / ENERGY_STEP);
            for (let k = 0; k < expected; k++) result.energy!.db.push(-90);
            result.energy!.db.push(...db);
        } catch {
            result.energy = undefined; // loudness is a bonus signal; carry on without it
        }
        onStatus(`Transcribing part ${i + 1} of ${chunks.length}`, i / chunks.length);
        const form = new FormData();
        form.append('file', new File([chunks[i].blob], `chunk_${i}.mp3`, { type: 'audio/mpeg' }));
        const res = await fetch('/api/transcribe', { method: 'POST', body: form, headers: headers(accessCode) });
        if (!res.ok) throw new Error(await readError(res));
        const part = (await res.json()) as Transcript;
        const off = chunks[i].offset;
        if (result.language === 'unknown') result.language = part.language;
        if (result.energy && result.energy.db.length === 0) result.energy = undefined;
        result.words.push(...part.words.map((w) => ({ ...w, start: w.start + off, end: w.end + off })));
        result.segments.push(...part.segments.map((s) => ({ ...s, start: s.start + off, end: s.end + off })));
    }
    onStatus('Transcribed', 1);
    return result;
}

/** Free: Whisper runs in this browser. Slower than OpenAI, but costs nothing. */
async function transcribeLocally(
    file: File,
    duration: number,
    onStatus: (label: string, ratio: number) => void,
    language: string,
    quality: 'fast' | 'accurate'
): Promise<Transcript> {
    const STEP = 120;
    const chunks = await extractAudioChunks(file, duration, (r) => onStatus('Extracting audio', r * 0.15), STEP);
    const result: Transcript = { language, words: [], segments: [], energy: { step: ENERGY_STEP, db: [] } };
    const started = Date.now();
    for (let i = 0; i < chunks.length; i++) {
        try {
            const db = await loudness(chunks[i].blob);
            const expected = Math.round((chunks[i].offset - result.energy!.db.length * ENERGY_STEP) / ENERGY_STEP);
            for (let k = 0; k < expected; k++) result.energy!.db.push(-90);
            result.energy!.db.push(...db);
        } catch {
            result.energy = undefined;
        }
        const ratio = 0.15 + (0.85 * i) / chunks.length;
        let label = `Making captions (free, on your PC): part ${i + 1} of ${chunks.length}`;
        if (i > 0) {
            const perChunk = (Date.now() - started) / i;
            const mins = Math.ceil((perChunk * (chunks.length - i)) / 60000);
            label += ` · about ${mins} min left`;
        }
        onStatus(label, ratio);
        const audio = await decode16k(chunks[i].blob);
        const words = await transcribeChunk(audio, chunks[i].offset, language, quality, (loaded, total) => {
            if (total > 0) onStatus(`Downloading the free speech model, first time only (${Math.round(loaded / 1048576)} of ${Math.round(total / 1048576)} MB)`, ratio);
        });
        result.words.push(...words);
    }
    result.segments = segmentsFromWords(result.words);
    onStatus('Captions ready', 1);
    return result;
}

export async function findClips(
    transcript: Transcript,
    options: Project['options'],
    accessCode: string
): Promise<Clip[]> {
    const res = await fetch('/api/highlights', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers(accessCode) },
        body: JSON.stringify({ segments: transcript.segments, events: findAudioEvents(transcript.energy, transcript.words), duration: transcript.segments.at(-1)?.end ?? 0, ...options })
    });
    if (!res.ok) throw new Error(await readError(res));
    const data = (await res.json()) as { clips: Omit<Clip, 'id'>[] };
    return data.clips.map((c, i) => ({
        ...c,
        subscores: c.subscores ?? { hook: c.score, flow: c.score, value: c.score, shareability: c.score },
        keywords: c.keywords ?? [],
        emojis: c.emojis ?? [],
        id: `clip-${i}-${Math.round(c.start)}`
    }));
}
