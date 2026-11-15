// Copies the ffmpeg.wasm core into public/ so the browser can load it from our own domain.
import { cpSync, mkdirSync } from 'node:fs';

const src = 'node_modules/@ffmpeg/core/dist/esm';
const dest = 'public/ffmpeg';
mkdirSync(dest, { recursive: true });
cpSync(`${src}/ffmpeg-core.js`, `${dest}/ffmpeg-core.js`);
cpSync(`${src}/ffmpeg-core.wasm`, `${dest}/ffmpeg-core.wasm`);
console.log('Copied ffmpeg core to public/ffmpeg');
