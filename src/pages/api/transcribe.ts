import type { APIRoute } from 'astro';
import { checkAccess, json } from '../../lib/server';

export const prerender = false;

// Receives one small audio chunk (mp3) from the browser and returns word-level timestamps
// from OpenAI's speech-to-text API. The browser splits long videos into chunks so each
// request stays under the serverless body-size limit.
export const POST: APIRoute = async ({ request }) => {
    const denied = checkAccess(request);
    if (denied) return denied;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return json({ error: 'OPENAI_API_KEY is not set on the server.' }, 500);

    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return json({ error: 'Missing audio file.' }, 400);

    const upstream = new FormData();
    upstream.append('file', file, file.name || 'audio.mp3');
    upstream.append('model', 'whisper-1');
    upstream.append('response_format', 'verbose_json');
    upstream.append('timestamp_granularities[]', 'word');
    upstream.append('timestamp_granularities[]', 'segment');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: upstream
    });
    if (!res.ok) {
        const detail = await res.text();
        return json({ error: `Transcription failed (${res.status}): ${detail.slice(0, 300)}` }, 502);
    }

    const data = (await res.json()) as {
        language?: string;
        words?: { word: string; start: number; end: number }[];
        segments?: { start: number; end: number; text: string }[];
    };

    return json({
        language: data.language ?? 'unknown',
        words: (data.words ?? []).map((w) => ({ text: w.word.trim(), start: w.start, end: w.end })),
        segments: (data.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }))
    });
};
