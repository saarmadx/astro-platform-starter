import type { APIRoute } from 'astro';
import { ADMIN_COOKIE } from '../../lib/session';

export const POST: APIRoute = ({ cookies, redirect }) => {
    cookies.delete(ADMIN_COOKIE, { path: '/' });
    return redirect('/admin', 303);
};
