import { useEffect, useMemo, useRef, useState } from 'react';
import { groupTimes, type DWord } from '../lib/captions';
import { replayLength } from '../lib/fx';
import { SFX_KINDS } from '../lib/sfx';
import { mergeSpans, pieces, subtractSpan } from '../lib/timeline';
import type { AudioEvent, Clip, Energy, Span } from '../lib/types';
import { fmt } from './ui';

export type Selection =
    | { type: 'piece' | 'cut' | 'zoom' | 'caption' | 'sfx' | 'shake' | 'sticker'; i: number }
    | null;

type Props = {
    clip: Clip;
    duration: number;
    time: number;
    playing: boolean;
    groups: DWord[][];
    energy?: Energy;
    events: AudioEvent[];
    bleeps: Span[];
    thumbs: { t: number; url: string }[];
    selection: Selection;
    setSelection: (s: Selection) => void;
    onSeek: (t: number) => void;
    onTogglePlay: () => void;
    onChange: (patch: Partial<Clip>) => void;
    onUndo: () => void;
    canUndo: boolean;
    onRedo: () => void;
    canRedo: boolean;
    onRemoveSilences: () => void;
    outputTime: number;
    outputLength: number;
};

const TRACK_H = { ruler: 22, video: 56, captions: 34, text: 26, effects: 30, audio: 34 };
const LABEL_W = 72;

export default function Timeline(p: Props) {
    const { clip } = p;
    const scrollRef = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(800);
    const [zoom, setZoom] = useState(1);
    const drag = useRef<null | { kind: string; startX: number; orig: Clip; index?: number }>(null);

    // visible window: the clip plus some context either side
    const winStart = Math.max(0, clip.start - 10);
    const tail = replayLength(clip) + (clip.freeze?.seconds ?? 0); // replay and freeze play after the clip
    const winEnd = Math.max(Math.min(p.duration, clip.end + 10), clip.end + tail + 1);
    const span = Math.max(1, winEnd - winStart);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() => setWidth(el.clientWidth - LABEL_W));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const pps = (Math.max(200, width) / span) * zoom; // pixels per second
    const X = (t: number) => (t - winStart) * pps;
    const T = (x: number) => winStart + x / pps;
    const total = span * pps;

    // keep the playhead in view while playing
    useEffect(() => {
        const el = scrollRef.current;
        if (!el || !p.playing) return;
        const x = X(p.time) + LABEL_W;
        if (x < el.scrollLeft + LABEL_W || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = x - LABEL_W - 60;
    }, [p.time, p.playing]);

    const ps = useMemo(() => pieces(clip), [clip.start, clip.end, clip.splits, clip.cuts]);
    const cuts = clip.cuts ?? [];
    const zooms = clip.zooms ?? [];
    const capTimes = useMemo(() => groupTimes(p.groups), [p.groups]);

    // ---------- actions ----------
    function split() {
        if (p.time <= clip.start + 0.1 || p.time >= clip.end - 0.1) return;
        p.onChange({ splits: [...(clip.splits ?? []), p.time].sort((a, b) => a - b) });
    }
    function deleteSelection() {
        const s = p.selection;
        if (!s) return;
        if (s.type === 'piece') {
            const pc = ps[s.i];
            if (!pc) return;
            const kept = ps.filter((x, i) => i !== s.i && !x.cut).length;
            if (!pc.cut && kept === 0) return; // never cut everything
            p.onChange({ cuts: pc.cut ? subtractSpan(cuts, pc) : mergeSpans([...cuts, { start: pc.start, end: pc.end }]) });
        } else if (s.type === 'cut') p.onChange({ cuts: cuts.filter((_, i) => i !== s.i) });
        else if (s.type === 'zoom') p.onChange({ zooms: zooms.filter((_, i) => i !== s.i) });
        else if (s.type === 'sfx') p.onChange({ sfx: (clip.sfx ?? []).filter((_, i) => i !== s.i) });
        else if (s.type === 'shake') p.onChange({ shakes: (clip.shakes ?? []).filter((_, i) => i !== s.i) });
        else if (s.type === 'sticker') p.onChange({ stickers: (clip.stickers ?? []).filter((_, i) => i !== s.i) });
        p.setSelection(null);
    }
    function addZoom() {
        const start = Math.max(clip.start, Math.min(p.time, clip.end - 0.5));
        const z = { start, end: Math.min(clip.end, start + 1.5), scale: 1.25 };
        p.onChange({ zooms: [...zooms, z].sort((a, b) => a.start - b.start) });
        p.setSelection({ type: 'zoom', i: [...zooms, z].sort((a, b) => a.start - b.start).indexOf(z) });
    }

    // keyboard shortcuts
    const keyRef = useRef({ split, deleteSelection, addZoom, ...p });
    keyRef.current = { split, deleteSelection, addZoom, ...p };
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement)?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            const k = keyRef.current;
            if (e.key === ' ') {
                e.preventDefault();
                k.onTogglePlay();
            } else if (e.key === 's' || e.key === 'S') k.split();
            else if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                k.deleteSelection();
            } else if (e.key === 'z' && !(e.ctrlKey || e.metaKey)) k.addZoom();
            else if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                k.onUndo();
            } else if (e.key === 'ArrowLeft') k.onSeek(k.time - (e.shiftKey ? 1 : 0.1));
            else if (e.key === 'ArrowRight') k.onSeek(k.time + (e.shiftKey ? 1 : 0.1));
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    // ---------- dragging ----------
    function startDrag(e: React.PointerEvent, kind: string, index?: number) {
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { kind, startX: e.clientX, orig: clip, index };
    }
    function onDragMove(e: React.PointerEvent) {
        const d = drag.current;
        if (!d) return;
        const dt = (e.clientX - d.startX) / pps;
        const o = d.orig;
        const snap = (t: number) => Math.round(t * 20) / 20;
        if (d.kind === 'trim-start') p.onChange({ start: snap(Math.max(0, Math.min(o.start + dt, o.end - 1))) });
        else if (d.kind === 'trim-end') p.onChange({ end: snap(Math.min(p.duration, Math.max(o.end + dt, o.start + 1))) });
        else if (d.kind.startsWith('zoom') && d.index !== undefined) {
            const z = (o.zooms ?? [])[d.index];
            if (!z) return;
            let { start, end } = z;
            if (d.kind === 'zoom-move') {
                const len = end - start;
                start = Math.max(o.start, Math.min(o.end - len, start + dt));
                end = start + len;
            } else if (d.kind === 'zoom-l') start = Math.max(o.start, Math.min(end - 0.2, start + dt));
            else end = Math.min(o.end, Math.max(start + 0.2, end + dt));
            const next = [...(o.zooms ?? [])];
            next[d.index] = { ...z, start: snap(start), end: snap(end) };
            p.onChange({ zooms: next });
        } else if (d.kind.startsWith('sticker') && d.index !== undefined) {
            const st = (o.stickers ?? [])[d.index];
            if (!st) return;
            let { start, end } = st;
            if (d.kind === 'sticker-move') {
                const len = end - start;
                start = Math.max(o.start, Math.min(o.end - len, start + dt));
                end = start + len;
            } else if (d.kind === 'sticker-l') start = Math.max(o.start, Math.min(end - 0.2, start + dt));
            else end = Math.min(o.end, Math.max(start + 0.2, end + dt));
            const next = [...(o.stickers ?? [])];
            next[d.index] = { ...st, start: snap(start), end: snap(end) };
            p.onChange({ stickers: next });
        } else if (d.kind === 'sfx-move' && d.index !== undefined) {
            const next = [...(o.sfx ?? [])];
            next[d.index] = { ...next[d.index], t: snap(Math.max(o.start, Math.min(o.end, next[d.index].t + dt))) };
            p.onChange({ sfx: next });
        } else if (d.kind === 'shake-move' && d.index !== undefined) {
            const next = [...(o.shakes ?? [])];
            next[d.index] = { ...next[d.index], t: snap(Math.max(o.start, Math.min(o.end, next[d.index].t + dt))) };
            p.onChange({ shakes: next });
        } else if (d.kind === 'title' && o.hookTitle) p.onChange({ hookTitle: { ...o.hookTitle, seconds: Math.max(0.5, Math.min(15, snap(o.hookTitle.seconds + dt))) } });
        else if (d.kind === 'freeze' && o.freeze) p.onChange({ freeze: { ...o.freeze, seconds: Math.max(0.5, Math.min(6, snap(o.freeze.seconds + dt))) } });
        else if (d.kind === 'scrub') {
            const rect = scrollRef.current!.getBoundingClientRect();
            p.onSeek(T(e.clientX - rect.left + scrollRef.current!.scrollLeft - LABEL_W));
        }
    }
    function endDrag() {
        drag.current = null;
    }

    function seekFromEvent(e: React.MouseEvent) {
        const rect = scrollRef.current!.getBoundingClientRect();
        p.onSeek(T(e.clientX - rect.left + scrollRef.current!.scrollLeft - LABEL_W));
    }

    // ruler ticks
    const step = pps > 120 ? 1 : pps > 40 ? 5 : pps > 12 ? 10 : 30;
    const ticks: number[] = [];
    for (let t = Math.ceil(winStart / step) * step; t <= winEnd; t += step) ticks.push(t);

    // audio waveform bars from loudness
    const bars = useMemo(() => {
        if (!p.energy) return [];
        const out: { t: number; v: number }[] = [];
        const stepT = Math.max(p.energy.step, 2 / pps);
        for (let t = winStart; t < winEnd; t += stepT) {
            const i = Math.floor(t / p.energy.step);
            const db = p.energy.db[i] ?? -90;
            out.push({ t, v: Math.max(0, Math.min(1, (db + 55) / 45)) });
        }
        return out;
    }, [p.energy, winStart, winEnd, pps]);

    const sel = p.selection;
    const selectedPiece = sel?.type === 'piece' ? ps[sel.i] : null;

    return (
        <div className="panel flex flex-col overflow-hidden select-none">
            {/* toolbar */}
            <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2 text-sm">
                <button className="tl-btn !w-10" onClick={p.onTogglePlay} aria-label={p.playing ? 'Pause' : 'Play'} title="Play / pause (Space)">
                    {p.playing ? '❚❚' : '▶'}
                </button>
                <span className="w-28 font-mono text-xs tabular-nums text-muted">
                    {fmt(p.outputTime)}.{String(Math.floor((p.outputTime % 1) * 10))} / {fmt(p.outputLength)}
                </span>
                <span className="mx-1 h-5 w-px bg-white/10" />
                <button className="tl-btn" onClick={split} title="Split at playhead (S)">✂ Split</button>
                <button className="tl-btn" onClick={deleteSelection} disabled={!sel || sel.type === 'caption'} title="Delete or restore the selected part (Delete)">
                    {selectedPiece?.cut || sel?.type === 'cut' ? '↺ Restore' : '🗑 Delete'}
                </button>
                <button className="tl-btn" onClick={addZoom} title="Add a punch-in zoom at the playhead (Z)">🔍 Zoom</button>
                <button className="tl-btn" onClick={p.onRemoveSilences} title="Cut out pauses between words">⏩ Remove silences</button>
                <button className="tl-btn" onClick={p.onUndo} disabled={!p.canUndo} title="Undo (Ctrl+Z)">↶ Undo</button>
                <button className="tl-btn" onClick={p.onRedo} disabled={!p.canRedo} title="Redo (Ctrl+Y)">↷ Redo</button>
                <span className="ml-auto flex items-center gap-2 text-xs text-muted">
                    Zoom
                    <input type="range" min={1} max={12} step={0.5} value={zoom} onChange={(e) => setZoom(+e.target.value)} className="w-24 accent-[var(--color-accent)]" aria-label="Timeline zoom" />
                </span>
            </div>

            {/* tracks */}
            <div ref={scrollRef} className="relative overflow-x-auto" onPointerMove={onDragMove} onPointerUp={endDrag}>
                <div className="relative" style={{ width: total + LABEL_W }}>
                    {/* labels */}
                    <div className="sticky left-0 z-20 float-left flex flex-col bg-surface text-[11px] font-semibold text-muted" style={{ width: LABEL_W }}>
                        <div style={{ height: TRACK_H.ruler }} />
                        <div className="flex items-center px-2" style={{ height: TRACK_H.video }}>Video</div>
                        <div className="flex items-center px-2" style={{ height: TRACK_H.captions }}>Captions</div>
                        <div className="flex items-center px-2" style={{ height: TRACK_H.text }}>Text</div>
                        <div className="flex items-center px-2" style={{ height: TRACK_H.effects }}>Effects</div>
                        <div className="flex items-center px-2" style={{ height: TRACK_H.audio }}>Audio</div>
                    </div>

                    <div className="relative" style={{ marginLeft: LABEL_W, width: total }}>
                        {/* ruler */}
                        <div className="relative cursor-ew-resize border-b border-white/10" style={{ height: TRACK_H.ruler }} onPointerDown={(e) => { startDrag(e, 'scrub'); seekFromEvent(e); }}>
                            {ticks.map((t) => (
                                <div key={t} className="absolute top-0 h-full border-l border-white/15 pl-1 text-[10px] text-muted" style={{ left: X(t) }}>
                                    {fmt(t)}
                                </div>
                            ))}
                        </div>

                        {/* video track */}
                        <div className="relative" style={{ height: TRACK_H.video }} onClick={seekFromEvent}>
                            <div className="absolute inset-y-1 left-0 flex overflow-hidden rounded opacity-30" style={{ width: total }}>
                                {p.thumbs.map((th, i) => (
                                    <img key={i} src={th.url} alt="" className="absolute top-0 h-full object-cover" style={{ left: X(th.t), width: Math.max(8, (p.thumbs[i + 1]?.t ?? th.t + 2) - th.t) * pps }} />
                                ))}
                            </div>
                            {ps.map((pc, i) => (
                                <div
                                    key={i}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        p.setSelection({ type: 'piece', i });
                                        p.onSeek(Math.max(pc.start, Math.min(pc.end - 0.05, T(e.clientX - (e.currentTarget.parentElement!.getBoundingClientRect().left)))));
                                    }}
                                    className={`absolute inset-y-1 overflow-hidden rounded border-2 ${sel?.type === 'piece' && sel.i === i ? 'border-white' : 'border-accent/80'} ${pc.cut ? 'tl-cut' : ''}`}
                                    style={{ left: X(pc.start), width: Math.max(2, (pc.end - pc.start) * pps) }}
                                >
                                    {p.thumbs
                                        .filter((th) => th.t >= pc.start - 2 && th.t < pc.end)
                                        .map((th, k) => (
                                            <img key={k} src={th.url} alt="" className="absolute top-0 h-full object-cover" style={{ left: X(th.t) - X(pc.start), width: 2 * pps + 1 }} />
                                        ))}
                                    {pc.cut && <span className="absolute inset-0 grid place-items-center text-xs font-bold text-red-200">CUT</span>}
                                </div>
                            ))}
                            {cuts.map((c, i) =>
                                ps.some((pc) => pc.cut && pc.start <= c.start + 0.01 && pc.end >= c.end - 0.01) ? null : (
                                    <div
                                        key={`c${i}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            p.setSelection({ type: 'cut', i });
                                        }}
                                        title="Cut part. Select it and press Restore to bring it back."
                                        className={`tl-cut absolute inset-y-1 rounded ${sel?.type === 'cut' && sel.i === i ? 'ring-2 ring-white' : ''}`}
                                        style={{ left: X(c.start), width: Math.max(3, (c.end - c.start) * pps) }}
                                    />
                                )
                            )}
                            <div className="absolute inset-y-0 z-10 w-3 -translate-x-1/2 cursor-ew-resize rounded bg-accent" style={{ left: X(clip.start) }} onPointerDown={(e) => startDrag(e, 'trim-start')} title="Drag to change the start" />
                            <div className="absolute inset-y-0 z-10 w-3 -translate-x-1/2 cursor-ew-resize rounded bg-accent" style={{ left: X(clip.end) }} onPointerDown={(e) => startDrag(e, 'trim-end')} title="Drag to change the end" />
                        </div>

                        {/* captions track */}
                        <div className="relative border-t border-white/5" style={{ height: TRACK_H.captions }} onClick={seekFromEvent}>
                            {p.groups.map((g, i) => (
                                <button
                                    key={i}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        p.setSelection({ type: 'caption', i });
                                        p.onSeek(capTimes[i].start + 0.01);
                                    }}
                                    className={`absolute inset-y-1 truncate rounded px-1 text-left text-[10px] leading-6 ${sel?.type === 'caption' && sel.i === i ? 'bg-white text-ink' : 'bg-sky-500/30 text-sky-50 hover:bg-sky-500/50'}`}
                                    style={{ left: X(capTimes[i].start), width: Math.max(4, (capTimes[i].end - capTimes[i].start) * pps - 1) }}
                                    title={g.map((w) => w.text).join(' ')}
                                >
                                    {g.map((w) => w.text).join(' ')}
                                </button>
                            ))}
                        </div>

                        {/* text track: hook title and stickers */}
                        <div className="relative border-t border-white/5" style={{ height: TRACK_H.text }} onClick={seekFromEvent}>
                            {clip.hookTitle && clip.hookTitle.seconds > 0 && clip.hookTitle.text.trim() && (
                                <div className="absolute inset-y-0.5 truncate rounded bg-white/85 pl-1 text-[10px] leading-5 font-bold text-ink" style={{ left: X(clip.start), width: clip.hookTitle.seconds * pps }} title="Hook title. Drag the right edge to change how long it shows.">
                                    T {clip.hookTitle.text}
                                    <span className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-ink/30" onPointerDown={(e) => startDrag(e, 'title')} />
                                </div>
                            )}
                            {(clip.stickers ?? []).map((st, i) => (
                                <div
                                    key={st.id}
                                    onPointerDown={(e) => {
                                        p.setSelection({ type: 'sticker', i });
                                        startDrag(e, 'sticker-move', i);
                                    }}
                                    onClick={(e) => e.stopPropagation()}
                                    className={`absolute inset-y-0.5 cursor-grab truncate rounded bg-amber-400/80 px-2 text-[10px] leading-5 font-bold text-ink ${sel?.type === 'sticker' && sel.i === i ? 'ring-2 ring-white' : ''}`}
                                    style={{ left: X(st.start), width: Math.max(10, (st.end - st.start) * pps) }}
                                    title="Text sticker. Drag to move, drag the edges to resize."
                                >
                                    ✎ {st.text}
                                    <span className="absolute inset-y-0 left-0 w-2 cursor-ew-resize" onPointerDown={(e) => { p.setSelection({ type: 'sticker', i }); startDrag(e, 'sticker-l', i); }} />
                                    <span className="absolute inset-y-0 right-0 w-2 cursor-ew-resize" onPointerDown={(e) => { p.setSelection({ type: 'sticker', i }); startDrag(e, 'sticker-r', i); }} />
                                </div>
                            ))}
                        </div>

                        {/* effects track */}
                        <div className="relative border-t border-white/5" style={{ height: TRACK_H.effects }} onClick={seekFromEvent}>
                            {p.events
                                .filter((e) => (e.type === 'reaction' || e.type === 'chat') && e.start >= winStart && e.start <= winEnd)
                                .map((e, i) => (
                                    <span key={`l${i}`} className="pointer-events-none absolute top-1 text-xs opacity-80" style={{ left: X(e.start) - 6 }} title={e.type === 'chat' ? `Chat spike: ${e.label}` : 'Laugh or reaction'}>
                                        {e.type === 'chat' ? '💬' : '😂'}
                                    </span>
                                ))}
                            {clip.replay && replayLength(clip) > 0 && (
                                <div className="absolute inset-y-1 truncate rounded bg-rose-500/70 pl-1 text-[10px] leading-5 font-bold" style={{ left: X(clip.end), width: replayLength(clip) * pps }} title="Instant replay (plays after the clip)">
                                    ⏪ Replay
                                </div>
                            )}
                            {zooms.map((z, i) => (
                                <div
                                    key={i}
                                    onPointerDown={(e) => {
                                        p.setSelection({ type: 'zoom', i });
                                        startDrag(e, 'zoom-move', i);
                                    }}
                                    onClick={(e) => e.stopPropagation()}
                                    className={`absolute inset-y-1 cursor-grab truncate rounded bg-fuchsia-500/60 px-2 text-[10px] leading-5 font-bold ${sel?.type === 'zoom' && sel.i === i ? 'ring-2 ring-white' : ''}`}
                                    style={{ left: X(z.start), width: Math.max(10, (z.end - z.start) * pps) }}
                                    title="Zoom. Drag to move, drag the edges to resize."
                                >
                                    🔍 {z.scale.toFixed(2)}×
                                    <span className="absolute inset-y-0 left-0 w-2 cursor-ew-resize" onPointerDown={(e) => { p.setSelection({ type: 'zoom', i }); startDrag(e, 'zoom-l', i); }} />
                                    <span className="absolute inset-y-0 right-0 w-2 cursor-ew-resize" onPointerDown={(e) => { p.setSelection({ type: 'zoom', i }); startDrag(e, 'zoom-r', i); }} />
                                </div>
                            ))}
                            {clip.freeze && clip.freeze.seconds > 0 && (
                                <div className="absolute inset-y-1 truncate rounded bg-cyan-400/60 pl-1 text-[10px] leading-5 font-bold" style={{ left: X(clip.end + replayLength(clip)), width: clip.freeze.seconds * pps }} title="Freeze ending. Drag the right edge to change its length.">
                                    ❄ {clip.freeze.text || 'Freeze'}
                                    <span className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-ink/30" onPointerDown={(e) => startDrag(e, 'freeze')} />
                                </div>
                            )}
                            {(clip.shakes ?? []).map((sh, i) => (
                                <button
                                    key={`sh${i}`}
                                    onPointerDown={(e) => {
                                        p.setSelection({ type: 'shake', i });
                                        startDrag(e, 'shake-move', i);
                                    }}
                                    onClick={(e) => e.stopPropagation()}
                                    className={`absolute top-0.5 z-10 grid size-5 -translate-x-1/2 cursor-grab place-items-center rounded bg-yellow-300 text-[11px] text-ink ${sel?.type === 'shake' && sel.i === i ? 'ring-2 ring-white' : ''}`}
                                    style={{ left: X(sh.t) }}
                                    title={sh.kind === 'flash' ? 'Flash' : sh.kind === 'both' ? 'Shake + flash' : 'Shake'}
                                >
                                    {sh.kind === 'flash' ? '✦' : '⚡'}
                                </button>
                            ))}
                        </div>

                        {/* audio track */}
                        <div className="relative border-t border-white/5" style={{ height: TRACK_H.audio }} onClick={seekFromEvent}>
                            {bars.map((b, i) => (
                                <div key={i} className={`absolute bottom-1 w-px ${b.t >= clip.start && b.t <= clip.end ? 'bg-emerald-300/70' : 'bg-white/15'}`} style={{ left: X(b.t), height: Math.max(1, b.v * (TRACK_H.audio - 6)) }} />
                            ))}
                            {(clip.sfx ?? []).map((sx, i) => (
                                <button
                                    key={`sx${i}`}
                                    onPointerDown={(e) => {
                                        p.setSelection({ type: 'sfx', i });
                                        startDrag(e, 'sfx-move', i);
                                    }}
                                    onClick={(e) => e.stopPropagation()}
                                    className={`absolute top-1 z-10 grid size-6 -translate-x-1/2 cursor-grab place-items-center rounded-full bg-sky-400 text-xs ${sel?.type === 'sfx' && sel.i === i ? 'ring-2 ring-white' : ''}`}
                                    style={{ left: X(sx.t) }}
                                    title={`Sound effect: ${SFX_KINDS.find((k) => k.id === sx.kind)?.label}. Drag to move.`}
                                >
                                    {SFX_KINDS.find((k) => k.id === sx.kind)?.icon}
                                </button>
                            ))}
                            {p.bleeps.map((b, i) => (
                                <div key={`b${i}`} className="absolute inset-y-1 rounded-sm bg-red-500/70" style={{ left: X(b.start), width: Math.max(3, (b.end - b.start) * pps) }} title="Bleep" />
                            ))}
                            {!p.energy && <span className="absolute inset-0 grid place-items-center text-[10px] text-muted">No waveform for this project</span>}
                        </div>

                        {/* dim outside the clip */}
                        <div className="pointer-events-none absolute top-[22px] bottom-0 left-0 bg-black/50" style={{ width: Math.max(0, X(clip.start)) }} />
                        <div className="pointer-events-none absolute top-[22px] bottom-0 bg-black/50" style={{ left: X(clip.end + tail), right: 0 }} />

                        {/* playhead */}
                        <div className="pointer-events-none absolute top-0 bottom-0 z-30 w-0.5 bg-white" style={{ left: X(p.time) }}>
                            <div className="-ml-[5px] h-3 w-3 rotate-45 bg-white" />
                        </div>
                    </div>
                </div>
            </div>
            <p className="border-t border-white/10 px-3 py-1.5 text-[11px] text-muted">
                Space play/pause · S split · Delete remove the selected item (or restore a cut part) · Z add zoom · ←/→ step · Ctrl+Z undo · Ctrl+Y redo · drag the green handles to trim
            </p>
        </div>
    );
}
