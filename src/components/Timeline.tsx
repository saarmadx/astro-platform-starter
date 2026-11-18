// A Premiere-style timeline. Everything is shown in sequence time (the finished video), so a
// deleted part disappears and the rest closes up. Parts of the video are separate blocks on V1 that
// can be selected, trimmed, split with the razor and given their own layout.
import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from 'react';
import {
    Captions,
    Check,
    Layers,
    Magnet,
    Maximize2,
    MousePointer2,
    Music,
    Pause,
    Play,
    Redo2,
    Scissors,
    SkipBack,
    SkipForward,
    Sparkles,
    Trash2,
    Type,
    Undo2,
    Video,
    ZoomIn,
    ZoomOut,
    AudioLines,
    FastForward
} from 'lucide-react';
import { groupTimes, type DWord } from '../lib/captions';
import { replayLength } from '../lib/fx';
import { SFX_KINDS } from '../lib/sfx';
import { keptSegments, newSegId, segmentsOf, toOutput, toOutputClamped, toSource, withSegs } from '../lib/timeline';
import type { AudioEvent, Clip, Energy, Layout, Seg, Span, StyleSettings } from '../lib/types';

export type Selection =
    | { type: 'segs'; ids: string[] }
    | { type: 'zoom' | 'caption' | 'sfx' | 'shake' | 'sticker'; i: number }
    | null;

export type TimelineApi = { setPlayhead: (outT: number) => void };

type Props = {
    clip: Clip;
    style: StyleSettings;
    duration: number;
    playing: boolean;
    groups: DWord[][];
    energy?: Energy;
    events: AudioEvent[];
    bleeps: Span[];
    thumbs: { t: number; url: string }[];
    hasMusic: boolean;
    selection: Selection;
    setSelection: (s: Selection) => void;
    getOutTime: () => number;
    onSeekOut: (outT: number) => void;
    onTogglePlay: () => void;
    onPlay: () => void;
    onPause: () => void;
    /** call once before a change that should be undoable (e.g. at the start of a drag) */
    onBeginEdit: () => void;
    /** apply a change without adding a new undo step */
    onUpdate: (patch: Partial<Clip>) => void;
    onUndo: () => void;
    onRedo: () => void;
    canUndo: boolean;
    canRedo: boolean;
};

export const LAYOUTS: { id: Layout | 'default'; label: string; short: string }[] = [
    { id: 'default', label: 'Project default', short: 'Default' },
    { id: 'split', label: 'Facecam + gameplay', short: 'Facecam' },
    { id: 'pip', label: 'Gameplay + facecam bubble', short: 'PiP' },
    { id: 'auto', label: 'Full screen, follow speaker', short: 'Full' },
    { id: 'manual', label: 'Full screen, fixed position', short: 'Fixed' },
    { id: 'fit', label: 'Whole frame + blur', short: 'Fit' }
];
const layoutName = (l: Layout) => LAYOUTS.find((x) => x.id === l)?.short ?? l;

const HEAD_W = 92;
const PAD = 16;
const FPS = 30;
const TRACKS = [
    { id: 'ruler', h: 30 },
    { id: 'text', h: 34, label: 'T1', name: 'Titles', icon: Type },
    { id: 'fx', h: 34, label: 'FX', name: 'Effects', icon: Sparkles },
    { id: 'video', h: 64, label: 'V1', name: 'Video', icon: Video },
    { id: 'cc', h: 34, label: 'CC', name: 'Captions', icon: Captions },
    { id: 'a1', h: 48, label: 'A1', name: 'Audio', icon: AudioLines },
    { id: 'a2', h: 30, label: 'A2', name: 'SFX', icon: Music }
] as const;
const top = (id: string) => {
    let y = 0;
    for (const t of TRACKS) {
        if (t.id === id) return y;
        y += t.h;
    }
    return y;
};
const trackH = (id: string) => TRACKS.find((t) => t.id === id)!.h;
const TOTAL_H = TRACKS.reduce((a, t) => a + t.h, 0);

export function timecode(t: number) {
    const s = Math.max(0, t);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const f = Math.floor((s - Math.floor(s)) * FPS);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}
const snapFrame = (t: number) => Math.round(t * FPS) / FPS;

const Timeline = forwardRef<TimelineApi, Props>(function Timeline(p, ref) {
    const { clip } = p;
    const scrollRef = useRef<HTMLDivElement>(null);
    const playheadRef = useRef<HTMLDivElement>(null);
    const timecodeRef = useRef<HTMLSpanElement>(null);
    const waveRef = useRef<HTMLCanvasElement>(null);
    const razorLineRef = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(900);
    const [zoom, setZoom] = useState(1);
    const [tool, setTool] = useState<'select' | 'razor'>('select');
    const [snap, setSnap] = useState(true);
    const [menu, setMenu] = useState<null | { x: number; y: number; segId: string }>(null);
    const [viewX, setViewX] = useState(0);
    const scrollRaf = useRef(0);
    const drag = useRef<null | { kind: string; startX: number; orig: Clip; index?: number; segId?: string; moved: boolean }>(null);
    const outNow = useRef(0);

    const segs = useMemo(() => segmentsOf(clip), [clip]);
    const spans = useMemo(() => keptSegments(clip), [clip]);
    const outLen = spans.reduce((a, s) => a + s.end - s.start, 0);
    const replay = replayLength(clip);
    const freeze = clip.freeze && clip.freeze.seconds > 0 ? clip.freeze.seconds : 0;
    const seqLen = outLen + replay + freeze;

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() => setWidth(el.clientWidth - HEAD_W));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const fitPps = Math.max(0.05, (Math.max(300, width) - PAD * 2) / Math.max(4, seqLen + 0.5));
    // long videos need much more zoom to reach frame level
    const MAXZ = Math.max(40, 300 / fitPps);
    const maxZRef = useRef(MAXZ);
    maxZRef.current = MAXZ;
    const pps = fitPps * zoom;
    const X = useCallback((outT: number) => PAD + outT * pps, [pps]);
    const contentW = PAD * 2 + Math.max(seqLen + 2, 4) * pps;
    const outOf = (src: number) => toOutputClamped(clip, src, spans);
    const srcOf = (out: number) => toSource(clip, out, spans);
    const segOut = useMemo(() => {
        let acc = 0;
        return segs.map((s) => {
            const r = { seg: s, start: acc, end: acc + (s.end - s.start) };
            acc = r.end;
            return r;
        });
    }, [segs]);

    // playhead and timecode move every frame without re-rendering React
    useImperativeHandle(ref, () => ({
        setPlayhead(outT: number) {
            outNow.current = outT;
            if (playheadRef.current) playheadRef.current.style.transform = `translateX(${X(outT)}px)`;
            if (timecodeRef.current) timecodeRef.current.textContent = timecode(outT);
            const el = scrollRef.current;
            if (el && p.playing) {
                const x = X(outT);
                if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - HEAD_W - 40) el.scrollLeft = Math.max(0, x - 80);
            }
        }
    }));
    useEffect(() => {
        if (playheadRef.current) playheadRef.current.style.transform = `translateX(${X(outNow.current)}px)`;
    }, [X]);

    // ---------- editing ----------
    const selectedIds = p.selection?.type === 'segs' ? p.selection.ids : [];
    const commitSegs = (next: Seg[], begin = true) => {
        if (begin) p.onBeginEdit();
        p.onUpdate(withSegs(clip, next));
    };

    function splitAt(outT: number) {
        const t = snapFrame(outT);
        const hit = segOut.find((r) => t > r.start + 0.05 && t < r.end - 0.05);
        if (!hit) return;
        const at = hit.seg.start + (t - hit.start);
        const next = segs.flatMap((s) => (s.id === hit.seg.id ? [{ ...s, end: at }, { ...s, id: newSegId(), start: at }] : [s]));
        commitSegs(next);
    }

    function rippleDelete(ids: string[]) {
        const next = segs.filter((s) => !ids.includes(s.id));
        if (!next.length) return; // never delete everything
        commitSegs(next);
        p.setSelection(null);
    }

    function setLayout(ids: string[], layout: Layout | 'default') {
        commitSegs(segs.map((s) => (ids.includes(s.id) ? { ...s, layout: layout === 'default' ? undefined : layout } : s)));
    }

    function deleteSelection() {
        const s = p.selection;
        if (!s) return;
        if (s.type === 'segs') return rippleDelete(s.ids);
        p.onBeginEdit();
        if (s.type === 'zoom') p.onUpdate({ zooms: (clip.zooms ?? []).filter((_, i) => i !== s.i) });
        else if (s.type === 'sfx') p.onUpdate({ sfx: (clip.sfx ?? []).filter((_, i) => i !== s.i) });
        else if (s.type === 'shake') p.onUpdate({ shakes: (clip.shakes ?? []).filter((_, i) => i !== s.i) });
        else if (s.type === 'sticker') p.onUpdate({ stickers: (clip.stickers ?? []).filter((_, i) => i !== s.i) });
        p.setSelection(null);
    }

    function addZoomAtPlayhead() {
        const start = srcOf(outNow.current);
        const z = { start, end: srcOf(Math.min(outLen, outNow.current + 1.5)), scale: 1.25 };
        const list = [...(clip.zooms ?? []), z].sort((a, b) => a.start - b.start);
        p.onBeginEdit();
        p.onUpdate({ zooms: list });
        p.setSelection({ type: 'zoom', i: list.indexOf(z) });
    }

    const editPoints = useMemo(() => [0, ...segOut.map((r) => r.end), seqLen], [segOut, seqLen]);
    const fit = () => {
        setZoom(1);
        if (scrollRef.current) scrollRef.current.scrollLeft = 0;
    };

    // ---------- keyboard (Premiere-style) ----------
    const keys = useRef({ splitAt, deleteSelection, addZoomAtPlayhead, fit, p, editPoints, outLen });
    keys.current = { splitAt, deleteSelection, addZoomAtPlayhead, fit, p, editPoints, outLen };
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement)?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            const k = keys.current;
            const ctrl = e.ctrlKey || e.metaKey;
            const now = outNow.current;
            const key = e.key.toLowerCase();
            if (e.key === ' ') {
                e.preventDefault();
                k.p.onTogglePlay();
            } else if (key === 'k' && ctrl) {
                e.preventDefault();
                k.splitAt(now);
            } else if (key === 'k') k.p.onPause();
            else if (key === 'l') k.p.onPlay();
            else if (key === 'j') {
                k.p.onPause();
                k.p.onSeekOut(Math.max(0, now - 1));
            } else if (key === 'v' && !ctrl) setTool('select');
            else if (key === 'c' && !ctrl) setTool('razor');
            else if (key === 's' && !ctrl) setSnap((x) => !x);
            else if (key === 'z' && !ctrl) k.addZoomAtPlayhead();
            else if ((key === 'y' && ctrl) || (key === 'z' && ctrl && e.shiftKey)) {
                e.preventDefault();
                k.p.onRedo();
            } else if (key === 'z' && ctrl) {
                e.preventDefault();
                k.p.onUndo();
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                k.deleteSelection();
            } else if (e.key === 'Escape') {
                k.p.setSelection(null);
                setMenu(null);
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                k.p.onSeekOut(Math.max(0, now - (e.shiftKey ? 1 : 1 / FPS)));
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                k.p.onSeekOut(now + (e.shiftKey ? 1 : 1 / FPS));
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                const prev = [...k.editPoints].reverse().find((x) => x < now - 0.02);
                k.p.onSeekOut(prev ?? 0);
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                const next = k.editPoints.find((x) => x > now + 0.02);
                if (next !== undefined) k.p.onSeekOut(Math.min(next, k.outLen - 0.01));
            } else if (e.key === 'Home') k.p.onSeekOut(0);
            else if (e.key === 'End') k.p.onSeekOut(Math.max(0, k.outLen - 0.05));
            else if (e.key === '=' || e.key === '+') setZoom((z) => Math.min(maxZRef.current, z * 1.25));
            else if (e.key === '-') setZoom((z) => Math.max(1, z / 1.25));
            else if (e.key === '\\') k.fit();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    // ---------- pointer handling ----------
    const xToOut = (clientX: number) => {
        const el = scrollRef.current!;
        const r = el.getBoundingClientRect();
        return (clientX - r.left + el.scrollLeft - HEAD_W - PAD) / pps;
    };
    /** snap a sequence time to the playhead and edit points */
    const snapOut = (t: number) => {
        if (!snap) return t;
        const cands = [outNow.current, ...editPoints];
        let best = t;
        let dist = 8 / pps;
        for (const c of cands)
            if (Math.abs(c - t) < dist) {
                dist = Math.abs(c - t);
                best = c;
            }
        return best;
    };

    function startDrag(e: React.PointerEvent, kind: string, extra: { index?: number; segId?: string } = {}) {
        e.stopPropagation();
        if (e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { kind, startX: e.clientX, orig: clip, moved: false, ...extra };
    }

    function onPointerMove(e: React.PointerEvent) {
        if (tool === 'razor' && razorLineRef.current) {
            const t = Math.max(0, Math.min(outLen, snapOut(xToOut(e.clientX))));
            razorLineRef.current.style.transform = `translateX(${X(t)}px)`;
            razorLineRef.current.style.opacity = '1';
        }
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.startX;
        if (!d.moved) {
            if (Math.abs(dx) < 3 && d.kind !== 'scrub') return;
            d.moved = true;
            if (d.kind !== 'scrub') p.onBeginEdit();
        }
        const o = d.orig;
        const oSpans = keptSegments(o);
        const dt = dx / pps;
        const toSrc = (out: number) => toSource(o, out, oSpans);
        const toOut = (src: number) => toOutputClamped(o, src, oSpans);

        if (d.kind === 'scrub') return p.onSeekOut(Math.max(0, Math.min(seqLen, xToOut(e.clientX))));

        if ((d.kind === 'trim-l' || d.kind === 'trim-r') && d.segId) {
            const list = segmentsOf(o);
            const i = list.findIndex((s) => s.id === d.segId);
            const s = list[i];
            if (!s) return;
            const prev = list[i - 1];
            const next = list[i + 1];
            if (d.kind === 'trim-l') {
                // the edit point moves on screen; snapping is done in sequence time
                const segStartOut = toOut(s.start);
                const want = snapOut(segStartOut + dt) - segStartOut;
                const ns = Math.max(prev ? prev.end : 0, Math.min(s.end - 0.2, s.start + want));
                list[i] = { ...s, start: snapFrame(ns) };
            } else {
                const segEndOut = toOut(s.end);
                const want = snapOut(segEndOut + dt) - segEndOut;
                const ne = Math.min(next ? next.start : p.duration, Math.max(s.start + 0.2, s.end + want));
                list[i] = { ...s, end: snapFrame(ne) };
            }
            p.onUpdate(withSegs(o, list));
            return;
        }

        const moveSpan = (start: number, end: number, mode: string) => {
            const a = toOut(start);
            const b = toOut(end);
            let na = a;
            let nb = b;
            if (mode === 'move') {
                na = Math.max(0, Math.min(outLen - (b - a), snapOut(a + dt)));
                nb = na + (b - a);
            } else if (mode === 'l') na = Math.max(0, Math.min(b - 0.2, snapOut(a + dt)));
            else nb = Math.min(outLen, Math.max(a + 0.2, snapOut(b + dt)));
            return { start: toSrc(na), end: toSrc(nb) };
        };
        if (d.kind.startsWith('zoom-') && d.index !== undefined) {
            const z = (o.zooms ?? [])[d.index];
            if (!z) return;
            const list = [...(o.zooms ?? [])];
            list[d.index] = { ...z, ...moveSpan(z.start, z.end, d.kind.slice(5)) };
            p.onUpdate({ zooms: list });
        } else if (d.kind.startsWith('sticker-') && d.index !== undefined) {
            const st = (o.stickers ?? [])[d.index];
            if (!st) return;
            const list = [...(o.stickers ?? [])];
            list[d.index] = { ...st, ...moveSpan(st.start, st.end, d.kind.slice(8)) };
            p.onUpdate({ stickers: list });
        } else if (d.kind === 'sfx' && d.index !== undefined) {
            const list = [...(o.sfx ?? [])];
            list[d.index] = { ...list[d.index], t: toSrc(Math.max(0, Math.min(outLen, snapOut(toOut(list[d.index].t) + dt)))) };
            p.onUpdate({ sfx: list });
        } else if (d.kind === 'shake' && d.index !== undefined) {
            const list = [...(o.shakes ?? [])];
            list[d.index] = { ...list[d.index], t: toSrc(Math.max(0, Math.min(outLen, snapOut(toOut(list[d.index].t) + dt)))) };
            p.onUpdate({ shakes: list });
        } else if (d.kind === 'title' && o.hookTitle) {
            p.onUpdate({ hookTitle: { ...o.hookTitle, seconds: Math.max(0.5, Math.min(15, snapFrame(o.hookTitle.seconds + dt))) } });
        } else if (d.kind === 'freeze' && o.freeze) {
            p.onUpdate({ freeze: { ...o.freeze, seconds: Math.max(0.5, Math.min(6, snapFrame(o.freeze.seconds + dt))) } });
        }
    }

    function onPointerUp() {
        drag.current = null;
    }

    function clickSeg(e: React.MouseEvent, id: string) {
        e.stopPropagation();
        setMenu(null);
        if (tool === 'razor') return splitAt(snapOut(xToOut(e.clientX)));
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
            const ids = selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id];
            p.setSelection(ids.length ? { type: 'segs', ids } : null);
        } else p.setSelection({ type: 'segs', ids: [id] });
    }

    // ---------- waveform (drawn on a canvas, fast even for long clips) ----------
    useEffect(() => {
        const c = waveRef.current;
        if (!c) return;
        const w = Math.ceil(Math.min(contentW, 16000));
        const h = trackH('a1') - 10;
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d')!;
        ctx.clearRect(0, 0, w, h);
        if (!p.energy) return;
        ctx.fillStyle = 'rgba(110, 231, 183, 0.75)';
        for (let x = PAD; x < Math.min(w, X(outLen)); x += 2) {
            const src = srcOf((x - PAD) / pps);
            const db = p.energy.db[Math.floor(src / p.energy.step)] ?? -90;
            const v = Math.max(0, Math.min(1, (db + 55) / 45));
            const bh = Math.max(1, v * h);
            ctx.fillRect(x, (h - bh) / 2, 1.4, bh);
        }
    }, [p.energy, pps, clip, contentW]);

    // ruler ticks
    const minorEvery = pps > 160 ? 1 / FPS * 5 : pps > 60 ? 0.5 : pps > 25 ? 1 : pps > 10 ? 2 : pps > 4 ? 5 : pps > 1.5 ? 15 : pps > 0.5 ? 60 : 300;
    const majorEvery = pps > 160 ? 1 : pps > 60 ? 2 : pps > 25 ? 5 : pps > 10 ? 10 : pps > 4 ? 30 : pps > 1.5 ? 60 : pps > 0.5 ? 300 : 1800;
    const ticks: { t: number; major: boolean }[] = [];
    for (let t = 0; t <= seqLen + 2; t += minorEvery) ticks.push({ t: Math.round(t * 1000) / 1000, major: Math.abs(t / majorEvery - Math.round(t / majorEvery)) < 1e-6 });

    const capTimes = useMemo(() => groupTimes(p.groups), [p.groups]);
    const sel = p.selection;
    const selSegs = segs.filter((s) => selectedIds.includes(s.id));
    const selLayout: Layout | 'default' | 'mixed' = selSegs.length ? (selSegs.every((s) => s.layout === selSegs[0].layout) ? selSegs[0].layout ?? 'default' : 'mixed') : 'default';
    const visible = (src: number) => toOutput(clip, src, spans) !== null;

    return (
        <div className="tl-root select-none" onPointerDown={() => menu && setMenu(null)}>
            {/* toolbar */}
            <div className="tl-toolbar">
                <div className="flex items-center gap-1">
                    <button className="tl-icon" onClick={() => p.onSeekOut(0)} title="Go to start (Home)"><SkipBack size={15} /></button>
                    <button className="tl-icon tl-play" onClick={p.onTogglePlay} title="Play / pause (Space)">{p.playing ? <Pause size={16} /> : <Play size={16} />}</button>
                    <button className="tl-icon" onClick={() => p.onSeekOut(Math.max(0, outLen - 0.05))} title="Go to end (End)"><SkipForward size={15} /></button>
                    <span className="tl-timecode">
                        <span ref={timecodeRef}>00:00:00:00</span>
                        <span className="text-white/35"> / {timecode(seqLen)}</span>
                    </span>
                </div>
                <div className="tl-sep" />
                <div className="tl-group" role="radiogroup" aria-label="Tool">
                    <button className={`tl-icon ${tool === 'select' ? 'tl-on' : ''}`} onClick={() => setTool('select')} title="Selection tool (V)"><MousePointer2 size={15} /></button>
                    <button className={`tl-icon ${tool === 'razor' ? 'tl-on' : ''}`} onClick={() => setTool('razor')} title="Razor tool (C): click a part to cut it"><Scissors size={15} /></button>
                </div>
                <button className="tl-btn" onClick={() => splitAt(outNow.current)} title="Split at playhead (Ctrl+K)"><Scissors size={14} /> Split</button>
                <button className="tl-btn" onClick={deleteSelection} disabled={!sel || sel.type === 'caption'} title="Delete the selection; the gap closes (Delete)"><Trash2 size={14} /> Delete</button>
                <button className="tl-btn" onClick={addZoomAtPlayhead} title="Add a punch-in zoom at the playhead (Z)"><ZoomIn size={14} /> Zoom</button>
                <div className="tl-sep" />
                <button className="tl-icon" onClick={p.onUndo} disabled={!p.canUndo} title="Undo (Ctrl+Z)"><Undo2 size={15} /></button>
                <button className="tl-icon" onClick={p.onRedo} disabled={!p.canRedo} title="Redo (Ctrl+Shift+Z)"><Redo2 size={15} /></button>
                {selSegs.length > 0 && (
                    <>
                        <div className="tl-sep" />
                        <label className="flex items-center gap-2 text-xs text-white/60">
                            <Layers size={14} />
                            {selSegs.length > 1 ? `${selSegs.length} parts` : 'Part'} layout
                            <select className="tl-select" value={selLayout === 'mixed' ? '' : selLayout} onChange={(e) => setLayout(selectedIds, e.target.value as Layout | 'default')} aria-label="Layout for the selected part">
                                {selLayout === 'mixed' && <option value="">Mixed</option>}
                                {LAYOUTS.map((l) => (
                                    <option key={l.id} value={l.id}>{l.label}</option>
                                ))}
                            </select>
                        </label>
                    </>
                )}
                <div className="ml-auto flex items-center gap-1">
                    <button className={`tl-icon ${snap ? 'tl-on' : ''}`} onClick={() => setSnap(!snap)} title="Snapping (S)"><Magnet size={15} /></button>
                    <div className="tl-sep" />
                    <button className="tl-icon" onClick={() => setZoom((z) => Math.max(1, z / 1.4))} title="Zoom out (-)"><ZoomOut size={15} /></button>
                    <input type="range" min={0} max={1} step={0.001} value={Math.log(zoom) / Math.log(MAXZ)} onChange={(e) => setZoom(Math.pow(MAXZ, +e.target.value))} className="tl-range" aria-label="Timeline zoom" />
                    <button className="tl-icon" onClick={() => setZoom((z) => Math.min(MAXZ, z * 1.4))} title="Zoom in (+)"><ZoomIn size={15} /></button>
                    <button className="tl-icon" onClick={fit} title="Fit to window (\)"><Maximize2 size={14} /></button>
                </div>
            </div>

            {/* tracks */}
            <div
                ref={scrollRef}
                className={`tl-scroll ${tool === 'razor' ? 'tl-razor' : ''}`}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={() => razorLineRef.current && (razorLineRef.current.style.opacity = '0')}
                onScroll={() => {
                    cancelAnimationFrame(scrollRaf.current);
                    scrollRaf.current = requestAnimationFrame(() => setViewX(scrollRef.current?.scrollLeft ?? 0));
                }}
                onWheel={(e) => {
                    const el = scrollRef.current!;
                    if (e.ctrlKey || e.metaKey) {
                        // zoom around the mouse
                        const at = xToOut(e.clientX);
                        const nz = Math.max(1, Math.min(MAXZ, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
                        setZoom(nz);
                        requestAnimationFrame(() => {
                            const r = el.getBoundingClientRect();
                            el.scrollLeft = PAD + at * fitPps * nz - (e.clientX - r.left - HEAD_W);
                        });
                    } else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY;
                }}
            >
                <div className="relative flex" style={{ width: contentW + HEAD_W, height: TOTAL_H }}>
                    {/* track headers */}
                    <div className="tl-heads" style={{ width: HEAD_W }}>
                        {TRACKS.map((t) =>
                            t.id === 'ruler' ? (
                                <div key={t.id} style={{ height: t.h }} className="border-b border-white/10" />
                            ) : (
                                <div key={t.id} className="tl-head" style={{ height: t.h }}>
                                    <span className="tl-tag">{t.label}</span>
                                    <span className="truncate">{t.name}</span>
                                </div>
                            )
                        )}
                    </div>

                    <div
                        className="relative"
                        style={{ width: contentW, height: TOTAL_H }}
                        onPointerDown={(e) => {
                            if (e.button !== 0) return;
                            p.setSelection(null);
                            p.onSeekOut(Math.max(0, Math.min(seqLen, xToOut(e.clientX))));
                        }}
                    >
                        {/* track lanes */}
                        {TRACKS.filter((t) => t.id !== 'ruler').map((t) => (
                            <div key={t.id} className={`tl-lane ${t.id === 'video' ? 'tl-lane-video' : ''}`} style={{ top: top(t.id), height: t.h }} />
                        ))}

                        {/* ruler */}
                        <div className="tl-ruler" style={{ height: trackH('ruler') }} onPointerDown={(e) => { startDrag(e, 'scrub'); p.onSeekOut(Math.max(0, Math.min(seqLen, xToOut(e.clientX)))); }}>
                            {ticks.map((tk) => (
                                <div key={tk.t} className={`tl-tick ${tk.major ? 'tl-tick-major' : ''}`} style={{ left: X(tk.t) }}>
                                    {tk.major && <span>{seqLen >= 3600 ? timecode(tk.t).slice(0, 8) : timecode(tk.t).slice(3, 8)}</span>}
                                </div>
                            ))}
                        </div>

                        {/* T1: hook title + stickers */}
                        {clip.hookTitle && clip.hookTitle.seconds > 0 && clip.hookTitle.text.trim() && (
                            <div className="tl-item tl-title" style={{ top: top('text') + 4, height: trackH('text') - 8, left: X(0), width: Math.min(outLen, clip.hookTitle.seconds) * pps }} onPointerDown={(e) => e.stopPropagation()} title="Hook title. Drag the right edge to change how long it shows.">
                                <Type size={11} /> <span className="truncate">{clip.hookTitle.text}</span>
                                <span className="tl-handle tl-handle-r" onPointerDown={(e) => startDrag(e, 'title')} />
                            </div>
                        )}
                        {(clip.stickers ?? []).map((st, i) =>
                            visible(st.start) || visible(st.end - 0.01) ? (
                                <div
                                    key={st.id}
                                    className={`tl-item tl-sticker ${sel?.type === 'sticker' && sel.i === i ? 'tl-selected' : ''}`}
                                    style={{ top: top('text') + 4, height: trackH('text') - 8, left: X(outOf(st.start)), width: Math.max(8, (outOf(st.end) - outOf(st.start)) * pps) }}
                                    onPointerDown={(e) => { p.setSelection({ type: 'sticker', i }); startDrag(e, 'sticker-move', { index: i }); }}
                                    title="Text sticker. Drag to move, drag the edges to resize."
                                >
                                    <span className="truncate">{st.text}</span>
                                    <span className="tl-handle tl-handle-l" onPointerDown={(e) => { p.setSelection({ type: 'sticker', i }); startDrag(e, 'sticker-l', { index: i }); }} />
                                    <span className="tl-handle tl-handle-r" onPointerDown={(e) => { p.setSelection({ type: 'sticker', i }); startDrag(e, 'sticker-r', { index: i }); }} />
                                </div>
                            ) : null
                        )}

                        {/* FX: zooms, shakes, replay, freeze, laughs */}
                        {p.events
                            .filter((e) => (e.type === 'reaction' || e.type === 'chat' || e.type === 'hype') && visible(e.start))
                            .map((e, i) => (
                                <span key={`l${i}`} className="tl-marker-emoji" style={{ top: top('fx') + 8, left: X(outOf(e.start)) - 7 }} title={e.type === 'chat' ? `Chat spike: ${e.label}` : e.type === 'hype' ? `Hype: “${e.label}”` : 'Laugh or reaction'}>
                                    {e.type === 'chat' ? '💬' : e.type === 'hype' ? '🔥' : '😂'}
                                </span>
                            ))}
                        {(clip.zooms ?? []).map((z, i) =>
                            visible(z.start) || visible(z.end - 0.01) ? (
                                <div
                                    key={`z${i}`}
                                    className={`tl-item tl-zoom ${sel?.type === 'zoom' && sel.i === i ? 'tl-selected' : ''}`}
                                    style={{ top: top('fx') + 4, height: trackH('fx') - 8, left: X(outOf(z.start)), width: Math.max(10, (outOf(z.end) - outOf(z.start)) * pps) }}
                                    onPointerDown={(e) => { p.setSelection({ type: 'zoom', i }); startDrag(e, 'zoom-move', { index: i }); }}
                                    title="Zoom. Drag to move, drag the edges to resize."
                                >
                                    <ZoomIn size={11} /> <span className="truncate">{z.scale.toFixed(2)}×</span>
                                    <span className="tl-handle tl-handle-l" onPointerDown={(e) => { p.setSelection({ type: 'zoom', i }); startDrag(e, 'zoom-l', { index: i }); }} />
                                    <span className="tl-handle tl-handle-r" onPointerDown={(e) => { p.setSelection({ type: 'zoom', i }); startDrag(e, 'zoom-r', { index: i }); }} />
                                </div>
                            ) : null
                        )}
                        {(clip.shakes ?? []).map((sh, i) =>
                            visible(sh.t) ? (
                                <button
                                    key={`sh${i}`}
                                    className={`tl-pin tl-pin-shake ${sel?.type === 'shake' && sel.i === i ? 'tl-selected' : ''}`}
                                    style={{ top: top('fx') + 7, left: X(outOf(sh.t)) - 10 }}
                                    onPointerDown={(e) => { p.setSelection({ type: 'shake', i }); startDrag(e, 'shake', { index: i }); }}
                                    title={sh.kind === 'flash' ? 'Flash' : sh.kind === 'both' ? 'Shake + flash' : 'Shake'}
                                >
                                    {sh.kind === 'flash' ? '✦' : '⚡'}
                                </button>
                            ) : null
                        )}
                        {clip.transition && (clip.transition.kind !== 'none' || clip.transition.sound) &&
                            segOut.slice(1).map((r) => (
                                <span key={`tr${r.seg.id}`} className="tl-trans" style={{ top: top('fx') + 9, left: X(r.start) - 8 }} title={`Transition: ${clip.transition!.kind}${clip.transition!.sound ? ` + ${clip.transition!.sound}` : ''}`}>
                                    {clip.transition!.kind === 'flash' ? '✦' : clip.transition!.kind === 'shake' ? '⚡' : clip.transition!.kind === 'zoom' ? '🔍' : '♪'}
                                </span>
                            ))}
                        {replay > 0 && (
                            <div className="tl-item tl-replay" style={{ top: top('fx') + 4, height: trackH('fx') - 8, left: X(outLen), width: replay * pps }} onPointerDown={(e) => e.stopPropagation()} title="Instant replay (plays after the clip)">
                                <FastForward size={11} className="rotate-180" /> <span className="truncate">Replay</span>
                            </div>
                        )}
                        {freeze > 0 && (
                            <div className="tl-item tl-freeze" style={{ top: top('fx') + 4, height: trackH('fx') - 8, left: X(outLen + replay), width: freeze * pps }} onPointerDown={(e) => e.stopPropagation()} title="Freeze ending. Drag the right edge to change its length.">
                                <span className="truncate">❄ {clip.freeze?.text || 'Freeze'}</span>
                                <span className="tl-handle tl-handle-r" onPointerDown={(e) => startDrag(e, 'freeze')} />
                            </div>
                        )}

                        {/* V1: the parts of the video */}
                        {segOut.map((r, idx) => {
                            const s = r.seg;
                            const selected = selectedIds.includes(s.id);
                            const lay = s.layout ?? p.style.layout;
                            return (
                                <div
                                    key={s.id}
                                    className={`tl-seg ${selected ? 'tl-seg-selected' : ''} ${s.layout ? 'tl-seg-custom' : ''}`}
                                    style={{ top: top('video') + 4, height: trackH('video') - 8, left: X(r.start), width: Math.max(4, (r.end - r.start) * pps) }}
                                    onPointerDown={(e) => e.stopPropagation()}
                                    onClick={(e) => clickSeg(e, s.id)}
                                    onDoubleClick={() => p.onSeekOut(r.start)}
                                    onContextMenu={(e) => {
                                        e.preventDefault();
                                        if (!selectedIds.includes(s.id)) p.setSelection({ type: 'segs', ids: [s.id] });
                                        setMenu({ x: e.clientX, y: e.clientY, segId: s.id });
                                    }}
                                    title="Click to select · right-click for options · drag the edges to trim"
                                >
                                    <div className="tl-film">
                                        {p.thumbs
                                            .filter((th) => th.t >= s.start - 1 && th.t < s.end)
                                            .map((th, k) => (
                                                <img key={k} src={th.url} alt="" draggable={false} style={{ left: Math.max(0, (Math.max(th.t, s.start) - s.start) * pps) }} />
                                            ))}
                                    </div>
                                    <div className="tl-seg-label">
                                        <span className="tl-seg-num">{idx + 1}</span>
                                        <span className={`tl-badge ${s.layout ? 'tl-badge-custom' : ''}`}>{layoutName(lay)}</span>
                                    </div>
                                    {tool === 'select' && (
                                        <>
                                            <span className="tl-trim tl-trim-l" onPointerDown={(e) => startDrag(e, 'trim-l', { segId: s.id })} title="Drag to trim the start" />
                                            <span className="tl-trim tl-trim-r" onPointerDown={(e) => startDrag(e, 'trim-r', { segId: s.id })} title="Drag to trim the end" />
                                        </>
                                    )}
                                </div>
                            );
                        })}

                        {/* CC: captions */}
                        {p.groups.map((g, i) => {
                            const a = outOf(capTimes[i].start);
                            const b = outOf(capTimes[i].end);
                            if (b - a < 0.02) return null;
                            if (X(b) < viewX - 400 || X(a) > viewX + width + 400) return null;
                            return (
                                <button
                                    key={i}
                                    className={`tl-cap ${sel?.type === 'caption' && sel.i === i ? 'tl-selected' : ''}`}
                                    style={{ top: top('cc') + 5, height: trackH('cc') - 10, left: X(a), width: Math.max(4, (b - a) * pps - 1) }}
                                    onPointerDown={(e) => e.stopPropagation()}
                                    onClick={() => {
                                        p.setSelection({ type: 'caption', i });
                                        p.onSeekOut(a + 0.01);
                                    }}
                                    title={`${g.map((w) => w.text).join(' ')}. Click to edit`}
                                >
                                    {g.map((w) => w.text).join(' ')}
                                </button>
                            );
                        })}

                        {/* A1: audio waveform + bleeps */}
                        <div className="tl-audio" style={{ top: top('a1') + 5, height: trackH('a1') - 10, left: 0, width: Math.min(contentW, 16000) }}>
                            <canvas ref={waveRef} className="h-full" />
                        </div>
                        {p.bleeps.map((b, i) =>
                            visible(b.start) ? <div key={`b${i}`} className="tl-bleep" style={{ top: top('a1') + 5, height: trackH('a1') - 10, left: X(outOf(b.start)), width: Math.max(3, (outOf(b.end) - outOf(b.start)) * pps) }} title="Bleep" /> : null
                        )}
                        {!p.energy && <span className="absolute text-[10px] text-white/30" style={{ top: top('a1') + 16, left: X(0) + 8 }}>No waveform for this project</span>}

                        {/* A2: sound effects + music */}
                        {p.hasMusic && <div className="tl-music" style={{ top: top('a2') + 6, height: trackH('a2') - 12, left: X(0), width: seqLen * pps }}><Music size={10} /> Music</div>}
                        {(clip.sfx ?? []).map((sx, i) =>
                            visible(sx.t) ? (
                                <button
                                    key={`sx${i}`}
                                    className={`tl-pin tl-pin-sfx ${sel?.type === 'sfx' && sel.i === i ? 'tl-selected' : ''}`}
                                    style={{ top: top('a2') + 4, left: X(outOf(sx.t)) - 10 }}
                                    onPointerDown={(e) => { p.setSelection({ type: 'sfx', i }); startDrag(e, 'sfx', { index: i }); }}
                                    title={`${SFX_KINDS.find((k) => k.id === sx.kind)?.label}. Drag to move.`}
                                >
                                    {SFX_KINDS.find((k) => k.id === sx.kind)?.icon}
                                </button>
                            ) : null
                        )}

                        {/* end of sequence shading */}
                        <div className="tl-after" style={{ top: trackH('ruler'), left: X(seqLen), height: TOTAL_H - trackH('ruler') }} />

                        {/* razor guide and playhead */}
                        <div ref={razorLineRef} className="tl-razor-line" style={{ height: TOTAL_H }} />
                        <div ref={playheadRef} className="tl-playhead" style={{ height: TOTAL_H }}>
                            <div className="tl-playhead-head" />
                        </div>
                    </div>
                </div>
            </div>

            {/* right-click menu */}
            {menu && (
                <div className="tl-menu" style={{ left: Math.min(menu.x, window.innerWidth - 260), top: Math.min(menu.y, window.innerHeight - 330) }} onPointerDown={(e) => e.stopPropagation()}>
                    <p className="tl-menu-title">Layout for {selectedIds.length > 1 ? `${selectedIds.length} parts` : 'this part'}</p>
                    {LAYOUTS.map((l) => (
                        <button key={l.id} onClick={() => { setLayout(selectedIds.length ? selectedIds : [menu.segId], l.id); setMenu(null); }}>
                            <span className="w-4">{(selLayout === l.id) && <Check size={13} />}</span>
                            {l.label}
                        </button>
                    ))}
                    <div className="tl-menu-sep" />
                    <button onClick={() => { splitAt(outNow.current); setMenu(null); }}><span className="w-4"><Scissors size={13} /></span>Split at playhead<kbd>Ctrl+K</kbd></button>
                    <button onClick={() => { rippleDelete(selectedIds.length ? selectedIds : [menu.segId]); setMenu(null); }}><span className="w-4"><Trash2 size={13} /></span>Delete (close the gap)<kbd>Del</kbd></button>
                    <button onClick={() => { p.setSelection({ type: 'segs', ids: segs.map((s) => s.id) }); setMenu(null); }}><span className="w-4" />Select all parts</button>
                </div>
            )}

            <p className="tl-help">
                <b>V</b> select · <b>C</b> razor · <b>Ctrl+K</b> split at playhead · <b>Del</b> delete part · <b>J K L</b> back / pause / play · <b>←→</b> frame · <b>↑↓</b> previous / next cut · <b>S</b> snapping · <b>Ctrl+scroll</b> zoom · right-click a part to change its layout
            </p>
        </div>
    );
});

export default memo(Timeline);
