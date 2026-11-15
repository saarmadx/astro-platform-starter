// Helpers shared by the API routes.

export function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' }
    });
}

/**
 * If APP_ACCESS_CODE is set, every API call must send it in the x-access-code header.
 * This stops strangers from spending your OpenAI / Anthropic credits.
 */
export function checkAccess(request: Request): Response | null {
    const code = process.env.APP_ACCESS_CODE;
    if (!code) return null;
    if (request.headers.get('x-access-code') === code) return null;
    return json({ error: 'Wrong or missing access code.' }, 401);
}
