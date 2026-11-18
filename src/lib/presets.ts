// Saved looks: a caption/layout style plus which effects are switched on.
// Used by "Apply to every clip" in the editor and by templates picked when a video is added.
import { autoReplay, autoShakes, autoSfx } from './fx';
import { removeRanges, segmentsOf, silenceCuts, withSegs } from './timeline';
import type { AudioEvent, Clip, StyleSettings, Word } from './types';

export type PresetFx = {
    hookTitle: boolean;
    freeze: string | null;
    sfx: boolean;
    shakes: boolean;
    replay: boolean;
    zoomLaughs: boolean;
    silences: boolean;
    transition?: Clip['transition'];
};
export type Preset = { name: string; style: Partial<StyleSettings>; fx: PresetFx; builtIn?: boolean };

const PRESET_KEY = 'clipsmith.presets';
export function loadPresets(): Preset[] {
    try {
        return JSON.parse(localStorage.getItem(PRESET_KEY) ?? '[]');
    } catch {
        return [];
    }
}
export function savePresets(p: Preset[]) {
    try {
        localStorage.setItem(PRESET_KEY, JSON.stringify(p));
    } catch {}
}

/** Ready-made looks offered when adding a video (they keep the caption style chosen there). */
export const BUILT_IN_TEMPLATES: Preset[] = [
    {
        name: '🎮 Streamer chaos',
        builtIn: true,
        style: { layout: 'split', emojis: true, emojiAnim: true, keywordHighlight: true, progressBar: true },
        fx: { hookTitle: true, freeze: null, sfx: true, shakes: true, replay: false, zoomLaughs: true, silences: true, transition: { kind: 'zoom', sound: 'whoosh' } }
    },
    {
        name: '🔥 Hype moment + replay',
        builtIn: true,
        style: { layout: 'pip', emojis: true, keywordHighlight: true },
        fx: { hookTitle: true, freeze: null, sfx: true, shakes: true, replay: true, zoomLaughs: true, silences: false, transition: { kind: 'flash', sound: null } }
    },
    {
        name: '😂 Clean & funny',
        builtIn: true,
        style: { emojis: true, keywordHighlight: true },
        fx: { hookTitle: true, freeze: null, sfx: false, shakes: false, replay: false, zoomLaughs: true, silences: true, transition: { kind: 'none', sound: null } }
    }
];

/** Effects of a clip, as switches that can be applied to other clips. */
export function currentFx(clip: Clip): PresetFx {
    return {
        hookTitle: !!clip.hookTitle && clip.hookTitle.seconds > 0,
        freeze: clip.freeze && clip.freeze.seconds > 0 ? clip.freeze.text : null,
        sfx: (clip.sfx?.length ?? 0) > 0,
        shakes: (clip.shakes?.length ?? 0) > 0,
        replay: !!clip.replay,
        zoomLaughs: (clip.zooms?.length ?? 0) > 0,
        silences: segmentsOf(clip).length > 1,
        transition: clip.transition
    };
}

/** Switch effects on a clip, each placed automatically for that clip. */
export function applyFx(c: Clip, fx: PresetFx, events: AudioEvent[], words: Word[]): Clip {
    let n: Clip = { ...c };
    n.hookTitle = fx.hookTitle ? { text: c.hookTitle?.text || shortTitle(c.title), seconds: c.hookTitle?.seconds || 3 } : c.hookTitle ? { ...c.hookTitle, seconds: 0 } : undefined;
    n.freeze = fx.freeze !== null ? { seconds: c.freeze?.seconds || 1.5, text: c.freeze?.text || fx.freeze } : undefined;
    if (fx.zoomLaughs && !c.zooms?.length) {
        const laughs = events.filter((e) => (e.type === 'reaction' || e.type === 'chat' || e.type === 'loud') && e.start > c.start + 1 && e.start < c.end);
        n.zooms = laughs.slice(0, 4).map((e) => ({ start: Math.max(c.start, e.start - 1.2), end: Math.min(c.end, e.start + 0.8), scale: 1.3 }));
    }
    if (fx.silences && segmentsOf(c).length <= 1) n = { ...n, ...withSegs(c, removeRanges(segmentsOf(c), silenceCuts(c, words))) };
    n.sfx = fx.sfx ? (c.sfx?.length ? c.sfx : autoSfx(n, events)) : [];
    n.shakes = fx.shakes ? (c.shakes?.length ? c.shakes : autoShakes(n, events)) : [];
    n.replay = fx.replay ? c.replay ?? autoReplay(n, events) : undefined;
    if (fx.transition) n.transition = fx.transition;
    return n;
}

/** A hook title short enough to read in a second: the first words of the clip title. */
function shortTitle(title: string): string {
    const t = title.replace(/^[“"]|[”"…]$/g, '').trim();
    if (t.length <= 42) return t;
    const cut = t.slice(0, 42);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 20)).replace(/[,.;:]$/, '')}…`;
}
