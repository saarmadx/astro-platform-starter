// Draws one frame of a clip (framing, captions, emoji, logo) onto a canvas.
// Used by the live preview; the exported video is built to match it.
import { captionY, displayText, emojiEvents, groupTimes, isKeyword } from './captions';
import { cropPath, cropWindow, posAt } from './geometry';
import { getTemplate } from './templates';
import type { Brand, Clip, StyleSettings, Word } from './types';

export type Scene = {
    clip: Clip;
    style: StyleSettings;
    brand: Brand;
    groups: Word[][];
    logo: HTMLImageElement | null;
};

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

export function drawScene(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, t: number, s: Scene) {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw && video.readyState >= 2) {
        if (s.style.layout === 'fit') {
            // blurred fill behind the whole frame
            const cover = Math.max(W / vw, H / vh);
            ctx.save();
            ctx.filter = 'blur(24px) brightness(0.8)';
            ctx.drawImage(video, (W - vw * cover) / 2, (H - vh * cover) / 2, vw * cover, vh * cover);
            ctx.restore();
            const fit = Math.min(W / vw, H / vh);
            ctx.drawImage(video, (W - vw * fit) / 2, (H - vh * fit) / 2, vw * fit, vh * fit);
        } else {
            const { cw, ch, y } = cropWindow(vw, vh, s.style.aspect);
            const x = (vw - cw) * posAt(cropPath(s.clip, s.style, vw, vh), t);
            ctx.drawImage(video, x, y, cw, ch, 0, 0, W, H);
        }
    }

    drawCaptions(ctx, t, s);

    if (s.logo && s.logo.complete && s.logo.naturalWidth) {
        const lw = W * s.brand.logoSize;
        const lh = (lw * s.logo.naturalHeight) / s.logo.naturalWidth;
        const m = W * 0.04;
        const lx = s.brand.logoCorner.endsWith('l') ? m : W - lw - m;
        const ly = s.brand.logoCorner.startsWith('t') ? m : H - lh - m;
        ctx.drawImage(s.logo, lx, ly, lw, lh);
    }
}

function drawCaptions(ctx: CanvasRenderingContext2D, t: number, s: Scene) {
    const tpl = getTemplate(s.style.template);
    if (tpl.id === 'none') return;
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const times = groupTimes(s.groups);
    const gi = times.findIndex((g) => t >= g.start && t < g.end);
    if (gi < 0) return;
    const group = s.groups[gi];
    const size = tpl.size * W * (s.style.aspect === '16:9' ? 0.6 : 1);
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
    const cy = captionY(s.style.position) * H;
    let y = cy - ((lines.length - 1) * lh) / 2;
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
            const spoken = tpl.id === 'karaoke' && activeIdx >= 0 && i <= activeIdx;
            const kw = s.style.keywordHighlight && isKeyword(s.clip, it.w);
            let scale = 1;
            if (active && tpl.pop) scale = 1 + 0.15 * Math.max(0, 1 - (t - it.w.start) / 0.1);
            else if (kw && !active) scale = 1.08;
            ctx.save();
            ctx.translate(x + it.width / 2, y);
            ctx.scale(scale, scale);
            ctx.translate(-(x + it.width / 2), -y);
            if (active && tpl.active === 'box') {
                ctx.fillStyle = s.style.highlight;
                roundRect(ctx, x - size * 0.18, y - size * 0.6, it.width + size * 0.36, size * 1.2, size * 0.2);
                ctx.fill();
            }
            if (tpl.shadow) {
                ctx.shadowColor = 'rgba(0,0,0,0.6)';
                ctx.shadowOffsetY = size * 0.05;
                ctx.shadowBlur = size * 0.08;
            }
            if (tpl.outline > 0 && !(active && tpl.active === 'box')) {
                ctx.strokeStyle = '#000';
                ctx.lineWidth = tpl.outline * size * 2;
                ctx.strokeText(it.text, x, y);
                ctx.shadowColor = 'transparent';
            }
            ctx.fillStyle = (active && tpl.active === 'color') || spoken || (kw && !(active && tpl.active === 'box')) ? s.style.highlight : tpl.color;
            ctx.fillText(it.text, x, y);
            ctx.restore();
            x += it.width + space;
        }
        y += lh;
    }

    if (s.style.emojis) {
        const ev = emojiEvents(s.clip, s.groups).find((e) => t >= e.start && t < e.end);
        if (ev) {
            const es = size * 1.6;
            ctx.font = `${es}px 'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif`;
            ctx.textAlign = 'center';
            const top = cy - ((lines.length - 1) * lh) / 2 - size * 0.6 - es * 0.6;
            ctx.fillText(ev.emoji, W / 2, top);
        }
    }
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
