import { getStore } from '@netlify/blobs';

/**
 * Thin wrapper over Netlify Blobs. When Blobs isn't available (plain `astro dev`
 * without the Netlify CLI), it falls back to an in-memory map so the app still runs locally.
 */
const memory = new Map<string, Map<string, unknown>>();
let warned = false;

export async function blobGet<T>(storeName: string, key: string): Promise<T | null> {
    try {
        const store = getStore({ name: storeName, consistency: 'strong' });
        return ((await store.get(key, { type: 'json' })) as T | null) ?? null;
    } catch (err) {
        if (!import.meta.env.DEV) throw err;
        warnOnce(err);
        return (memory.get(storeName)?.get(key) as T | undefined) ?? null;
    }
}

export async function blobSet(storeName: string, key: string, value: unknown): Promise<void> {
    try {
        const store = getStore({ name: storeName, consistency: 'strong' });
        await store.setJSON(key, value);
    } catch (err) {
        if (!import.meta.env.DEV) throw err;
        warnOnce(err);
        if (!memory.has(storeName)) memory.set(storeName, new Map());
        memory.get(storeName)!.set(key, structuredClone(value));
    }
}

export async function blobDelete(storeName: string, key: string): Promise<void> {
    try {
        const store = getStore({ name: storeName, consistency: 'strong' });
        await store.delete(key);
    } catch (err) {
        if (!import.meta.env.DEV) throw err;
        warnOnce(err);
        memory.get(storeName)?.delete(key);
    }
}

function warnOnce(err: unknown) {
    if (warned) return;
    warned = true;
    console.warn('[store] Netlify Blobs unavailable, using in-memory store (dev only):', (err as Error)?.message);
}
