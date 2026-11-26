// Caption templates. Each one is applied the same way in the live preview (canvas)
// and in the exported video (an .ass subtitle file burned in by ffmpeg).

export type CaptionTemplate = {
    id: string;
    name: string;
    /** family name inside the TTF (used by ffmpeg/libass) */
    font: string;
    /** CSS font-family for the preview (loaded via @font-face) */
    cssFont: string;
    /** font size as a fraction of the output width */
    size: number;
    uppercase: boolean;
    color: string;
    outline: number; // fraction of font size
    outlineColor?: string;
    shadow: boolean;
    /** how the word being spoken is shown */
    active: 'color' | 'box' | 'none' | 'underline';
    /** grow the active word briefly */
    pop: boolean;
    /** how much bigger the active word gets (1 = same size) */
    activeScale?: number;
    /** dark box behind each line */
    lineBox: boolean;
    /** coloured glow around the text */
    glow?: string;
    /** words appear one at a time as they are spoken */
    reveal?: boolean;
    /** words already spoken take the highlight colour */
    fillSpoken?: boolean;
    /** text colour on top of the active box */
    boxText?: string;
    /** each new caption appears this much bigger and settles to normal size (e.g. 1.05 = 105% -> 100%) */
    settle?: number;
    /** each caption is tilted this many degrees, alternating left and right (sticker look) */
    tilt?: number;
    /** red and cyan copies just beside the text, like a glitchy screen */
    rgbSplit?: boolean;
    /** words are only outlined; the spoken word fills in */
    hollow?: boolean;
    /** a solid offset copy behind the text (3D block letters), in this colour */
    blockShadow?: string;
    /** the line box is a strip of tape in this colour (lineBox must be on) */
    tape?: string;
    /** always this many words at a time (overrides "Words on screen") */
    perLine?: number;
    defaultHighlight: string;
};

export const TEMPLATES: CaptionTemplate[] = [
    { id: 'punch', name: 'Punch', font: 'Montserrat ExtraBold', cssFont: 'CapMontserrat', size: 0.085, uppercase: true, color: '#ffffff', outline: 0.16, shadow: true, active: 'color', pop: true, lineBox: false, defaultHighlight: '#c8ff3d' },
    { id: 'spotlight', name: 'Spotlight', font: 'Poppins ExtraBold', cssFont: 'CapPoppins', size: 0.075, uppercase: false, color: '#ffffff', outline: 0.1, shadow: true, active: 'box', pop: false, lineBox: false, defaultHighlight: '#7c5cff' },
    { id: 'highlighter', name: 'Highlighter', font: 'Montserrat ExtraBold', cssFont: 'CapMontserrat', size: 0.08, uppercase: true, color: '#ffffff', outline: 0.14, shadow: true, active: 'box', pop: true, lineBox: false, boxText: '#000000', defaultHighlight: '#ffe600' },
    { id: 'headline', name: 'Headline', font: 'Anton', cssFont: 'CapAnton', size: 0.1, uppercase: true, color: '#ffffff', outline: 0.12, shadow: true, active: 'color', pop: true, lineBox: false, defaultHighlight: '#ffd60a' },
    { id: 'comic', name: 'Comic', font: 'Bangers', cssFont: 'CapBangers', size: 0.1, uppercase: true, color: '#ffffff', outline: 0.18, shadow: true, active: 'color', pop: true, lineBox: false, defaultHighlight: '#ff4d6d' },
    { id: 'cartoon', name: 'Cartoon', font: 'Luckiest Guy', cssFont: 'CapLuckiest', size: 0.092, uppercase: true, color: '#ffffff', outline: 0.2, shadow: true, active: 'color', pop: true, activeScale: 1.25, lineBox: false, defaultHighlight: '#3dd9ff' },
    { id: 'neon', name: 'Neon', font: 'Rubik Black', cssFont: 'CapRubik', size: 0.08, uppercase: true, color: '#ffffff', outline: 0.05, outlineColor: '#00e5ff', shadow: false, active: 'color', pop: false, lineBox: false, glow: '#00e5ff', defaultHighlight: '#ff3df2' },
    { id: 'pixel', name: 'Pixel', font: 'Press Start 2P', cssFont: 'CapPixel', size: 0.05, uppercase: true, color: '#ffffff', outline: 0.22, shadow: true, active: 'color', pop: true, lineBox: false, defaultHighlight: '#7dff5c' },
    { id: 'arcade', name: 'Arcade', font: 'Bungee', cssFont: 'CapBungee', size: 0.075, uppercase: true, color: '#ffffff', outline: 0.14, shadow: true, active: 'color', pop: true, lineBox: false, defaultHighlight: '#ff9f1c' },
    { id: 'marker', name: 'Marker', font: 'Permanent Marker', cssFont: 'CapMarker', size: 0.08, uppercase: false, color: '#ffffff', outline: 0.14, shadow: true, active: 'underline', pop: false, lineBox: false, defaultHighlight: '#ff4d6d' },
    { id: 'bebas', name: 'Bebas', font: 'Bebas Neue', cssFont: 'CapBebas', size: 0.11, uppercase: true, color: '#ffffff', outline: 0.08, shadow: true, active: 'color', pop: false, lineBox: false, defaultHighlight: '#ffd60a' },
    { id: 'fire', name: 'Fire', font: 'Anton', cssFont: 'CapAnton', size: 0.1, uppercase: true, color: '#ffffff', outline: 0.1, outlineColor: '#7a0000', shadow: true, active: 'color', pop: true, activeScale: 1.2, lineBox: false, glow: '#ff5a00', defaultHighlight: '#ffb000' },
    { id: 'reveal', name: 'Reveal', font: 'Poppins ExtraBold', cssFont: 'CapPoppins', size: 0.078, uppercase: false, color: '#ffffff', outline: 0.12, shadow: true, active: 'color', pop: true, lineBox: false, reveal: true, defaultHighlight: '#c8ff3d' },
    { id: 'bounce', name: 'Bounce', font: 'Rubik Black', cssFont: 'CapRubik', size: 0.082, uppercase: true, color: '#ffffff', outline: 0.15, shadow: true, active: 'color', pop: true, activeScale: 1.35, lineBox: false, defaultHighlight: '#ffe600' },
    { id: 'settle', name: 'Settle', font: 'Montserrat ExtraBold', cssFont: 'CapMontserrat', size: 0.08, uppercase: true, color: '#ffffff', outline: 0.14, shadow: true, active: 'color', pop: false, lineBox: false, settle: 1.05, defaultHighlight: '#ffe600' },
    { id: 'karaoke', name: 'Karaoke', font: 'Montserrat ExtraBold', cssFont: 'CapMontserrat', size: 0.075, uppercase: true, color: '#9aa0aa', outline: 0.12, shadow: false, active: 'color', pop: false, lineBox: false, fillSpoken: true, defaultHighlight: '#ffffff' },
    // ---- ClipHeist originals ----
    { id: 'glitch', name: 'Glitch', font: 'Rubik Black', cssFont: 'CapRubik', size: 0.082, uppercase: true, color: '#ffffff', outline: 0.1, shadow: false, active: 'color', pop: true, activeScale: 1.18, lineBox: false, rgbSplit: true, defaultHighlight: '#2ee6d6' },
    { id: 'sticker', name: 'Sticker', font: 'Luckiest Guy', cssFont: 'CapLuckiest', size: 0.09, uppercase: true, color: '#111111', outline: 0.2, outlineColor: '#ffffff', shadow: true, active: 'color', pop: true, activeScale: 1.2, lineBox: false, tilt: 4, defaultHighlight: '#ff4d6d' },
    { id: 'hollow', name: 'Outline', font: 'Anton', cssFont: 'CapAnton', size: 0.105, uppercase: true, color: '#ffffff', outline: 0.05, outlineColor: '#ffffff', shadow: false, active: 'color', pop: true, activeScale: 1.12, lineBox: false, hollow: true, defaultHighlight: '#ffd60a' },
    { id: 'block3d', name: '3D Block', font: 'Bungee', cssFont: 'CapBungee', size: 0.078, uppercase: true, color: '#ffffff', outline: 0.1, shadow: false, active: 'color', pop: true, lineBox: false, blockShadow: '#7c5cff', defaultHighlight: '#ffd60a' },
    { id: 'slam', name: 'Slam', font: 'Anton', cssFont: 'CapAnton', size: 0.15, uppercase: true, color: '#ffffff', outline: 0.1, shadow: true, active: 'none', pop: false, lineBox: false, settle: 1.3, perLine: 1, defaultHighlight: '#ffffff' },
    { id: 'vhs', name: 'VHS', font: 'Press Start 2P', cssFont: 'CapPixel', size: 0.052, uppercase: true, color: '#ffffff', outline: 0.14, shadow: false, active: 'color', pop: false, lineBox: false, rgbSplit: true, defaultHighlight: '#ff3df2' },
    { id: 'tape', name: 'Tape', font: 'Bebas Neue', cssFont: 'CapBebas', size: 0.1, uppercase: true, color: '#111111', outline: 0, shadow: false, active: 'color', pop: false, lineBox: true, tape: '#ffe600', tilt: 2, defaultHighlight: '#e0004d' },
    { id: 'subtitle', name: 'Subtitle', font: 'Poppins ExtraBold', cssFont: 'CapPoppins', size: 0.058, uppercase: false, color: '#ffffff', outline: 0, shadow: false, active: 'none', pop: false, lineBox: true, defaultHighlight: '#ffffff' },
    { id: 'minimal', name: 'Minimal', font: 'Montserrat ExtraBold', cssFont: 'CapMontserrat', size: 0.06, uppercase: false, color: '#ffffff', outline: 0.06, shadow: true, active: 'none', pop: false, lineBox: false, defaultHighlight: '#ffffff' },
    { id: 'none', name: 'No captions', font: 'Montserrat ExtraBold', cssFont: 'CapMontserrat', size: 0.07, uppercase: false, color: '#ffffff', outline: 0, shadow: false, active: 'none', pop: false, lineBox: false, defaultHighlight: '#ffffff' }
];

export const FONT_FILES = [
    'Montserrat-ExtraBold.ttf',
    'Poppins-ExtraBold.ttf',
    'Anton-Regular.ttf',
    'Bangers-Regular.ttf',
    'PressStart2P-Regular.ttf',
    'Bungee-Regular.ttf',
    'BebasNeue-Regular.ttf',
    'Rubik-Black.ttf',
    'LuckiestGuy-Regular.ttf',
    'PermanentMarker-Regular.ttf'
];

/** Font used for hook titles, freeze text and thumbnails. */
export const TITLE_FONT = { font: 'Montserrat ExtraBold', css: 'CapMontserrat' };

export function getTemplate(id: string): CaptionTemplate {
    return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
}

export const DEFAULT_SPEAKER_COLORS = ['#ffffff', '#4dd2ff', '#ffd60a', '#ff7ab6'];

/** How many words show at once: the style's own number if it has one, else your setting. */
export function perLine(style: { template: string; wordsPerLine: number }): number {
    return getTemplate(style.template).perLine ?? style.wordsPerLine;
}

/**
 * The burned-in captions (libass) size a font by its full line height (OS/2 winAscent + winDescent),
 * while the preview (canvas) sizes it by its em. Multiplying the size by this makes the exported
 * text exactly as big as in the preview. Numbers read from the font files.
 */
const ASS_SIZE: Record<string, number> = {
    Anton: 3550 / 2048,
    Bangers: 1757 / 1000,
    'Bebas Neue': 1300 / 1000,
    Bungee: 2574 / 1000,
    'Luckiest Guy': 2510 / 2048,
    'Montserrat ExtraBold': 1562 / 1000,
    'Permanent Marker': 1461 / 1024,
    'Poppins ExtraBold': 1762 / 1000,
    'Press Start 2P': 1374 / 1000,
    'Rubik Black': 1532 / 1000
};
export const assFontScale = (font: string) => ASS_SIZE[font] ?? 1;
