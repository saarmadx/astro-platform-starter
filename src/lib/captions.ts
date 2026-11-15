import { getTemplate, type CaptionTemplate } from './templates';
import type { Clip, StyleSettings, Word } from './types';

export function wordsInRange(words: Word[], start: number, end: number): Word[] {
    return words.filter((w) => w.end > start && w.start < end);
}

/** Group words into short caption lines, breaking early at punctuation. */
export function groupWords(words: Word[], perLine: number): Word[][] {
    const groups: Word[][] = [];
    let cur: Word[] = [];
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
export function captionY(position: StyleSettings['position']) {
    return position === 'top' ? 0.2 : position === 'middle' ? 0.5 : 0.74;
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

export function buildAss(words: Word[], clip: Clip, style: StyleSettings, W: number, H: number): string {
    const t = getTemplate(style.template);
    const size = Math.round(t.size * W * (style.aspect === '16:9' ? 0.6 : 1));
    const outline = Math.round(t.outline * size);
    const y = Math.round(captionY(style.position) * H);
    const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${t.font},${size},${assColor(t.color)},${assColor(t.color)},&H00000000,${t.lineBox ? '&H55000000' : '&H80000000'},0,0,0,0,100,100,0,0,${t.lineBox ? 3 : 1},${t.lineBox ? Math.round(size * 0.25) : outline},${t.shadow ? Math.max(1, Math.round(size * 0.05)) : 0},5,${Math.round(W * 0.08)},${Math.round(W * 0.08)},0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
    if (t.id === 'none') return header;

    const hl = assColor(style.highlight);
    const groups = groupWords(wordsInRange(words, clip.start, clip.end), style.wordsPerLine);
    const times = groupTimes(groups);
    const lines: string[] = [];
    const pos = `{\\an5\\pos(${Math.round(W / 2)},${y})}`;

    groups.forEach((group, gi) => {
        // one event per spoken word so the highlight moves word by word
        const spans = group.map((w, wi) => ({ from: wi === 0 ? times[gi].start : w.start, to: wi + 1 < group.length ? group[wi + 1].start : times[gi].end }));
        spans.forEach((span, wi) => {
            const from = span.from - clip.start;
            const to = span.to - clip.start;
            if (to <= 0 || to <= from) return;
            const text = group
                .map((w, i) => {
                    const s = clean(displayText(t, w));
                    const active = i === wi && t.active !== 'none';
                    const spoken = t.id === 'karaoke' && i <= wi;
                    const kw = style.keywordHighlight && isKeyword(clip, w);
                    let tags = '';
                    if (active && t.active === 'color') tags += `\\c${hl}`;
                    else if (spoken) tags += `\\c${hl}`;
                    else if (kw) tags += `\\c${hl}`;
                    if (active && t.active === 'box') tags += `\\3c${hl}\\bord${Math.round(size * 0.28)}\\shad0`;
                    if (active && t.pop) tags += `\\fscx115\\fscy115\\t(0,100,\\fscx100\\fscy100)`;
                    if (kw && !active) tags += `\\fscx108\\fscy108`;
                    return tags ? `{${tags}}${s}{\\r}` : s;
                })
                .join(' ');
            lines.push(`Dialogue: 0,${assTime(from)},${assTime(to)},Cap,,0,0,0,,${pos}${text}`);
        });
    });
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

export function buildSrt(words: Word[], clip: Clip, perLine: number): string {
    const groups = groupWords(wordsInRange(words, clip.start, clip.end), perLine);
    const times = groupTimes(groups);
    return groups
        .map((g, i) => `${i + 1}\n${srtTime(times[i].start - clip.start)} --> ${srtTime(times[i].end - clip.start)}\n${g.map((w) => w.text).join(' ')}\n`)
        .join('\n');
}
