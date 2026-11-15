# Clipsmith

Turn long videos (podcasts, interviews, talks, streams) into short vertical clips with animated captions, ready for YouTube Shorts, TikTok and Reels.

## How it works

1. **Upload**: the video stays in the browser. [ffmpeg.wasm](https://ffmpegwasm.netlify.app/) pulls out the audio in 10-minute mp3 chunks.
2. **Transcribe**: `/api/transcribe` sends each audio chunk to OpenAI Whisper and gets word-level timestamps.
3. **Pick clips**: `/api/highlights` sends the timestamped transcript to Claude, which returns the best moments with a hook, a 0–100 score, a title, a description and hashtags.
4. **Edit**: a live 9:16 preview with captions; trim the start and end, choose a caption style and highlight colour, and slide the crop to follow the speaker.
5. **Export**: ffmpeg.wasm cuts the clip, crops it to 720×1280 and burns in word-by-word captions. The MP4 downloads straight from the browser.

## Setup

```bash
npm install
cp .env.example .env   # then fill in the keys
npm run dev            # http://localhost:4321
```

| Variable | What it's for |
| --- | --- |
| `OPENAI_API_KEY` | Speech-to-text (Whisper) |
| `ANTHROPIC_API_KEY` | Picking the best clips (Claude) |
| `APP_ACCESS_CODE` | Optional. If set, the studio asks for this code so strangers can't spend your API credits |

On Netlify, add the same variables under **Site configuration → Environment variables**.

## Project layout

- `src/pages/index.astro`: landing page
- `src/pages/studio.astro` + `src/components/Studio.tsx`: the clip editor
- `src/lib/video.ts`: ffmpeg.wasm audio extraction and clip rendering
- `src/lib/captions.ts`: animated `.ass` caption builder
- `src/pages/api/transcribe.ts`, `src/pages/api/highlights.ts`: server routes
- `scripts/copy-ffmpeg.mjs`: copies the ffmpeg core into `public/ffmpeg` before `dev` and `build`

## Limits and ideas for later

- Rendering runs on the viewer's device, so it is slower than a server (about 1–2 minutes per clip).
- The crop position is manual. Automatic face tracking would be the next upgrade.
- No YouTube-link import: downloading from YouTube breaks YouTube's terms. Upload files you own or have permission to use.
- Next steps could include user accounts, saved projects, B-roll and emoji inserts, and batch export.
