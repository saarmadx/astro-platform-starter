import { useEffect, useState } from 'react';
import type { Brand, Watermark } from '../lib/types';
import { Segmented } from './Home';

/** Logo watermark settings, applied to every exported clip. */
export default function BrandKit({ brand, setBrand }: { brand: Brand; setBrand: (b: Brand) => void }) {
    const [error, setError] = useState('');

    function pickLogo(f?: File) {
        if (!f) return;
        if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(f.type)) {
            setError('Use a PNG, JPG, WebP or SVG image.');
            return;
        }
        setError('');
        // convert to PNG so ffmpeg can read it
        const url = URL.createObjectURL(f);
        const img = new Image();
        img.onload = () => {
            const scale = Math.min(1, 800 / Math.max(img.naturalWidth, img.naturalHeight));
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(img.naturalWidth * scale));
            c.height = Math.max(1, Math.round(img.naturalHeight * scale));
            c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
            setBrand({ ...brand, logo: c.toDataURL('image/png') });
            URL.revokeObjectURL(url);
        };
        img.onerror = () => setError('That image could not be read.');
        img.src = url;
    }

    const corner = { tl: 'top-3 left-3', tr: 'top-3 right-3', bl: 'bottom-3 left-3', br: 'bottom-3 right-3' }[brand.logoCorner];
    const wm: Watermark = brand.watermark ?? { text: '', corner: 'bl', size: 0.035, opacity: 0.8, moving: true };
    const setWm = (patch: Partial<Watermark>) => setBrand({ ...brand, watermark: { ...wm, ...patch } });
    const corners = ['tl', 'br', 'tr', 'bl'] as const;
    const [tick, setTick] = useState(0);
    useEffect(() => {
        const t = setInterval(() => setTick((x) => x + 1), 1500);
        return () => clearInterval(t);
    }, []);
    const wmCorner = wm.moving ? corners[tick % 4] : wm.corner;
    const wmPos = { tl: 'top-2 left-2', tr: 'top-2 right-2', bl: 'bottom-4 left-2', br: 'bottom-4 right-2' }[wmCorner];

    return (
        <div className="flex max-w-4xl flex-col gap-6">
            <div>
                <h1 className="!text-3xl">Brand kit</h1>
                <p className="mt-1 text-muted">Add your name and logo once and they are placed on every clip you export.</p>
            </div>
            <div className="grid gap-6 md:grid-cols-[1fr_auto]">
                <div className="panel flex flex-col gap-5 p-5">
                    <div className="flex flex-col gap-3 rounded-xl border border-accent/30 bg-accent/5 p-4">
                        <div>
                            <span className="block text-sm font-semibold">Your name on every clip</span>
                            <span className="block text-xs text-muted">Shows who made the clip, so re-uploads still credit you. Leave empty to turn it off.</span>
                        </div>
                        <input className="input" value={wm.text} maxLength={40} placeholder="@YourChannel" onChange={(e) => setWm({ text: e.target.value })} aria-label="Watermark text" />
                        <label className="flex items-start gap-2 text-sm">
                            <input type="checkbox" className="mt-1 accent-[var(--color-accent)]" checked={wm.moving} onChange={(e) => setWm({ moving: e.target.checked })} />
                            <span>
                                <b>Moving (anti-theft)</b>
                                <span className="block text-xs text-muted">Jumps to a different corner every {6} seconds, so it can’t be cropped or blurred out in one go.</span>
                            </span>
                        </label>
                        {!wm.moving && (
                            <Segmented value={wm.corner} onChange={(v) => setWm({ corner: v as Watermark['corner'] })} items={[{ id: 'tl', label: 'Top left' }, { id: 'tr', label: 'Top right' }, { id: 'bl', label: 'Bottom left' }, { id: 'br', label: 'Bottom right' }]} />
                        )}
                        <div className="grid gap-3 sm:grid-cols-2">
                            <label className="flex flex-col gap-1 text-xs text-muted">
                                Size
                                <input type="range" min={0.022} max={0.07} step={0.002} value={wm.size} onChange={(e) => setWm({ size: +e.target.value })} className="accent-[var(--color-accent)]" />
                            </label>
                            <label className="flex flex-col gap-1 text-xs text-muted">
                                Visibility: {Math.round(wm.opacity * 100)}%
                                <input type="range" min={0.3} max={1} step={0.05} value={wm.opacity} onChange={(e) => setWm({ opacity: +e.target.value })} className="accent-[var(--color-accent)]" />
                            </label>
                        </div>
                    </div>
                    <div className="flex flex-col gap-2">
                        <span className="text-sm font-semibold text-muted">Logo</span>
                        <div className="flex flex-wrap items-center gap-3">
                            <label className="btn-ghost cursor-pointer">
                                {brand.logo ? 'Replace logo' : 'Upload logo'}
                                <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="sr-only" onChange={(e) => pickLogo(e.target.files?.[0])} />
                            </label>
                            {brand.logo && (
                                <button className="text-sm text-muted hover:text-red-300" onClick={() => setBrand({ ...brand, logo: undefined })}>
                                    Remove
                                </button>
                            )}
                        </div>
                        <p className="text-xs text-muted">A PNG with a transparent background looks best.</p>
                        {error && <p className="text-sm text-red-300">{error}</p>}
                    </div>
                    <div className="flex flex-col gap-2">
                        <span className="text-sm font-semibold text-muted">Corner</span>
                        <Segmented
                            value={brand.logoCorner}
                            onChange={(v) => setBrand({ ...brand, logoCorner: v as Brand['logoCorner'] })}
                            items={[{ id: 'tl', label: 'Top left' }, { id: 'tr', label: 'Top right' }, { id: 'bl', label: 'Bottom left' }, { id: 'br', label: 'Bottom right' }]}
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <span className="text-sm font-semibold text-muted">Size: {Math.round(brand.logoSize * 100)}% of the width</span>
                        <input type="range" min={0.06} max={0.35} step={0.01} value={brand.logoSize} onChange={(e) => setBrand({ ...brand, logoSize: +e.target.value })} className="w-full accent-[var(--color-accent)]" />
                    </div>
                </div>
                <div className="relative mx-auto aspect-[9/16] w-56 overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-slate-600 to-slate-900">
                    {brand.logo ? (
                        <img src={brand.logo} alt="Your logo" className={`absolute ${corner}`} style={{ width: `${brand.logoSize * 100}%` }} />
                    ) : (
                        <span className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-white/60">Your logo preview appears here</span>
                    )}
                    {wm.text.trim() && (
                        <span
                            className={`absolute ${wmPos} font-extrabold text-white transition-all duration-500`}
                            style={{ fontFamily: 'CapMontserrat', fontSize: `${wm.size * 224}px`, opacity: wm.opacity, WebkitTextStroke: '2px rgba(0,0,0,0.75)', paintOrder: 'stroke fill' }}
                        >
                            {wm.text.trim()}
                        </span>
                    )}
                    <span className="absolute inset-x-0 bottom-[24%] text-center text-lg text-white" style={{ fontFamily: 'CapMontserrat', WebkitTextStroke: '4px #000', paintOrder: 'stroke fill' }}>
                        YOUR <span style={{ color: '#c8ff3d' }}>CLIP</span>
                    </span>
                </div>
            </div>
        </div>
    );
}
