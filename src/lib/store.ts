// Projects are kept in the browser (IndexedDB) so you can come back to them.
// The video itself is not stored; re-select the same file to keep editing.
import type { Brand, Project } from './types';

const DB = 'clipsmith';
const STORE = 'projects';

function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await open();
    return new Promise((resolve, reject) => {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export const listProjects = async () => ((await tx('readonly', (s) => s.getAll())) as Project[]).sort((a, b) => b.createdAt - a.createdAt);
export const saveProject = (p: Project) => tx('readwrite', (s) => s.put(p)).catch(() => undefined);
export const deleteProject = (id: string) => tx('readwrite', (s) => s.delete(id)).catch(() => undefined);

const BRAND_KEY = 'clipsmith.brand';
export const DEFAULT_BRAND: Brand = { logoCorner: 'tr', logoSize: 0.16, accent: '#c8ff3d' };

export function loadBrand(): Brand {
    try {
        return { ...DEFAULT_BRAND, ...JSON.parse(localStorage.getItem(BRAND_KEY) ?? '{}') };
    } catch {
        return DEFAULT_BRAND;
    }
}
export function saveBrand(b: Brand) {
    try {
        localStorage.setItem(BRAND_KEY, JSON.stringify(b));
    } catch {}
}
