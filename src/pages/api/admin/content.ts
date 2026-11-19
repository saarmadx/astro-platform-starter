import type { APIRoute } from 'astro';
import { fileContent, getContent, isContentError, resetContent, saveContent } from '../../../lib/content';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const GET: APIRoute = async ({ url }) => {
    if (url.searchParams.get('from') === 'files') return json({ content: fileContent(), source: 'files' });
    return json(await getContent());
};

export const PUT: APIRoute = async ({ request }) => {
    try {
        const content = await saveContent(await request.json());
        return json({ ok: true, content, source: 'admin' });
    } catch (err) {
        if (isContentError(err)) return json({ error: err.message }, 400);
        if (err instanceof SyntaxError) return json({ error: 'Invalid JSON' }, 400);
        throw err;
    }
};

/** Discards admin edits so the site uses the JSON files in /src/content again. */
export const DELETE: APIRoute = async () => {
    await resetContent();
    return json({ ok: true, content: fileContent(), source: 'files' });
};
