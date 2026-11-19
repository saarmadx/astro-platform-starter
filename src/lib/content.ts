import regions from '../content/regions.json';
import checklist from '../content/checklist.json';
import money from '../content/money.json';
import guides from '../content/guides.json';
import { blobDelete, blobGet, blobSet } from './store';
import type { Category, Content, Difficulty, Guide, MoneyMethod, Region } from './types';

const STORE = 'leonida-content';
const KEY = 'content';

/** The JSON files in /src/content — the defaults that ship with each deploy. */
export function fileContent(): Content {
    return validateContent({ regions, categories: checklist, money, guides });
}

/**
 * Live content: the version saved from /admin (Netlify Blobs) if there is one,
 * otherwise the JSON files in /src/content.
 */
export async function getContent(): Promise<{ content: Content; source: 'admin' | 'files' }> {
    const saved = await blobGet<unknown>(STORE, KEY);
    if (saved) {
        try {
            return { content: validateContent(saved), source: 'admin' };
        } catch (err) {
            console.error('[content] Saved content is invalid, using files instead:', err);
        }
    }
    return { content: fileContent(), source: 'files' };
}

export async function saveContent(input: unknown): Promise<Content> {
    const content = validateContent(input);
    await blobSet(STORE, KEY, content);
    return content;
}

export async function resetContent(): Promise<void> {
    await blobDelete(STORE, KEY);
}

// ---------- validation ----------

class ContentError extends Error {}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const DIFFICULTIES: Difficulty[] = ['Easy', 'Medium', 'Hard'];

function str(v: unknown, field: string, max = 2000, required = true): string {
    if (v === undefined || v === null) v = '';
    if (typeof v !== 'string') throw new ContentError(`${field} must be text`);
    const s = v.trim();
    if (required && !s) throw new ContentError(`${field} is required`);
    if (s.length > max) throw new ContentError(`${field} is too long (max ${max})`);
    return s;
}

function id(v: unknown, field: string): string {
    const s = str(v, field, 80);
    if (!ID_RE.test(s)) throw new ContentError(`${field} "${s}" must use lowercase letters, numbers and dashes`);
    return s;
}

function arr(v: unknown, field: string): unknown[] {
    if (!Array.isArray(v)) throw new ContentError(`${field} must be a list`);
    return v;
}

function obj(v: unknown, field: string): Record<string, unknown> {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ContentError(`${field} must be an object`);
    return v as Record<string, unknown>;
}

function unique(ids: string[], what: string) {
    const seen = new Set<string>();
    for (const i of ids) {
        if (seen.has(i)) throw new ContentError(`Duplicate ${what} id "${i}"`);
        seen.add(i);
    }
}

export function validateContent(input: unknown): Content {
    const root = obj(input, 'content');

    const regions: Region[] = arr(root.regions, 'regions').map((r, i) => {
        const o = obj(r, `regions[${i}]`);
        return { id: id(o.id, `Region ${i + 1} id`), name: str(o.name, `Region ${i + 1} name`, 80) };
    });
    unique(
        regions.map((r) => r.id),
        'region'
    );
    const regionIds = new Set(regions.map((r) => r.id));

    const categories: Category[] = arr(root.categories, 'categories').map((c, ci) => {
        const o = obj(c, `categories[${ci}]`);
        const name = str(o.name, `Category ${ci + 1} name`, 80);
        return {
            id: id(o.id, `Category "${name}" id`),
            name,
            blurb: str(o.blurb, `Category "${name}" description`, 200, false),
            items: arr(o.items ?? [], `Category "${name}" items`).map((it, ii) => {
                const io = obj(it, `item ${ii + 1}`);
                const itemName = str(io.name, `Item ${ii + 1} name in "${name}"`, 120);
                const region = str(io.region, `Region for "${itemName}"`, 80, false);
                if (region && !regionIds.has(region)) throw new ContentError(`"${itemName}" uses unknown region "${region}"`);
                return {
                    id: id(io.id, `Item "${itemName}" id`),
                    name: itemName,
                    region,
                    tip: str(io.tip, `Tip for "${itemName}"`, 500, false)
                };
            })
        };
    });
    unique(
        categories.map((c) => c.id),
        'category'
    );
    unique(
        categories.flatMap((c) => c.items.map((i) => i.id)),
        'checklist item'
    );

    const money: MoneyMethod[] = arr(root.money, 'money').map((m, mi) => {
        const o = obj(m, `money[${mi}]`);
        const title = str(o.title, `Money method ${mi + 1} title`, 120);
        const difficulty = str(o.difficulty, `Difficulty for "${title}"`, 10) as Difficulty;
        if (!DIFFICULTIES.includes(difficulty)) throw new ContentError(`Difficulty for "${title}" must be Easy, Medium or Hard`);
        return {
            id: id(o.id, `Money method "${title}" id`),
            title,
            payout: str(o.payout, `Payout for "${title}"`, 80, false),
            time: str(o.time, `Time for "${title}"`, 80, false),
            difficulty,
            unlock: str(o.unlock, `Unlock requirement for "${title}"`, 200, false),
            steps: arr(o.steps ?? [], `Steps for "${title}"`)
                .map((s, si) => str(s, `Step ${si + 1} for "${title}"`, 500, false))
                .filter(Boolean)
        };
    });
    unique(
        money.map((m) => m.id),
        'money method'
    );

    const guides: Guide[] = arr(root.guides, 'guides').map((g, gi) => {
        const o = obj(g, `guides[${gi}]`);
        const title = str(o.title, `Guide ${gi + 1} title`, 120);
        return {
            slug: id(o.slug, `Guide "${title}" URL slug`),
            title,
            summary: str(o.summary, `Summary for "${title}"`, 200, false),
            updated: str(o.updated, `Updated date for "${title}"`, 40, false),
            body: str(o.body, `Body for "${title}"`, 50000, false)
        };
    });
    unique(
        guides.map((g) => g.slug),
        'guide'
    );

    return { regions, categories, money, guides };
}

export function isContentError(err: unknown): err is Error {
    return err instanceof ContentError;
}
