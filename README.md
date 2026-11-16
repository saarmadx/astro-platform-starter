# Clipsmith

Turn long videos (podcasts, interviews, talks, streams) into short vertical clips with animated captions, ready for YouTube Shorts, TikTok and Reels.

## Features

- **Upload** a long video. It stays in the browser; only the audio is sent off for transcription.
- **Transcription** with word timings (OpenAI Whisper, via `/api/transcribe`).
- **AI clip finder** (Claude, via `/api/highlights`): picks the best moments, scores each 0–100 with a hook / flow / value / shareability breakdown, and suggests a title, description, hashtags, keywords and emoji.
- **Follow the speaker**: MediaPipe face detection builds a smooth crop path so vertical clips keep the speaker in frame. Manual framing and "fit + blur" are also available.
- **18 caption templates** with word-by-word highlighting, keyword emphasis, auto emoji and top / middle / bottom placement.
- **Timeline editor**: video track with thumbnails and trim handles, split / delete / restore, captions track (click to edit), effects track (draggable zooms, hook title, freeze), audio waveform with bleeps, keyboard shortcuts and undo.
- **Effects**: facecam + gameplay split layout (auto facecam detection), punch-in zooms (auto on laughs), hook title, remove silences, freeze-frame ending, progress bar, animated emoji, swear filter with bleep, speaker colours.
- **Optional effects** (each with an on/off switch): sound effects (synthesised in the browser), instant replay, screen shake & flash, text stickers, background music with ducking, presets and apply-to-all-clips.
- **More**: stream chat spikes (Twitch/YouTube chat replays), improve a clip or translate captions via a free Claude chat, compilation maker with countdown cards, project backup/restore, undo/redo.
- **Speed**: exports render pieces in parallel on several ffmpeg.wasm engines (one per core) and join them without re-encoding.
- **Extras**: watch all clips back to back, export all with a titles/descriptions file, title ideas, thumbnail maker, best clips across projects.
- **Brand kit**: logo watermark on every export.
- **Formats**: 9:16, 1:1, 16:9; export 720p or 1080p MP4, one clip or all, plus `.srt` captions.
- **Projects** are saved in the browser (IndexedDB) so you can come back to them.

## Free mode (default)

Nothing needs to be paid for:
- **Captions** run on your own computer with Whisper (transformers.js in a web worker). The model downloads once from Hugging Face.
- **Clip picking**: either the **laugh detector** (no AI: clips built around bursts of laughter) or **With Claude chat** (the app gives you a prompt with the transcript; paste it into claude.ai and paste the answer back).

The paid options below are optional.

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
- `src/components/`: `Studio` (shell + pipeline), `Home`, `ProjectView`, `Editor`, `BrandKit`
- `src/lib/video.ts`: ffmpeg.wasm audio extraction and clip rendering (crop path, captions, emoji, logo)
- `src/lib/captions.ts` + `templates.ts`: caption templates, `.ass` and `.srt` builders
- `src/lib/draw.ts`: canvas preview that matches the export
- `src/lib/faces.ts`: speaker tracking with MediaPipe
- `src/lib/store.ts`: saved projects and brand kit
- `src/pages/api/transcribe.ts`, `src/pages/api/highlights.ts`: server routes
- `scripts/copy-ffmpeg.mjs`: copies the ffmpeg and MediaPipe runtimes into `public/` before `dev` and `build`

## Limits and ideas for later

- Rendering runs on the viewer's device, so it is slower than a server (about 1–2 minutes per clip).
- Speaker tracking follows the largest face; with several people on screen it may not pick the one talking.
- No YouTube-link import: downloading from YouTube breaks YouTube's terms. Upload files you own or have permission to use.
- Next steps could include user accounts, AI B-roll and direct posting to social platforms.

Caption fonts (Montserrat, Poppins, Anton, Bangers, Press Start 2P, Bungee, Bebas Neue, Rubik, Luckiest Guy, Permanent Marker) are under the SIL Open Font License or Apache 2.0.
