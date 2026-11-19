import { defineMiddleware } from 'astro:middleware';
import { getSecret } from 'astro:env/server';
import { ADMIN_COOKIE, SESSION_COOKIE, setSignedCookie, verify, type AdminSession, type UserSession } from './lib/session';
import { hasProductAccess, whopConfig } from './lib/whop';

/** How often an active session re-confirms membership with Whop (needs WHOP_API_KEY). */
const RECHECK_MS = 6 * 60 * 60 * 1000;

const isMemberPath = (p: string) => p === '/app' || p.startsWith('/app/') || p.startsWith('/api/progress');
const isAdminApi = (p: string) => p.startsWith('/api/admin');

export const onRequest = defineMiddleware(async (ctx, next) => {
    const { pathname } = ctx.url;
    const secure = ctx.url.protocol === 'https:';
    ctx.locals.user = null;
    ctx.locals.isAdmin = false;

    // Local development shortcut — never active in a production build.
    const fake = import.meta.env.DEV ? getSecret('DEV_FAKE_USER') : undefined;
    if (fake) {
        ctx.locals.user = { uid: fake, name: 'Dev Raider' };
    } else {
        let session: UserSession | null = null;
        try {
            session = await verify<UserSession>(ctx.cookies.get(SESSION_COOKIE)?.value);
        } catch (err) {
            console.error('[auth]', (err as Error).message);
        }
        if (session && whopConfig().apiKey && Date.now() - session.checkedAt > RECHECK_MS) {
            try {
                if (await hasProductAccess(session.uid)) {
                    session = { ...session, checkedAt: Date.now() };
                    await setSignedCookie(ctx.cookies, SESSION_COOKIE, session, secure);
                } else {
                    ctx.cookies.delete(SESSION_COOKIE, { path: '/' });
                    session = null;
                    if (isMemberPath(pathname) && !pathname.startsWith('/api/')) return ctx.redirect('/?status=no-access');
                }
            } catch (err) {
                // Whop unreachable: keep the session for now and try again on the next request.
                console.error('[auth] access re-check failed:', (err as Error).message);
            }
        }
        if (session) ctx.locals.user = { uid: session.uid, name: session.name };
    }

    try {
        ctx.locals.isAdmin = Boolean(await verify<AdminSession>(ctx.cookies.get(ADMIN_COOKIE)?.value));
    } catch {
        ctx.locals.isAdmin = false;
    }

    if (isMemberPath(pathname) && !ctx.locals.user) {
        if (pathname.startsWith('/api/')) return json({ error: 'Not signed in' }, 401);
        return ctx.redirect('/');
    }
    if (isAdminApi(pathname) && !ctx.locals.isAdmin) return json({ error: 'Admin login required' }, 401);

    const res = await next();
    if (isMemberPath(pathname) || pathname.startsWith('/admin') || isAdminApi(pathname)) {
        res.headers.set('cache-control', 'private, no-store');
    }
    return res;
});

function json(body: unknown, status: number) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
