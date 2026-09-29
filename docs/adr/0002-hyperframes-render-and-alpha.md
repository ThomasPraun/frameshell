---
status: accepted
---

# HyperFrames clips render headlessly to VP9-alpha WebM; `render()` stays `{ file, hasAlpha }`

The HyperFrames adapter renders from Node with `@hyperframes/producer` (`createRenderJob` + `executeRenderJob`, no CLI). It writes **VP9 WebM with alpha** (`format: "webm"`) as the clip cache file. It does not use ProRes 4444 `.mov`. Chromium's `<video>` cannot decode ProRes, so a `.mov` cache (what SPEC §3.4 says now) would fail in the preview. The same WebM plays in Chromium with correct alpha and overlays correctly in ffmpeg, and it is about 65x smaller. The adapter contract keeps its shape, `render(clip, ctx) → { file, hasAlpha }`, and gains one format rule: when `hasAlpha` is true, `file` is VP9 WebM with `alpha_mode=1`. SPEC edits under Consequences were approved and applied.

## Evidence

Spike code: `spikes/hyperframes-alpha/` (reproduce with `npm install && npm run bench`, see its README). Composition: 8 s, 2560x1440, 30 fps, GSAP title card. It has no page background, one `rgba(…, 0.6)` panel and one opaque dot.

Setup: Apple M3, 8 cores, 8 GB RAM, macOS 26.3, Node 22.16.0, `@hyperframes/producer` 0.8.92, chrome-headless-shell 154.0.8037.57 (SwiftShader GL, screenshot capture), ffmpeg 6.0 (`ffmpeg-static` 5.3.0), ffprobe 4.4 (`ffprobe-static` 3.1.0). Other spike agents were running on the same machine at the same time. Timings may include noise from that, and I could not quantify it.

`npm run bench` (3 runs per variant, warm). Alpha was read at t = 3 s from the decoded pixel at an empty corner, the 0.6 panel and the opaque dot. The expected values are 0 / ~153 / 255.

| format | quality | render s (runs) | median s | size MB | pix_fmt (ffprobe) | alpha corner/panel/dot | overlay s |
|---|---|---|---|---|---|---|---|
| mov (ProRes 4444) | standard | 21.41, 22.44, 24.65 | 22.44 | 58.1 | yuva444p12le | 0/154/255 | 6.13 |
| webm (VP9) | standard | 23.65, 21.84, 22.15 | 22.15 | 0.9 | yuv420p (alpha_mode=1) | 0/154/255 | 3.01 |
| png-sequence | standard | 15.01, 15.65, 14.37 | 15.01 | 11.7 | rgba | 0/153/255 | n/a |
| mov | draft | 24.4, 23.74, 22.2 | 23.74 | 58.1 | yuva444p12le | 0/154/255 | 5.33 |
| mov | high | 23.17, 21.5, 24.37 | 23.17 | 58.1 | yuva444p12le | 0/154/255 | 4.69 |

Other measurements:

- **Where time goes** (one warm mov run, total 23.57 s, from producer trace): browser probe 3.63 s, capture plus streaming encode of 240 frames 18.38 s (about 77 ms per frame), assemble 0.07 s. Rendering takes about 2.8x the clip's real duration.
- **Cold first render** (first run after install): 38.43 s. This is a single observation.
- **Workers.** The producer sees 8 GB RAM and switches to a low-memory profile with 1 capture worker. With `PRODUCER_LOW_MEMORY_MODE=false`, mov took 22.28 s and 22.57 s with 2 workers, and 20.91 s and 21.94 s with 4 workers. Parallel capture gives no real gain on this machine.
- **Quality setting.** `quality` does not change ProRes output: 58.1 MB at draft, standard and high.
- **Chromium playback** (`src/chromium-playback.mjs`, Chrome for Testing 154). `.mov`: `canPlayType('video/quicktime; codecs="ap4h"')` returns `""`, and loading fails with `DEMUXER_ERROR_NO_SUPPORTED_STREAMS`. `.webm`: loads at 2560x1440, and a canvas readback at 3 s gives alpha 0/154/255.
- **VP9 decoder trap** (`src/vp9-decoder-check.mjs`). ffmpeg's native `vp9` decoder returns alpha 255/255/255, which means the clip becomes opaque. `-c:v libvpx-vp9` returns 0/154/255. `ffprobe` reports `yuv420p` for VP9 alpha, and only the `alpha_mode=1` stream tag shows that alpha is present.
- **Overlay.** `overlay=format=auto` on a synthetic `testsrc2` H.264 background, re-encoded to H.264 1440p. I extracted frames at 0.1 s, 3 s and 7.5 s and inspected them for both mov and webm. The background shows through the empty areas, the panel is translucent, the text is opaque, and the fade-out blends. No fringe or key colour was visible.
- **PNG-then-encode workaround** (`src/png-encode.mjs`). This means capturing once and encoding ourselves. Encoding the PNG sequence took 12.76 s to VP9 alpha (0.6 MB) and 10.16 s to ProRes 4444 (58.1 MB). Alpha was correct in both. Producing a single format this way (15.01 + 12.76 s) is slower than a direct render. It only helps if we ever need both a preview file and a master file.

Not measured: Linux and Windows (the producer docs say Linux falls back to slower screenshot capture for alpha), Electron's own Chromium build (Chrome for Testing was used as a proxy), compositions with audio, any objective quality metric for VP9 4:2:0 compared with ProRes 4:4:4 on the final export, and machines with more than 8 GB RAM.

## Considered options

- **ProRes 4444 `.mov` cache** (current SPEC §3.4). It has true 10-bit 4:4:4 alpha, but Chromium cannot play it, so preview would need a second file. It is also 58 MB per 8 s at 1440p. Rejected as the cache format.
- **PNG sequence plus our own encode.** It is lossless and one capture can feed several formats, but a single format is slower and it adds more code to maintain. Keep this in reserve in case a ProRes master is ever needed next to the preview WebM.
- **Chroma key.** Not needed. The producer outputs real alpha (the transparency comes from Chrome's capture, not from keying a coloured background).

## Consequences

- **SPEC §3.4**: change the cache path to `.frameshell/cache/clips/<hash>.webm` (VP9 with alpha). Opaque renders may use H.264 `.mp4`.
- **SPEC §8.2**: keep the `{ file, hasAlpha }` shape and add: "`hasAlpha: true` ⇒ VP9 WebM, `alpha_mode=1`; file must play in Chromium `<video>`."
- **SPEC §3.5 / #9, #17 (export compiler)**: for every VP9 input with alpha, emit `-c:v libvpx-vp9` before `-i`. Otherwise the overlay silently turns opaque. Add a golden test for this.
- **SPEC §9 / #6 (managed binaries)**: the pinned ffmpeg build must include libvpx, both the decoder and the encoder. `frameshell doctor` should check for it. HyperFrames also needs its own Chrome: puppeteer's chrome-headless-shell, 202 MB in `~/.cache/puppeteer`. The managed-binaries policy should cover it, or point the producer at it with `PRODUCER_HEADLESS_SHELL_PATH`.
- **#24 (HyperFrames adapter)**: call the producer in-process with `format: "webm"`. Point `HYPERFRAMES_FFMPEG_PATH` / `HYPERFRAMES_FFPROBE_PATH` at the managed binaries. Set width and height through the composition (`data-width` / `data-height`), because they are not job options. Expect about 3x real time for 1440p on an 8 GB M3, so the SPEC's background render with a progress placeholder is the right UX.
- **Risk**: VP9 4:2:0 alpha is lossy and chroma-subsampled. If fine coloured text looks soft in the final export, render an extra ProRes master for export only (measured cost: about +22 s per 8 s clip).
