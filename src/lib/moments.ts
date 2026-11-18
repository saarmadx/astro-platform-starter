// Free moment finding (no AI). Every second of the video gets an "interest" score from several
// signals at once, and clips are built around the strongest peaks with their setup and payoff:
//   - laughter / reactions heard in the audio (loud, few words, right after someone talks)
//   - live chat spikes (if a chat replay was added)
//   - excited voices: the speaker suddenly much louder than their normal level
//   - what is said: "NO WAY", "bro what", "go go go", laughs written out, swearing, "!"
//   - fast talking compared with the speaker's normal pace
// Long stretches of silence, menus or game sound without anyone talking score nothing.
import type { AudioEvent, Clip, ContentMode, Segment, Transcript, Word } from './types';

type Opts = { minSeconds: number; maxSeconds: number; maxClips: number; mode?: ContentMode };

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
const LAUGH = /^(ha){2,}h?$|^(he){2,}$|^lol$|^lmao$|^lmfao$|^rofl$|^laugh/;
const STRONG = new Set(['wtf', 'omg', 'insane', 'crazy', 'bruh', 'yooo', 'sheesh', 'ayo', 'lmao', 'lmfao', 'jesus', 'holy', 'unbelievable', 'impossible', 'clutch']);
const MEDIUM = new Set(['no', 'nah', 'what', 'bro', 'dude', 'yo', 'wait', 'why', 'stop', 'run', 'help', 'dead', 'died', 'dying', 'god', 'damn', 'hell', 'oh', 'wow', 'whoa', 'go', 'please', 'how', 'yes', 'yeah']);
const SWEAR = /^(fuck|fucking|fucked|shit|bitch|ass|crap|damn|hell)/;
const GAMING = new Set(['cops', 'police', 'crash', 'crashed', 'killed', 'kill', 'shot', 'shoot', 'explode', 'exploded', 'chase', 'wanted', 'heist', 'boss', 'clutch', 'win', 'won', 'lost', 'lose', 'respawn', 'glitch', 'bug', 'lag']);
const PHRASES: [RegExp, number][] = [
    [/\bno way\b/, 3],
    [/\bwhat the\b/, 2.5],
    [/\boh my god\b/, 3],
    [/\blet'?s go+\b/, 2.5],
    [/\bare you (kidding|serious)\b/, 2.5],
    [/\bi can'?t believe\b/, 2],
    [/\bbro what\b/, 2.5],
    [/\bshut up\b/, 1.5],
    [/\bi'?m (dead|dying|crying)\b/, 2]
];
// only pure hesitation sounds are dropped from the start; real words would leave a half sentence
const FILLER = new Set(['um', 'umm', 'uh', 'uhh', 'erm', 'hmm', 'mm']);
const STOP = new Set(
    'about above after again against because been before being below between both could does doing down during each from further have having here hers herself himself into itself just more most other ourselves over same should some such than that their theirs them themselves then there these they this those through under until very what when where which while whom will with would your yours yourself yourselves really gonna wanna kinda like yeah okay right thing things know mean think'.split(' ')
);

/** How excited each word sounds from its text alone (0 for ordinary words). */
function wordHeat(words: Word[], gaming: boolean): number[] {
    const heat = words.map((w, i) => {
        const raw = w.text.trim();
        const n = norm(raw);
        if (!n) return 0;
        let h = 0;
        if (LAUGH.test(n)) h += 2.5;
        else if (STRONG.has(n) || /^(no{3,}|yo{3,}|wha+t{2,}|go{3,}|ah{3,}|a{3,}h*)$/.test(n)) h += 2;
        else if (SWEAR.test(n)) h += 1.2;
        else if (MEDIUM.has(n)) h += 0.35;
        if (gaming && GAMING.has(n)) h += 0.6;
        if (/[!]/.test(raw)) h += 1;
        if (/\?!|!\?/.test(raw)) h += 0.5;
        if (raw.length >= 2 && /\p{L}/u.test(raw) && raw === raw.toUpperCase() && raw !== raw.toLowerCase()) h += 0.8;
        // "no no no", "go go go": the same word again straight away
        const prev = words[i - 1];
        if (prev && norm(prev.text) === n && w.start - prev.end < 1) h += 1.5;
        return h;
    });
    // phrases over neighbouring words
    for (let i = 0; i < words.length; i++) {
        const text = words.slice(i, i + 4).map((w) => norm(w.text)).join(' ');
        for (const [re, v] of PHRASES) {
            const m = text.match(re);
            if (m && m.index === 0) heat[i] += v;
        }
    }
    return heat;
}

function percentile(sorted: number[], p: number) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

type Curve = { score: number[]; talk: number[]; signals: { reaction: number[]; chat: number[]; voice: number[]; words: number[] } };

/** Interest score per second. */
export function interestCurve(t: Transcript, events: AudioEvent[], duration: number, mode: ContentMode = 'viral'): Curve {
    const n = Math.max(1, Math.ceil(duration));
    const gaming = mode === 'gaming';
    const W = gaming
        ? { reaction: 2.5, chat: 4, voice: 2, words: 1.4, rate: 0.5, loud: 1.2 }
        : mode === 'funny'
          ? { reaction: 3, chat: 4, voice: 1.2, words: 0.9, rate: 0.3, loud: 0.6 }
          : { reaction: 2.5, chat: 4, voice: 1.2, words: 1, rate: 0.4, loud: 0.8 };
    const talk = new Array(n).fill(0);
    const wordSig = new Array(n).fill(0);
    const rate = new Array(n).fill(0);
    const heat = wordHeat(t.words, gaming);
    t.words.forEach((w, i) => {
        const a = Math.max(0, Math.floor(w.start));
        const b = Math.min(n - 1, Math.floor(Math.max(w.start, w.end - 0.01)));
        for (let k = a; k <= b; k++) talk[k] = Math.min(1, talk[k] + (Math.min(k + 1, w.end) - Math.max(k, w.start)));
        if (a < n) {
            wordSig[a] += heat[i];
            rate[a] += 1;
        }
    });
    // pace: words per second over 3s compared with this speaker's usual pace
    const pace = rate.map((_, i) => (rate[i - 1] ?? 0) + rate[i] + (rate[i + 1] ?? 0));
    const usual = percentile(pace.filter((x) => x > 0).sort((a, b) => a - b), 0.5) || 1;
    const fast = pace.map((p) => Math.max(0, Math.min(1, p / usual - 1.3)));

    // voice: loudness above the speaker's normal level, counted fully only while someone talks
    const voice = new Array(n).fill(0);
    const e = t.energy;
    if (e && e.db.length > 8) {
        const active = e.db.filter((d) => d > -55).sort((a, b) => a - b);
        const base = percentile(active, 0.5);
        const top = Math.max(base + 3, percentile(active, 0.985));
        for (let k = 0; k < n; k++) {
            let peak = -120;
            for (let j = Math.floor(k / e.step); j < Math.floor((k + 1) / e.step) && j < e.db.length; j++) peak = Math.max(peak, e.db[j]);
            const lvl = Math.max(0, Math.min(1, (peak - base) / (top - base)));
            const talking = (talk[k - 1] ?? 0) + talk[k] + (talk[k + 1] ?? 0) > 0.3;
            voice[k] = lvl * lvl * (talking ? 1 : 0.3);
        }
    }

    const reaction = new Array(n).fill(0);
    const chat = new Array(n).fill(0);
    const loudEv = new Array(n).fill(0);
    for (const ev of events) {
        const target = ev.type === 'chat' ? chat : ev.type === 'reaction' ? reaction : ev.type === 'loud' ? loudEv : null;
        if (!target) continue;
        const a = Math.max(0, Math.floor(ev.start));
        const b = Math.min(n - 1, Math.ceil(ev.end));
        for (let k = a; k <= b; k++) target[k] = 1;
    }

    const raw = new Array(n).fill(0).map((_, k) => W.reaction * reaction[k] + W.chat * chat[k] + W.voice * voice[k] + W.words * Math.min(4, wordSig[k]) + W.rate * fast[k] + W.loud * loudEv[k]);
    // spread over neighbouring seconds: a moment is a few seconds, not a single instant
    const k5 = [0.25, 0.6, 1, 0.6, 0.25];
    const score = raw.map((_, i) => {
        let s = 0;
        for (let d = -2; d <= 2; d++) s += (raw[i + d] ?? 0) * k5[d + 2];
        return s / 2.7;
    });
    // nobody talking for a while (menus, loading, AFK): not a moment, whatever the game audio does
    for (let i = 0; i < n; i++) {
        let near = 0;
        for (let d = -4; d <= 4; d++) near += talk[i + d] ?? 0;
        if (near < 0.4 && !chat[i] && !reaction[i]) score[i] *= 0.15;
    }
    return { score, talk, signals: { reaction, chat, voice, words: wordSig } };
}

const sentenceStart = (segs: Segment[], i: number) => i === 0 || /[.!?…]$/.test(segs[i - 1].text.trim()) || segs[i].start - segs[i - 1].end > 0.6;

/** The best moments of a video, ready as clips. Always returns something if anyone talks. */
export function findMoments(t: Transcript, events: AudioEvent[], o: Opts, duration: number): Clip[] {
    const segs = t.segments;
    if (!segs.length || !t.words.length) return [];
    const mode = o.mode ?? 'viral';
    const gaming = mode === 'gaming';
    const { score, signals } = interestCurve(t, events, duration, mode);
    const n = score.length;
    const target = Math.max(o.minSeconds, Math.min(o.maxSeconds, gaming ? 24 : mode === 'funny' ? 22 : 30));

    // peaks: the highest point within ±4 seconds
    const peaks: number[] = [];
    for (let i = 0; i < n; i++) {
        if (score[i] <= 0.15) continue;
        let isPeak = true;
        for (let d = -4; d <= 4 && isPeak; d++) if (d && (score[i + d] ?? -1) > score[i]) isPeak = false;
        if (isPeak) peaks.push(i);
    }
    peaks.sort((a, b) => score[b] - score[a]);
    const top = score[peaks[0]] ?? 1;

    const heat = wordHeat(t.words, gaming);
    const chosen: Clip[] = [];
    for (const p of peaks) {
        if (chosen.length >= o.maxClips) break;
        // a weak bump far below the best moment is not worth a clip
        if (chosen.length >= Math.min(3, o.maxClips) && score[p] < top * 0.3) break;
        if (chosen.some((c) => p >= c.start - 3 && p <= c.end + 3)) continue;

        // the moment itself
        let l = p;
        let r = p;
        while (l > 0 && p - l < 12 && score[l - 1] >= score[p] * 0.4) l--;
        while (r < n - 1 && r - p < 8 && score[r + 1] >= score[p] * 0.4) r++;
        // end: after the reaction has played out, at the end of a word
        let end = r + 1;
        for (const ev of events) if ((ev.type === 'reaction' || ev.type === 'chat') && ev.start <= r + 3 && ev.end >= l) end = Math.max(end, Math.min(ev.end + 0.5, r + 6));
        const wEnd = t.words.find((w) => w.end >= end - 0.3);
        if (wEnd && wEnd.end - end < 2) end = wEnd.end;
        const seg = segs.find((s) => s.start <= end && s.end >= end);
        if (seg && seg.end - end < 2.5 && seg.end > end) end = seg.end; // finish the sentence
        end = Math.min(duration, end + 0.4);

        // start: a sentence start that gives the setup, close to the ideal length, ideally after a pause
        const latest = Math.min(l - 2, end - o.minSeconds);
        const earliest = end - o.maxSeconds;
        let start = -1;
        let best = -Infinity;
        for (let i = 0; i < segs.length; i++) {
            const s = segs[i].start;
            if (s < earliest || s > latest) continue;
            if (!sentenceStart(segs, i)) continue;
            const pause = i > 0 ? segs[i].start - segs[i - 1].end : 2;
            const fit = -Math.abs(end - s - target) + (pause > 0.8 ? 4 : 0) - (score[Math.floor(s)] > score[p] * 0.5 ? 2 : 0);
            if (fit > best) {
                best = fit;
                start = s;
            }
        }
        if (start < 0) {
            start = Math.max(0, end - target);
            const w = t.words.find((x) => x.start >= start - 0.05);
            if (w && end - w.start >= Math.min(o.minSeconds, 5)) start = w.start;
        }
        // don't open on "um", "so", "and"
        for (let k = 0; k < 2; k++) {
            const idx = t.words.findIndex((w) => w.start >= start - 0.05);
            const w = t.words[idx];
            const next = t.words[idx + 1];
            if (w && next && FILLER.has(norm(w.text)) && end - next.start >= o.minSeconds) start = next.start;
        }
        if (end - start < Math.min(5, o.minSeconds)) continue;
        if (chosen.some((c) => Math.min(c.end, end) - Math.max(c.start, start) > 0.3 * Math.min(c.end - c.start, end - start))) continue;

        // why it's good
        const has = (arr: number[]) => arr.slice(l, r + 1).some((x) => x > 0);
        const reactionHere = has(signals.reaction) || events.some((ev) => ev.type === 'reaction' && ev.start <= r + 3 && ev.end >= l);
        const chatHere = has(signals.chat);
        const voiceHere = Math.max(...signals.voice.slice(l, r + 1)) > 0.45;
        const hot = t.words.map((w, i) => ({ w, h: heat[i] })).filter((x) => x.w.start >= l - 1 && x.w.start <= r + 1 && x.h >= 1).sort((a, b) => b.h - a.h);
        const swearing = hot.some((x) => SWEAR.test(norm(x.w.text)));
        const signalsCount = [reactionHere, chatHere, voiceHere, hot.length > 0].filter(Boolean).length;
        const rel = score[p] / top;
        const scoreOut = Math.round(Math.max(40, Math.min(97, 46 + rel * 38 + signalsCount * 4)));
        const why: string[] = [];
        if (chatHere) {
            const ev = events.find((x) => x.type === 'chat' && x.start <= r + 1 && x.end >= l - 1);
            why.push(`stream chat exploded${ev?.label ? ` (${ev.label})` : ''}`);
        }
        if (reactionHere) why.push('a burst of laughter or reaction');
        if (voiceHere) why.push(gaming ? 'the voice goes way up (hype or rage)' : 'voices get loud and excited');
        if (hot.length) {
            // the hottest few words in a row, e.g. “NO WAY! No way bro”
            const k = t.words.indexOf(hot[0].w);
            why.push(`“${t.words.slice(k, k + 4).map((w) => w.text).join(' ').replace(/[.,]$/, '')}”`);
        }
        const category = swearing && voiceHere ? 'Rage' : reactionHere ? 'Funny' : gaming ? (voiceHere || hot.length ? 'Hype' : 'Funny') : voiceHere ? 'Surprising' : 'Funny';

        // title: the line right at the moment (the punchline or the exclamation)
        const inside = segs.filter((s) => s.end > start && s.start < end);
        const atPeak = segs.filter((s) => s.start <= r + 1 && s.end >= l - 2);
        // after a laugh, the punchline is the line just before it
        const laugh = events.find((ev) => ev.type === 'reaction' && ev.start <= r + 3 && ev.end >= l);
        const punchline = laugh ? [...segs].reverse().find((s) => s.end <= laugh.start + 0.3 && s.start >= start) : undefined;
        const quote = (punchline ?? atPeak.find((s) => hot.some((x) => x.w.start >= s.start && x.w.start <= s.end)) ?? atPeak[atPeak.length - 1] ?? inside[inside.length - 1])?.text.trim() ?? '';
        const shortTitle = quote.length > 62 ? `${quote.slice(0, 60).trim()}…` : quote;
        const words = t.words.filter((w) => w.start >= start && w.end <= end);
        const keywords = [...new Set(words.map((w) => norm(w.text)).filter((w) => w.length >= 5 && !STOP.has(w)))].sort((a, b) => b.length - a.length).slice(0, 4);
        const punchWord = hot[0]?.w ?? [...words].reverse().find((w) => w.end <= r + 1);
        const hook = (inside[0]?.text ?? '').trim();
        chosen.push({
            id: `free-${Math.round(start * 10)}`,
            title: shortTitle ? `“${shortTitle.replace(/[.,]$/, '')}”` : gaming ? 'Insane moment' : 'Funny moment',
            start,
            end,
            category,
            hook: hook.length > 90 ? `${hook.slice(0, 88)}…` : hook,
            score: scoreOut,
            subscores: { hook: Math.max(40, scoreOut - 8), flow: Math.max(40, scoreOut - 4), value: scoreOut, shareability: Math.max(40, scoreOut - 6) },
            reason: why.length ? `${why[0][0].toUpperCase()}${why[0].slice(1)}${why.length > 1 ? `, plus ${why.slice(1).join(' and ')}` : ''}.` : 'The most lively part of this stretch.',
            description: shortTitle,
            hashtags: gaming ? ['gaming', 'shorts', 'funny'] : category === 'Funny' ? ['funny', 'shorts', 'comedy'] : ['shorts'],
            keywords,
            emojis: punchWord ? [{ word: punchWord.text, emoji: category === 'Rage' ? '💀' : category === 'Hype' || category === 'Surprising' ? '😱' : '😂' }] : []
        });
    }
    return chosen.sort((a, b) => b.score - a.score);
}

/** Excited moments from the words alone, as markers for the Claude prompts and the timeline. */
export function hypeEvents(words: Word[], gaming = true): AudioEvent[] {
    const heat = wordHeat(words, gaming);
    const out: AudioEvent[] = [];
    let i = 0;
    while (i < words.length) {
        // 3 seconds of words starting here
        let j = i;
        let sum = 0;
        while (j < words.length && words[j].start - words[i].start <= 3) sum += heat[j++];
        if (sum >= 3.5 && heat[i] > 0) {
            const hot = words.slice(i, j).filter((_, k) => heat[i + k] >= 1);
            out.push({ start: words[i].start, end: words[j - 1].end, type: 'hype', strength: sum, label: hot.slice(0, 3).map((w) => w.text.replace(/[.,]/g, '')).join(' ') });
            i = j;
        } else i++;
    }
    return out.sort((a, b) => b.strength - a.strength).slice(0, 150).sort((a, b) => a.start - b.start);
}
