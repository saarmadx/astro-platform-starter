import type { AstroCookies } from 'astro';
import { getSecret } from 'astro:env/server';

/**
 * Signed cookies (HMAC-SHA256). The payload is readable but can't be forged without SESSION_SECRET.
 */

export const SESSION_COOKIE = 'l100_session';
export const ADMIN_COOKIE = 'l100_admin';
export const OAUTH_COOKIE = 'l100_oauth';

export interface UserSession {
    uid: string;
    name: string;
    /** When membership was last confirmed with Whop (ms). */
    checkedAt: number;
    exp: number;
}

export interface AdminSession {
    admin: true;
    exp: number;
}

export interface OAuthState {
    state: string;
    verifier: string;
    nonce: string;
    exp: number;
}

const enc = new TextEncoder();
let keyPromise: Promise<CryptoKey> | null = null;

export function sessionSecret(): string | undefined {
    const s = getSecret('SESSION_SECRET');
    return s && s.length >= 16 ? s : undefined;
}

function key(): Promise<CryptoKey> {
    const secret = sessionSecret();
    if (!secret) throw new Error('SESSION_SECRET is missing or shorter than 16 characters');
    keyPromise ??= crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    return keyPromise;
}

export function b64url(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
    const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function sign(payload: object): Promise<string> {
    const body = b64url(enc.encode(JSON.stringify(payload)));
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key(), enc.encode(body)));
    return `${body}.${b64url(sig)}`;
}

export async function verify<T extends { exp: number }>(token: string | undefined): Promise<T | null> {
    if (!token) return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    try {
        const ok = await crypto.subtle.verify('HMAC', await key(), fromB64url(sig), enc.encode(body));
        if (!ok) return null;
        const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as T;
        if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
        return payload;
    } catch {
        return null;
    }
}

export function cookieOptions(maxAgeSeconds: number, secure: boolean) {
    return { path: '/', httpOnly: true, sameSite: 'lax' as const, secure, maxAge: maxAgeSeconds };
}

export async function setSignedCookie<T extends { exp: number }>(cookies: AstroCookies, name: string, payload: T, secure: boolean) {
    const maxAge = Math.max(1, Math.floor((payload.exp - Date.now()) / 1000));
    cookies.set(name, await sign(payload), cookieOptions(maxAge, secure));
}

export function randomToken(bytes = 32): string {
    return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Constant-time string comparison (via HMAC of both values). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
    const k = await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const [ha, hb] = await Promise.all([crypto.subtle.sign('HMAC', k, enc.encode(a)), crypto.subtle.sign('HMAC', k, enc.encode(b))]);
    const x = new Uint8Array(ha);
    const y = new Uint8Array(hb);
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
    return diff === 0;
}
