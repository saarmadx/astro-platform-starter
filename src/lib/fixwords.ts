// Fixing misheard words across a whole transcript: find & replace (words or phrases), and a
// Claude chat prompt that lists likely mishearings (names, slang, game terms) to fix in one go.
import type { Word } from './types';

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/** Replaces every occurrence of a word or phrase. Returns the new words and how many were changed. */
export function replacePhrase(words: Word[], find: string, replace: string): { words: Word[]; count: number } {
    const target = find.trim().split(/\s+/).map(norm).filter(Boolean);
    const repl = replace.trim().split(/\s+/).filter(Boolean);
    if (!target.length) return { words, count: 0 };
    const out: Word[] = [];
    let count = 0;
    let i = 0;
    while (i < words.length) {
        let match = i + target.length <= words.length;
        for (let k = 0; match && k < target.length; k++) if (norm(words[i + k].text) !== target[k]) match = false;
        if (!match) {
            out.push(words[i]);
            i++;
            continue;
        }
        const first = words[i];
        const last = words[i + target.length - 1];
        const trailing = last.text.match(/[.,!?;:]+$/)?.[0] ?? '';
        if (repl.length) {
            const totalLen = repl.reduce((a, w) => a + w.length + 1, 0);
            let t = first.start;
            repl.forEach((w, k) => {
                const d = ((last.end - first.start) * (w.length + 1)) / totalLen;
                const text = k === repl.length - 1 && trailing && !/[.,!?;:]$/.test(w) ? w + trailing : w;
                out.push({ text, start: t, end: t + d });
                t += d;
            });
        }
        count++;
        i += target.length;
    }
    return { words: out, count };
}

/** Prompt for a Claude chat: find words the speech model probably misheard. */
export function fixPrompt(words: Word[], hint: string): string {
    let text = words.map((w) => w.text).join(' ');
    if (text.length > 60000) text = text.slice(0, 60000) + ' …';
    return `This is an automatic transcript of a video (for example a podcast or a gaming stream). Speech recognition often mishears names, slang, brand names and game terms.${hint.trim() ? `\n\nAbout the video: ${hint.trim()}` : ''}

Find the words or short phrases that were clearly misheard and say what was really said. Only include fixes you are confident about. Each "wrong" must appear exactly like that in the transcript (same words), and keep phrases short (1 to 4 words).

Reply with ONLY a JSON array like:
[{"wrong":"label key","right":"Lambo key"},{"wrong":"Jon","right":"John"}]

<transcript>
${text}
</transcript>`;
}

export function parseFixes(answer: string): { wrong: string; right: string }[] {
    const a = answer.indexOf('[');
    const b = answer.lastIndexOf(']');
    if (a < 0 || b <= a) throw new Error('No list found. Copy Claude’s whole answer, including the [ and ] brackets.');
    const data = JSON.parse(answer.slice(a, b + 1));
    if (!Array.isArray(data)) throw new Error('Expected a list of fixes.');
    return data
        .filter((x) => x && typeof x.wrong === 'string' && typeof x.right === 'string' && x.wrong.trim() && x.wrong.trim() !== x.right.trim())
        .map((x) => ({ wrong: x.wrong.trim(), right: x.right.trim() }));
}
