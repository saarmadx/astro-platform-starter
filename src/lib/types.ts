export type Word = { text: string; start: number; end: number };
export type Segment = { start: number; end: number; text: string };
export type Energy = { step: number; db: number[] };
export type Transcript = { language: string; words: Word[]; segments: Segment[]; energy?: Energy };
export type AudioEvent = { start: number; end: number; type: 'reaction' | 'loud' | 'chat' | 'hype'; strength: number; label?: string };

export type ContentMode = 'viral' | 'funny' | 'gaming' | 'insightful' | 'story' | 'hot-takes';
/** where captions come from: free on this PC, or OpenAI (paid) */
export type AsrEngine = 'local' | 'openai';
/** how clips are picked: free laugh detector, free via Claude chat copy/paste, or Claude API (paid) */
export type Picker = 'laughs' | 'chat' | 'api';
export type AsrQuality = 'fastest' | 'fast' | 'accurate' | 'best';

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
    /** the parts of the video that make up this clip, in order (absolute source times).
     *  When present this is the source of truth; `cuts`/`splits` are only used by older projects. */
    segs?: Seg[];
    /** split points added in the timeline (absolute source times) */
    splits?: number[];
    /** parts of the clip removed in the timeline (absolute source times) */
    cuts?: Span[];
    /** punch-in zooms (absolute source times) */
    zooms?: (Span & { scale: number })[];
    /** big headline at the top for the first seconds */
    hookTitle?: { text: string; seconds: number };
    /** freeze the last frame with a line of text */
    freeze?: { seconds: number; text: string };
    /** alternative titles to pick from */
    altTitles?: string[];
    /** sound effects (absolute source times) */
    sfx?: { t: number; kind: SfxKind }[];
    /** screen shakes / flashes (absolute source times) */
    shakes?: { t: number; kind: 'shake' | 'flash' | 'both' }[];
    /** replay a moment slowed down after the clip */
    replay?: { start: number; end: number; speed: number };
    /** text stickers placed on the video */
    stickers?: Sticker[];
    /** timeline markers (absolute source times) */
    markers?: number[];
    /** an effect (and optional sound) at every cut between parts */
    transition?: { kind: 'none' | 'flash' | 'shake' | 'zoom'; sound?: SfxKind | null };
    /** translated captions, one line per caption block (absolute source times) */
    translation?: { language: string; lines: { start: number; end: number; text: string }[] };
};

export type SfxKind = 'boom' | 'whoosh' | 'ding' | 'pop' | 'scratch';

export type Sticker = {
    id: string;
    text: string;
    start: number;
    end: number;
    /** centre position, fractions of the frame */
    x: number;
    y: number;
    /** text height as a fraction of the frame width */
    size: number;
    color: string;
    /** white box behind the text */
    box: boolean;
};

export type Span = { start: number; end: number };

/** One part of a clip on the timeline. Each part can have its own framing. */
export type Seg = { id: string; start: number; end: number; layout?: Layout; cropX?: number };

export type Aspect = '9:16' | '1:1' | '16:9';
export type Layout = 'auto' | 'manual' | 'fit' | 'split' | 'pip';
export type PipSettings = { corner: 'tl' | 'tr' | 'bl' | 'br'; size: number; shape: 'circle' | 'rounded' };
export type CaptionPosition = 'top' | 'middle' | 'bottom';

export type Brand = {
    logo?: string; // data URL (PNG)
    logoCorner: 'tl' | 'tr' | 'bl' | 'br';
    logoSize: number; // fraction of output width
    accent: string;
    /** your name / @handle on every clip, so it can't be passed off as someone else's */
    watermark?: Watermark;
};
export type Watermark = { text: string; corner: 'tl' | 'tr' | 'bl' | 'br'; size: number; opacity: number; moving: boolean };

export type StyleSettings = {
    template: string;
    highlight: string;
    position: CaptionPosition;
    wordsPerLine: number;
    emojis: boolean;
    keywordHighlight: boolean;
    aspect: Aspect;
    layout: Layout;
    cropX: number; // used when layout === 'manual' (and for the gameplay part of 'split')
    /** facecam rectangle in the source (fractions of width/height), for layout === 'split' */
    facecam?: { x: number; y: number; w: number; h: number };
    /** share of the height the facecam takes in 'split' layout */
    splitRatio?: number;
    /** small facecam over full gameplay, for layout === 'pip' */
    pip?: PipSettings;
    progressBar?: boolean;
    /** replace swear words in captions with ****; bleep also beeps the audio */
    censor?: 'off' | 'captions' | 'bleep';
    /** emoji pop and float instead of sitting still */
    emojiAnim?: boolean;
    speakerColors?: string[];
    sfxVolume?: number;
    /** which captions to show when a clip has a translation */
    captionLang?: 'original' | 'translated' | 'both';
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
        asrQuality?: AsrQuality;
        language?: string;
        picker?: Picker;
        /** just caption the whole video, no clip finding */
        captionsOnly?: boolean;
        /** optional: quick captions for the whole video, then Accurate captions only for the clips */
        speedBoost?: boolean;
        /** effects applied to every clip once they are found (from a template) */
        fx?: import('./presets').PresetFx;
    };
    thumb?: string;
    /** who is speaking from each time on (speaker index into style.speakerColors) */
    speakers?: { t: number; speaker: number }[];
    /** background music chosen by the creator (their own file) */
    music?: { name: string; blob: Blob; volume: number; duck: boolean };
    /** stream chat replay: moments where chat exploded */
    chat?: { name: string; spikes: { t: number; count: number; laughs: number }[] };
    /** captions finished so far, so a stopped run can continue where it left off */
    partial?: { key: string; words: Word[]; db: number[] | null; nextChunk: number };
    /** how far all captions were moved by hand (seconds; negative = earlier) */
    captionShift?: number;
};
