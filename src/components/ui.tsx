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
