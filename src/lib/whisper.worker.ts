// Runs the Whisper speech-recognition model inside the browser (free, on your own PC).
// The model downloads once from Hugging Face and is then cached by the browser.
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;

type AsrFn = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string; chunks?: { text: string; timestamp: [number, number | null] }[] }>;

let asr: AsrFn | null = null;
let loadedModel = '';

const post = (msg: unknown) => (self as unknown as Worker).postMessage(msg);

async function load(model: string, precise: boolean) {
    if (asr && loadedModel === model) return;
    const progress_callback = (p: { status: string; file?: string; progress?: number; loaded?: number; total?: number }) => {
        if (p.status === 'progress') post({ type: 'download', file: p.file, loaded: p.loaded ?? 0, total: p.total ?? 0 });
    };
    let useGpu = false;
    try {
        const nav = navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } };
        useGpu = !!(nav.gpu && (await nav.gpu.requestAdapter()));
    } catch {
        useGpu = false;
    }
    try {
        // graphics card: full-precision encoder; full-precision decoder too in the accurate modes
        // (the very large "best" model keeps a compressed decoder so it fits in memory)
        const gpuDecoder = precise && !model.includes('large') ? 'fp32' : 'q4';
        asr = (await pipeline('automatic-speech-recognition', model, useGpu
            ? { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: gpuDecoder }, progress_callback }
            : { device: 'wasm', dtype: 'q8', progress_callback })) as unknown as AsrFn;
    } catch (err) {
        if (!useGpu) throw err;
        // graphics card route failed: fall back to the processor
        asr = (await pipeline('automatic-speech-recognition', model, { device: 'wasm', dtype: 'q8', progress_callback })) as unknown as AsrFn;
        useGpu = false;
    }
    loadedModel = model;
    post({ type: 'ready', gpu: useGpu });
}

self.onmessage = async (e: MessageEvent) => {
    const { id, audio, model, language, precise } = e.data as { id: number; audio: Float32Array; model: string; language: string; precise: boolean };
    try {
        await load(model, precise);
        const englishOnly = model.endsWith('.en');
        const opts = { chunk_length_s: 30, stride_length_s: 5, ...(englishOnly ? {} : { language, task: 'transcribe' }) };
        try {
            const out = await asr!(audio, { ...opts, return_timestamps: 'word' });
            post({ type: 'result', id, level: 'word', chunks: out.chunks ?? [] });
        } catch {
            // some models can't time single words: fall back to phrase timings (words are spread across each phrase)
            const out = await asr!(audio, { ...opts, return_timestamps: true });
            post({ type: 'result', id, level: 'segment', chunks: out.chunks ?? [] });
        }
    } catch (err) {
        post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
    }
};
