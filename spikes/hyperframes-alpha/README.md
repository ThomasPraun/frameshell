# Spike: HyperFrames headless render with alpha (PROTOTYPE, throwaway)

Ticket #3. Answers one question: can a HyperFrames composition be rendered from Node
(no interactive CLI) to a file with real alpha, and overlaid on footage with ffmpeg?
Decision and numbers: [`docs/adr/0002-hyperframes-render-and-alpha.md`](../../docs/adr/0002-hyperframes-render-and-alpha.md).

Self-contained npm package. Not part of any pnpm workspace. Nothing installed system-wide:
ffmpeg and ffprobe come from `ffmpeg-static` / `ffprobe-static`.

## Layout

| Path | What |
|---|---|
| `composition/index.html` | 8 s, 2560x1440, 30 fps title card. GSAP timeline, no page background, one `rgba(…, 0.6)` panel to test partial alpha |
| `src/render.mjs` | `createRenderJob` + `executeRenderJob` from `@hyperframes/producer`, then ffprobe + per-pixel alpha check. Prints JSON |
| `src/overlay.mjs` | Synthetic `testsrc2` background, `overlay` filter, extracts frames at 0.1 s, 3 s, 7.5 s to `out/frames/` |
| `src/bench.mjs` | Every variant x N runs + one overlay each. Prints the Markdown table used in the ADR |
| `src/chromium-playback.mjs` | Loads mov and webm in headless Chrome `<video>`, reads alpha via canvas |
| `src/vp9-decoder-check.mjs` | Same VP9 pixel via ffmpeg native `vp9` vs `libvpx-vp9` decoder |
| `src/png-encode.mjs` | Workaround path: PNG sequence encoded to VP9 alpha and ProRes 4444 by ffmpeg-static |
| `src/ff.mjs` | ffmpeg-static / ffprobe-static helpers, pixel sample coordinates |
| `out/` | Generated media (gitignored) |

## Reproduce

Requires Node >= 22. Install is slow on first run: `ffprobe-static` ships binaries for all platforms (~350 MB unpacked),
and puppeteer downloads Chrome for Testing + chrome-headless-shell into `~/.cache/puppeteer` (per-user cache).

```sh
npm install
npm run bench          # all measurements in the ADR table (5 variants x 3 runs + overlays)
```

Single steps:

```sh
npm run render:mov     # ProRes 4444 .mov  -> out/title-card-standard.mov
npm run render:webm    # VP9 alpha .webm   -> out/title-card-standard.webm
npm run render:png     # RGBA PNG sequence -> out/title-card-standard-png/
node src/render.mjs mov --quality high --workers 2
npm run overlay -- out/title-card-standard.mov   # composite + frames in out/frames/
npm run chromium       # needs render:mov + render:webm first
npm run vp9check       # needs render:webm first
npm run png-encode     # needs render:png first
PRODUCER_LOW_MEMORY_MODE=false node src/render.mjs mov --workers 4   # worker measurement
```

`src/render.mjs` sets `HYPERFRAMES_FFMPEG_PATH` / `HYPERFRAMES_FFPROBE_PATH` so the producer uses
the local static binaries, and copies `gsap.min.js` from `node_modules` next to the composition so the
render is offline.

## Gotchas found

- VP9 alpha: `ffprobe` reports `pix_fmt=yuv420p`. Alpha is a side channel, flagged only by the stream tag
  `alpha_mode=1`. Decode with `-c:v libvpx-vp9` or ffmpeg's native vp9 decoder silently drops alpha.
- ProRes 4444: `ffprobe` reports `yuva444p12le` (producer encodes `yuva444p10le`; decoder output is 12-bit).
- Producer detects total RAM <= 8 GiB and switches to a low-memory profile with 1 capture worker.
  Override with `PRODUCER_LOW_MEMORY_MODE=false` and/or `--workers N`.
- Output resolution comes from the composition (`data-width` / `data-height` + viewport meta), not from the job config.
