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

function seek(v: HTMLVideoElement, t: number): Promise<void> {
    return new Promise((resolve) => {
        const done = () => {
            v.removeEventListener('seeked', done);
            resolve();
        };
        v.addEventListener('seeked', done);
        v.currentTime = t;
    });
}

export type TrackResult = { track?: { t: number; x: number }[]; thumb: string };

/**
 * Samples the clip every `step` seconds, detects the largest face, and returns crop
 * keyframes (absolute time -> face centre as a fraction of the video width). Also captures a thumbnail.
 */
export async function analyseClip(videoUrl: string, start: number, end: number, aspect: Aspect, step = 0.5): Promise<TrackResult> {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = videoUrl;
    await new Promise<void>((res, rej) => {
        v.onloadeddata = () => res();
        v.onerror = () => rej(new Error('Could not read the video for reframing.'));
    });
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    const scale = Math.min(1, 640 / vw);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

    // thumbnail
    await seek(v, Math.min(end - 0.1, start + 1));
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = 320;
    thumbCanvas.height = Math.round((320 * vh) / vw);
    thumbCanvas.getContext('2d')!.drawImage(v, 0, 0, thumbCanvas.width, thumbCanvas.height);
    const thumb = thumbCanvas.toDataURL('image/jpeg', 0.7);

    const { cw } = cropWindow(vw, vh, aspect);
    if (vw - cw < 4) return { thumb }; // source already fits: nothing to track

    let detector: FaceDetector;
    try {
        detector = await getDetector();
    } catch {
        return { thumb };
    }

    const centers: (number | null)[] = [];
    const times: number[] = [];
    for (let t = start; t < end; t += step) {
        await seek(v, t);
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
    v.removeAttribute('src');
    v.load();

    if (centers.every((c) => c === null)) return { thumb };

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
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = videoUrl;
    await new Promise<void>((res, rej) => {
        v.onloadeddata = () => res();
        v.onerror = () => rej(new Error('Could not read the video.'));
    });
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
    for (let i = 0; i < samples; i++) {
        await seek(v, (duration * (i + 0.5)) / samples);
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
