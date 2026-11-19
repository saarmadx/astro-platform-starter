import type { APIRoute } from 'astro';
import { OAUTH_COOKIE, SESSION_COOKIE, setSignedCookie, verify, type OAuthState, type UserSession } from '../../lib/session';
import { exchangeCode, fetchUser, hasProductAccess, whopConfig } from '../../lib/whop';

// With WHOP_API_KEY set, sessions last 30 days and membership is re-checked every few hours.
// Without it, members sign in again daily so cancelled memberships lose access.
const sessionDays = () => (whopConfig().apiKey ? 30 : 1);

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
    const saved = await verify<OAuthState>(cookies.get(OAUTH_COOKIE)?.value);
    cookies.delete(OAUTH_COOKIE, { path: '/' });

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (url.searchParams.get('error')) return redirect('/?status=cancelled');
    if (!saved || !code || !state || state !== saved.state) return redirect('/?status=login-failed');

    try {
        const token = await exchangeCode({ code, redirectUri: `${url.origin}/auth/callback`, verifier: saved.verifier });
        const user = await fetchUser(token);
        if (!(await hasProductAccess(user.id, token))) return redirect('/?status=no-access');

        const session: UserSession = { uid: user.id, name: user.name, checkedAt: Date.now(), exp: Date.now() + sessionDays() * 864e5 };
        await setSignedCookie(cookies, SESSION_COOKIE, session, url.protocol === 'https:');
        return redirect('/app');
    } catch (err) {
        console.error('[auth] callback failed:', (err as Error).message);
        return redirect('/?status=login-failed');
    }
};
