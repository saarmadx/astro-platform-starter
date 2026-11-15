import type { CaptionStyle, Word } from './types';

// Builds an .ass subtitle file with word-by-word animated captions for a 720x1280 video.
// Times are shifted so the clip starts at 0.

const W = 720;
const H = 1280;

/** #rrggbb -> ASS colour &HBBGGRR& */
function assColor(hex: string): string {
    const h = hex.replace('#', '');
    return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase();
}

function assTime(t: number): string {
    const s = Math.max(0, t);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const cs = Math.floor((s - Math.floor(s)) * 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function escapeText(t: string): string {
    return t.replace(/\\/g, '').replace(/[{}]/g, '').replace(/\n/g, ' ');
}

export function wordsInRange(words: Word[], start: number, end: number): Word[] {
    return words.filter((w) => w.end > start && w.start < end);
}

/** Group words into short lines, breaking early at sentence ends. */
export function groupWords(words: Word[], perLine: number): Word[][] {
    const groups: Word[][] = [];
    let cur: Word[] = [];
    for (const w of words) {
        cur.push(w);
        const endsSentence = /[.!?,]$/.test(w.text);
        if (cur.length >= perLine || endsSentence) {
            groups.push(cur);
            cur = [];
        }
    }
    if (cur.length) groups.push(cur);
    return groups;
}

export function buildAss(
    words: Word[],
    clipStart: number,
    clipEnd: number,
    style: CaptionStyle,
    highlight: string,
    perLine: number
): string {
    const boxed = style === 'boxed';
    const upper = style !== 'clean';
    const fontSize = style === 'clean' ? 54 : 66;
    // BorderStyle 3 = opaque box behind text
    const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Montserrat ExtraBold,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,${boxed ? '&H99000000' : '&H80000000'},-1,0,0,0,100,100,0,0,${boxed ? 3 : 1},${boxed ? 10 : 5},${boxed ? 0 : 2},2,60,60,360,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
    if (style === 'none') return header;

    const hl = assColor(highlight);
    const lines: string[] = [];
    const groups = groupWords(wordsInRange(words, clipStart, clipEnd), perLine);

    groups.forEach((group, gi) => {
        const groupEnd = gi + 1 < groups.length ? Math.min(groups[gi + 1][0].start, group[group.length - 1].end + 0.6) : group[group.length - 1].end + 0.4;
        group.forEach((word, wi) => {
            const from = word.start - clipStart;
            const to = (wi + 1 < group.length ? group[wi + 1].start : groupEnd) - clipStart;
            if (to <= 0 || to <= from) return;
            const text = group
                .map((w, i) => {
                    const t = escapeText(upper ? w.text.toUpperCase() : w.text);
                    if (i !== wi || style === 'clean') return t;
                    // active word: highlight colour + a small "pop" scale animation
                    return `{\\c${hl}\\fscx112\\fscy112\\t(0,90,\\fscx100\\fscy100)}${t}{\\c&H00FFFFFF&\\fscx100\\fscy100}`;
                })
                .join(' ');
            lines.push(`Dialogue: 0,${assTime(from)},${assTime(to)},Cap,,0,0,0,,${text}`);
        });
    });
    return header + lines.join('\n') + '\n';
}
