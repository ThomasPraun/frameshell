# WebGL2 grade pass in the preview (spike G0 for #384)

ADR 0031 decides that colour grade goes through **one generated 3D table**: export applies it with `lut3d interp=trilinear`, and the preview applies the same table in a WebGL2 pass, "after a measured WebGL2 spike". This is that spike. It answers four questions. Can the engine worker run the pass? What does it cost per frame? How close is it to ffmpeg? What should G2 build?

Prototype: `spikes/webgl2-grade/` (throwaway, not in the pnpm workspace). It is the engine worker's shape reduced to the grade: WebCodecs `VideoDecoder` in a dedicated worker, the visible canvas handed over with `transferControlToOffscreen` and drawn with a 2D context, and a second `OffscreenCanvas` with a `webgl2` context that applies the table before the 2D draw. No shipped code changed.

## Answers

1. **Yes.** `OffscreenCanvas.getContext('webgl2')` works in a dedicated worker in Electron 44.5.0 (Chrome 152): `ANGLE (Apple, ANGLE Metal Renderer: Apple M3)`, `MAX_3D_TEXTURE_SIZE` 2048. A decoded `VideoFrame` (NV12, hardware decoder) goes straight into `texImage2D`. A 33- or 65-point table is a 3D texture. The result reaches the 2D composite through `transferToImageBitmap()` + `drawImage`, or through `drawImage(glCanvas)`. Both hand-offs are pixel-identical to reading the GL canvas directly (0 differing pixels).
2. **Cheap enough.** The cost at 1080p is GPU-side; the worker's JavaScript time per composite stays at 0.3 ms p95 or less for 4 layers. GPU round trip, 1080p: 1 graded layer adds about 0.1 ms over the ungraded draw (2.1 vs 2.0 ms). 4 graded layers add 2.2-2.8 ms (6.1-6.4 vs 3.6-3.9 ms). Both are well inside a 33.3 ms frame at 30 fps. In rAF-paced playback (30 fps content on a 120 Hz display), 4 graded 1080p layers showed no long ticks after the first 4 ticks, the same as the ungraded draw.
3. **Parity: the table lookup matches ffmpeg to the bit, once you know ffmpeg truncates.** `lut3d` converts its float result to 8 bit by **truncation**, not rounding. A shader that does trilinear itself (8 `texelFetch` taps on an `RGBA32F` texture) and floors to 8 bit matches `lut3d` on all but 36-41 of 6.2 M channel values (max 1). With the GPU's normal rounding instead, the shader is 0-1 LSB off ffmpeg on 39 % of channels (mean 0.37-0.45). The difference that remains on video is **not the grade**: it is chroma upsampling in YUV→RGB, which the ungraded preview already has. Chromium interpolates the 4:2:0 chroma bilinearly; ffmpeg's automatic conversion does not. On adversarial 8×8 random-colour blocks this gives max 8/3/9 ungraded and 11/5/12 graded (R/G/B, 8-bit), mean about 1.
4. **Recommendation: build G2 as measured here, with two additions to ADR 0031** (see [Recommendation](#recommendation-for-g2)): the table is sampled with 8 taps and floored to match `lut3d`, and the YUV→RGB conversion on both sides stays as it is today.

## Machine and method

- MacBook Pro 14" Apple M3, 8 GB, macOS 26.3, built-in 120 Hz display; Electron 44.5.0 / Chrome 152.0.7977.130 (the desktop app's pin), Node 22.16. ffmpeg: the pinned 9.0.2 darwin-arm64 build from `.cache/test-binaries` (`docs/binaries.md`).
- The machine was shared with other agents' jobs: load average 2.6-7.9 during the runs. Numbers are upper bounds.
- **Fixtures** (`scripts/make-fixtures.mjs`, all synthetic, generated, not committed):
  - A strong look (S-curve contrast, saturation 1.5, cross-channel twist, warm offset), so that interpolation between lattice points is visible. It is written as `.cube` files at 33 and 65 points with 6 decimals. Both sides read the same file.
  - `random.png`: 1920×1080, every pixel an independent random RGB, plus the grey ramp and the 8 cube corners. This tests the table alone, with no YUV.
  - `blocks.*.h264`: 1920×1080 8×8 blocks of random colour. It was converted with `out_color_matrix=bt709:out_range=tv` and encoded with libx264 High, crf 4, no B-frames. There are two variants: one tagged bt709/tv like the proxy recipe (`PROXY_COLOR_TAGS`), and one whose VUI says "unspecified". Random saturated colours with hard edges are the worst case for chroma subsampling.
  - `bench1080.h264`, `bench540.h264`: 10 s `testsrc2` at 30 fps, encoded like the proxy (High, no B-frames, GOP 15, bt709 tv). The real preview plays 960×540 proxies (`PROXY_SHORT_SIDE`), so 1080p is the upper bound.
- **Shader** (`src/worker.js`): a full-screen triangle. The source is `texImage2D(VideoFrame | ImageBitmap)`, sampled NEAREST. There are two table paths:
  - *hw*: an `RGBA16F` 3D texture with `LINEAR` filtering, at `(c·(n−1)+0.5)/n`;
  - *8-tap*: an `RGBA32F` texture read with 8 `texelFetch` and mixed in the shader, the way `lut3d` computes it.
  
  Optional `floor(c·255)/255` before output.
- **Cost:** for each configuration, 150 frames after 10 warm-up frames. The frames come from 1 or 4 live hardware decoders of the same stream, and every layer is composited full size, the upper layers at opacity 0.8. Three paths:
  - `2d`: today's `drawImage(VideoFrame)`;
  - `gl-bitmap`: grade, then `transferToImageBitmap` and `drawImage`;
  - `gl-canvas`: grade, then `drawImage(glCanvas)`.

  Two timings:
  - *synced*: composite plus a 1-pixel `getImageData`, which waits for the GPU. This is latency, including one readback.
  - *paced*: one composite per worker `requestAnimationFrame` tick on a 30 fps clock. It reports tick intervals, ticks longer than 1.5× the median, and wall time.

  The whole matrix ran twice. A 280-frame paced run of the 4-layer 1080p case ran twice per path (`results/paced4.json`). Worker `performance.now()` resolution is 0.1 ms.
- **Parity** (`scripts/compare.mjs`, `scripts/yuv-check.mjs`): readbacks of the GL canvas and of the 2D hand-off, compared per channel against:
  - ffmpeg `lut3d=…:interp=trilinear`;
  - a float64 trilinear reference in Node, rounded or truncated;
  - a float64 bt709 limited-range conversion of the decoded YUV.

  On the block fixture only block interiors are compared (pixels 2-5 of each 8), to keep 4:2:0 edge bleed out.

Reproduce: `cd spikes/webgl2-grade && FFMPEG=<pinned ffmpeg> node scripts/make-fixtures.mjs`. Then `<electron> src/main.cjs --only=parity`, `--only=bench`, `--only=paced4`, and `npm run compare`. `<electron>` is `apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`.

## Cost (measured)

GPU round trip per composite: mean / p95 / max in ms, run 1 and run 2. "Graded" is hardware trilinear, 33 points, unless noted.

| Frame | Layers | `2d` (today, ungraded) | `gl-bitmap` (graded) | `gl-canvas` (graded) |
|---|---|---|---|---|
| 1920×1080 | 1 | 2.04 / 3.0 / 3.1 · 2.05 / 2.9 / 3.5 | 2.11 / 2.9 / 3.1 · 2.15 / 3.0 / 3.2 | 2.39 / 3.2 / 3.3 · 2.36 / 3.2 / 3.3 |
| 1920×1080 | 4 | 3.88 / 4.3 / 5.5 · 3.63 / 4.6 / 6.2 | 6.08 / 6.8 / 7.8 · 6.45 / 7.8 / 8.3 | 8.25 / 9.1 / 11.4 · 8.04 / 9.5 / 10.5 |
| 960×540 | 1 | 0.78 / 1.0 / 1.9 · 0.90 / 1.5 / 2.1 | 1.16 / 2.0 / 2.1 · 1.16 / 2.0 / 2.1 | 1.27 / 1.9 / 2.2 · 1.28 / 2.0 / 2.2 |
| 960×540 | 4 | 1.92 / 2.7 / 2.9 · 1.96 / 2.8 / 2.9 | 4.63 / 5.5 / 5.7 · 4.62 / 5.4 / 5.8 | 4.56 / 5.3 / 5.5 · 4.55 / 5.3 / 5.4 |

1080p, 4 layers, other variants (synced mean, run 1 · run 2):

| Variant | ms |
|---|---|
| `gl-bitmap`, 65 points, hw trilinear | 6.17 · 6.48 |
| `gl-bitmap`, 65 points, 8-tap | 6.29 · 6.32 |
| GL pass alone (`readPixels` 1 px, no 2D hand-off), identity shader | 2.93 · 2.93 |
| GL pass alone, 33 points hw | 2.99 · 2.97 |
| GL pass alone, 65 points 8-tap | 3.70 · 3.63 |
| GL pass alone, 1 layer, 33 points hw | 1.14 · 1.21 |

What this says:

- **The table lookup itself is nearly free.** With hardware filtering it costs the same as an identity shader (2.97 vs 2.93 ms for 4 layers). The 8-tap path at 65 points adds about 0.17 ms per 1080p layer. Most of the GL time is the `VideoFrame` upload (NV12→RGBA conversion in `texImage2D`).
- **Each graded layer costs about 0.7 ms at 1080p**, mostly fixed per hand-off between the GL and 2D contexts. 540p costs nearly the same as 1080p (4 layers: +2.7 ms vs +2.2-2.8 ms).
- **`transferToImageBitmap` beats `drawImage(glCanvas)` at 1080p** (6.1-6.4 vs 8.0-8.3 ms for 4 layers) and ties at 540p.
- **The table texture's size does not matter.** Setup measured once per table: 33 points takes 9 ms to parse from `.cube` text and 1.4-1.6 ms to upload both textures. 65 points takes 61 ms to parse and 6.1-6.4 ms to upload. Shader compile plus context creation took 14-436 ms; the first run in a fresh profile was slowest.
- **CPU in the worker:** submit time p95 is 0.1 ms for 1 layer and 0.3-0.4 ms for 4 layers, the same for all three paths. The work is GPU-side and asynchronous.
- **Paced playback** (30 fps content, 120 Hz rAF): wall time was within 0.12 % of the expected 4.97 s and 9.30 s for every path. In the 280-frame runs every tick longer than 1.5× the median was among the first 4 ticks of the run, for `2d` as well (max 17.7 ms). The GL paths had 1-3 startup ticks of 25-42 ms. After those, 0 long ticks on every path. The 150-frame runs agree: the maximum tick was 16.6-17.7 ms for `2d` and 33-50 ms for the 4-layer GL paths, at most 2 long ticks per run (positions not recorded there). Ticks p95 was 8.4-8.5 ms everywhere.

Against ADR 0001: its thresholds are freezes at cuts (p95 ≤ 17 ms, ≤ 5 % of cuts), interior drops (≤ 0.1 %) and wall time (≤ 0.1 %). They were measured with the full app harness, which this spike did not run. The worst composite here is 4 graded 1080p layers at a synced p95 of 7.8 ms. That is under half of the 17 ms freeze budget and under a quarter of a 30 fps frame. Steady-state playback added no long ticks. The startup ticks of 25-50 ms on the GL paths are the thing to watch: they fall inside the 167 ms freeze cap but above the 17 ms p95. G2 should create the GL context and compile the shader when the engine starts, not on the first graded frame.

## Parity (measured)

Per-channel absolute error in 8-bit levels: max R/G/B, then the share of pixels with any channel off by more than 1 or more than 2. Full table: `spikes/webgl2-grade/results/parity.txt`.

### The table alone (RGB still, no YUV)

| Comparison | max | %px >1 | note |
|---|---|---|---|
| GL readback of the uploaded still vs source | 0/0/0 | 0 | upload is exact (`colorSpaceConversion: 'none'`) |
| ffmpeg `lut3d` vs float64 reference, **truncated** | 1/1/1 | 0 | mean 0.000: ffmpeg truncates |
| ffmpeg `lut3d` vs float64 reference, rounded | 1/1/1 | 0 | mean 0.37-0.45 |
| shader 8-tap `RGBA32F` vs float64 reference, rounded | 1/1/1 | 0 | mean 0.000 |
| shader hw `RGBA16F` vs float64 reference, rounded | 1/1/1 | 0 | mean 0.02 (from the video run; the still is the same) |
| shader 8-tap vs ffmpeg | 1/1/1 | 0 | 39 % of channels off by 1 (rounding vs truncation) |
| shader hw vs ffmpeg | 1/1/1 | 0 | 39 % of channels off by 1 |
| **shader 8-tap + floor vs ffmpeg**, 33 and 65 | 1/1/1 | 0 | **41 and 36 of 6,220,800 channels differ** |
| shader hw + floor vs ffmpeg, 65 | 1/1/1 | 0 | 2.1 % of channels differ (half-float table, fixed-point filter weights) |
| either shader through `ImageBitmap` → 2D `drawImage` | same as the GL readback | | the hand-off adds nothing |
| ffmpeg at 33 points vs ffmpeg at 65 points | 3/2/3 | 0.74 | how much the table size matters for this look |

### Video: decoded bt709 limited-range H.264

| Comparison (block interiors) | max | mean | %px >2 |
|---|---|---|---|
| Chromium 2D `drawImage(VideoFrame)` vs Chromium GL `texImage2D(VideoFrame)` (whole frame) | 1/1/1 | 0.000 | 0 |
| GL with `UNPACK_COLORSPACE_CONVERSION_WEBGL` default vs `NONE` | 0/0/0 | 0 | 0 |
| Chromium (2D or GL) vs ffmpeg automatic conversion (`format=rgba`, tagged stream) | 8/3/9 | 1.08/0.62/1.20 | 24.2 |
| Chromium vs float64 bt709 limited, **pixels with flat chroma** (n = 3592) | 0/0/0 | 0 | 0 |
| ffmpeg automatic (tagged) vs float64 bt709 limited, nearest chroma | 1/1/1 | 0.24/0.49/0.24 | 0 |
| ffmpeg `scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd+full_chroma_int` vs ffmpeg automatic | 13/5/15 | 1.82/0.81/2.04 | 40.1 |
| **shader (hw or 8-tap, 33 or 65) vs ffmpeg automatic + `lut3d`** | 11/5/12 | 1.17/1.00/1.22 | 27.7 |
| shader vs float64 trilinear of the GL's own decode (the table alone, on video) | 1/1/1 | ≤ 0.023 | 0 |
| **untagged stream:** ffmpeg automatic vs ffmpeg automatic of the tagged twin | 22/37/11 | 7.14/11.04/3.26 | 95.5 |
| untagged stream: shader vs ffmpeg automatic + `lut3d` | 25/37/15 | 4.3/9.1/2.5 | 93.5 |

### YUV range and matrix pitfalls (measured)

- **Chromium's conversion is exact bt709 limited range.** Where chroma is flat it is identical to a float64 conversion. It differs from ffmpeg only in chroma upsampling: Chromium is bilinear, while ffmpeg's automatic conversion is close to nearest-sample (within 1 of it). All the video error above comes from that. It is already in today's ungraded preview, and the grade does not add to it. On real footage, chroma is far smoother than random 8×8 blocks, so the difference should be much smaller, but that was not measured.
- **Untagged streams split the two decoders.** Chromium reported `colorSpace` bt709 for a stream whose VUI says "unspecified" and converted it as bt709. ffmpeg's automatic conversion treated the same stream as bt601: up to 37 levels off in green. In Frameshell today this cancels out, because the preview never decodes a source. The proxy recipe converts the source with ffmpeg's automatic input matrix and writes tagged bt709 (`proxyVideoFilter`, `PROXY_COLOR_TAGS`). Export decodes the source with the same automatic interpretation (`videoGraph` sets no `in_color_matrix`). So an untagged source gets one interpretation on both sides. This was inferred from the code; no end-to-end export of an untagged source was compared.
- **Changing only one side breaks parity by up to 15 levels.** Adding `full_chroma_int`/`accurate_rnd`, or an explicit `in_color_matrix`, to the export graph without the proxy recipe (or the reverse) moves results by up to 13/5/15 on this fixture.
- **`UNPACK_COLORSPACE_CONVERSION_WEBGL` has no effect** on `VideoFrame` uploads (0 differing pixels). Stills must be decoded with `createImageBitmap(…, { colorSpaceConversion: 'none' })`, or the browser may colour-manage them.
- **Not tested:** full-range (`pc`, `yuvj*`) sources, 10-bit sources, bt601 or bt2020 tagged sources, and VP9-alpha proxies.

## Recommendation for G2

Build the preview grade as prototyped. ADR 0031's approach holds: one generated table, `lut3d interp=trilinear` in export, a WebGL2 pass in the engine worker.

1. **One WebGL2 `OffscreenCanvas` per engine**, created and compiled when the engine starts (about 14 ms warm, up to 436 ms cold), not on the first graded frame. Per graded part:
   - `texImage2D(VideoFrame)`;
   - draw the table pass;
   - `transferToImageBitmap()`, then `drawImage` at the part's `layerRect`, with the rest of `#composite` unchanged.

   The grade comes first in ADR 0031's per-part order (grade → shape → mask → backdrop), so it slots in before the existing `drawImage`. Use `transferToImageBitmap`, not `drawImage(glCanvas)`.
2. **Sample the table with 8 `texelFetch` taps on an `RGBA32F` texture and floor to 8 bit**, matching `lut3d`'s trilinear and truncation. That makes preview and export agree on the table to within 1 level on about 6 channels per million. A parity test can then be strict, like the audio effects' 1e-6 test. Hardware filtering on `RGBA16F` is about 0.17 ms per 1080p layer cheaper but only within 1 level on 2 % of channels. Use it only if the 8-tap cost ever matters.
3. **Upload a table once per grade key**, cached by key like the audio bakes. Give the worker the generated `Float32Array`, never `.cube` text: parsing 65 points of text took 61 ms.
4. **Leave YUV→RGB alone on both sides.** G1 must not add `in_color_matrix`, `full_chroma_int` or `accurate_rnd` to the export path of graded clips unless the proxy recipe changes in the same step (and bumps `RECIPE_VERSION`). G1's golden or parity test should use a smooth-chroma fixture with a tolerance. Suggested: max 2 levels, to be set from a measurement on that fixture. Random 8×8 blocks measure chroma upsampling, not the grade.
5. **Fallback:** when `getContext('webgl2')` returns null or the context is lost (`webglcontextlost` on the `OffscreenCanvas`), draw the part ungraded and report it, rather than fail the frame. This case was not measured.
6. **Alpha layers** (VP9-alpha proxies through `AlphaMasker`, renders): grade the colour before the alpha mask is applied, and upload unpremultiplied colour. A table applied to premultiplied colour darkens edges. Not prototyped.
7. **Re-run ADR 0001's harness** (`FRAMESHELL_PREVIEW_MEASURE=1 … preview-thresholds`) with graded clips before shipping G2. This spike's paced loop is a proxy for those thresholds, not the thresholds.

Suggested additions to ADR 0031, for the owner to decide:

- The 8-bit output of `lut3d` is truncated, and the preview floors to match.
- YUV→RGB stays ffmpeg's automatic conversion in export and Chromium's in the preview. Parity is defined after that conversion, and the chroma-upsampling difference is accepted.

Nothing measured argues against the 33/65-point table or the WebGL2 pass.

## Not measured

- Windows and Linux: ANGLE on D3D11, OpenGL or Vulkan, other GPUs, blocklisted GPUs where WebGL2 is unavailable or falls back to SwiftShader. Only one Apple M3 was measured.
- The real engine: the spike reimplements the decode and composite shape and does not run `engine.worker.ts`. ADR 0001's thresholds through the app harness, cuts and seeks with graded clips, and more than 4 layers were not run.
- Photons and display: rAF ticks in the worker and GPU readbacks were measured, not what the panel shows. Nobody looked at graded playback for banding.
- Power, thermals, memory over long sessions, and GPU memory with many cached tables (each 65-point `RGBA32F` table is 4.4 MB, an `RGBA16F` one 2.2 MB).
- Real footage: chroma-upsampling error on natural images, LOG footage, full-range, 10-bit, HDR and wide-gamut sources.
- Alpha layers, `AlphaMasker` output as the grade input, and stills (`ImageBitmap` parts) inside the engine.
- Context loss and recovery.
- Run-to-run variance beyond two runs, on a shared machine.
