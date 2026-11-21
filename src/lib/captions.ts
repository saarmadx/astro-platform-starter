import { censorText } from './censor';
import { getTemplate, TITLE_FONT, DEFAULT_SPEAKER_COLORS, type CaptionTemplate } from './templates';
import { keptSegments, toOutput, toOutputClamped } from './timeline';
import type { Clip, StyleSettings, Word } from './types';

export function wordsInRange(words: Word[], start: number, end: number): Word[] {
    return words.filter((w) => w.end > start && w.start < end);
}

/** Group words into short caption lines, breaking early at punctuation. */
export function groupWords<T extends Word>(words: T[], perLine: number): T[][] {
    const groups: T[][] = [];
    let cur: T[] = [];
    for (const w of words) {
        cur.push(w);
        if (cur.length >= perLine || /[.!?,;:]$/.test(w.text)) {
            groups.push(cur);
            cur = [];
        }
    }
    if (cur.length) groups.push(cur);
    return groups;
}

/** When each caption group is on screen. */
export function groupTimes(groups: Word[][]): { start: number; end: number }[] {
    return groups.map((g, i) => {
        const next = groups[i + 1];
        const end = next ? Math.min(next[0].start, g[g.length - 1].end + 0.6) : g[g.length - 1].end + 0.4;
        return { start: g[0].start, end: Math.max(end, g[0].start + 0.2) };
    });
}

export const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

export function isKeyword(clip: Clip, w: Word) {
    const n = norm(w.text);
    return n.length > 0 && clip.keywords.some((k) => norm(k) === n);
}

export function speakerAt(speakers: { t: number; speaker: number }[] | undefined, t: number): number {
    if (!speakers?.length) return 0;
    let s = 0;
    for (const x of speakers) if (x.t <= t + 0.01) s = x.speaker;
    return s;
}

/** A caption word ready to draw: censored, coloured by speaker, flagged as keyword. */
export type DWord = Word & { kw: boolean; color: string; index: number };

/**
 * Words to caption for a clip. Cut parts are dropped. With output=true, times are moved
 * to where they land in the finished video (after cuts); otherwise they stay in source time.
 */
export function displayWords(words: Word[], clip: Clip, style: StyleSettings, speakers: { t: number; speaker: number }[] | undefined, output: boolean): DWord[] {
    const tpl = getTemplate(style.template);
    const colors = style.speakerColors ?? DEFAULT_SPEAKER_COLORS;
    const segs = keptSegments(clip);
    const out: DWord[] = [];
    for (let index = 0; index < words.length; index++) {
        const w = words[index];
        if (!(w.end > clip.start && w.start < clip.end)) continue;
        const mid = (w.start + w.end) / 2;
        if (toOutput(clip, Math.min(Math.max(mid, clip.start), clip.end), segs) === null) continue;
        const spk = speakerAt(speakers, w.start);
        const color = spk > 0 ? colors[spk] ?? tpl.color : tpl.color;
        const text = style.censor && style.censor !== 'off' ? censorText(w.text) : w.text;
        const start = output ? toOutputClamped(clip, w.start, segs) : w.start;
        const end = output ? toOutputClamped(clip, w.end, segs) : w.end;
        out.push({ text, start, end: Math.max(end, start + 0.05), kw: style.keywordHighlight && isKeyword(clip, w), color, index });
    }
    return out;
}

/** Emojis to show, with the time span of the caption group they belong to. */
export function emojiEvents(clip: Clip, groups: Word[][]): { emoji: string; start: number; end: number }[] {
    const times = groupTimes(groups);
    const out: { emoji: string; start: number; end: number }[] = [];
    const used = new Set<string>();
    groups.forEach((g, gi) => {
        for (const w of g) {
            const hit = clip.emojis.find((e) => norm(e.word) === norm(w.text));
            if (hit && !used.has(hit.word)) {
                used.add(hit.word);
                out.push({ emoji: hit.emoji, start: times[gi].start, end: times[gi].end });
                break;
            }
        }
    });
    return out;
}

export function displayText(t: CaptionTemplate, w: Word) {
    return t.uppercase ? w.text.toUpperCase() : w.text;
}

/** Vertical anchor of the caption block (fraction of output height). */
export function captionY(style: StyleSettings) {
    if (style.layout === 'split' && style.position === 'middle') return style.splitRatio ?? 0.4;
    return style.position === 'top' ? 0.2 : style.position === 'middle' ? 0.5 : 0.74;
}

export function captionSize(tpl: CaptionTemplate, style: StyleSettings, W: number) {
    return tpl.size * W * (style.aspect === '16:9' ? 0.6 : 1);
}

// ---------- .ass subtitle export ----------

function assColor(hex: string, alpha = 0): string {
    const h = hex.replace('#', '');
    const a = alpha.toString(16).padStart(2, '0');
    return `&H${a}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase();
}

function assTime(t: number): string {
    const s = Math.max(0, t);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const cs = Math.floor((s - Math.floor(s)) * 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

const clean = (t: string) => t.replace(/[\\{}]/g, '').replace(/\n/g, ' ');

export function buildAss(words: Word[], clip: Clip, style: StyleSettings, W: number, H: number, speakers?: { t: number; speaker: number }[]): string {
    const t = getTemplate(style.template);
    const size = Math.round(captionSize(t, style, W));
    const outline = Math.round(t.outline * size);
    const y = Math.round(captionY(style) * H);
    const titleSize = Math.round(W * (style.aspect === '16:9' ? 0.04 : 0.062));
    const marginLR = Math.round(W * 0.08);
    const outlineCol = assColor(t.outlineColor ?? '#000000');
    const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${t.font},${size},${assColor(t.color)},${assColor(t.color)},${outlineCol},${t.lineBox ? '&H55000000' : '&H80000000'},0,0,0,0,100,100,0,0,${t.lineBox ? 3 : 1},${t.lineBox ? Math.round(size * 0.25) : outline},${t.shadow ? Math.max(1, Math.round(size * 0.05)) : 0},5,${marginLR},${marginLR},0,1
Style: Title,${TITLE_FONT.font},${titleSize},&H00000000,&H00000000,&H00FFFFFF,&H00000000,0,0,0,0,100,100,0,0,3,${Math.round(titleSize * 0.35)},0,8,${Math.round(W * 0.1)},${Math.round(W * 0.1)},${Math.round(H * 0.07)},1
Style: Freeze,${TITLE_FONT.font},${Math.round(titleSize * 1.15)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,${Math.round(titleSize * 0.14)},2,5,${Math.round(W * 0.1)},${Math.round(W * 0.1)},0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
    const lines: string[] = [];

    // hook title and freeze text are drawn as image overlays (so emoji work), see renderClip

    const lang = clip.translation ? style.captionLang ?? 'original' : 'original';
    if (t.id !== 'none' && lang !== 'original' && clip.translation) {
        const segs = keptSegments(clip);
        const below = lang === 'both';
        const fs = Math.round(size * (below ? 0.62 : 1));
        const ty = below ? y + Math.round(size * 1.25) : y;
        for (const l of clip.translation.lines) {
            const a = toOutputClamped(clip, l.start, segs);
            const b = toOutputClamped(clip, l.end, segs);
            if (b - a < 0.05) continue;
            const text = clean(t.uppercase ? l.text.toUpperCase() : l.text);
            const col = below ? `\\c${assColor(style.highlight)}` : '';
            lines.push(`Dialogue: 2,${assTime(a)},${assTime(b)},Cap,,0,0,0,,{\\an${below ? 8 : 5}\\pos(${Math.round(W / 2)},${ty})\\fs${fs}${col}\\bord${Math.max(2, Math.round(fs * 0.12))}}${text}`);
        }
    }

    if (t.id !== 'none' && lang !== 'translated') {
        const hl = assColor(style.highlight);
        const dw = displayWords(words, clip, style, speakers, true);
        const groups = groupWords(dw, style.wordsPerLine);
        const times = groupTimes(groups);
        const pos = `\\an5\\pos(${Math.round(W / 2)},${y})`;
        const scaleUp = Math.round((t.activeScale ?? 1.15) * 100);

        groups.forEach((group, gi) => {
            // one event per spoken word so the highlight moves word by word
            const spans = group.map((w, wi) => ({ from: wi === 0 ? times[gi].start : w.start, to: wi + 1 < group.length ? group[wi + 1].start : times[gi].end }));
            spans.forEach((span, wi) => {
                if (span.to <= span.from) return;
                const text = group
                    .map((w, i) => {
                        const s = clean(displayText(t, w));
                        const active = i === wi && t.active !== 'none';
                        const spoken = t.fillSpoken && i <= wi;
                        let tags = '';
                        if (t.reveal && i > wi) tags += '\\alpha&HFF&';
                        if (w.color !== t.color) tags += `\\c${assColor(w.color)}`;
                        if ((active && t.active === 'color') || spoken || (w.kw && !(active && t.active === 'box'))) tags += `\\c${hl}`;
                        if (active && t.active === 'box') tags += `\\3c${hl}\\bord${Math.round(size * 0.28)}\\shad0${t.boxText ? `\\c${assColor(t.boxText)}` : ''}`;
                        if (active && t.active === 'underline') tags += `\\u1\\c${hl}`;
                        if (active && t.pop) tags += `\\fscx${scaleUp}\\fscy${scaleUp}\\t(0,110,\\fscx100\\fscy100)`;
                        else if (active && t.activeScale) tags += `\\fscx${scaleUp}\\fscy${scaleUp}`;
                        else if (w.kw && !active) tags += `\\fscx108\\fscy108`;
                        // settle: every word of a new caption starts bigger and shrinks to normal together
                        if (t.settle && wi === 0) {
                            const big = Math.round(t.settle * 100);
                            tags = `\\fscx${big}\\fscy${big}\\t(0,150,\\fscx100\\fscy100)` + tags;
                        }
                        return tags ? `{${tags}}${s}{\\r}` : s;
                    })
                    .join(' ');
                if (t.glow) {
                    lines.push(`Dialogue: 0,${assTime(span.from)},${assTime(span.to)},Cap,,0,0,0,,{${pos}\\bord${Math.round(size * 0.18)}\\3c${assColor(t.glow)}\\blur${Math.round(size * 0.15)}\\shad0}${text.replace(/\\3c&H[0-9A-F]+&/g, '')}`);
                }
                lines.push(`Dialogue: 1,${assTime(span.from)},${assTime(span.to)},Cap,,0,0,0,,{${pos}}${text}`);
            });
        });
    }
    return header + lines.join('\n') + '\n';
}

// ---------- .srt export ----------

function srtTime(t: number) {
    const s = Math.max(0, t);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.round((s - Math.floor(s)) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export function buildSrt(words: Word[], clip: Clip, style: StyleSettings, speakers?: { t: number; speaker: number }[]): string {
    const groups = groupWords(displayWords(words, clip, style, speakers, true), style.wordsPerLine);
    const times = groupTimes(groups);
    return groups.map((g, i) => `${i + 1}\n${srtTime(times[i].start)} --> ${srtTime(times[i].end)}\n${g.map((w) => w.text).join(' ')}\n`).join('\n');
}
