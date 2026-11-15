export type Word = { text: string; start: number; end: number };
export type Segment = { start: number; end: number; text: string };
export type Transcript = { language: string; words: Word[]; segments: Segment[] };

export type Clip = {
    id: string;
    title: string;
    start: number;
    end: number;
    hook: string;
    score: number;
    reason: string;
    description: string;
    hashtags: string[];
};

export type CaptionStyle = 'pop' | 'clean' | 'boxed' | 'none';

export type ExportSettings = {
    captionStyle: CaptionStyle;
    highlightColor: string; // #rrggbb
    cropX: number; // 0 = left edge, 0.5 = center, 1 = right edge
    wordsPerLine: number;
};
