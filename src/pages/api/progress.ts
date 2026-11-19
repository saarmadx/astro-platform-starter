import type { APIRoute } from 'astro';
import { blobGet, blobSet } from '../../lib/store';
import { cleanProgress, emptyProgress } from '../../lib/progress';
import type { Progress } from '../../lib/types';

const STORE = 'leonida-progress';
const MAX_BYTES = 256 * 1024;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const GET: APIRoute = async ({ locals }) => {
    const saved = await blobGet<Progress>(STORE, locals.user!.uid);
    return json(saved ?? emptyProgress());
};

export const PUT: APIRoute = async ({ request, locals }) => {
    const text = await request.text();
    if (text.length > MAX_BYTES) return json({ error: 'Progress is too large' }, 413);
    let progress: Progress;
    try {
        progress = cleanProgress(JSON.parse(text));
    } catch {
        return json({ error: 'Invalid progress data' }, 400);
    }
    // Never let a client clock far in the future pin the record.
    progress.updatedAt = Math.min(progress.updatedAt, Date.now() + 60_000);
    await blobSet(STORE, locals.user!.uid, progress);
    return json({ ok: true, updatedAt: progress.updatedAt });
};
