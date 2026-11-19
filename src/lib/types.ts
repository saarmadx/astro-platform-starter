export interface Region {
    id: string;
    name: string;
}

export interface ChecklistItem {
    id: string;
    name: string;
    /** Region id, or empty string when the item isn't tied to a region. */
    region: string;
    tip: string;
}

export interface Category {
    id: string;
    name: string;
    blurb: string;
    items: ChecklistItem[];
}

export type Difficulty = 'Easy' | 'Medium' | 'Hard';

export interface MoneyMethod {
    id: string;
    title: string;
    payout: string;
    time: string;
    difficulty: Difficulty;
    unlock: string;
    steps: string[];
}

export interface Guide {
    slug: string;
    title: string;
    summary: string;
    updated: string;
    /** Markdown. */
    body: string;
}

export interface Content {
    regions: Region[];
    categories: Category[];
    money: MoneyMethod[];
    guides: Guide[];
}

export interface Progress {
    v: 1;
    /** Item id → time it was ticked (ms). */
    done: Record<string, number>;
    /** Item id → personal note. */
    notes: Record<string, string>;
    updatedAt: number;
}
