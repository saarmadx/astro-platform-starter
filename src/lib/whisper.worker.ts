// Runs the Whisper speech-recognition model inside the browser (free, on your own PC).
// The model downloads once from Hugging Face and is then cached by the browser.
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;

type Chunk = { text: string; timestamp: [number, number | null] };
type AsrFn = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string; chunks?: Chunk[] }>;

let asr: AsrFn | null = null;
let loadedModel = '';

const post = (msg: unknown) => (self as unknown as Worker).postMessage(msg);

async function load(model: string, precise: boolean) {
    if (asr && loadedModel === model) return;
    const progress_callback = (p: { status: string; file?: string; progress?: number; loaded?: number; total?: number }) => {
        if (p.status === 'progress') post({ type: 'download', file: p.file, loaded: p.loaded ?? 0, total: p.total ?? 0 });
    };
    let useGpu = false;
    let f16 = false;
    try {
        const nav = navigator as Navigator & { gpu?: { requestAdapter: () => Promise<{ features: Set<string> } | null> } };
        const adapter = nav.gpu ? await nav.gpu.requestAdapter() : null;
        useGpu = !!adapter;
        f16 = !!adapter?.features.has('shader-f16');
    } catch {
        useGpu = false;
    }
    const large = model.includes('large');
    // the large "best" model only runs well on a graphics card with half-precision support
    // (full precision is a 2.7 GB download that browsers can stall on)
    if (large && !(useGpu && f16)) throw new Error('needs-f16');
    try {
        // graphics card: full-precision encoder; full-precision decoder too in the accurate modes
        // (the very large "best" model keeps a compressed decoder so it fits in memory)
        type Dt = 'fp16' | 'fp32' | 'q4';
        const gpuDtype: Record<string, Dt> = large ? { encoder_model: 'fp16', decoder_model_merged: 'q4' } : { encoder_model: 'fp32', decoder_model_merged: precise ? 'fp32' : 'q4' };
        asr = (await pipeline('automatic-speech-recognition', model, useGpu
            ? { device: 'webgpu', dtype: gpuDtype, progress_callback }
            : { device: 'wasm', dtype: 'q8', progress_callback })) as unknown as AsrFn;
    } catch (err) {
        if (!useGpu || large) throw err;
        // graphics card route failed: fall back to the processor
        asr = (await pipeline('automatic-speech-recognition', model, { device: 'wasm', dtype: 'q8', progress_callback })) as unknown as AsrFn;
        useGpu = false;
    }
    loadedModel = model;
    post({ type: 'ready', gpu: useGpu });
}

const SR = 16000;

/**
 * Cuts the audio into pieces of at most 30 seconds (Whisper's window), each cut placed at the
 * quietest moment between 18 and 29.5 seconds so no word is split. Each piece is then timed on
 * its own: letting the library stitch 30-second windows together shifts word times by seconds.
 */
export function windows(audio: Float32Array, maxS = 29.5, minS = 18): [number, number][] {
    const frame = 320; // 20 ms
    const n = Math.floor(audio.length / frame);
    const energy = new Float32Array(n);
    for (let f = 0; f < n; f++) {
        let s = 0;
        for (let i = f * frame; i < (f + 1) * frame; i++) s += audio[i] * audio[i];
        energy[f] = s / frame;
    }
    // loudness over 300 ms around each frame, so a cut lands in a real pause, not between syllables
    const smooth = new Float32Array(n);
    for (let f = 0; f < n; f++) {
        let s = 0;
        let c = 0;
        for (let k = Math.max(0, f - 7); k <= Math.min(n - 1, f + 7); k++) {
            s += energy[k];
            c++;
        }
        smooth[f] = s / c;
    }
    const out: [number, number][] = [];
    let pos = 0;
    while (pos < audio.length) {
        if (audio.length - pos <= maxS * SR) {
            out.push([pos, audio.length]);
            break;
        }
        const a = Math.floor((pos + minS * SR) / frame);
        const b = Math.floor((pos + maxS * SR) / frame);
        let cut = b;
        for (let f = a; f <= b; f++) if (smooth[f] < smooth[cut]) cut = f;
        const at = cut * frame;
        out.push([pos, at]);
        pos = at;
    }
    return out;
}

/**
 * Whisper often starts a word that follows a pause too early, inside the silence. This moves such
 * starts to where the voice actually begins, and trims ends that run on into silence.
 * Loudness is compared with this piece's own background level, so it also works over game sound.
 */
export function snapToSpeech(words: Chunk[], piece: Float32Array): Chunk[] {
    const frame = 320; // 20 ms
    const n = Math.floor(piece.length / frame);
    if (n < 10) return words;
    const db = new Float32Array(n);
    for (let f = 0; f < n; f++) {
        let s = 0;
        for (let i = f * frame; i < (f + 1) * frame; i++) s += piece[i] * piece[i];
        db[f] = 10 * Math.log10(s / frame + 1e-12);
    }
    const sorted = Array.from(db).sort((x, y) => x - y);
    const floor = sorted[Math.floor(n * 0.15)];
    const loud = sorted[Math.floor(n * 0.9)];
    if (loud - floor < 8) return words; // can't tell voice from background here: leave the times alone
    const thr = floor + Math.max(6, (loud - floor) * 0.35);
    // voice = loud for at least 60 ms (ignores clicks)
    const active = new Uint8Array(n);
    for (let f = 0; f + 2 < n; f++) if (db[f] > thr && db[f + 1] > thr && db[f + 2] > thr) active[f] = active[f + 1] = active[f + 2] = 1;
    const at = (t: number) => Math.max(0, Math.min(n - 1, Math.round(t / 0.02)));
    const out = words.map((w) => ({ ...w, timestamp: [...w.timestamp] as [number, number | null] }));
    for (let i = 0; i < out.length; i++) {
        const w = out[i];
        const s0 = w.timestamp[0];
        const e0 = w.timestamp[1] ?? s0 + 0.3;
        const next = out[i + 1]?.timestamp[0];
        let f = at(s0);
        const moveTo = (frame: number) => {
            const ns = frame * 0.02;
            w.timestamp[0] = ns;
            w.timestamp[1] = Math.max(ns + 0.08, e0);
        };
        // no word lasts seconds. Whisper gives the first word of a piece a start of 0 (and stretches
        // others back over music or game noise) while its end is right: the word starts where the
        // voice last begins before that end.
        if (e0 - s0 > 1.5) {
            const fe = Math.min(n - 1, at(Math.min(e0, next ?? e0)));
            let last = -1;
            let run = 13; // the start of the stretch counts as a pause
            for (let k = f; k <= fe; k++) {
                if (!active[k]) run++;
                else {
                    if (run >= 13) last = k;
                    run = 0;
                }
            }
            if (last >= 0) {
                moveTo(last);
                continue;
            }
        }
        if (!(active[f] || active[Math.max(0, f - 2)] || active[Math.min(n - 1, f + 2)])) {
            // starts in silence: move to where the voice begins. The first word after a long gap can
            // be placed far too early, so it may move up to the next word; others at most 1.6 s.
            const reach = next === undefined ? s0 + 1.6 : next - s0 > 2 ? next : Math.min(s0 + 1.6, next + 0.4);
            const limit = Math.min(n - 1, at(reach));
            while (f < limit && !active[f]) f++;
            if (active[f]) moveTo(f);
            continue;
        }
        // starts a little late: the voice began up to 0.4 s earlier, right after a pause that comes
        // after the previous word, so that is where this word starts
        {
            // Whisper also stretches the previous word's end into the pause, so only its start counts
            const prevStart = i > 0 ? out[i - 1].timestamp[0] : -1;
            let onset = -1;
            let pauseStart = 0;
            for (let k = f; k >= Math.max(1, f - 20); k--) {
                if (active[k] && !active[k - 1]) {
                    let run = 0;
                    for (let j = k - 1; j >= 0 && !active[j] && run < 13; j--) run++;
                    if (run >= 13 && (k - run) * 0.02 >= prevStart + 0.1) {
                        onset = k;
                        pauseStart = k - run;
                    }
                    break;
                }
            }
            if (onset >= 0 && onset < f) {
                moveTo(onset);
                // the previous word ends where its voice stops, not inside the pause
                if (i > 0) {
                    let pe = pauseStart;
                    while (pe > 0 && !active[pe - 1]) pe--;
                    out[i - 1].timestamp[1] = Math.max(out[i - 1].timestamp[0] + 0.05, Math.min(out[i - 1].timestamp[1] ?? pe * 0.02, pe * 0.02 + 0.05));
                }
                continue;
            }
        }
        // starts in speech but stretches across a pause with voice after it: the speech before the
        // pause is the end of the previous word, so this word really starts after the pause
        const fe = Math.min(n - 1, at(Math.max(e0, next ?? e0)));
        let run = 0;
        for (let k = f; k <= fe; k++) {
            if (!active[k]) {
                run++;
                continue;
            }
            if (run >= 13) {
                // a pause of 260 ms or more ended at frame k. Move only if there is enough voice after
                // it (before the next word) to be this word; otherwise that voice is the next word's.
                let before = 0;
                for (let j = f; j < k - run; j++) before += active[j];
                let after = 0;
                for (let j = k; j <= fe; j++) after += active[j];
                if (after * 0.02 >= 0.15 && after >= before * 0.6) {
                    moveTo(k);
                    if (i > 0 && out[i - 1].timestamp[1] != null) out[i - 1].timestamp[1] = Math.max(out[i - 1].timestamp[1]!, s0, (k - run) * 0.02);
                }
                break;
            }
            run = 0;
        }
    }
    // words must stay in order and not overlap the next one
    for (let i = 1; i < out.length; i++) {
        if (out[i].timestamp[0] < out[i - 1].timestamp[0]) out[i].timestamp[0] = out[i - 1].timestamp[0];
        const prevEnd = out[i - 1].timestamp[1];
        if (prevEnd != null && prevEnd > out[i].timestamp[0]) out[i - 1].timestamp[1] = Math.max(out[i - 1].timestamp[0] + 0.05, out[i].timestamp[0]);
    }
    return out;
}

function rmsDb(a: Float32Array) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * a[i];
    return 10 * Math.log10(s / Math.max(1, a.length) + 1e-12);
}

self.onmessage = async (e: MessageEvent) => {
    const { id, audio, model, language, precise } = e.data as { id: number; audio: Float32Array; model: string; language: string; precise: boolean };
    try {
        await load(model, precise);
        const englishOnly = model.endsWith('.en');
        const opts = englishOnly ? {} : { language, task: 'transcribe' };
        let level: 'word' | 'segment' = 'word';
        const chunks: Chunk[] = [];
        const parts = windows(audio);
        for (let k = 0; k < parts.length; k++) {
            const [a, b] = parts[k];
            const piece = audio.subarray(a, b);
            const off = a / SR;
            const len = (b - a) / SR;
            post({ type: 'progress', id, done: k, total: parts.length });
            if (rmsDb(piece) < -60) continue; // silence: nothing to hear (and Whisper would invent words)
            let out: { chunks?: Chunk[] };
            if (level === 'word') {
                try {
                    out = await asr!(piece, { ...opts, return_timestamps: 'word' });
                } catch {
                    // some models can't time single words: phrase timings instead (words spread across each phrase)
                    level = 'segment';
                    out = await asr!(piece, { ...opts, return_timestamps: true });
                }
            } else out = await asr!(piece, { ...opts, return_timestamps: true });
            const timed = level === 'word' ? snapToSpeech(out.chunks ?? [], piece) : out.chunks ?? [];
            for (const c of timed) {
                // sound labels like [BLANK_AUDIO], [wind], (music) are not speech
                if (/^\s*[\[(*♪]|[\])*♪]\s*$/.test(c.text)) continue;
                const s = c.timestamp[0];
                if (s == null || !isFinite(s) || s > len + 0.5) continue; // nothing can start after the piece ends
                const end = c.timestamp[1] == null ? null : Math.min(c.timestamp[1], len);
                chunks.push({ text: c.text, timestamp: [s + off, end == null ? null : end + off] });
            }
        }
        post({ type: 'result', id, level, chunks });
    } catch (err) {
        post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
    }
};
