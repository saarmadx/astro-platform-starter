// Free clip picking with no AI: builds clips around the biggest laughs and reactions.
// The line just before a burst of laughter is usually the punchline.
import { findMoments } from './moments';
import type { AudioEvent, Clip, ContentMode, Transcript } from './types';



export function pickByLaughs(t: Transcript, events: AudioEvent[], o: { minSeconds: number; maxSeconds: number; maxClips: number; mode?: ContentMode }, duration: number): Clip[] {
    return findMoments(t, events, o, duration);
}

/** Reads clips from an answer pasted back from a Claude chat. */
export function parseChatAnswer(text: string, duration: number): Clip[] {
    let raw = text.trim();
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) raw = fence[1];
    const a = raw.indexOf('[');
    const b = raw.lastIndexOf(']');
    if (a < 0 || b <= a) throw new Error('No list of clips found. Copy Claude’s whole answer, including the [ and ] brackets.');
    let data: unknown;
    try {
        data = JSON.parse(raw.slice(a, b + 1));
    } catch {
        throw new Error('The answer could not be read. Ask Claude to “reply with only the JSON array”, then copy it again.');
    }
    if (!Array.isArray(data)) throw new Error('Expected a list of clips.');
    const num = (v: unknown, d: number) => (typeof v === 'number' && isFinite(v) ? v : d);
    // times may come as numbers, "83.5", "1:23" or "1:02:03"
    const time = (v: unknown): number | null => {
        if (typeof v === 'number') return isFinite(v) ? v : null;
        if (typeof v !== 'string') return null;
        const t = v.trim().replace(/s$/i, '');
        if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
        const m = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
        return m ? (+(m[1] ?? 0)) * 3600 + +m[2] * 60 + +m[3] : null;
    };
    const clips = data
        .filter((c): c is Record<string, any> => !!c && typeof c === 'object' && time(c.start) !== null && time(c.end) !== null)
        .map((c): Record<string, any> => ({ ...c, start: time(c.start)!, end: time(c.end)! }))
        .map((c, i) => {
            const score = Math.round(Math.max(0, Math.min(100, num(c.score, 60))));
            const sub = c.subscores ?? {};
            return {
                id: `chat-${i}-${Math.round(c.start)}`,
                title: String(c.title ?? `Clip ${i + 1}`),
                start: Math.max(0, c.start),
                end: Math.min(duration || c.end, c.end),
                category: c.category ? String(c.category) : undefined,
                hook: String(c.hook ?? ''),
                score,
                subscores: { hook: num(sub.hook, score), flow: num(sub.flow, score), value: num(sub.value, score), shareability: num(sub.shareability, score) },
                reason: String(c.reason ?? ''),
                description: String(c.description ?? ''),
                hashtags: Array.isArray(c.hashtags) ? c.hashtags.map(String) : [],
                keywords: Array.isArray(c.keywords) ? c.keywords.map(String) : [],
                emojis: Array.isArray(c.emojis) ? c.emojis.filter((e: any) => e && e.word && e.emoji).map((e: any) => ({ word: String(e.word), emoji: String(e.emoji) })) : [],
                altTitles: Array.isArray(c.altTitles) ? c.altTitles.map(String) : []
            } as Clip;
        })
        .filter((c) => c.end - c.start >= 3);
    if (!clips.length) throw new Error('No usable clips were in that answer.');
    return clips.sort((x, y) => y.score - x.score);
}
