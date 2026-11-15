import { defineConfig } from 'astro/config';
import netlify from '@astrojs/netlify';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
    vite: {
        plugins: [tailwindcss()],
        // ffmpeg.wasm spins up its own web worker; pre-bundling breaks that in dev
        optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] }
    },
    integrations: [react()],
    adapter: netlify()
});
