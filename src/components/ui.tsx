import { useEffect, useState } from 'react';
import { clearFinishedExports, exportsBusy, removeExport, retryExport, useExportJobs } from '../lib/exportQueue';
import type { CaptionTemplate } from '../lib/templates';

export function fmt(t: number) {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

export function scoreTone(score: number) {
    if (score >= 85) return 'bg-accent text-ink';
    if (score >= 70) return 'bg-amber-300 text-ink';
    return 'bg-white/20 text-white';
}

/** A small tile showing what a caption template looks like. */
export function TemplateSwatch({ template, highlight, selected, onClick }: { template: CaptionTemplate; highlight: string; selected: boolean; onClick: () => void }) {
    const word = (w: string) => (template.uppercase ? w.toUpperCase() : w);
    const stroke = template.outline ? `${Math.max(1, template.outline * 12)}px #000` : undefined;
    const base: React.CSSProperties = { fontFamily: template.cssFont, WebkitTextStroke: stroke, paintOrder: 'stroke fill', color: template.color };
    const activeStyle: React.CSSProperties =
        template.active === 'color' ? { color: highlight } : template.active === 'box' ? { background: highlight, borderRadius: 6, padding: '0 4px', WebkitTextStroke: undefined } : {};
    return (
        <button onClick={onClick} className={`flex h-16 flex-col items-center justify-center gap-1 rounded-xl border bg-gradient-to-b from-slate-700/60 to-slate-900/80 px-1 ${selected ? 'border-accent ring-1 ring-accent' : 'border-white/10 hover:border-white/30'}`}>
            {template.id === 'none' ? (
                <span className="text-xs text-muted">No captions</span>
            ) : (
                <span className={`text-[15px] leading-none ${template.lineBox ? 'rounded bg-black/70 px-1.5 py-1' : ''}`} style={base}>
                    {word('so')} <span style={activeStyle}>{word('good')}</span>
                </span>
            )}
            <span className="text-[10px] font-medium text-muted">{template.name}</span>
        </button>
    );
}

export function Bar({ label, value }: { label: string; value: number }) {
    return (
        <div className="flex items-center gap-2 text-xs">
            <span className="w-20 shrink-0 text-muted">{label}</span>
            <span className="h-1.5 grow overflow-hidden rounded-full bg-white/10">
                <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
            </span>
            <span className="w-7 text-right tabular-nums">{value}</span>
        </div>
    );
}

/** Small floating panel with the export queue; shows on every page while there are exports. */
export function ExportQueuePanel() {
    const jobs = useExportJobs();
    const [open, setOpen] = useState(false);
    useEffect(() => {
        // closing the tab would stop the renders
        const warn = (e: BeforeUnloadEvent) => {
            if (exportsBusy()) e.preventDefault();
        };
        window.addEventListener('beforeunload', warn);
        return () => window.removeEventListener('beforeunload', warn);
    }, []);
    if (!jobs.length) return null;
    const now = jobs.find((j) => j.status === 'rendering');
    const left = jobs.filter((j) => j.status === 'waiting' || j.status === 'rendering').length;
    const failed = jobs.filter((j) => j.status === 'error').length;
    const summary = now ? `Exporting · ${Math.round(now.progress * 100)}% · ${left} left` : failed ? `${failed} export${failed > 1 ? 's' : ''} failed` : 'Exports done ✓';
    return (
        <div className="fixed right-3 bottom-3 z-50 w-72 max-w-[calc(100vw-1.5rem)] rounded-xl border border-white/10 bg-surface/95 text-sm shadow-2xl backdrop-blur" data-export-queue>
            <button className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left" onClick={() => setOpen(!open)}>
                <span className={`font-semibold ${failed && !now ? 'text-red-300' : ''}`}>{summary}</span>
                <span className="text-xs text-muted">{open ? 'Hide' : 'Show'}</span>
            </button>
            {now && !open && <div className="mx-3 mb-2 h-1 overflow-hidden rounded bg-white/10"><div className="h-full bg-accent" style={{ width: `${now.progress * 100}%` }} /></div>}
            {open && (
                <div className="flex max-h-64 flex-col gap-1 overflow-y-auto border-t border-white/10 p-2">
                    {jobs.map((j) => (
                        <div key={j.id} className="rounded-lg bg-white/[0.04] px-2 py-1.5">
                            <div className="flex items-center justify-between gap-2">
                                <span className="truncate">{j.label}</span>
                                <span className="shrink-0 text-xs text-muted">
                                    {j.status === 'rendering' ? `${Math.round(j.progress * 100)}%` : j.status === 'waiting' ? 'waiting' : j.status === 'done' ? 'done ✓' : 'failed'}
                                </span>
                            </div>
                            {j.status === 'rendering' && <div className="mt-1 h-1 overflow-hidden rounded bg-white/10"><div className="h-full bg-accent" style={{ width: `${j.progress * 100}%` }} /></div>}
                            {j.status === 'error' && (
                                <div className="mt-1 flex items-center justify-between gap-2 text-xs">
                                    <span className="truncate text-red-300" title={j.error}>{j.error}</span>
                                    <span className="flex shrink-0 gap-2">
                                        <button className="text-accent" onClick={() => retryExport(j.id)}>Retry</button>
                                        <button className="text-muted" onClick={() => removeExport(j.id)}>Remove</button>
                                    </span>
                                </div>
                            )}
                            {j.status === 'waiting' && <button className="text-xs text-muted hover:text-white" onClick={() => removeExport(j.id)}>Cancel</button>}
                        </div>
                    ))}
                    {jobs.some((j) => j.status === 'done' || j.status === 'error') && (
                        <button className="mt-1 text-xs text-muted hover:text-white" onClick={clearFinishedExports}>Clear finished</button>
                    )}
                </div>
            )}
        </div>
    );
}
