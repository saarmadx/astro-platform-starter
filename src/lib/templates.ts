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
