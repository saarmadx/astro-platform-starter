// One queue for every export. Renders run one at a time (the video engine can only do one
// render well at once) and keep going while you edit other clips or switch pages.
import { useSyncExternalStore } from 'react';

export type ExportJob = {
    id: string;
    /** shown in the queue panel */
    label: string;
    /** project/clip it belongs to, so the editor can show its own progress */
    projectId: string;
    clipId?: string;
    /** jobs added together by "Export all" share a group */
    group?: string;
    status: 'waiting' | 'rendering' | 'done' | 'error';
    progress: number;
    error?: string;
    /** makes the file; the result is downloaded as `filename` */
    run: (onProgress: (r: number) => void) => Promise<Blob>;
    filename: string;
    save: (blob: Blob, name: string) => void;
};

let jobs: ExportJob[] = [];
const listeners = new Set<() => void>();
let running = false;

function emit() {
    jobs = [...jobs];
    listeners.forEach((l) => l());
}
function patch(id: string, p: Partial<ExportJob>) {
    const j = jobs.find((x) => x.id === id);
    if (j) Object.assign(j, p);
    emit();
}

async function pump() {
    if (running) return;
    running = true;
    try {
        for (;;) {
            const next = jobs.find((j) => j.status === 'waiting');
            if (!next) break;
            patch(next.id, { status: 'rendering', progress: 0 });
            let last = 0;
            try {
                const blob = await next.run((r) => {
                    // fewer re-renders: only report whole-percent changes
                    if (Math.abs(r - last) >= 0.01 || r >= 1) {
                        last = r;
                        patch(next.id, { progress: r });
                    }
                });
                next.save(blob, next.filename);
                patch(next.id, { status: 'done', progress: 1 });
            } catch (e) {
                patch(next.id, { status: 'error', error: (e as Error).message || 'Export failed' });
            }
        }
    } finally {
        running = false;
    }
}

let n = 0;
export function enqueueExport(job: Omit<ExportJob, 'id' | 'status' | 'progress'>): string {
    const id = `x${Date.now().toString(36)}${n++}`;
    jobs.push({ ...job, id, status: 'waiting', progress: 0 });
    emit();
    void pump();
    return id;
}

export function retryExport(id: string) {
    patch(id, { status: 'waiting', progress: 0, error: undefined });
    void pump();
}
export function removeExport(id: string) {
    jobs = jobs.filter((j) => j.id !== id || j.status === 'rendering');
    emit();
}
export function clearFinishedExports() {
    jobs = jobs.filter((j) => j.status === 'waiting' || j.status === 'rendering');
    emit();
}
/** true while anything is waiting or rendering (used to warn before closing the tab) */
export const exportsBusy = () => jobs.some((j) => j.status === 'waiting' || j.status === 'rendering');

const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
};
const snapshot = () => jobs;
export function useExportJobs(): ExportJob[] {
    return useSyncExternalStore(subscribe, snapshot, snapshot);
}
