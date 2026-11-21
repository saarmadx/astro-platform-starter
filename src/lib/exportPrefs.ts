// Export quality settings, remembered in this browser and shared by "Export" and "Export all".
import type { Quality } from './video';

export type ExportPrefs = { quality: Quality; fps: 30 | 60 };
const KEY = 'clipsmith.export';
export const DEFAULT_EXPORT: ExportPrefs = { quality: 1080, fps: 30 };

export function loadExportPrefs(): ExportPrefs {
    try {
        const p = JSON.parse(localStorage.getItem(KEY) ?? '{}');
        return { quality: [720, 1080, 1440].includes(p.quality) ? p.quality : DEFAULT_EXPORT.quality, fps: p.fps === 60 ? 60 : 30 };
    } catch {
        return DEFAULT_EXPORT;
    }
}

export function saveExportPrefs(p: ExportPrefs) {
    try {
        localStorage.setItem(KEY, JSON.stringify(p));
    } catch {}
}
