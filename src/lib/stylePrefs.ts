// Your last caption and layout choices, used for the next video you start, so things like
// "emojis off" or your facecam box only have to be set once.
import type { StyleSettings } from './types';

const KEY = 'clipsmith.lastStyle';
// what carries over to new projects (not things that only make sense for one video)
const KEEP = ['template', 'highlight', 'position', 'wordsPerLine', 'emojis', 'emojiAnim', 'keywordHighlight', 'layout', 'facecam', 'splitRatio', 'cropX', 'pip', 'progressBar', 'censor', 'speakerColors', 'sfxVolume'] as const;

export type StylePrefs = Partial<Pick<StyleSettings, (typeof KEEP)[number]>>;

export function loadStylePrefs(): StylePrefs {
    try {
        const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
        const out: Record<string, unknown> = {};
        for (const k of KEEP) if (raw[k] !== undefined) out[k] = raw[k];
        return out as StylePrefs;
    } catch {
        return {};
    }
}

export function saveStylePrefs(style: StyleSettings) {
    try {
        const out: Record<string, unknown> = {};
        for (const k of KEEP) if (style[k] !== undefined) out[k] = style[k];
        localStorage.setItem(KEY, JSON.stringify(out));
    } catch {
        /* storage full or blocked: not important */
    }
}
