// Timeline maths: which parts of a clip are kept after cuts, and how source times map
// to times in the finished video.
import type { Clip, Span, Word } from './types';

/** Kept pieces of the clip, in source time, in order. */
export function keptSegments(clip: Clip): Span[] {
    const cuts = (clip.cuts ?? [])
        .map((c) => ({ start: Math.max(clip.start, c.start), end: Math.min(clip.end, c.end) }))
        .filter((c) => c.end - c.start > 0.02)
        .sort((a, b) => a.start - b.start);
    const out: Span[] = [];
    let t = clip.start;
    for (const c of cuts) {
        if (c.start > t) out.push({ start: t, end: c.start });
        t = Math.max(t, c.end);
    }
    if (clip.end > t) out.push({ start: t, end: clip.end });
    return out.filter((s) => s.end - s.start > 0.05);
}

export function outputDuration(clip: Clip): number {
    return keptSegments(clip).reduce((a, s) => a + s.end - s.start, 0);
}

/** Source time -> time in the finished video (null when that moment was cut). */
export function toOutput(clip: Clip, t: number, segs = keptSegments(clip)): number | null {
    let acc = 0;
    for (const s of segs) {
        if (t < s.start) return null;
        if (t <= s.end) return acc + (t - s.start);
        acc += s.end - s.start;
    }
    return null;
}

/** Like toOutput, but snaps a cut moment to the next kept moment. */
export function toOutputClamped(clip: Clip, t: number, segs = keptSegments(clip)): number {
    let acc = 0;
    for (const s of segs) {
        if (t <= s.start) return acc;
        if (t <= s.end) return acc + (t - s.start);
        acc += s.end - s.start;
    }
    return acc;
}

/** If t falls inside a cut, the source time where playback should continue (else t). */
export function skipCut(clip: Clip, t: number): number {
    for (const c of clip.cuts ?? []) if (t >= c.start && t < c.end) return c.end;
    return t;
}

export function isCut(clip: Clip, t: number): boolean {
    return (clip.cuts ?? []).some((c) => t >= c.start && t < c.end);
}

/** Gaps between words longer than `minGap` become cuts (keeping a little breathing room). */
export function silenceCuts(clip: Clip, words: Word[], minGap = 0.7, pad = 0.15): Span[] {
    const inside = words.filter((w) => w.end > clip.start && w.start < clip.end).sort((a, b) => a.start - b.start);
    const cuts: Span[] = [];
    let prevEnd = clip.start;
    for (const w of inside) {
        if (w.start - prevEnd > minGap) cuts.push({ start: prevEnd + pad, end: w.start - pad });
        prevEnd = Math.max(prevEnd, w.end);
    }
    if (clip.end - prevEnd > minGap + 0.5) cuts.push({ start: prevEnd + pad + 0.4, end: clip.end }); // trailing dead air
    return cuts.filter((c) => c.end - c.start > 0.2);
}

/** Merge overlapping spans. */
export function mergeSpans(spans: Span[]): Span[] {
    const s = [...spans].sort((a, b) => a.start - b.start);
    const out: Span[] = [];
    for (const x of s) {
        const last = out[out.length - 1];
        if (last && x.start <= last.end + 0.01) last.end = Math.max(last.end, x.end);
        else out.push({ ...x });
    }
    return out;
}

/** Pieces between split points, each marked cut or kept. */
export function pieces(clip: Clip): (Span & { cut: boolean })[] {
    const pts = [clip.start, ...(clip.splits ?? []).filter((s) => s > clip.start + 0.05 && s < clip.end - 0.05).sort((a, b) => a - b), clip.end];
    const out: (Span & { cut: boolean })[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
        const mid = (pts[i] + pts[i + 1]) / 2;
        out.push({ start: pts[i], end: pts[i + 1], cut: isCut(clip, mid) });
    }
    return out;
}

/** Removes `piece` from the cut list (restores it). */
export function subtractSpan(spans: Span[], piece: Span): Span[] {
    const out: Span[] = [];
    for (const c of spans) {
        if (c.end <= piece.start || c.start >= piece.end) out.push(c);
        else {
            if (c.start < piece.start) out.push({ start: c.start, end: piece.start });
            if (c.end > piece.end) out.push({ start: piece.end, end: c.end });
        }
    }
    return out;
}
