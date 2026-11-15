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
    shadow: boolean;
    /** how the word being spoken is shown */
    active: 'color' | 'box' | 'none';
    /** grow the active word briefly */
    pop: boolean;
    /** dark box behind each line */
    lineBox: boolean;
    defaultHighlight: string;
};

export const TEMPLATES: CaptionTemplate[] = [
    { id: 'punch', name: 'Punch', font: 'Montserrat ExtraBold', cssFont: 'CapMontserrat', size: 0.085, uppercase: true, color: '#ffffff', outline: 0.16, shadow: true, active: 'color', pop: true, lineBox: false, defaultHighlight: '#c8ff3d' },
    { id: 'spotlight', name: 'Spotlight', font: 'Poppins ExtraBold', cssFont: 'CapPoppins', size: 0.075, uppercase: false, color: '#ffffff', outline: 0.1, shadow: true, active: 'box', pop: false, lineBox: false, defaultHighlight: '#7c5cff' },
    { id: 'headline', name: 'Headline', font: 'Anton', cssFont: 'CapAnton', size: 0.1, uppercase: true, color: '#ffffff', outline: 0.12, shadow: true, active: 'color', pop: true, lineBox: false, defaultHighlight: '#ffd60a' },
    { id: 'comic', name: 'Comic', font: 'Bangers', cssFont: 'CapBangers', size: 0.1, uppercase: true, color: '#ffffff', outline: 0.18, shadow: true, active: 'color', pop: true, lineBox: false, defaultHighlight: '#ff4d6d' },
    { id: 'subtitle', name: 'Subtitle', font: 'Poppins ExtraBold', cssFont: 'CapPoppins', size: 0.058, uppercase: false, color: '#ffffff', outline: 0, shadow: false, active: 'none', pop: false, lineBox: true, defaultHighlight: '#ffffff' },
    { id: 'karaoke', name: 'Karaoke', font: 'Montserrat ExtraBold', cssFont: 'CapMontserrat', size: 0.075, uppercase: true, color: '#9aa0aa', outline: 0.12, shadow: false, active: 'color', pop: false, lineBox: false, defaultHighlight: '#ffffff' },
    { id: 'minimal', name: 'Minimal', font: 'Montserrat ExtraBold', cssFont: 'CapMontserrat', size: 0.06, uppercase: false, color: '#ffffff', outline: 0.06, shadow: true, active: 'none', pop: false, lineBox: false, defaultHighlight: '#ffffff' },
    { id: 'none', name: 'No captions', font: 'Montserrat ExtraBold', cssFont: 'CapMontserrat', size: 0.07, uppercase: false, color: '#ffffff', outline: 0, shadow: false, active: 'none', pop: false, lineBox: false, defaultHighlight: '#ffffff' }
];

export const FONT_FILES = ['Montserrat-ExtraBold.ttf', 'Poppins-ExtraBold.ttf', 'Anton-Regular.ttf', 'Bangers-Regular.ttf'];

export function getTemplate(id: string): CaptionTemplate {
    return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
}
