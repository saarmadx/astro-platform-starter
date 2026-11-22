// Quick checks before exporting: things that hurt a Short on YouTube/TikTok and are easy to miss.
import { captionY, displayWords } from './captions';
import { isSwear } from './censor';
import { pipBox } from './draw';
import { outputDuration, segmentsOf } from './timeline';
import type { Brand, Clip, StyleSettings, Word } from './types';

export type Check = { level: 'warn' | 'tip'; text: string };

export function exportChecks(clip: Clip, style: StyleSettings, words: Word[], brand?: Brand): Check[] {
    const out: Check[] = [];
    const len = outputDuration(clip) + (clip.freeze?.seconds ?? 0);
    if (len > 180) out.push({ level: 'warn', text: `It’s ${Math.round(len)}s long. YouTube only counts videos up to 3 minutes as Shorts. Trim it in the timeline.` });
    if (len < 5) out.push({ level: 'warn', text: `It’s only ${len.toFixed(1)}s long. Very short clips rarely get views.` });
    if (style.aspect !== '9:16') out.push({ level: 'tip', text: `It exports as ${style.aspect}. Shorts, TikTok and Reels look best in 9:16 (Layout tab).` });

    const captionsOn = style.template !== 'none';
    const inClip = displayWords(words, clip, style, undefined, false);
    if (captionsOn && inClip.length === 0) out.push({ level: 'warn', text: 'This clip has no captions (no speech was found in it).' });

    // a facecam bubble sitting on top of the captions
    const pipUsed = style.layout === 'pip' || segmentsOf(clip).some((s) => s.layout === 'pip');
    if (captionsOn && inClip.length && pipUsed) {
        const W = 1080, H = style.aspect === '9:16' ? 1920 : style.aspect === '1:1' ? 1080 : 608;
        const b = pipBox(style, W, H);
        const cy = captionY(style) * H;
        const band = H * 0.07; // about two lines of captions
        if (b.y < cy + band && b.y + b.s > cy - band) out.push({ level: 'warn', text: 'The facecam bubble covers the captions. Move the bubble to another corner or the captions up or down.' });
    }

    const swears = inClip.filter((w) => isSwear(w.text)).length;
    if (swears && (!style.censor || style.censor === 'off'))
        out.push({ level: 'tip', text: `${swears} swear word${swears > 1 ? 's' : ''} in this clip. Choosing “f*** + bleep” under Swear words (Captions tab) keeps it advertiser-friendly.` });

    if (!clip.title?.trim()) out.push({ level: 'tip', text: 'No title yet. Add one in the Post tab.' });
    if (brand && !brand.watermark?.text?.trim()) out.push({ level: 'tip', text: 'No name watermark. Add your name in the Brand kit so people can’t repost your clip as their own.' });
    return out;
}
