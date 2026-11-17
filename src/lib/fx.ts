// One-click auto placement for the optional effects.
import { keptSegments, segmentsOf } from './timeline';
import type { AudioEvent, Clip, PipSettings, SfxKind, Span } from './types';

const inside = (clip: Clip, t: number) => t > clip.start + 0.3 && t < clip.end - 0.2;

/** Booms on laughs/chat spikes, whooshes on zooms. */
export function autoSfx(clip: Clip, events: AudioEvent[]): { t: number; kind: SfxKind }[] {
    const out: { t: number; kind: SfxKind }[] = [];
    for (const e of events) if ((e.type === 'reaction' || e.type === 'chat') && inside(clip, e.start)) out.push({ t: Math.max(clip.start, e.start - 0.15), kind: 'boom' });
    for (const z of clip.zooms ?? []) if (inside(clip, z.start)) out.push({ t: Math.max(clip.start, z.start - 0.2), kind: 'whoosh' });
    // keep them at least 1.5s apart
    const sorted = out.sort((a, b) => a.t - b.t);
    return sorted.filter((s, i) => i === 0 || s.t - sorted[i - 1].t > 1.5).slice(0, 12);
}

/** Shakes on the loudest moments, with a flash on the biggest. */
export function autoShakes(clip: Clip, events: AudioEvent[]): { t: number; kind: 'shake' | 'flash' | 'both' }[] {
    const loud = events.filter((e) => (e.type === 'loud' || e.type === 'reaction') && inside(clip, e.start)).sort((a, b) => b.strength - a.strength).slice(0, 4);
    return loud.map((e, i) => ({ t: e.start, kind: i === 0 ? ('both' as const) : ('shake' as const) })).sort((a, b) => a.t - b.t);
}

/** Replay the build-up to the biggest laugh (or the last few seconds) in slow motion. */
export function autoReplay(clip: Clip, events: AudioEvent[]): { start: number; end: number; speed: number } {
    const best = events.filter((e) => (e.type === 'reaction' || e.type === 'chat') && inside(clip, e.start)).sort((a, b) => b.strength - a.strength)[0];
    const segs = keptSegments(clip);
    const lastEnd = segs.length ? segs[segs.length - 1].end : clip.end;
    const peak = best ? best.start : lastEnd - 0.5;
    return { start: Math.max(clip.start, peak - 2.4), end: Math.min(clip.end, peak + 0.4), speed: 0.6 };
}

/** Length of the replay part in the finished video. */
export function replayLength(clip: Clip): number {
    const r = clip.replay;
    return r && r.end > r.start ? (r.end - r.start) / r.speed : 0;
}

export const PIP_DEFAULT: PipSettings = { corner: 'tl', size: 0.36, shape: 'circle' };

/** Source times where one part ends and the next begins. */
export function cutTimes(clip: Clip): number[] {
    return segmentsOf(clip).slice(1).map((s) => s.start);
}

/** Shakes and flashes, including the ones the transition adds at every cut. */
export function allShakes(clip: Clip): NonNullable<Clip['shakes']> {
    const base = clip.shakes ?? [];
    const tr = clip.transition;
    if (!tr || (tr.kind !== 'flash' && tr.kind !== 'shake')) return base;
    return [...base, ...cutTimes(clip).map((t) => ({ t, kind: tr.kind as 'flash' | 'shake' }))];
}

/** Zooms, including the quick punch-in a "zoom" transition adds at every cut. */
export function allZooms(clip: Clip): (Span & { scale: number })[] {
    const base = clip.zooms ?? [];
    if (clip.transition?.kind !== 'zoom') return base;
    const segs = segmentsOf(clip);
    const punches = segs.slice(1).map((s) => ({ start: s.start, end: Math.min(s.end, s.start + 0.3), scale: 1.2 }));
    // a punch wins over a longer zoom that covers the same moment
    return [...punches, ...base];
}

/** Sound effects, including the transition sound at every cut. */
export function allSfx(clip: Clip): { t: number; kind: SfxKind }[] {
    const base = clip.sfx ?? [];
    const snd = clip.transition?.sound;
    if (!snd) return base;
    return [...base, ...cutTimes(clip).map((t) => ({ t, kind: snd }))].sort((a, b) => a.t - b.t);
}
