// Free clip picking with no AI: builds clips around the biggest laughs and reactions.
// The line just before a burst of laughter is usually the punchline.
import type { AudioEvent, Clip, Segment, Transcript } from './types';

const STOP = new Set(
    'about above after again against because been before being below between both could does doing down during each from further have having here hers herself himself into itself just more most other ourselves over same should some such than that their theirs them themselves then there these they this those through under until very what when where which while whom will with would your yours yourself yourselves really gonna wanna kinda like yeah okay right thing things know mean think'.split(' ')
);

const sentenceStart = (segs: Segment[], i: number) => i === 0 || /[.!?]$/.test(segs[i - 1].text.trim()) || segs[i].start - segs[i - 1].end > 0.6;

export function pickByLaughs(
    t: Transcript,
    events: AudioEvent[],
    o: { minSeconds: number; maxSeconds: number; maxClips: number },
    duration: number
): Clip[] {
    const segs = t.segments;
    if (!segs.length) return [];
    const reactions = events.filter((e) => e.type === 'reaction').sort((a, b) => b.strength - a.strength);
    const louds = events.filter((e) => e.type === 'loud').sort((a, b) => b.strength - a.strength);
    const maxStrength = Math.max(...events.map((e) => e.strength), -60);
    const minStrength = Math.min(...events.map((e) => e.strength), -60);
    const chosen: Clip[] = [];

    const build = (e: AudioEvent, kind: 'reaction' | 'loud'): Clip | null => {
        const end = Math.min(duration, e.end + 0.5);
        // latest sentence start that still gives at least the minimum length
        let startIdx = -1;
        for (let i = segs.length - 1; i >= 0; i--) {
            if (segs[i].start > e.start - 2) continue;
            const len = end - segs[i].start;
            if (len > o.maxSeconds) break;
            if (len >= o.minSeconds && sentenceStart(segs, i)) {
                startIdx = i;
                break;
            }
        }
        let start: number;
        if (startIdx >= 0) start = segs[startIdx].start;
        else {
            start = Math.max(0, end - Math.max(o.minSeconds, Math.min(o.maxSeconds, 25)));
            const s = segs.find((x) => x.start >= start - 0.01);
            if (s && end - s.start >= 5) start = s.start;
        }
        if (end - start < 5) return null;
        const inside = segs.filter((s) => s.end > start && s.start < end);
        const before = segs.filter((s) => s.end <= e.start + 0.5);
        const punch = (before[before.length - 1]?.text ?? inside[inside.length - 1]?.text ?? '').trim();
        const hook = (inside[0]?.text ?? '').trim();
        const words = t.words.filter((w) => w.start >= start && w.end <= end);
        const lastWord = [...words].reverse().find((w) => w.end <= e.start + 0.3);
        const keywords = [...new Set(words.map((w) => w.text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')).filter((w) => w.length >= 5 && !STOP.has(w)))]
            .sort((a, b) => b.length - a.length)
            .slice(0, 4);
        const strength = maxStrength > minStrength ? (e.strength - minStrength) / (maxStrength - minStrength) : 0.5;
        const laughLen = Math.min(4, e.end - e.start);
        const base = kind === 'reaction' ? 62 : 50;
        const score = Math.round(Math.min(96, base + strength * 22 + laughLen * 3));
        const shortTitle = punch.length > 62 ? `${punch.slice(0, 60).trim()}…` : punch;
        return {
            id: `free-${Math.round(start * 10)}`,
            title: shortTitle ? `“${shortTitle.replace(/[.,]$/, '')}”` : 'Funny moment',
            start,
            end,
            category: kind === 'reaction' ? 'Funny' : 'Surprising',
            hook: hook.length > 90 ? `${hook.slice(0, 88)}…` : hook,
            score,
            subscores: { hook: Math.max(40, score - 8), flow: Math.max(40, score - 4), value: score, shareability: Math.max(40, score - 6) },
            reason: kind === 'reaction' ? `A ${laughLen.toFixed(1)}s burst of laughter or reaction comes right after this line.` : 'Voices get loud and excited here.',
            description: shortTitle,
            hashtags: kind === 'reaction' ? ['funny', 'shorts', 'comedy'] : ['shorts'],
            keywords,
            emojis: lastWord ? [{ word: lastWord.text, emoji: kind === 'reaction' ? '😂' : '😮' }] : []
        };
    };

    for (const [list, kind] of [[reactions, 'reaction'], [louds, 'loud']] as const) {
        for (const e of list) {
            if (chosen.length >= o.maxClips) break;
            const c = build(e, kind);
            if (!c) continue;
            if (chosen.some((x) => Math.min(x.end, c.end) - Math.max(x.start, c.start) > 0.3 * Math.min(x.end - x.start, c.end - c.start))) continue;
            chosen.push(c);
        }
    }
    return chosen.sort((a, b) => b.score - a.score);
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
    const clips = data
        .filter((c): c is Record<string, any> => !!c && typeof c === 'object' && typeof c.start === 'number' && typeof c.end === 'number')
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
                emojis: Array.isArray(c.emojis) ? c.emojis.filter((e: any) => e && e.word && e.emoji).map((e: any) => ({ word: String(e.word), emoji: String(e.emoji) })) : []
            } as Clip;
        })
        .filter((c) => c.end - c.start >= 3);
    if (!clips.length) throw new Error('No usable clips were in that answer.');
    return clips.sort((x, y) => y.score - x.score);
}
