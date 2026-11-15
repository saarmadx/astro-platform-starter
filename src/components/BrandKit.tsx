import { useState } from 'react';
import type { Brand } from '../lib/types';
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

    return (
        <div className="flex max-w-4xl flex-col gap-6">
            <div>
                <h1 className="!text-3xl">Brand kit</h1>
                <p className="mt-1 text-muted">Add your logo once and it is placed on every clip you export.</p>
            </div>
            <div className="grid gap-6 md:grid-cols-[1fr_auto]">
                <div className="panel flex flex-col gap-5 p-5">
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
                    <span className="absolute inset-x-0 bottom-[24%] text-center text-lg text-white" style={{ fontFamily: 'CapMontserrat', WebkitTextStroke: '4px #000', paintOrder: 'stroke fill' }}>
                        YOUR <span style={{ color: '#c8ff3d' }}>CLIP</span>
                    </span>
                </div>
            </div>
        </div>
    );
}
