import type { Aspect, Clip, StyleSettings } from './types';

export function outputSize(aspect: Aspect, shortSide: number): { W: number; H: number } {
    const even = (n: number) => Math.round(n / 2) * 2;
    if (aspect === '9:16') return { W: shortSide, H: even((shortSide * 16) / 9) };
    if (aspect === '16:9') return { W: even((shortSide * 16) / 9), H: shortSide };
    return { W: shortSide, H: shortSide };
}

export function aspectRatio(aspect: Aspect): number {
    return aspect === '9:16' ? 9 / 16 : aspect === '16:9' ? 16 / 9 : 1;
}

/** Largest window of the output's aspect ratio that fits inside the source video. */
export function cropWindow(vw: number, vh: number, aspect: Aspect) {
    const ar = aspectRatio(aspect);
    const cw = Math.min(vw, vh * ar);
    const ch = Math.min(vh, vw / ar);
    return { cw, ch, y: (vh - ch) / 2 };
}

/** Converts a face centre (fraction of source width) to a crop position (0 = left, 1 = right). */
export function faceToPos(faceX: number, vw: number, vh: number, aspect: Aspect): number {
    const { cw } = cropWindow(vw, vh, aspect);
    if (vw - cw < 1) return 0.5;
    return Math.min(1, Math.max(0, (faceX * vw - cw / 2) / (vw - cw)));
}

/** Crop keyframes (absolute time -> crop position) for the current layout. */
export function cropPath(clip: Clip, style: StyleSettings, vw: number, vh: number): { t: number; x: number }[] {
    if (style.layout === 'manual' || style.layout === 'pip') return [{ t: clip.start, x: style.cropX }];
    if (style.layout !== 'auto' || !clip.track?.length) return [{ t: clip.start, x: 0.5 }];
    return clip.track.map((p) => ({ t: p.t, x: faceToPos(p.x, vw, vh, style.aspect) }));
}

export function posAt(path: { t: number; x: number }[], t: number): number {
    if (t <= path[0].t) return path[0].x;
    for (let i = 1; i < path.length; i++) {
        if (t < path[i].t) {
            const a = path[i - 1];
            const b = path[i];
            return a.x + ((b.x - a.x) * (t - a.t)) / (b.t - a.t);
        }
    }
    return path[path.length - 1].x;
}
