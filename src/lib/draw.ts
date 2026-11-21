// Draws one frame of a clip (layout, zoom, captions, emoji, title, logo, progress bar) on a
// canvas. Used by the live preview, the reel preview and the thumbnail maker; the exported
// video is built to match it.
import { captionSize, captionY, displayText, emojiEvents, groupTimes, type DWord } from './captions';
import { aspectRatio, cropPath, cropWindow, posAt } from './geometry';
import { getTemplate, TITLE_FONT } from './templates';
import { outputDuration, styleAt, toOutputClamped } from './timeline';
import { allShakes, allZooms, PIP_DEFAULT } from './fx';
import type { Brand, Clip, Sticker, StyleSettings, Watermark } from './types';

export type Scene = {
    clip: Clip;
    style: StyleSettings;
    brand: Brand;
    groups: DWord[][];
    logo: HTMLImageElement | null;
    /** set while the preview holds the last frame for the freeze ending (0..1 progress) */
    freezing?: number | null;
    /** set while the preview plays the instant replay */
    replaying?: boolean;
};

/** A text sticker (also used to make the overlay image for export). */
export function drawSticker(ctx: CanvasRenderingContext2D, st: Sticker, selected = false) {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const size = st.size * W;
    ctx.save();
    ctx.font = `${size}px ${TITLE_FONT.css}, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const lines = st.text.split('\n');
    const widths = lines.map((l) => ctx.measureText(l).width);
    const bw = Math.max(...widths) + size * 0.6;
    const bh = lines.length * size * 1.15 + size * 0.3;
    const cx = st.x * W;
    const cy = st.y * H;
    if (st.box) {
        ctx.fillStyle = '#ffffff';
        roundRect(ctx, cx - bw / 2, cy - bh / 2, bw, bh, size * 0.2);
        ctx.fill();
    }
    lines.forEach((l, i) => {
        const y = cy + (i - (lines.length - 1) / 2) * size * 1.15;
        if (!st.box) {
            ctx.strokeStyle = '#000';
            ctx.lineWidth = size * 0.22;
            ctx.strokeText(l, cx, y);
        }
        ctx.fillStyle = st.box ? '#000000' : st.color;
        ctx.fillText(l, cx, y);
    });
    if (selected) {
        ctx.strokeStyle = '#c8ff3d';
        ctx.lineWidth = Math.max(2, W * 0.004);
        ctx.setLineDash([8, 6]);
        ctx.strokeRect(cx - bw / 2 - 4, cy - bh / 2 - 4, bw + 8, bh + 8);
    }
    ctx.restore();
}

/** Sticker bounds in canvas pixels (for clicking and dragging in the preview). */
export function stickerBox(ctx: CanvasRenderingContext2D, st: Sticker) {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const size = st.size * W;
    ctx.save();
    ctx.font = `${size}px ${TITLE_FONT.css}, sans-serif`;
    const lines = st.text.split('\n');
    const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + size * 0.6;
    ctx.restore();
    const bh = lines.length * size * 1.15 + size * 0.3;
    return { x: st.x * W - bw / 2, y: st.y * H - bh / 2, w: bw, h: bh };
}

/** "REPLAY" badge shown during the instant replay. */
export function drawReplayBadge(ctx: CanvasRenderingContext2D) {
    const W = ctx.canvas.width;
    const size = W * 0.05;
    ctx.save();
    ctx.font = `${size}px ${TITLE_FONT.css}, sans-serif`;
    ctx.textBaseline = 'middle';
    const label = '⏪ REPLAY';
    const w = ctx.measureText(label).width + size * 0.8;
    ctx.fillStyle = '#ff2d55';
    roundRect(ctx, W * 0.05, W * 0.05, w, size * 1.5, size * 0.3);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(label, W * 0.05 + size * 0.4, W * 0.05 + size * 0.75);
    ctx.restore();
}

/** Screen-shake offset (pixels) and flash strength (0..1) at source time t. */
export function shakeAt(clip: Clip, t: number, W: number): { dx: number; dy: number; flash: number } {
    let dx = 0;
    let dy = 0;
    let flash = 0;
    for (const s of allShakes(clip)) {
        const age = t - s.t;
        if (age < 0 || age > 0.45) continue;
        if (s.kind !== 'flash') {
            const amp = W * 0.025 * (1 - age / 0.45);
            dx += amp * Math.sin(age * 90);
            dy += amp * Math.cos(age * 77);
        }
        if (s.kind !== 'shake' && age < 0.12) flash = Math.max(flash, 0.6 * (1 - age / 0.12));
    }
    return { dx, dy, flash };
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

export function zoomAt(clip: Clip, t: number): number {
    const z = allZooms(clip).find((s) => t >= s.start && t < s.end);
    return z ? z.scale : 1;
}

/** Draws a source rectangle into a destination rectangle, cropping to fill (cover), with zoom. */
function drawRegion(ctx: CanvasRenderingContext2D, v: HTMLVideoElement, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number, zoom: number) {
    // cover: trim the source so its shape matches the destination
    const dar = dw / dh;
    if (sw / sh > dar) {
        const nw = sh * dar;
        sx += (sw - nw) / 2;
        sw = nw;
    } else {
        const nh = sw / dar;
        sy += (sh - nh) / 2;
        sh = nh;
    }
    if (zoom !== 1) {
        const zw = sw / zoom;
        const zh = sh / zoom;
        sx += (sw - zw) / 2;
        sy += (sh - zh) / 2;
        sw = zw;
        sh = zh;
    }
    ctx.drawImage(v, sx, sy, sw, sh, dx, dy, dw, dh);
}

export function drawVideoLayer(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, t: number, clip: Clip, baseStyle: StyleSettings) {
    const style = styleAt(clip, baseStyle, t); // a part of the clip can have its own framing
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || video.readyState < 2) return;
    const zoom = zoomAt(clip, t);

    if (style.layout === 'fit') {
        const cover = Math.max(W / vw, H / vh);
        ctx.save();
        ctx.filter = 'blur(24px) brightness(0.8)';
        ctx.drawImage(video, (W - vw * cover) / 2, (H - vh * cover) / 2, vw * cover, vh * cover);
        ctx.restore();
        const fit = Math.min(W / vw, H / vh) * zoom;
        ctx.drawImage(video, (W - vw * fit) / 2, (H - vh * fit) / 2, vw * fit, vh * fit);
        return;
    }

    if (style.layout === 'split') {
        const fc = style.facecam ?? { x: 0, y: 0, w: 0.3, h: 0.3 };
        const TH = Math.round(H * (style.splitRatio ?? 0.4));
        drawRegion(ctx, video, fc.x * vw, fc.y * vh, fc.w * vw, fc.h * vh, 0, 0, W, TH, zoom);
        const ar = W / (H - TH);
        const cw = Math.min(vw, vh * ar);
        const ch = Math.min(vh, vw / ar);
        drawRegion(ctx, video, (vw - cw) * style.cropX, (vh - ch) / 2, cw, ch, 0, TH, W, H - TH, zoom);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, TH - 2, W, 4);
        return;
    }

    const { cw, ch, y } = cropWindow(vw, vh, style.aspect);
    const x = (vw - cw) * posAt(cropPath(clip, style, vw, vh), t);
    drawRegion(ctx, video, x, y, cw, ch, 0, 0, W, H, zoom);

    if (style.layout === 'pip') {
        // facecam bubble in a corner over the full gameplay
        const fc = style.facecam ?? { x: 0, y: 0, w: 0.3, h: 0.3 };
        const b = pipBox(style, W, H);
        const fw = fc.w * vw;
        const fh = fc.h * vh;
        const side = Math.min(fw, fh);
        ctx.save();
        pipPath(ctx, b);
        ctx.clip();
        ctx.drawImage(video, fc.x * vw + (fw - side) / 2, fc.y * vh + (fh - side) / 2, side, side, b.x, b.y, b.s, b.s);
        ctx.restore();
        ctx.save();
        ctx.lineWidth = b.border;
        ctx.strokeStyle = '#fff';
        pipPath(ctx, { ...b, x: b.x + b.border / 2, y: b.y + b.border / 2, s: b.s - b.border });
        ctx.stroke();
        ctx.restore();
    }
}

/** Where the picture-in-picture facecam sits (same maths as the export). */
export function pipBox(style: StyleSettings, W: number, H: number) {
    const pp = style.pip ?? PIP_DEFAULT;
    const s = 2 * Math.round((W * pp.size) / 2);
    const m = 2 * Math.round((W * 0.04) / 2);
    return {
        x: pp.corner.endsWith('l') ? m : W - s - m,
        // top corners sit below the hook title, bottom corners above the progress bar
        y: pp.corner.startsWith('t') ? 2 * Math.round((H * 0.14) / 2) : H - s - 2 * Math.round(Math.max(m, H * 0.05) / 2),
        s,
        border: Math.max(3, Math.round(s * 0.025)),
        shape: pp.shape
    };
}

export function pipPath(ctx: CanvasRenderingContext2D, b: { x: number; y: number; s: number; shape: 'circle' | 'rounded' }) {
    if (b.shape === 'circle') {
        ctx.beginPath();
        ctx.arc(b.x + b.s / 2, b.y + b.s / 2, b.s / 2, 0, Math.PI * 2);
    } else roundRect(ctx, b.x, b.y, b.s, b.s, b.s * 0.14);
}

export function drawScene(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, t: number, s: Scene) {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const shake = s.replaying || s.freezing != null ? { dx: 0, dy: 0, flash: 0 } : shakeAt(s.clip, t, W);
    if (s.replaying) {
        // replay: slowed down (by the player) and zoomed in
        ctx.save();
        ctx.translate(W / 2, H / 2);
        ctx.scale(1.18, 1.18);
        ctx.translate(-W / 2, -H / 2);
        drawVideoLayer(ctx, video, t, { ...s.clip, zooms: [] }, s.style);
        ctx.restore();
    } else if (shake.dx || shake.dy) {
        ctx.save();
        ctx.translate(W / 2 + shake.dx, H / 2 + shake.dy);
        ctx.scale(1.1, 1.1);
        ctx.translate(-W / 2, -H / 2);
        drawVideoLayer(ctx, video, t, s.clip, s.style);
        ctx.restore();
    } else drawVideoLayer(ctx, video, t, s.clip, s.style);
    if (shake.flash) {
        ctx.fillStyle = `rgba(255,255,255,${shake.flash})`;
        ctx.fillRect(0, 0, W, H);
    }
    const outT = s.freezing != null ? outputDuration(s.clip) : toOutputClamped(s.clip, t);

    if (s.freezing == null && !s.replaying) {
        drawCaptions(ctx, t, s);
        for (const st of s.clip.stickers ?? []) if (t >= st.start && t < st.end) drawSticker(ctx, st);
    }
    if (s.replaying) drawReplayBadge(ctx);
    if (!s.replaying) drawHookTitle(ctx, outT, s);

    if (s.logo && s.logo.complete && s.logo.naturalWidth) {
        const lw = W * s.brand.logoSize;
        const lh = (lw * s.logo.naturalHeight) / s.logo.naturalWidth;
        const m = W * 0.04;
        const lx = s.brand.logoCorner.endsWith('l') ? m : W - lw - m;
        const ly = s.brand.logoCorner.startsWith('t') ? m : H - lh - m;
        ctx.drawImage(s.logo, lx, ly, lw, lh);
    }

    if (s.brand.watermark?.text.trim()) drawWatermark(ctx, s.brand.watermark, outT + (s.freezing ?? 0) * (s.clip.freeze?.seconds ?? 0));

    if (s.freezing != null && s.clip.freeze?.text.trim()) drawFreezeText(ctx, s.clip.freeze.text, s.style);

    if (s.style.progressBar) {
        const total = outputDuration(s.clip) + (s.clip.freeze?.seconds ?? 0);
        const p = total > 0 ? Math.min(1, (outT + (s.freezing ?? 0) * (s.clip.freeze?.seconds ?? 0)) / total) : 0;
        const bh = Math.max(4, Math.round(H * 0.008));
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.fillRect(0, H - bh, W, bh);
        ctx.fillStyle = s.style.highlight;
        ctx.fillRect(0, H - bh, W * p, bh);
    }
}

export function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
        const test = cur ? `${cur} ${w}` : w;
        if (cur && ctx.measureText(test).width > maxW) {
            lines.push(cur);
            cur = w;
        } else cur = test;
    }
    if (cur) lines.push(cur);
    return lines;
}

export function drawFreezeText(ctx: CanvasRenderingContext2D, text: string, style: StyleSettings) {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const size = W * (style.aspect === '16:9' ? 0.046 : 0.072);
    ctx.save();
    ctx.font = `${size}px ${TITLE_FONT.css}, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const lines = wrap(ctx, text.trim(), W * 0.8);
    lines.forEach((l, i) => {
        const y = H / 2 + (i - (lines.length - 1) / 2) * size * 1.2;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = size * 0.28;
        ctx.strokeText(l, W / 2, y);
        ctx.fillStyle = '#fff';
        ctx.fillText(l, W / 2, y);
    });
    ctx.restore();
}

function drawHookTitle(ctx: CanvasRenderingContext2D, outT: number, s: Scene) {
    const h = s.clip.hookTitle;
    if (!h || !h.text.trim() || h.seconds <= 0 || outT > h.seconds) return;
    drawHookTitleText(ctx, h.text, s.style);
}

export function drawHookTitleText(ctx: CanvasRenderingContext2D, text: string, style: StyleSettings) {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const size = W * (style.aspect === '16:9' ? 0.04 : 0.062);
    ctx.save();
    ctx.font = `${size}px ${TITLE_FONT.css}, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = wrap(ctx, text.trim(), W * 0.78);
    const pad = size * 0.35;
    let y = H * 0.07 + pad;
    for (const l of lines) {
        const w = ctx.measureText(l).width;
        ctx.fillStyle = '#fff';
        roundRect(ctx, W / 2 - w / 2 - pad, y - pad * 0.4, w + pad * 2, size + pad * 0.8, size * 0.15);
        ctx.fill();
        ctx.fillStyle = '#000';
        ctx.fillText(l, W / 2, y + size / 2);
        y += size + pad * 0.8;
    }
    ctx.restore();
}

function drawTranslation(ctx: CanvasRenderingContext2D, t: number, s: Scene, below: boolean) {
    const line = s.clip.translation?.lines.find((l) => t >= l.start && t < l.end);
    if (!line) return;
    const tpl = getTemplate(s.style.template);
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const size = captionSize(tpl, s.style, W) * (below ? 0.62 : 1);
    ctx.save();
    ctx.font = `${size}px ${tpl.cssFont}, 'Arial Black', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const text = tpl.uppercase ? line.text.toUpperCase() : line.text;
    const lines = wrap(ctx, text, W * 0.84);
    const y0 = captionY(s.style) * H + (below ? captionSize(tpl, s.style, W) * 1.25 : 0);
    lines.forEach((l, i) => {
        const y = y0 + (i - (below ? 0 : (lines.length - 1) / 2)) * size * 1.2;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = Math.max(4, size * 0.22);
        ctx.strokeText(l, W / 2, y);
        ctx.fillStyle = below ? s.style.highlight : tpl.color;
        ctx.fillText(l, W / 2, y);
    });
    ctx.restore();
}

function drawCaptions(ctx: CanvasRenderingContext2D, t: number, s: Scene) {
    const tpl = getTemplate(s.style.template);
    if (tpl.id === 'none') return;
    const lang = s.clip.translation ? s.style.captionLang ?? 'original' : 'original';
    if (lang === 'translated') return drawTranslation(ctx, t, s, false);
    if (lang === 'both') drawTranslation(ctx, t, s, true);
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const times = groupTimes(s.groups);
    const gi = times.findIndex((g) => t >= g.start && t < g.end);
    const size = captionSize(tpl, s.style, W);
    const cy = captionY(s.style) * H;

    if (gi >= 0) {
        const group = s.groups[gi];
        ctx.font = `${size}px ${tpl.cssFont}, 'Arial Black', sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.lineJoin = 'round';
        const space = size * 0.28;
        const maxW = W * 0.84;
        const activeIdx = group.findIndex((w, i) => t >= w.start && (i + 1 >= group.length || t < group[i + 1].start));
        const items = group.map((w) => {
            const text = displayText(tpl, w);
            return { w, text, width: ctx.measureText(text).width };
        });
        const lines: { items: typeof items; width: number }[] = [];
        let line: typeof items = [];
        let lw = 0;
        for (const it of items) {
            if (line.length && lw + space + it.width > maxW) {
                lines.push({ items: line, width: lw });
                line = [];
                lw = 0;
            }
            lw += (line.length ? space : 0) + it.width;
            line.push(it);
        }
        if (line.length) lines.push({ items: line, width: lw });

        const lh = size * 1.2;
        let y = cy - ((lines.length - 1) * lh) / 2;
        // settle: the whole caption appears a little bigger and shrinks to normal (eases out)
        const age = t - times[gi].start;
        const settle = tpl.settle && age < 0.15 ? 1 + (tpl.settle - 1) * (1 - age / 0.15) * (1 - age / 0.15) : 1;
        ctx.save();
        if (settle !== 1) {
            ctx.translate(W / 2, cy);
            ctx.scale(settle, settle);
            ctx.translate(-W / 2, -cy);
        }
        for (const ln of lines) {
            let x = (W - ln.width) / 2;
            if (tpl.lineBox) {
                ctx.fillStyle = 'rgba(0,0,0,0.67)';
                roundRect(ctx, x - size * 0.3, y - size * 0.62, ln.width + size * 0.6, size * 1.24, size * 0.18);
                ctx.fill();
            }
            for (const it of ln.items) {
                const i = group.indexOf(it.w);
                const active = i === activeIdx && tpl.active !== 'none';
                const spoken = tpl.fillSpoken && activeIdx >= 0 && i <= activeIdx;
                const hidden = tpl.reveal && activeIdx >= 0 && i > activeIdx;
                if (hidden) {
                    x += it.width + space;
                    continue;
                }
                const big = tpl.activeScale ?? 1.15;
                let scale = 1;
                if (active && tpl.pop) scale = 1 + (big - 1) * Math.max(0, 1 - (t - it.w.start) / 0.11);
                else if (active && tpl.activeScale) scale = big;
                else if (it.w.kw && !active) scale = 1.08;
                ctx.save();
                ctx.translate(x + it.width / 2, y);
                ctx.scale(scale, scale);
                ctx.translate(-(x + it.width / 2), -y);
                const boxed = active && tpl.active === 'box';
                if (boxed) {
                    ctx.fillStyle = s.style.highlight;
                    roundRect(ctx, x - size * 0.18, y - size * 0.6, it.width + size * 0.36, size * 1.2, size * 0.2);
                    ctx.fill();
                }
                if (tpl.glow) {
                    ctx.shadowColor = tpl.glow;
                    ctx.shadowBlur = size * 0.45;
                } else if (tpl.shadow) {
                    ctx.shadowColor = 'rgba(0,0,0,0.6)';
                    ctx.shadowOffsetY = size * 0.05;
                    ctx.shadowBlur = size * 0.08;
                }
                if (tpl.outline > 0 && !boxed) {
                    ctx.strokeStyle = tpl.outlineColor ?? '#000';
                    ctx.lineWidth = tpl.outline * size * 2;
                    ctx.strokeText(it.text, x, y);
                    if (!tpl.glow) ctx.shadowColor = 'transparent';
                }
                const highlighted = (active && (tpl.active === 'color' || tpl.active === 'underline')) || spoken || (it.w.kw && !boxed);
                ctx.fillStyle = boxed && tpl.boxText ? tpl.boxText : highlighted ? s.style.highlight : it.w.color;
                ctx.fillText(it.text, x, y);
                if (active && tpl.active === 'underline') {
                    ctx.shadowColor = 'transparent';
                    ctx.fillRect(x, y + size * 0.45, it.width, Math.max(3, size * 0.08));
                }
                ctx.restore();
                x += it.width + space;
            }
            y += lh;
        }
        ctx.restore();
    }

    if (s.style.emojis) {
        const ev = emojiEvents(s.clip, s.groups).find((e) => t >= e.start && t < e.end);
        if (ev) {
            const es = size * 1.6;
            const age = t - ev.start;
            const pop = s.style.emojiAnim ? (age < 0.12 ? 0.5 + (age / 0.12) * 0.7 : age < 0.24 ? 1.2 - ((age - 0.12) / 0.12) * 0.2 : 1) : 1;
            const bob = s.style.emojiAnim ? Math.sin(age * Math.PI * 3) * es * 0.06 : 0;
            ctx.save();
            ctx.font = `${es * pop}px 'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(ev.emoji, W / 2, cy - size * 0.6 - es * 0.6 + bob);
            ctx.restore();
        }
    }
}

/** Renders a full-size transparent PNG with some text drawn on it (title / freeze), for ffmpeg to overlay. */
export async function textOverlayPng(W: number, H: number, draw: (ctx: CanvasRenderingContext2D) => void): Promise<Uint8Array> {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    draw(c.getContext('2d')!);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
}

/** Renders an emoji to a PNG so ffmpeg can overlay it (libass can't draw colour emoji). */
export async function emojiPng(emoji: string, px: number): Promise<Uint8Array> {
    const c = document.createElement('canvas');
    c.width = c.height = px;
    const ctx = c.getContext('2d')!;
    ctx.font = `${px * 0.85}px 'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji, px / 2, px / 2 + px * 0.05);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
}

export { aspectRatio };

// ---------- name watermark ----------
/** The moving watermark visits the corners in this order (diagonal jumps are hardest to crop out). */
export const WATERMARK_CYCLE: Watermark['corner'][] = ['tl', 'br', 'tr', 'bl'];
export const WATERMARK_SECONDS = 6;

function watermarkFont(wm: Watermark, W: number) {
    return `800 ${Math.max(10, Math.round(W * wm.size))}px CapMontserrat, 'Montserrat ExtraBold', sans-serif`;
}

/** Draws the watermark text with its own transparency at (x, y) top-left. */
function paintWatermark(ctx: CanvasRenderingContext2D, wm: Watermark, W: number, x: number, y: number) {
    const fs = Math.max(10, Math.round(W * wm.size));
    ctx.save();
    ctx.globalAlpha = wm.opacity;
    ctx.font = watermarkFont(wm, W);
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, fs * 0.16);
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(wm.text.trim(), x, y);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(wm.text.trim(), x, y);
    ctx.restore();
}

/** Size of the watermark image (text plus room for its outline). */
const boxCache = new Map<string, { w: number; h: number; pad: number }>();
export function watermarkBox(wm: Watermark, W: number): { w: number; h: number; pad: number } {
    const key = `${wm.text}|${wm.size}|${W}|${document.fonts?.status}`;
    const hit = boxCache.get(key);
    if (hit) return hit;
    const c = document.createElement('canvas').getContext('2d')!;
    c.font = watermarkFont(wm, W);
    const fs = Math.max(10, Math.round(W * wm.size));
    const pad = Math.ceil(fs * 0.2);
    const box = { w: Math.ceil(c.measureText(wm.text.trim()).width) + pad * 2, h: Math.ceil(fs * 1.25) + pad * 2, pad };
    if (boxCache.size > 50) boxCache.clear();
    boxCache.set(key, box);
    return box;
}

/** Corner margins: top corners hug the edge, bottom corners stay above the progress bar. */
export function watermarkMargins(W: number, H: number) {
    return { m: Math.round(W * 0.035), mb: Math.round(Math.max(W * 0.035, H * 0.03)) };
}

export function watermarkCorner(wm: Watermark, outT: number): Watermark['corner'] {
    return wm.moving ? WATERMARK_CYCLE[Math.floor(Math.max(0, outT) / WATERMARK_SECONDS) % 4] : wm.corner;
}

export function drawWatermark(ctx: CanvasRenderingContext2D, wm: Watermark, outT: number) {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const b = watermarkBox(wm, W);
    const { m, mb } = watermarkMargins(W, H);
    const corner = watermarkCorner(wm, outT);
    const x = corner.endsWith('l') ? m : W - b.w - m;
    const y = corner.startsWith('t') ? m : H - b.h - mb;
    paintWatermark(ctx, wm, W, x + b.pad, y + b.pad);
}

/** The watermark as a small transparent PNG for ffmpeg. */
export async function watermarkPng(wm: Watermark, W: number): Promise<Uint8Array> {
    const b = watermarkBox(wm, W);
    const c = document.createElement('canvas');
    c.width = b.w;
    c.height = b.h;
    paintWatermark(c.getContext('2d')!, wm, W, b.pad, b.pad);
    const blob: Blob = await new Promise((r) => c.toBlob((x) => r(x!), 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
}

/** Black/white shape of the facecam bubble and its white rim, as PNGs for the export. */
export async function pipMaskPngs(style: StyleSettings, W: number, H: number): Promise<{ mask: Uint8Array; rim: Uint8Array }> {
    const b = pipBox(style, W, H);
    const png = async (paint: (ctx: CanvasRenderingContext2D) => void) => {
        const c = document.createElement('canvas');
        c.width = c.height = b.s;
        paint(c.getContext('2d')!);
        const blob: Blob = await new Promise((r) => c.toBlob((x) => r(x!), 'image/png'));
        return new Uint8Array(await blob.arrayBuffer());
    };
    const mask = await png((ctx) => {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, b.s, b.s);
        ctx.fillStyle = '#fff';
        pipPath(ctx, { x: 0, y: 0, s: b.s, shape: b.shape });
        ctx.fill();
    });
    const rim = await png((ctx) => {
        ctx.lineWidth = b.border;
        ctx.strokeStyle = '#fff';
        pipPath(ctx, { x: b.border / 2, y: b.border / 2, s: b.s - b.border, shape: b.shape });
        ctx.stroke();
    });
    return { mask, rim };
}
