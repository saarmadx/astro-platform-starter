// Loudness analysis. Speech-to-text usually drops laughter, so we look at the audio itself:
// loud bursts with few or no words are usually laughter or a big reaction, which is the
// strongest sign that something funny just happened.
import { chatEvents } from './chat';
import { hypeEvents } from './moments';
import type { AudioEvent, Energy, Word } from './types';

export const ENERGY_STEP = 0.25; // seconds per loudness sample

/** Loudness (dB) of a decoded audio blob in ENERGY_STEP windows. */
export async function loudness(blob: Blob): Promise<number[]> {
    const Ctx = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
    const ctx = new Ctx(1, 16000, 16000);
    const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    const data = buffer.getChannelData(0);
    const win = Math.max(1, Math.round(buffer.sampleRate * ENERGY_STEP));
    const out: number[] = [];
    for (let i = 0; i < data.length; i += win) {
        let sum = 0;
        const end = Math.min(data.length, i + win);
        for (let j = i; j < end; j++) sum += data[j] * data[j];
        const rms = Math.sqrt(sum / Math.max(1, end - i));
        out.push(Math.round(20 * Math.log10(rms + 1e-6) * 10) / 10);
    }
    return out;
}

function percentile(sorted: number[], p: number) {
    if (sorted.length === 0) return 0;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

const LAUGH_WORD = /^(ha){1,}h?!?$|^(he){2,}|^lol$|^lmao$|^\(?laugh/i;

/** Finds reactions (loud, few words: laughter, cheering, shouting) and loud excited speech. */
export function findAudioEvents(energy: Energy | undefined, words: Word[]): AudioEvent[] {
    if (!energy || energy.db.length < 8) return [];
    const { step, db } = energy;
    const active = db.filter((d) => d > -55).sort((a, b) => a - b);
    if (active.length < 8) return [];
    const loudLine = percentile(active, 0.82);
    const veryLoud = percentile(active, 0.95);

    // runs of loud windows, bridging tiny dips
    const runs: { a: number; b: number }[] = [];
    let start = -1;
    let gap = 0;
    for (let i = 0; i <= db.length; i++) {
        const loud = i < db.length && db[i] >= loudLine;
        if (loud) {
            if (start < 0) start = i;
            gap = 0;
        } else if (start >= 0) {
            gap++;
            if (gap > 1 || i === db.length) {
                runs.push({ a: start, b: i - gap + 1 });
                start = -1;
                gap = 0;
            }
        }
    }

    const events: AudioEvent[] = [];
    for (const r of runs) {
        const s = r.a * step;
        const e = r.b * step;
        if (e - s < 0.75) continue;
        let covered = 0;
        let laughWords = 0;
        for (const w of words) {
            if (w.end <= s || w.start >= e) continue;
            covered += Math.min(e, w.end) - Math.max(s, w.start);
            if (LAUGH_WORD.test(w.text.replace(/[.,!?]/g, ''))) laughWords++;
        }
        const coverage = covered / (e - s);
        const peak = Math.max(...db.slice(r.a, r.b));
        // laughter comes right after someone says something and is fairly short; long loud stretches
        // with nobody talking are music, explosions or other game sound
        const spokeBefore = words.some((w) => w.end > s - 4 && w.start < e);
        if (laughWords > 0 || (coverage < 0.35 && spokeBefore && e - s <= 9)) events.push({ start: s, end: e, type: 'reaction', strength: peak });
        else if (peak >= veryLoud) events.push({ start: s, end: e, type: 'loud', strength: peak });
    }
    // keep the strongest few hundred so the prompt stays small
    return events.sort((x, y) => y.strength - x.strength).slice(0, 300).sort((x, y) => x.start - y.start);
}

/** Laughs/reactions from the audio plus spikes from a stream chat replay, if one was added. */
export function projectEvents(p: { transcript?: { energy?: Energy; words: Word[] }; chat?: { spikes: { t: number; count: number; laughs: number }[] } }): AudioEvent[] {
    const audio = p.transcript ? findAudioEvents(p.transcript.energy, p.transcript.words) : [];
    const hype = p.transcript ? hypeEvents(p.transcript.words) : [];
    return [...audio, ...hype, ...chatEvents(p.chat?.spikes)].sort((a, b) => a.start - b.start);
}
