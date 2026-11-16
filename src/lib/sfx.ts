// Original sound effects, synthesised in the browser (no samples, no copyright issues).
import type { SfxKind } from './types';

export const SFX_KINDS: { id: SfxKind; label: string; icon: string }[] = [
    { id: 'boom', label: 'Boom', icon: '💥' },
    { id: 'whoosh', label: 'Whoosh', icon: '💨' },
    { id: 'ding', label: 'Ding', icon: '🔔' },
    { id: 'pop', label: 'Pop', icon: '🫧' },
    { id: 'scratch', label: 'Scratch', icon: '💿' }
];

const SR = 48000;
const cache = new Map<SfxKind, AudioBuffer>();

function noise(ctx: BaseAudioContext, seconds: number) {
    const b = ctx.createBuffer(1, Math.ceil(SR * seconds), SR);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const s = ctx.createBufferSource();
    s.buffer = b;
    return s;
}

/** Renders one effect to an AudioBuffer. */
export async function sfxBuffer(kind: SfxKind): Promise<AudioBuffer> {
    const hit = cache.get(kind);
    if (hit) return hit;
    const len = { boom: 1.2, whoosh: 0.6, ding: 1.0, pop: 0.15, scratch: 0.45 }[kind];
    const ctx = new OfflineAudioContext(1, Math.ceil(SR * len), SR);
    const out = ctx.createGain();
    out.connect(ctx.destination);
    const now = 0;
    if (kind === 'boom') {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(110, now);
        o.frequency.exponentialRampToValueAtTime(32, now + 0.9);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(1, now + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, now + 1.15);
        o.connect(g).connect(out);
        o.start(now);
        const n = noise(ctx, 0.25);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 400;
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0.6, now);
        ng.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
        n.connect(lp).connect(ng).connect(out);
        n.start(now);
    } else if (kind === 'whoosh') {
        const n = noise(ctx, len);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 1.2;
        bp.frequency.setValueAtTime(300, now);
        bp.frequency.exponentialRampToValueAtTime(3500, now + 0.35);
        bp.frequency.exponentialRampToValueAtTime(900, now + len);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.9, now + 0.3);
        g.gain.exponentialRampToValueAtTime(0.001, now + len);
        n.connect(bp).connect(g).connect(out);
        n.start(now);
    } else if (kind === 'ding') {
        for (const [f, v] of [
            [1320, 0.5],
            [1980, 0.25],
            [2640, 0.12]
        ]) {
            const o = ctx.createOscillator();
            o.frequency.value = f;
            const g = ctx.createGain();
            g.gain.setValueAtTime(v, now);
            g.gain.exponentialRampToValueAtTime(0.001, now + len);
            o.connect(g).connect(out);
            o.start(now);
        }
    } else if (kind === 'pop') {
        const o = ctx.createOscillator();
        o.frequency.setValueAtTime(900, now);
        o.frequency.exponentialRampToValueAtTime(250, now + 0.08);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.9, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
        o.connect(g).connect(out);
        o.start(now);
    } else {
        // record scratch: filtered noise with a fast wobbling pitch
        const n = noise(ctx, len);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 6;
        bp.frequency.setValueAtTime(1800, now);
        bp.frequency.linearRampToValueAtTime(500, now + 0.12);
        bp.frequency.linearRampToValueAtTime(2200, now + 0.22);
        bp.frequency.linearRampToValueAtTime(400, now + 0.42);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(1.6, now + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, now + len);
        n.connect(bp).connect(g).connect(out);
        n.start(now);
    }
    const buf = await ctx.startRendering();
    cache.set(kind, buf);
    return buf;
}

/** 16-bit mono WAV bytes, for ffmpeg. */
export async function sfxWav(kind: SfxKind): Promise<Uint8Array> {
    const b = await sfxBuffer(kind);
    const d = b.getChannelData(0);
    const out = new DataView(new ArrayBuffer(44 + d.length * 2));
    const str = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF');
    out.setUint32(4, 36 + d.length * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    out.setUint32(16, 16, true);
    out.setUint16(20, 1, true);
    out.setUint16(22, 1, true);
    out.setUint32(24, SR, true);
    out.setUint32(28, SR * 2, true);
    out.setUint16(32, 2, true);
    out.setUint16(34, 16, true);
    str(36, 'data');
    out.setUint32(40, d.length * 2, true);
    for (let i = 0; i < d.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, d[i])) * 0x7fff, true);
    return new Uint8Array(out.buffer);
}

let liveCtx: AudioContext | null = null;
/** Plays an effect right now (preview). */
export async function playSfx(kind: SfxKind, volume = 0.8) {
    liveCtx ??= new AudioContext();
    if (liveCtx.state === 'suspended') await liveCtx.resume().catch(() => {});
    const src = liveCtx.createBufferSource();
    src.buffer = await sfxBuffer(kind);
    const g = liveCtx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(liveCtx.destination);
    src.start();
}
