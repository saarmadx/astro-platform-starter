// Free title ideas (no AI): a few proven Shorts title patterns filled with the clip's own words.
import type { Clip } from './types';

const short = (s: string, n = 48) => {
    const t = s.replace(/\s+/g, ' ').replace(/^["“]|["”]$/g, '').trim();
    return t.length > n ? `${t.slice(0, n - 1).trim()}…` : t;
};

export function titleIdeas(clip: Clip): string[] {
    const hook = short(clip.hook || clip.title, 46);
    const kw = clip.keywords[0] ?? '';
    const ideas = [
        `He really said “${hook}” 💀`,
        `Wait for it… 😂`,
        kw ? `The ${kw} moment that broke everyone` : `The moment that broke everyone`,
        `Nobody expected this 😭`,
        `“${hook}”`,
        clip.category === 'Funny' ? `I can't stop laughing at this` : `This changed how I see it`,
        `POV: your friend says “${short(clip.hook || clip.title, 30)}”`
    ];
    return [...new Set([...(clip.altTitles ?? []), ...ideas])].filter((t) => t && t !== clip.title).slice(0, 8);
}
