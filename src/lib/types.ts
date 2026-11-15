export type Word = { text: string; start: number; end: number };
export type Segment = { start: number; end: number; text: string };
export type Energy = { step: number; db: number[] };
export type Transcript = { language: string; words: Word[]; segments: Segment[]; energy?: Energy };
export type AudioEvent = { start: number; end: number; type: 'reaction' | 'loud'; strength: number };

export type ContentMode = 'viral' | 'funny' | 'insightful' | 'story' | 'hot-takes';
/** where captions come from: free on this PC, or OpenAI (paid) */
export type AsrEngine = 'local' | 'openai';
/** how clips are picked: free laugh detector, free via Claude chat copy/paste, or Claude API (paid) */
export type Picker = 'laughs' | 'chat' | 'api';

export type SubScores = { hook: number; flow: number; value: number; shareability: number };

export type Clip = {
    id: string;
    title: string;
    start: number;
    end: number;
    hook: string;
    score: number;
    subscores: SubScores;
    reason: string;
    /** what kind of moment this is, e.g. Funny, Insight, Story */
    category?: string;
    description: string;
    hashtags: string[];
    /** words (lowercase) the captions should emphasise */
    keywords: string[];
    /** emoji to pop up next to a keyword */
    emojis: { word: string; emoji: string }[];
    /** auto-reframe path: time (absolute, seconds) -> face centre as a fraction of video width */
    track?: { t: number; x: number }[];
    thumb?: string; // data URL
};

export type Aspect = '9:16' | '1:1' | '16:9';
export type Layout = 'auto' | 'manual' | 'fit';
export type CaptionPosition = 'top' | 'middle' | 'bottom';

export type Brand = {
    logo?: string; // data URL (PNG)
    logoCorner: 'tl' | 'tr' | 'bl' | 'br';
    logoSize: number; // fraction of output width
    accent: string;
};

export type StyleSettings = {
    template: string;
    highlight: string;
    position: CaptionPosition;
    wordsPerLine: number;
    emojis: boolean;
    keywordHighlight: boolean;
    aspect: Aspect;
    layout: Layout;
    cropX: number; // used when layout === 'manual'
};

export type Project = {
    id: string;
    name: string;
    fileName: string;
    fileSize: number;
    duration: number;
    width: number;
    height: number;
    createdAt: number;
    status: 'transcribing' | 'clipping' | 'awaiting-paste' | 'ready' | 'error';
    transcript?: Transcript;
    clips: Clip[];
    style: StyleSettings;
    options: {
        minSeconds: number;
        maxSeconds: number;
        maxClips: number;
        topic: string;
        mode?: ContentMode;
        asr?: AsrEngine;
        asrQuality?: 'fast' | 'accurate';
        language?: string;
        picker?: Picker;
    };
    thumb?: string;
};
