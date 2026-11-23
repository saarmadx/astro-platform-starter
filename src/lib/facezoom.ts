// Face zoom on awkward silences: when nobody talks for a moment, slowly push in on the face,
// aimed at the eyes (and mouth), the classic "awkward silence" zoom.
import { findEyes, type FacePoint } from './faces';
import { keptSegments } from './timeline';
import type { Clip, Energy, StyleSettings, Word, Zoom } from './types';

const MIN_GAP = 1.2; // seconds of silence that feel awkward
const MAX_ZOOM = 4; // never hold a zoom longer than this
export const FACE_ZOOM_SCALE = 1.5;

/** Silences in the clip (absolute source times) where the zoom should play. */
export function awkwardSilences(clip: Clip, words: Word[], energy?: Energy): { start: number; end: number }[] {
    const segs = keptSegments(clip);
    const inClip = words.filter((w) => w.end > clip.start && w.start < clip.end).sort((a, b) => a.start - b.start);
    if (!inClip.length) return [];
    // how loud talking is in this clip, to tell a real silence from laughing or shouting with no words
    const dbAt = (t: number) => (energy ? energy.db[Math.floor(t / energy.step)] ?? -90 : undefined);
    const speechDb = energy ? median(inClip.map((w) => dbAt((w.start + w.end) / 2)!).filter((d) => d > -80)) : undefined;
    const out: { start: number; end: number }[] = [];
    for (let i = 0; i < inClip.length; i++) {
        const from = inClip[i].end;
        const to = i + 1 < inClip.length ? inClip[i + 1].start : clip.end;
        if (to - from < MIN_GAP) continue;
        // the whole silence must be in one kept part (a jump cut may have removed it)
        const seg = segs.find((s) => from >= s.start - 0.05 && from < s.end);
        if (!seg || Math.min(to, seg.end) - from < MIN_GAP) continue;
        const end = Math.min(to, seg.end, from + MAX_ZOOM);
        if (speechDb !== undefined) {
            const samples: number[] = [];
            for (let t = from + 0.2; t < end; t += energy!.step) samples.push(dbAt(t)!);
            // laughing, screaming or music in the gap: not an awkward silence
            if (samples.length && median(samples) > speechDb - 10) continue;
        }
        out.push({ start: from + 0.15, end: Math.min(clip.end, end + 0.15) });
    }
    // at most 3 per clip: the longest silences
    return out
        .sort((a, b) => b.end - b.start - (a.end - a.start))
        .slice(0, 3)
        .sort((a, b) => a.start - b.start);
}

function median(a: number[]): number {
    if (!a.length) return -90;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
}

/**
 * Face zooms for one clip. `video` is a hidden video element of the source (frames are read
 * from it); `aim` is a point the creator picked by hand, used when it is set.
 * Returns the zooms and how many of them found the eyes by themselves.
 */
export async function makeFaceZooms(
    video: HTMLVideoElement,
    clip: Clip,
    words: Word[],
    energy: Energy | undefined,
    style: StyleSettings,
    aim?: { x: number; y: number }
): Promise<{ zooms: Zoom[]; found: number; total: number }> {
    const spans = awkwardSilences(clip, words, energy);
    const zooms: Zoom[] = [];
    let found = 0;
    // a facecam layout: look for the eyes inside the facecam first
    const camArea = style.layout === 'split' || style.layout === 'pip' ? style.facecam : undefined;
    for (const sp of spans) {
        let p: FacePoint | null | { x: number; y: number } = aim ?? null;
        if (!p) {
            const mid = (sp.start + sp.end) / 2;
            p = (camArea ? await findEyes(video, mid, camArea) : null) ?? (await findEyes(video, mid)) ?? (await findEyes(video, sp.start + 0.1));
            if (p) found++;
        }
        // no eyes found and no point picked: aim at the facecam, else the upper middle of the frame
        const fallback = camArea ? { x: camArea.x + camArea.w / 2, y: camArea.y + camArea.h * 0.42 } : { x: 0.5, y: 0.4 };
        const pt = p ?? fallback;
        zooms.push({ start: sp.start, end: sp.end, scale: FACE_ZOOM_SCALE, ease: Math.min(0.9, (sp.end - sp.start) * 0.4), fx: pt.x, fy: pt.y, face: true });
    }
    return { zooms, found: aim ? spans.length : found, total: spans.length };
}

/** The clip's zooms with its face zooms replaced (other zooms are kept, overlapping ones dropped). */
export function withFaceZooms(clip: Clip, face: Zoom[]): Zoom[] {
    const others = (clip.zooms ?? []).filter((z) => !z.face && !face.some((f) => z.start < f.end && f.start < z.end));
    return [...others, ...face].sort((a, b) => a.start - b.start);
}
