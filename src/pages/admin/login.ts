import type { APIRoute } from 'astro';
import { getSecret } from 'astro:env/server';
import { ADMIN_COOKIE, safeEqual, sessionSecret, setSignedCookie } from '../../lib/session';

export const POST: APIRoute = async ({ request, cookies, redirect, url }) => {
    const expected = getSecret('ADMIN_PASSWORD');
    if (!expected || !sessionSecret()) return redirect('/admin?error=config', 303);

    const form = await request.formData();
    const password = String(form.get('password') ?? '');
    // Small fixed delay slows down password guessing.
    await new Promise((r) => setTimeout(r, 400));
    if (!(await safeEqual(password, expected))) return redirect('/admin?error=password', 303);

    await setSignedCookie(cookies, ADMIN_COOKIE, { admin: true, exp: Date.now() + 12 * 3600 * 1000 }, url.protocol === 'https:');
    return redirect('/admin', 303);
};
