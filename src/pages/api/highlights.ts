import type { APIRoute } from 'astro';
import Anthropic from '@anthropic-ai/sdk';
import { checkAccess, json } from '../../lib/server';

export const prerender = false;

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

const SYSTEM_PROMPT = `You are a short-form video editor who finds the best moments in long videos (podcasts, interviews, talks, streams) and turns them into YouTube Shorts, TikToks and Reels.

You get a timestamped transcript. Pick the moments most likely to hold a viewer's attention as standalone clips.

What makes a good clip:
- It opens with a hook in the first 3 seconds: a bold claim, a surprising fact, a question, a strong emotion, or a conflict. Never start mid-sentence or on filler ("so", "um", "yeah").
- It makes sense to someone who has not seen the rest of the video.
- It has a payoff: an answer, a punchline, a lesson, or a twist, and it ends on a complete thought.
- It is dense: no long pauses, tangents, or setup that goes nowhere.

Rules:
- Start and end times must come from the transcript's timestamps and fall on sentence boundaries.
- Respect the requested minimum and maximum clip length.
- Clips must not overlap.
- Score each clip 0-100 for how likely it is to perform well, and be honest: a weak video should get low scores. Also score four parts 0-100: hook (how strongly the first seconds grab attention), flow (does it play smoothly and end on a complete thought), value (how useful, funny or emotional it is), shareability (how likely people are to send it to someone).
- Pick 3 to 6 keywords per clip: single words actually spoken in the clip that carry the meaning, to highlight in the captions.
- Pick 2 to 4 emoji per clip, each tied to one single word actually spoken in the clip.
- Write titles in the same language as the transcript. Make each title specific to that clip, not a generic template, and under 70 characters.`;

const CLIP_SCHEMA = {
    type: 'object',
    properties: {
        clips: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Catchy, specific title for the Short.' },
                    start: { type: 'number', description: 'Clip start time in seconds.' },
                    end: { type: 'number', description: 'Clip end time in seconds.' },
                    hook: { type: 'string', description: 'The opening line that grabs attention.' },
                    score: { type: 'integer', description: 'Predicted performance, 0-100.' },
                    subscores: {
                        type: 'object',
                        properties: {
                            hook: { type: 'integer' },
                            flow: { type: 'integer' },
                            value: { type: 'integer' },
                            shareability: { type: 'integer' }
                        },
                        required: ['hook', 'flow', 'value', 'shareability'],
                        additionalProperties: false
                    },
                    keywords: { type: 'array', items: { type: 'string' }, description: 'Single spoken words to highlight.' },
                    emojis: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: { word: { type: 'string' }, emoji: { type: 'string' } },
                            required: ['word', 'emoji'],
                            additionalProperties: false
                        }
                    },
                    reason: { type: 'string', description: 'One sentence on why this moment works.' },
                    description: { type: 'string', description: 'A short video description for the upload.' },
                    hashtags: { type: 'array', items: { type: 'string' } }
                },
                required: ['title', 'start', 'end', 'hook', 'score', 'subscores', 'keywords', 'emojis', 'reason', 'description', 'hashtags'],
                additionalProperties: false
            }
        }
    },
    required: ['clips'],
    additionalProperties: false
} as const;

type Segment = { start: number; end: number; text: string };
type Clip = {
    title: string;
    start: number;
    end: number;
    hook: string;
    score: number;
    subscores: { hook: number; flow: number; value: number; shareability: number };
    keywords: string[];
    emojis: { word: string; emoji: string }[];
    reason: string;
    description: string;
    hashtags: string[];
};

export const POST: APIRoute = async ({ request }) => {
    const denied = checkAccess(request);
    if (denied) return denied;
    if (!process.env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY is not set on the server.' }, 500);

    const body = (await request.json()) as {
        segments?: Segment[];
        minSeconds?: number;
        maxSeconds?: number;
        maxClips?: number;
        topic?: string;
    };
    const segments = body.segments ?? [];
    if (segments.length === 0) return json({ error: 'Transcript is empty.' }, 400);

    const minSeconds = clamp(body.minSeconds ?? 20, 5, 170);
    const maxSeconds = clamp(body.maxSeconds ?? 60, minSeconds + 5, 180);
    const maxClips = clamp(body.maxClips ?? 8, 1, 20);

    const transcript = segments.map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join('\n');
    const focus = body.topic?.trim() ? `\nFocus on moments about: ${body.topic.trim().slice(0, 200)}` : '';

    try {
        const stream = client.beta.messages.stream({
            model: 'claude-opus-5-5',
            max_tokens: 16000,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            output_config: {
                effort: 'medium',
                format: { type: 'json_schema', schema: CLIP_SCHEMA }
            },
            system: SYSTEM_PROMPT,
            messages: [
                {
                    role: 'user',
                    content: `<transcript>\n${transcript}\n</transcript>\n\nFind up to ${maxClips} clips, each between ${minSeconds} and ${maxSeconds} seconds long. Order them from best to worst.${focus}`
                }
            ]
        });
        const message = await stream.finalMessage();

        if (message.stop_reason === 'refusal') {
            return json({ error: 'The AI declined to process this transcript.' }, 422);
        }
        const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
        const parsed = JSON.parse(text) as { clips: Clip[] };

        const videoEnd = segments[segments.length - 1].end;
        const clips = parsed.clips
            .map((c) => ({ ...c, start: Math.max(0, c.start), end: Math.min(videoEnd, c.end) }))
            .filter((c) => c.end - c.start >= 3)
            .sort((a, b) => b.score - a.score);

        return json({ clips });
    } catch (err) {
        if (err instanceof Anthropic.RateLimitError) return json({ error: 'AI is busy, try again in a minute.' }, 429);
        if (err instanceof Anthropic.APIError) return json({ error: `AI request failed (${err.status}): ${err.message}` }, 502);
        if (err instanceof SyntaxError) return json({ error: 'AI returned an unreadable answer, please retry.' }, 502);
        throw err;
    }
};

function clamp(n: number, min: number, max: number) {
    return Math.min(max, Math.max(min, Number(n) || min));
}
