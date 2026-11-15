import type { APIRoute } from 'astro';
import Anthropic from '@anthropic-ai/sdk';
import { checkAccess, json } from '../../lib/server';
import { annotate, MODE_GUIDE, systemPrompt } from '../../lib/prompts';

export const prerender = false;

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
const MODEL = 'claude-opus-5-5';

type Segment = { start: number; end: number; text: string };
type AudioEvent = { start: number; end: number; type: 'reaction' | 'loud'; strength: number };
type Mode = 'viral' | 'funny' | 'insightful' | 'story' | 'hot-takes';

// ---------- schemas ----------

const CANDIDATES_SCHEMA = {
    type: 'object',
    properties: {
        candidates: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    start: { type: 'number' },
                    end: { type: 'number' },
                    note: { type: 'string', description: 'What happens and why it could work, one sentence.' }
                },
                required: ['start', 'end', 'note'],
                additionalProperties: false
            }
        }
    },
    required: ['candidates'],
    additionalProperties: false
} as const;

const CLIPS_SCHEMA = {
    type: 'object',
    properties: {
        clips: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Specific, catchy title under 70 characters.' },
                    start: { type: 'number' },
                    end: { type: 'number' },
                    category: { type: 'string', enum: ['Funny', 'Insight', 'Story', 'Hot take', 'Emotional', 'Surprising'] },
                    hook: { type: 'string', description: 'The opening line that grabs attention.' },
                    score: { type: 'integer', description: 'Overall predicted performance 0-100.' },
                    subscores: {
                        type: 'object',
                        properties: { hook: { type: 'integer' }, flow: { type: 'integer' }, value: { type: 'integer' }, shareability: { type: 'integer' } },
                        required: ['hook', 'flow', 'value', 'shareability'],
                        additionalProperties: false
                    },
                    reason: { type: 'string', description: 'One sentence on why this works.' },
                    description: { type: 'string', description: 'Short upload description.' },
                    hashtags: { type: 'array', items: { type: 'string' } },
                    keywords: { type: 'array', items: { type: 'string' }, description: '3-6 single spoken words to highlight in captions.' },
                    emojis: {
                        type: 'array',
                        items: { type: 'object', properties: { word: { type: 'string' }, emoji: { type: 'string' } }, required: ['word', 'emoji'], additionalProperties: false }
                    },
                    altTitles: { type: 'array', items: { type: 'string' }, description: '3 alternative titles in different styles.' }
                },
                required: ['title', 'start', 'end', 'category', 'hook', 'score', 'subscores', 'reason', 'description', 'hashtags', 'keywords', 'emojis', 'altTitles'],
                additionalProperties: false
            }
        }
    },
    required: ['clips'],
    additionalProperties: false
} as const;

type Clip = {
    title: string;
    start: number;
    end: number;
    category: string;
    hook: string;
    score: number;
    subscores: { hook: number; flow: number; value: number; shareability: number };
    reason: string;
    description: string;
    hashtags: string[];
    keywords: string[];
    emojis: { word: string; emoji: string }[];
    altTitles: string[];
};

// ---------- helpers ----------

async function ask<T>(system: string, user: string, schema: { [key: string]: unknown }, effort: 'medium' | 'high'): Promise<T> {
    const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 32000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort, format: { type: 'json_schema', schema } },
        system,
        messages: [{ role: 'user', content: user }]
    });
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') throw new Error('refusal');
    const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    return JSON.parse(text) as T;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Number(n) || min));

function overlap(a: { start: number; end: number }, b: { start: number; end: number }) {
    const o = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
    return o / Math.min(a.end - a.start, b.end - b.start);
}

// ---------- route ----------

export const POST: APIRoute = async ({ request }) => {
    const denied = checkAccess(request);
    if (denied) return denied;
    if (!process.env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY is not set on the server.' }, 500);

    const body = (await request.json()) as {
        segments?: Segment[];
        events?: AudioEvent[];
        duration?: number;
        minSeconds?: number;
        maxSeconds?: number;
        maxClips?: number;
        topic?: string;
        mode?: Mode;
    };
    const segments = body.segments ?? [];
    if (segments.length === 0) return json({ error: 'Transcript is empty.' }, 400);
    const events = (body.events ?? []).filter((e) => e && e.end > e.start).slice(0, 300);
    const mode: Mode = body.mode && body.mode in MODE_GUIDE ? body.mode : 'viral';
    const minSeconds = clamp(body.minSeconds ?? 15, 5, 170);
    const maxSeconds = clamp(body.maxSeconds ?? 60, minSeconds + 5, 180);
    const maxClips = clamp(body.maxClips ?? 8, 1, 20);
    const videoEnd = Math.max(body.duration ?? 0, segments[segments.length - 1].end);
    const focus = body.topic?.trim() ? `\nThe creator especially wants moments about: ${body.topic.trim().slice(0, 200)}` : '';

    const system = systemPrompt(mode);

    try {
        // Pass 1: scout the whole transcript for many candidates
        const scoutCount = Math.min(40, maxClips * 3);
        const scout = await ask<{ candidates: { start: number; end: number; note: string }[] }>(
            system,
            `<transcript>\n${annotate(segments, events)}\n</transcript>\n\nScan the whole transcript and list up to ${scoutCount} candidate moments, each roughly ${minSeconds}-${maxSeconds} seconds long. Cast a wide net: a second editor will review them closely.${focus}`,
            CANDIDATES_SCHEMA,
            'medium'
        );
        const candidates = scout.candidates
            .map((c) => ({ ...c, start: clamp(c.start, 0, videoEnd), end: clamp(c.end, 0, videoEnd) }))
            .filter((c) => c.end - c.start >= 3);
        if (candidates.length === 0) return json({ clips: [] });

        // Pass 2: review each candidate with context, tighten timing, keep only the best
        const reviewed = candidates
            .map((c, i) => `<candidate id="${i + 1}" start="${c.start.toFixed(1)}" end="${c.end.toFixed(1)}">\nScout's note: ${c.note}\n${annotate(segments, events, c.start - 20, c.end + 15)}\n</candidate>`)
            .join('\n\n');
        const final = await ask<{ clips: Clip[] }>(
            system,
            `${reviewed}\n\nYou are the final editor. Each candidate above includes the transcript around it. For each one, judge honestly whether it truly works as a standalone clip for a stranger${mode === 'funny' ? ' (would they actually laugh?)' : ''}. Then choose the best ${maxClips} at most, and drop anything weak even if that leaves fewer clips.

For every clip you keep:
- Fix the start and end using the transcript timestamps: start right at the hook or setup, end right after the payoff${mode === 'funny' ? ' or laugh, keeping any reaction that follows the punchline' : ''}.
- Keep it between ${minSeconds} and ${maxSeconds} seconds.
- Score it 0-100 honestly with the four part scores (hook, flow, value = how ${mode === 'funny' ? 'funny' : 'valuable or entertaining'} it is, shareability).
- Write a title that is specific to the moment, a hook line quoted from the clip, 3-6 keywords that are single words actually spoken in the clip, 2-4 emoji each tied to one spoken word, and 3 alternative titles in different styles (a quote, a question, a "POV:" or reaction style).${focus}`,
            CLIPS_SCHEMA,
            'high'
        );

        // Make sure a laugh right after the end is not cut off, then tidy up
        const reactions = events.filter((e) => e.type === 'reaction');
        let clips = final.clips
            .map((c) => {
                let start = clamp(c.start, 0, videoEnd);
                let end = clamp(c.end, 0, videoEnd);
                const laugh = reactions.find((e) => e.start >= end - 0.75 && e.start <= end + 1.5);
                if (laugh) end = Math.min(videoEnd, Math.max(end, Math.min(laugh.end + 0.4, end + 4)));
                if (end - start > 180) end = start + 180;
                return { ...c, start, end, score: clamp(c.score, 0, 100) };
            })
            .filter((c) => c.end - c.start >= 3)
            .sort((a, b) => b.score - a.score);

        // drop near-duplicates, keeping the higher score
        const kept: typeof clips = [];
        for (const c of clips) if (!kept.some((k) => overlap(k, c) > 0.5)) kept.push(c);
        clips = kept.slice(0, maxClips);

        return json({ clips });
    } catch (err) {
        if (err instanceof Error && err.message === 'refusal') return json({ error: 'The AI declined to process this transcript.' }, 422);
        if (err instanceof Anthropic.RateLimitError) return json({ error: 'AI is busy, try again in a minute.' }, 429);
        if (err instanceof Anthropic.APIError) return json({ error: `AI request failed (${err.status}): ${err.message}` }, 502);
        if (err instanceof SyntaxError) return json({ error: 'AI returned an unreadable answer, please retry.' }, 502);
        throw err;
    }
};
