// Timeline maths. A clip is a list of parts ("segments") of the source video, played one after
// another. Times on the timeline are sequence times (the finished video); effects are stored in
// source time and mapped back and forth.
import type { Clip, Layout, Seg, Span, StyleSettings, Word } from './types';

let idCounter = 0;
export const newSegId = () => `sg${Date.now().toString(36)}${(idCounter++).toString(36)}`;

/** Older projects describe a clip with start/end + cut ranges: turn that into parts. */
function legacySegments(clip: Clip): Seg[] {
    const cuts = (clip.cuts ?? [])
        .map((c) => ({ start: Math.max(clip.start, c.start), end: Math.min(clip.end, c.end) }))
        .filter((c) => c.end - c.start > 0.02)
        .sort((a, b) => a.start - b.start);
    const kept: Span[] = [];
    let t = clip.start;
    for (const c of cuts) {
        if (c.start > t) kept.push({ start: t, end: c.start });
        t = Math.max(t, c.end);
    }
    if (clip.end > t) kept.push({ start: t, end: clip.end });
    // honour split points too, so each piece becomes its own part
    const splits = (clip.splits ?? []).sort((a, b) => a - b);
    const out: Seg[] = [];
    for (const k of kept) {
        let s = k.start;
        for (const sp of splits) {
            if (sp > s + 0.05 && sp < k.end - 0.05) {
                out.push({ id: newSegId(), start: s, end: sp });
                s = sp;
            }
        }
        out.push({ id: newSegId(), start: s, end: k.end });
    }
    return out.filter((s) => s.end - s.start > 0.05);
}

/** The parts of the clip, in order. */
export function segmentsOf(clip: Clip): Seg[] {
    if (clip.segs?.length) return [...clip.segs].sort((a, b) => a.start - b.start);
    return legacySegments(clip);
}

/** Kept pieces of the clip, in source time, in order. */
export function keptSegments(clip: Clip): Span[] {
    return segmentsOf(clip).map((s) => ({ start: s.start, end: s.end }));
}

/** A clip rebuilt from a list of parts (start/end follow the parts; old-style cuts are dropped). */
export function withSegs(clip: Clip, segs: Seg[]): Partial<Clip> {
    const sorted = [...segs].filter((s) => s.end - s.start > 0.05).sort((a, b) => a.start - b.start);
    if (!sorted.length) return {};
    return { segs: sorted, start: sorted[0].start, end: sorted[sorted.length - 1].end, cuts: [], splits: [] };
}

/** Make sure a clip uses the parts model (used when an older clip is opened in the editor). */
export function ensureSegs(clip: Clip): Clip {
    if (clip.segs?.length) return clip;
    return { ...clip, ...withSegs(clip, legacySegments(clip)) };
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

/** Time in the finished video -> source time. */
export function toSource(clip: Clip, out: number, segs = keptSegments(clip)): number {
    let acc = 0;
    for (const s of segs) {
        const len = s.end - s.start;
        if (out <= acc + len) return s.start + Math.max(0, out - acc);
        acc += len;
    }
    return segs.length ? segs[segs.length - 1].end : clip.end;
}

/** If t falls between two parts (a cut), the source time where playback should continue (else t). */
export function skipCut(clip: Clip, t: number): number {
    const segs = keptSegments(clip);
    for (let i = 0; i < segs.length; i++) {
        if (t < segs[i].start) return i === 0 ? t : segs[i].start;
        if (t < segs[i].end) return t;
    }
    return t;
}

export function isCut(clip: Clip, t: number): boolean {
    if (t < clip.start || t > clip.end) return false;
    return !keptSegments(clip).some((s) => t >= s.start && t < s.end);
}

/** The part playing at source time t (or the nearest one). */
export function segAt(clip: Clip, t: number): Seg | undefined {
    const segs = segmentsOf(clip);
    return segs.find((s) => t >= s.start && t < s.end) ?? segs.find((s) => t < s.start) ?? segs[segs.length - 1];
}

/** Framing at source time t: a part can override the project's layout. */
export function styleAt(clip: Clip, style: StyleSettings, t: number): StyleSettings {
    const s = segAt(clip, t);
    if (!s || (!s.layout && s.cropX === undefined)) return style;
    return { ...style, layout: (s.layout ?? style.layout) as Layout, cropX: s.cropX ?? style.cropX };
}

/** Gaps between words longer than `minGap` (keeping a little breathing room), for jump cuts. */
export function silenceCuts(clip: Clip, words: Word[], minGap = 0.7, pad = 0.15): Span[] {
    const inside = words.filter((w) => w.end > clip.start && w.start < clip.end).sort((a, b) => a.start - b.start);
    const cuts: Span[] = [];
    let prevEnd = clip.start;
    for (const w of inside) {
        if (w.start - prevEnd > minGap) cuts.push({ start: prevEnd + pad, end: w.start - pad });
        prevEnd = Math.max(prevEnd, w.end);
    }
    if (clip.end - prevEnd > minGap + 0.5) cuts.push({ start: prevEnd + pad + 0.4, end: clip.end });
    return cuts.filter((c) => c.end - c.start > 0.2);
}

/** Removes source ranges from the parts (keeping each part's layout), e.g. for jump cuts. */
export function removeRanges(segs: Seg[], ranges: Span[]): Seg[] {
    let out = segs;
    for (const r of ranges) {
        const next: Seg[] = [];
        for (const s of out) {
            if (r.end <= s.start || r.start >= s.end) next.push(s);
            else {
                if (r.start > s.start + 0.05) next.push({ ...s, end: r.start });
                if (r.end < s.end - 0.05) next.push({ ...s, id: newSegId(), start: r.end });
            }
        }
        out = next;
    }
    return out;
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
