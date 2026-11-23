// Automatic reframing: finds the speaker's face through a clip and turns it into a
// smooth crop path, so vertical clips keep the person in frame.
import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';
import { cropWindow } from './geometry';
import type { Aspect } from './types';

let detectorPromise: Promise<FaceDetector> | null = null;

function getDetector(): Promise<FaceDetector> {
    if (!detectorPromise) {
        detectorPromise = (async () => {
            const fileset = await FilesetResolver.forVisionTasks(`${location.origin}/mediapipe`);
            return FaceDetector.createFromOptions(fileset, {
                baseOptions: { modelAssetPath: '/models/blaze_face_short_range.tflite', delegate: 'CPU' },
                runningMode: 'IMAGE',
                minDetectionConfidence: 0.45
            });
        })();
        detectorPromise.catch(() => (detectorPromise = null));
    }
    return detectorPromise;
}

/** Jumps to a time. Resolves false if the browser doesn't manage it in time (never waits forever). */
function seek(v: HTMLVideoElement, t: number, timeoutMs = 4000): Promise<boolean> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => finish(false), timeoutMs);
        function finish(ok: boolean) {
            clearTimeout(timer);
            v.removeEventListener('seeked', onSeeked);
            resolve(ok);
        }
        const onSeeked = () => finish(true);
        v.addEventListener('seeked', onSeeked);
        v.currentTime = t;
    });
}

/** A hidden video element for reading frames; rejects if the file can't be opened in time. */
export function openVideo(videoUrl: string, timeoutMs = 20000): Promise<HTMLVideoElement> {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = videoUrl;
    return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('The video took too long to open for reframing.')), timeoutMs);
        v.onloadeddata = () => {
            clearTimeout(timer);
            res(v);
        };
        v.onerror = () => {
            clearTimeout(timer);
            rej(new Error('Could not read the video for reframing.'));
        };
    });
}

export function closeVideo(v: HTMLVideoElement) {
    v.removeAttribute('src');
    v.load();
}

export type TrackResult = { track?: { t: number; x: number }[]; thumb: string };

/**
 * Samples the clip every `step` seconds, detects the largest face, and returns crop
 * keyframes (absolute time -> face centre as a fraction of the video width). Also captures a thumbnail.
 */
export async function analyseClip(
    videoUrl: string,
    start: number,
    end: number,
    aspect: Aspect,
    opts: { video?: HTMLVideoElement; track?: boolean; budgetMs?: number } = {}
): Promise<TrackResult> {
    // a shared video element can be passed in so a long file isn't opened again for every clip
    const own = !opts.video;
    const v = opts.video ?? (await openVideo(videoUrl));
    try {
        return await analyse(v, start, end, aspect, opts.track !== false, opts.budgetMs ?? 45000);
    } finally {
        if (own) closeVideo(v);
    }
}

async function analyse(v: HTMLVideoElement, start: number, end: number, aspect: Aspect, wantTrack: boolean, budgetMs: number): Promise<TrackResult> {
    const began = performance.now();
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    const scale = Math.min(1, 640 / vw);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

    // thumbnail
    await seek(v, Math.min(end - 0.1, start + 1), 8000);
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = 320;
    thumbCanvas.height = Math.round((320 * vh) / vw);
    thumbCanvas.getContext('2d')!.drawImage(v, 0, 0, thumbCanvas.width, thumbCanvas.height);
    const thumb = thumbCanvas.toDataURL('image/jpeg', 0.7);

    const { cw } = cropWindow(vw, vh, aspect);
    if (!wantTrack || vw - cw < 4) return { thumb }; // not needed, or the source already fits

    let detector: FaceDetector;
    try {
        detector = await getDetector();
    } catch {
        return { thumb };
    }

    const centers: (number | null)[] = [];
    const times: number[] = [];
    // at most ~40 looks per clip, and never longer than the time budget
    const step = Math.max(0.5, (end - start) / 40);
    let misses = 0;
    for (let t = start; t < end; t += step) {
        if (performance.now() - began > budgetMs || misses >= 3) break;
        if (!(await seek(v, t))) {
            misses++;
            continue;
        }
        misses = 0;
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const result = detector.detect(canvas);
        let best: { x: number; area: number } | null = null;
        for (const d of result.detections) {
            const b = d.boundingBox;
            if (!b) continue;
            const area = b.width * b.height;
            if (!best || area > best.area) best = { x: (b.originX + b.width / 2) / scale, area };
        }
        centers.push(best ? best.x : null);
        times.push(t);
    }

    if (!centers.length || centers.every((c) => c === null)) return { thumb };

    // fill gaps with the nearest known position
    let last = centers.find((c) => c !== null) as number;
    const filled = centers.map((c) => (c === null ? last : (last = c)));

    const toPos = (cx: number) => cx / vw; // stored as face centre; converted per aspect ratio later
    // hold the frame steady; only move when the face drifts far for two samples in a row
    const track: { t: number; x: number }[] = [];
    let cur = filled[0];
    track.push({ t: start, x: toPos(cur) });
    for (let i = 1; i < filled.length; i++) {
        const far = Math.abs(filled[i] - cur) > cw * 0.22;
        const confirmed = i + 1 < filled.length ? Math.abs(filled[i + 1] - cur) > cw * 0.22 : true;
        if (far && confirmed) {
            track.push({ t: times[i], x: toPos(cur) });
            cur = (filled[i] + (filled[i + 1] ?? filled[i])) / 2;
            track.push({ t: times[i] + 0.35, x: toPos(cur) });
        }
    }
    track.push({ t: end, x: toPos(cur) });
    return { track, thumb };
}

export type Rect = { x: number; y: number; w: number; h: number };

/**
 * Finds a streamer's facecam: a face that stays in roughly the same place across the video.
 * Returns a rectangle (fractions of the frame) around it, or null if none is found.
 */
export async function detectFacecam(videoUrl: string, duration: number, samples = 10): Promise<Rect | null> {
    const v = await openVideo(videoUrl);
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    const scale = Math.min(1, 640 / vw);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    let detector: FaceDetector;
    try {
        detector = await getDetector();
    } catch {
        return null;
    }
    const boxes: Rect[] = [];
    let misses = 0;
    for (let i = 0; i < samples && misses < 3; i++) {
        if (!(await seek(v, (duration * (i + 0.5)) / samples, 6000))) {
            misses++;
            continue;
        }
        misses = 0;
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        for (const d of detector.detect(canvas).detections) {
            const b = d.boundingBox;
            if (b) boxes.push({ x: b.originX / canvas.width, y: b.originY / canvas.height, w: b.width / canvas.width, h: b.height / canvas.height });
        }
    }
    v.removeAttribute('src');
    v.load();
    if (!boxes.length) return null;

    // the facecam is the face position seen most often
    let best: { box: Rect; count: number } | null = null;
    for (const b of boxes) {
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        const near = boxes.filter((o) => Math.abs(o.x + o.w / 2 - cx) < 0.06 && Math.abs(o.y + o.h / 2 - cy) < 0.06);
        if (!best || near.length > best.count) {
            const avg = near.reduce((a, o) => ({ x: a.x + o.x / near.length, y: a.y + o.y / near.length, w: a.w + o.w / near.length, h: a.h + o.h / near.length }), { x: 0, y: 0, w: 0, h: 0 });
            best = { box: avg, count: near.length };
        }
    }
    if (!best || best.count < Math.max(2, samples * 0.3)) return null;

    // widen around the face to take in the whole webcam view
    const f = best.box;
    const w = Math.min(1, f.w * 2.6);
    const h = Math.min(1, f.h * 2.4);
    const x = Math.min(1 - w, Math.max(0, f.x + f.w / 2 - w / 2));
    const y = Math.min(1 - h, Math.max(0, f.y + f.h / 2 - h / 2));
    return { x, y, w, h };
}

// ---------- face zoom: where are the eyes? ----------

let looseDetectorPromise: Promise<FaceDetector> | null = null;
/** A more forgiving detector, so faces that are only eyes and a mouth (e.g. a cartoon with a
 *  real person's eyes and mouth) are still found. */
function getLooseDetector(): Promise<FaceDetector> {
    if (!looseDetectorPromise) {
        looseDetectorPromise = (async () => {
            const fileset = await FilesetResolver.forVisionTasks(`${location.origin}/mediapipe`);
            return FaceDetector.createFromOptions(fileset, {
                baseOptions: { modelAssetPath: '/models/blaze_face_short_range.tflite', delegate: 'CPU' },
                runningMode: 'IMAGE',
                minDetectionConfidence: 0.25
            });
        })();
        looseDetectorPromise.catch(() => (looseDetectorPromise = null));
    }
    return looseDetectorPromise;
}

/** A point to zoom on (fractions of the video frame): between the eyes, a little toward the mouth. */
export type FacePoint = { x: number; y: number; size: number };

function pointFrom(d: { boundingBox?: { originX: number; originY: number; width: number; height: number }; keypoints?: { x: number; y: number }[] }, sx: number, sy: number, sw: number, sh: number, W: number, H: number): FacePoint | null {
    const k = d.keypoints;
    const b = d.boundingBox;
    if (!b) return null;
    // keypoints: 0 right eye, 1 left eye, 2 nose, 3 mouth (fractions of the image that was searched)
    let x: number;
    let y: number;
    if (k && k.length >= 4) {
        const ex = (k[0].x + k[1].x) / 2;
        const ey = (k[0].y + k[1].y) / 2;
        x = ex;
        y = ey * 0.65 + k[3].y * 0.35;
    } else {
        x = (b.originX + b.width / 2) / sw;
        y = (b.originY + b.height * 0.45) / sh;
    }
    return { x: (sx + x * sw) / W, y: (sy + y * sh) / H, size: b.width / sw * (sw / W) };
}

/**
 * Finds the eyes in the frame at time t. Looks at the whole frame first, then at closer
 * pieces of it (small faces, like a facecam). Returns null when there are no eyes to find.
 */
export async function findEyes(v: HTMLVideoElement, t: number, region?: Rect): Promise<FacePoint | null> {
    if (!(await seek(v, t))) return null;
    let det: FaceDetector;
    try {
        det = await getLooseDetector();
    } catch {
        return null;
    }
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    const r = region ?? { x: 0, y: 0, w: 1, h: 1 };
    // the whole area, then 2x2 overlapping pieces of it, each scaled up for the detector
    const areas: Rect[] = [r];
    for (const ax of [0, 0.4]) for (const ay of [0, 0.4]) areas.push({ x: r.x + r.w * ax, y: r.y + r.h * ay, w: r.w * 0.6, h: r.h * 0.6 });
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    for (const a of areas) {
        const sw = a.w * vw;
        const sh = a.h * vh;
        const scale = 640 / Math.max(sw, sh);
        canvas.width = Math.round(sw * scale);
        canvas.height = Math.round(sh * scale);
        ctx.drawImage(v, a.x * vw, a.y * vh, sw, sh, 0, 0, canvas.width, canvas.height);
        const found = det.detect(canvas).detections;
        if (!found.length) continue;
        const best = found.reduce((p, d) => ((d.boundingBox?.width ?? 0) > (p.boundingBox?.width ?? 0) ? d : p));
        // box is in canvas pixels; keypoints are fractions of the canvas
        const bb = best.boundingBox;
        const pt = pointFrom({ keypoints: best.keypoints, boundingBox: bb ? { originX: bb.originX / scale, originY: bb.originY / scale, width: bb.width / scale, height: bb.height / scale } : undefined }, a.x * vw, a.y * vh, sw, sh, vw, vh);
        if (pt) return pt;
    }
    return null;
}
