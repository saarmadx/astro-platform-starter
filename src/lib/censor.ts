// Swear filter for captions (and bleep timings for the audio).
import type { Word } from './types';

const ROOTS = ['fuck', 'shit', 'bitch', 'cunt', 'dick', 'cock', 'pussy', 'asshole', 'bastard', 'motherfuck', 'whore', 'slut', 'damn', 'goddamn', 'piss', 'twat', 'wank', 'bollock', 'prick', 'nigg', 'fag', 'retard'];
const EXACT = new Set(['ass', 'arse', 'hell', 'crap', 'bullshit', 'tits']);

export function isSwear(text: string): boolean {
    const w = text.toLowerCase().replace(/[^a-z]/g, '');
    if (!w) return false;
    if (EXACT.has(w)) return true;
    return ROOTS.some((r) => w.includes(r));
}

/** "fucking" -> "f******" (keeps punctuation) */
export function censorText(text: string): string {
    return text.replace(/[A-Za-z]+/g, (m) => (isSwear(m) ? m[0] + '*'.repeat(Math.max(2, m.length - 1)) : m));
}

export function bleepSpans(words: Word[]): { start: number; end: number }[] {
    return words.filter((w) => isSwear(w.text)).map((w) => ({ start: w.start, end: Math.max(w.end, w.start + 0.15) }));
}
