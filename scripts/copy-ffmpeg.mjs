// Copies browser runtimes (ffmpeg.wasm core and MediaPipe face detection) into public/
// so the app loads them from its own domain.
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('public/ffmpeg', { recursive: true });
for (const f of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) cpSync(`node_modules/@ffmpeg/core/dist/esm/${f}`, `public/ffmpeg/${f}`);

mkdirSync('public/mediapipe', { recursive: true });
cpSync('node_modules/@mediapipe/tasks-vision/wasm', 'public/mediapipe', { recursive: true });

console.log('Copied ffmpeg core and MediaPipe wasm into public/');
