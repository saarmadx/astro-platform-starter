import { getSecret } from 'astro:env/server';
import { b64url } from './session';

/**
 * "Sign in with Whop" (OAuth 2.0 authorization code + PKCE) and the membership check.
 *
 * Endpoints default to Whop's current OAuth/OIDC endpoints and can be overridden with env vars
 * (WHOP_OAUTH_AUTHORIZE_URL, WHOP_OAUTH_TOKEN_URL, WHOP_OAUTH_USERINFO_URL, WHOP_API_BASE)
 * without touching code.
 *
 * Access check: GET {WHOP_API_BASE}/users/{user_id}/access/{product_id}
 *   → { has_access: boolean, access_level: "no_access" | "customer" | "admin" }
 */

const DEFAULTS = {
    authorize: 'https://api.whop.com/oauth/authorize',
    token: 'https://api.whop.com/oauth/token',
    userinfo: 'https://api.whop.com/oauth/userinfo',
    apiBase: 'https://api.whop.com/api/v1',
    scopes: 'openid profile email'
};

export function whopConfig() {
    return {
        clientId: getSecret('WHOP_CLIENT_ID') ?? '',
        clientSecret: getSecret('WHOP_CLIENT_SECRET') ?? '',
        productId: getSecret('WHOP_PRODUCT_ID') ?? '',
        apiKey: getSecret('WHOP_API_KEY') ?? '',
        storeUrl: getSecret('WHOP_STORE_URL') || 'https://whop.com/',
        authorizeUrl: getSecret('WHOP_OAUTH_AUTHORIZE_URL') || DEFAULTS.authorize,
        tokenUrl: getSecret('WHOP_OAUTH_TOKEN_URL') || DEFAULTS.token,
        userinfoUrl: getSecret('WHOP_OAUTH_USERINFO_URL') || DEFAULTS.userinfo,
        apiBase: (getSecret('WHOP_API_BASE') || DEFAULTS.apiBase).replace(/\/+$/, ''),
        scopes: getSecret('WHOP_OAUTH_SCOPES') || DEFAULTS.scopes
    };
}

export function whopConfigured(): boolean {
    const c = whopConfig();
    return Boolean(c.clientId && c.clientSecret && c.productId);
}

export async function pkceChallenge(verifier: string): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return b64url(new Uint8Array(hash));
}

export async function authorizeUrl(opts: { redirectUri: string; state: string; verifier: string; nonce: string }): Promise<string> {
    const c = whopConfig();
    const url = new URL(c.authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', c.clientId);
    url.searchParams.set('redirect_uri', opts.redirectUri);
    url.searchParams.set('scope', c.scopes);
    url.searchParams.set('state', opts.state);
    url.searchParams.set('nonce', opts.nonce);
    url.searchParams.set('code_challenge', await pkceChallenge(opts.verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
}

export async function exchangeCode(opts: { code: string; redirectUri: string; verifier: string }): Promise<string> {
    const c = whopConfig();
    const res = await fetch(c.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: opts.code,
            redirect_uri: opts.redirectUri,
            client_id: c.clientId,
            client_secret: c.clientSecret,
            code_verifier: opts.verifier
        })
    });
    if (!res.ok) throw new Error(`Whop token exchange failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { access_token?: string };
    if (!data.access_token) throw new Error('Whop token response had no access_token');
    return data.access_token;
}

export interface WhopUser {
    id: string;
    name: string;
}

export async function fetchUser(accessToken: string): Promise<WhopUser> {
    const c = whopConfig();
    const headers = { authorization: `Bearer ${accessToken}`, accept: 'application/json' };

    // OIDC userinfo first, then the REST "me" endpoint as a fallback.
    for (const url of [c.userinfoUrl, `${c.apiBase}/users/me`]) {
        try {
            const res = await fetch(url, { headers });
            if (!res.ok) continue;
            const d = (await res.json()) as Record<string, unknown>;
            const id = String(d.sub ?? d.id ?? '');
            if (!id.startsWith('user_')) continue;
            const name = String(d.preferred_username ?? d.username ?? d.name ?? 'Raider');
            return { id, name };
        } catch {
            /* try next */
        }
    }
    throw new Error('Could not read the Whop user profile');
}

/**
 * True when the user owns the product. Uses WHOP_API_KEY when set (needed for background
 * re-checks), otherwise the user's own OAuth token.
 */
export async function hasProductAccess(userId: string, userToken?: string): Promise<boolean> {
    const c = whopConfig();
    const token = c.apiKey || userToken;
    if (!token) throw new Error('No Whop credential available to check access');
    const res = await fetch(`${c.apiBase}/users/${encodeURIComponent(userId)}/access/${encodeURIComponent(c.productId)}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' }
    });
    if (!res.ok) throw new Error(`Whop access check failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const d = (await res.json()) as { has_access?: boolean; access_level?: string };
    return d.has_access === true || d.access_level === 'customer' || d.access_level === 'admin';
}
