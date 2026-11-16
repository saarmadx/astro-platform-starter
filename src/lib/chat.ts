// Stream chat replays: moments where chat explodes with laughter are usually the funniest.
// Reads Twitch chat JSON (TwitchDownloader), YouTube live chat JSON (yt-dlp .live_chat.json)
// and plain text logs with timestamps like "[1:02:03] name: message" or "12:34 message".
import type { AudioEvent } from './types';

type Msg = { t: number; text: string };

const LAUGH = /(\b(lol|lmao|lmfao|rofl|kekw|lul|lulw|omegalul|icant|xd|dead|bruh|haha+|hehe+|jaja+|kek|pepelaugh)\b|😂|🤣|💀|😭)/i;

function parseClock(s: string): number | null {
    const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d+)?$/);
    if (!m) return null;
    return +(m[1] ?? 0) * 3600 + +m[2] * 60 + +m[3];
}

export function parseChat(text: string): Msg[] {
    const trimmed = text.trim();
    // Twitch (TwitchDownloader): { comments: [{ content_offset_seconds, message: { body } }] }
    if (trimmed.startsWith('{') && trimmed.includes('content_offset_seconds')) {
        try {
            const data = JSON.parse(trimmed);
            return (data.comments ?? []).map((c: any) => ({ t: +c.content_offset_seconds, text: String(c.message?.body ?? '') })).filter((m: Msg) => isFinite(m.t));
        } catch {
            /* fall through */
        }
    }
    // YouTube (yt-dlp live_chat.json): one JSON object per line
    if (trimmed.includes('videoOffsetTimeMsec')) {
        const out: Msg[] = [];
        for (const line of trimmed.split('\n')) {
            try {
                const o = JSON.parse(line);
                const r = o.replayChatItemAction;
                const t = +r.videoOffsetTimeMsec / 1000;
                const item = r.actions?.[0]?.addChatItemAction?.item;
                const runs = item?.liveChatTextMessageRenderer?.message?.runs ?? [];
                const txt = runs.map((x: any) => x.text ?? x.emoji?.shortcuts?.[0] ?? '').join('');
                if (isFinite(t)) out.push({ t, text: txt });
            } catch {
                /* skip bad line */
            }
        }
        return out;
    }
    // plain text: "[0:12:34] user: message" or "12:34 message"
    const out: Msg[] = [];
    for (const line of trimmed.split('\n')) {
        const m = line.match(/^\s*\[?((?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?)\]?\s+(.*)$/);
        if (!m) continue;
        const t = parseClock(m[1]);
        if (t !== null) out.push({ t, text: m[2] });
    }
    return out;
}

/**
 * Finds chat spikes: 5-second windows with far more messages or laughs than usual.
 * Chat reacts a few seconds late, so times are moved earlier by `delay`.
 */
export function chatSpikes(msgs: Msg[], delay = 5): { t: number; count: number; laughs: number }[] {
    if (msgs.length < 10) return [];
    const W = 5;
    const end = Math.max(...msgs.map((m) => m.t));
    const bins = Array.from({ length: Math.ceil(end / W) + 1 }, () => ({ count: 0, laughs: 0 }));
    for (const m of msgs) {
        const b = bins[Math.floor(m.t / W)];
        b.count++;
        if (LAUGH.test(m.text)) b.laughs++;
    }
    const scores = bins.map((b) => b.count + b.laughs * 2);
    const sorted = [...scores].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 1;
    const high = Math.max(median * 2.5, sorted[Math.floor(sorted.length * 0.9)] || 0, 4);
    const spikes: { t: number; count: number; laughs: number }[] = [];
    bins.forEach((b, i) => {
        if (scores[i] >= high && b.laughs >= Math.max(2, b.count * 0.2)) spikes.push({ t: Math.max(0, i * W - delay), count: b.count, laughs: b.laughs });
    });
    return spikes;
}

export function chatEvents(spikes: { t: number; count: number; laughs: number }[] | undefined): AudioEvent[] {
    return (spikes ?? []).map((s) => ({ start: s.t, end: s.t + 5, type: 'chat' as const, strength: s.laughs * 2 + s.count, label: `${s.count} messages, ${s.laughs} laughing` }));
}
