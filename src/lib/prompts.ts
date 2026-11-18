// Instructions for finding clips. Shared by the paid API route and the free
// "paste into Claude chat" option so both get the same quality of guidance.
import type { AudioEvent, ContentMode, Segment } from './types';

type Mode = ContentMode;

// ---------- what to look for, per content type ----------

export const MODE_GUIDE: Record<Mode, string> = {
    viral: `Find the moments most likely to hold a stranger's attention: funny moments first, then surprising facts, strong opinions, emotional stories and useful advice. Mix types if the video has them.`,
    funny: `Find the FUNNIEST moments. This channel lives on comedy, so be picky: only pick moments a stranger scrolling past would actually laugh at.

Strong comedy signals:
- A setup that pays off with a punchline, especially one the listener didn't see coming.
- Banter and quick comebacks; someone getting roasted or teased and firing back.
- Someone caught off guard: an unexpected answer, an embarrassing admission, a slip of the tongue.
- Absurd or wildly exaggerated stories, ridiculous hypotheticals, bad ideas defended with total confidence.
- Awkward moments: misunderstandings, a joke that bombs, an uncomfortable silence that becomes funny.
- Self-deprecating jokes and people losing it and failing to keep a straight face.
- Audio markers in the transcript: ((REACTION ...)) means a burst of sound with almost no words, usually laughter. A reaction right after a line is the strongest evidence that the line was funny. ((LOUD ...)) means excited or raised voices. ((CHAT SPIKE ...)) means the live stream chat exploded with laughter around that moment (already shifted for chat delay): very strong evidence.

Weak or bad picks, avoid them:
- Inside jokes or callbacks that need earlier parts of the video to make sense.
- People laughing while nothing funny is said in the clip itself (the cause was earlier, or it is just politeness).
- Long rambling stories where the payoff is weak or missing.
- Jokes that depend on what is on screen if the words alone do not carry it.

Timing is everything in comedy:
- Start at the setup, as late as possible while the joke still lands. Cut greetings, filler and slow lead-ins.
- End 1 to 2 seconds after the punchline or the laugh. Never cut off the laugh, never let it drag on after.
- Shorter is funnier: prefer 15 to 45 seconds unless the bit genuinely needs more (still respect the requested range).`,
    gaming: `This is gaming / streamer content (e.g. a GTA stream with a facecam). Find the moments viewers would clip and share: the streamer's most entertaining reactions to what happens in the game.

Strong signals:
- Rage and frustration: screaming, yelling at the game, losing it after a death, a fail or a betrayal.
- Hype and disbelief: "NO WAY", "WHAT?!", clutch plays, insane escapes, lucky or unlucky moments.
- Chaos: crashes, chases, explosions, everything going wrong at once, bad plans going badly.
- Funny commentary: roasting other players or NPCs, absurd decisions defended with confidence, running bits.
- Audio markers: ((LOUD ...)) raised voices are often the best moments in gaming (rage or hype); ((REACTION ...)) usually laughter; ((CHAT SPIKE ...)) the live chat exploded: very strong evidence.

The transcript only has what is said, so infer the in-game event from the words ("he hit me", "the cops", "I'm dead", "get in the car").

Avoid:
- Long quiet stretches of just playing, menus, loading, reading chat or donations without a payoff.
- Moments that only make sense with earlier context.

Timing: start just before the action or the setup line (a few seconds of build-up), end 1 to 3 seconds after the peak reaction. Prefer 15 to 45 seconds.`,
    insightful: `Find the most useful and surprising insights: clear advice, counter-intuitive facts, "I wish I knew this earlier" moments, and simple explanations of hard ideas. Each clip must teach one complete idea.`,
    story: `Find the best stories: personal anecdotes with stakes, tension and a payoff or twist, and emotional moments. Each clip must contain a full story arc or one complete emotional beat.`,
    'hot-takes': `Find the boldest opinions and debates: controversial takes, disagreements, predictions and strong reactions that make viewers want to comment. Each clip must state the take clearly and include the best argument for it.`
};

export const BASE_RULES = `General rules:
- Every clip must work for someone who has not seen the rest of the video.
- The first 3 seconds must hook: a bold line, a question, a laugh, a surprise. Never start mid-sentence or on filler ("so", "um", "yeah").
- End on a complete thought or a punchline, never mid-sentence.
- Start and end times must come from the transcript timestamps.
- Clips must not overlap.
- Write in the same language as the transcript.`;

/** Transcript lines with audio markers merged in by time. */
export function annotate(segments: Segment[], events: AudioEvent[], from = 0, to = Infinity): string {
    const lines: { t: number; text: string }[] = [];
    for (const s of segments) if (s.end > from && s.start < to) lines.push({ t: s.start, text: `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}` });
    for (const e of events) {
        if (e.end <= from || e.start >= to) continue;
        const len = (e.end - e.start).toFixed(1);
        const label =
            e.type === 'chat'
                ? `((CHAT SPIKE: stream chat exploded here, ${e.label ?? ''}))`
                : e.type === 'reaction'
                  ? `((REACTION: laughter or loud reaction, ${len}s))`
                  : e.type === 'hype'
                    ? `((HYPE: excited words: "${e.label ?? ''}"))`
                  : `((LOUD: raised voices, ${len}s))`;
        lines.push({ t: e.start + 0.001, text: `[${e.start.toFixed(1)}] ${label}` });
    }
    return lines.sort((a, b) => a.t - b.t).map((l) => l.text).join('\n');
}


export function systemPrompt(mode: Mode): string {
    return `You are a top short-form video editor who turns long videos (podcasts, streams, interviews, vlogs) into YouTube Shorts, TikToks and Reels that people watch to the end and share.

${MODE_GUIDE[mode]}

Markers in the transcript: ((REACTION)) laughter or a loud reaction with few words, ((LOUD)) raised voices, ((HYPE)) excited exclamations like "no way" or "bro what", ((CHAT SPIKE)) the live chat exploded. Several markers close together are the strongest evidence of a great moment; a marker alone is only a hint, so check that the words around it really work as a clip.

${BASE_RULES}`;
}

/** One self-contained prompt to paste into a Claude chat; the answer is pasted back into the app. */
export function chatPrompt(
    segments: Segment[],
    events: AudioEvent[],
    o: { mode: Mode; minSeconds: number; maxSeconds: number; maxClips: number; topic: string },
    part?: { index: number; count: number }
): string {
    const focus = o.topic.trim() ? `\nThe creator especially wants moments about: ${o.topic.trim()}` : '';
    const partNote = part && part.count > 1 ? `\n\nThis is part ${part.index + 1} of ${part.count} of a long video. Only pick moments inside this part; times are already the real times in the full video.` : '';
    return `${systemPrompt(o.mode)}${partNote}

<transcript>
${annotate(segments, events)}
</transcript>

Read the whole transcript, consider many candidate moments, then keep only the best ${o.maxClips} at most (fewer if the rest are weak). Each clip must be between ${o.minSeconds} and ${o.maxSeconds} seconds.${(o.mode === 'funny' || o.mode === 'gaming') ? ' Ask yourself for each one: would a stranger actually laugh?' : ''}${focus}

For each clip: fix the start and end from the transcript timestamps (start at the hook or setup, end right after the payoff${(o.mode === 'funny' || o.mode === 'gaming') ? ' or laugh' : ''}), score it 0-100 honestly with four part scores (hook, flow, value = how ${(o.mode === 'funny' || o.mode === 'gaming') ? 'funny' : 'valuable or entertaining'} it is, shareability), write a specific title, quote the hook line, give 3-6 keywords (single words actually spoken in the clip), 2-4 emoji each tied to one spoken word, and 3 alternative titles in different styles (a quote, a question, a "POV:" or reaction style).

Reply with ONLY a JSON array, best clip first, in exactly this shape:
[{"title":"...","start":12.3,"end":48.9,"category":"Funny","hook":"...","score":87,"subscores":{"hook":90,"flow":85,"value":88,"shareability":84},"reason":"...","description":"...","hashtags":["...","..."],"keywords":["...","..."],"emojis":[{"word":"...","emoji":"😂"}],"altTitles":["...","...","..."]}]
category is one of: Funny, Insight, Story, Hot take, Emotional, Surprising.`;
}

/** Splits a long transcript into parts that each fit comfortably in one chat message. */
export function splitForChat(segments: Segment[], events: AudioEvent[], maxChars = 60000): { segments: Segment[]; events: AudioEvent[] }[] {
    const parts: { segments: Segment[]; events: AudioEvent[] }[] = [];
    let cur: Segment[] = [];
    let size = 0;
    const flush = () => {
        if (!cur.length) return;
        const from = cur[0].start;
        const to = cur[cur.length - 1].end;
        parts.push({ segments: cur, events: events.filter((e) => e.start >= from && e.start <= to + 3) });
        cur = [];
        size = 0;
    };
    for (const s of segments) {
        const len = s.text.length + 20;
        if (size + len > maxChars && cur.length) {
            // a little overlap so a moment on the border isn't lost
            const tail = cur.filter((x) => x.start >= cur[cur.length - 1].end - 45);
            flush();
            cur = [...tail];
            size = tail.reduce((a, x) => a + x.text.length + 20, 0);
        }
        cur.push(s);
        size += len;
    }
    flush();
    return parts;
}
