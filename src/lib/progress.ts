import type { Progress } from './types';

export const MAX_NOTE = 500;
const MAX_ITEMS = 5000;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function emptyProgress(): Progress {
    return { v: 1, done: {}, notes: {}, updatedAt: 0 };
}

/** Normalises untrusted progress data (from the client or a backup code). Throws on garbage. */
export function cleanProgress(input: unknown): Progress {
    if (!input || typeof input !== 'object') throw new Error('Invalid progress');
    const o = input as Record<string, unknown>;
    const done: Record<string, number> = {};
    const notes: Record<string, string> = {};
    const rawDone = o.done && typeof o.done === 'object' ? (o.done as Record<string, unknown>) : {};
    const rawNotes = o.notes && typeof o.notes === 'object' ? (o.notes as Record<string, unknown>) : {};

    for (const [k, v] of Object.entries(rawDone).slice(0, MAX_ITEMS)) {
        if (ID_RE.test(k) && typeof v === 'number' && Number.isFinite(v)) done[k] = v;
    }
    for (const [k, v] of Object.entries(rawNotes).slice(0, MAX_ITEMS)) {
        if (ID_RE.test(k) && typeof v === 'string' && v.trim()) notes[k] = v.slice(0, MAX_NOTE);
    }
    const updatedAt = typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt) ? o.updatedAt : Date.now();
    return { v: 1, done, notes, updatedAt };
}
