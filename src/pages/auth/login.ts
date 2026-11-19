import type { APIRoute } from 'astro';
import { OAUTH_COOKIE, randomToken, sessionSecret, setSignedCookie } from '../../lib/session';
import { authorizeUrl, whopConfigured } from '../../lib/whop';

export const GET: APIRoute = async ({ url, cookies, redirect, locals }) => {
    if (locals.user) return redirect('/app');
    if (!whopConfigured() || !sessionSecret()) return redirect('/?status=not-configured');

    const state = randomToken();
    const verifier = randomToken(48);
    const nonce = randomToken();
    await setSignedCookie(cookies, OAUTH_COOKIE, { state, verifier, nonce, exp: Date.now() + 10 * 60 * 1000 }, url.protocol === 'https:');

    return redirect(await authorizeUrl({ redirectUri: `${url.origin}/auth/callback`, state, verifier, nonce }));
};
