# Motion blur: the HyperFrames producer's sub-frame accumulation (#501, slice 0)

Spike 0 of [#501](https://github.com/ThomasPraun/frameshell/issues/501) (epic #451), as the owner's decision of 2026-11-11 asks. The ticket's choice is option A, the producer's built-in `motionBlur`. This note measures what it costs and how it behaves before the ADR (0041, SPEC decision 46) is written. It makes no product change. The harness is `spikes/motion-blur/` (throwaway, not in the pnpm workspace).

## Result

| Question from the decision | Answer on this machine |
|---|---|
| Cost vs a plain render, adaptive | 21x to 27x the screenshot time per output frame (3 fixtures); wall time 7.6x to 20.3x, depending on how loaded the host was during the plain baseline. Over the "about 20x" line on the fast-moving fixture |
| Cost vs a plain render, fixed 8 | 7.4x to 8.1x the screenshot time per frame; wall time 2.5x to 7.4x. Fixed 4 is 3.6x to 4.1x, fixed 16 is 15.2x to 15.8x. Linear and sRGB blend cost the same |
| Are static frames skipped? | **No.** Static-frame dedup does not arm for a seek-only page (`staticDedup.skipReason: "ineligible"`, "no GSAP tweens"), in sharp renders too. Adaptive mode gives every static frame its 16-sample floor plus 2 probes. Fixed 8 captures 8 samples on a frame that does not move |
| Sample counts | Fixed N: N page seeks per frame, plus 2. Adaptive: 2 probes, then 16, 32 or 64 samples, plus 2. On the motion-real fixture 22 of 30 frames sit on the floor, 3 got 32, 5 got 64. The owner's "2 samples when slow" is not available |
| Cold vs reseek, at the page | **0/255** on 96 captures (12 probe frames x the 8 sample times of a fixed-8 render), and 0/255 on the blended frames. Passes the 2/255 gate |
| Repeatability of the blurred render itself | **Not byte-repeatable.** Sharp: byte-identical in 3 of 3 repeat runs. Fixed 8: PNG frames differed in 2 of 3 repeat runs (up to 4/255 and up to 255/255 on a few pixels), WebM up to 92/255 in 2 of 3. Adaptive: PNG up to 2/255, WebM 0. Cause not found |
| Sprung element plus element CSS | Works. `#box { translate: 0px 30px !important; }` moves the blurred box down (centre y 44.5 to 72.1; less than 30 px because the bottom edge clips it), x unchanged (within 0.3 px), and the smear stays |
| Linux `beginframe` | Read from the code, not run: an alpha WebM render never launches `beginframe`, so it neither falls back nor throws. See "Linux" |

By the rule in the decision (adaptive only if static frames are skipped and the cost is at most about 20x, otherwise fixed 8), the numbers point to fixed 8. The owner decides in the ADR.

## Setup

- Apple M3, 8 cores, 8 GB, Darwin 25.3.0 (macOS), Node 22.16.0, 2026-11-11.
- `@hyperframes/producer`, `@hyperframes/engine` 0.9.30; managed Chrome Headless Shell 154.0.8037.57 (software GL, ANGLE SwiftShader), managed ffmpeg 9.0.2, `.cache/test-binaries`.
- The host was shared with other agents of the same wave. Load average (1 min) during the measurements ran from 5 to 50 on 8 cores and is printed with each run. Wall times are noisy for that reason: the **screenshot time per output frame** (`captureScreenshotAvgMs` of the producer's perf summary) held within a few percent across runs and is the figure to compare. A quiet-machine rerun is not done.
- Renders go through the producer in-process, as `plugins/hyperframes/src/adapter.ts` does: `format: "webm"`, `quality: "standard"`, 30 fps, one worker, plus `motionBlur` and `pageMotionBlur: "off"` when blurred. Default blend (sRGB) unless a row says linear.
- Fixtures, all the motion-real composition (red box springs 80 px right while it turns and fades in, three blue dots on a staggered track), painted by `@frameshell/motion`:
  - `fixture`: exactly the test's, 160x90, 1 s, 30 frames, moving on every frame.
  - `hold`: 640x360, 2 s, the world scaled 4x by CSS, time clamped at 1 s: 30 moving frames, then 30 exactly static frames.
  - `hd`: 1280x720, 1 s, scaled 8x.
- Reproduce: `FRAMESHELL_TEST_BINARIES_DIR=$PWD/.cache/test-binaries node spikes/motion-blur/measure.mjs <timing|counts|blur-look|diff|repeat> <fixture>`.

## Cost

Median of the runs, relative to `off` in the same batch. Screenshot is the producer's per-frame screenshot time; capture is the whole capture stage; wall includes browser start and the VP9 encode.

| Fixture (batch, host load) | Mode | Screenshot per frame | Capture stage | Wall |
|---|---|---|---|---|
| `fixture` (3 runs, load 6 to 25) | off | 40 ms | 1.7 s | 1.8 s |
| | adaptive | 1064 ms (26.6x) | 35.7 s (21.2x) | 36.2 s (20.3x) |
| | fixed 4 | 156 ms (3.9x) | 5.7 s (3.4x) | 6.1 s (3.4x) |
| | fixed 8 | 306 ms (7.7x) | 10.9 s (6.5x) | 11.0 s (6.2x) |
| | fixed 16 | 618 ms (15.4x) | 20.7 s (12.3x) | 21.1 s (11.8x) |
| `fixture` (3 runs, load 40 to 48) | off | 37 ms | 5.1 s | 6.5 s |
| | adaptive | 1000 ms (27.0x) | 48.4 s (9.5x) | 49.4 s (7.6x) |
| | fixed 8 | 295 ms (8.0x) | 15.1 s (3.0x) | 16.1 s (2.5x) |
| `hold`, 640x360, 60 frames (2 runs, load 13 to 17) | off | 37 ms | 4.1 s | 4.3 s |
| | adaptive | 778 ms (21.0x) | 63.1 s (15.5x) | 63.2 s (14.8x) |
| | fixed 8 | 276 ms (7.4x) | 30.9 s (7.6x) | 31.7 s (7.4x) |
| `hd`, 1280x720, 30 frames (2 runs, load 6 to 17) | off | 40 ms | 2.6 s | 3.0 s |
| | adaptive | 1038 ms (25.9x) | 43.3 s (16.4x) | 43.5 s (14.7x) |
| | fixed 4 | 162 ms (4.1x) | 7.0 s (2.7x) | 7.3 s (2.5x) |
| | fixed 8 | 323 ms (8.1x) | 12.9 s (4.9x) | 13.0 s (4.4x) |
| | fixed 16 | 632 ms (15.8x) | 25.1 s (9.5x) | 25.3 s (8.5x) |

Reading:

- A sub-frame sample costs about 30 ms (one PNG screenshot plus a seek) here, whatever the size: `hd` has 64 times the pixels of `fixture` and the same per-frame figures, because the content is flat colour. A real composition (images, text, shadows, 3D) will cost more per sample. That is not measured.
- Adaptive averages about 24 samples per frame on `fixture` (28 seeks per frame counting the 4 constant ones) and about 20 on `hold`, half of which is static (see the counts below).
- The linear blend costs the same as sRGB (fixed 8 linear: 10.5 s wall, 323 ms per frame; fixed 8 sRGB: 11.2 to 11.6 s, 304 to 317 ms; load 17 to 25).
- Memory: samples are folded into one running average, so the accumulator holds one frame plus one sample whatever N is (read in `MotionBlurAccumulator`; peak RSS not measured). The producer forces PNG capture while blur is on.

## Sample counts and static frames

A beacon in the composition reported every `seek` the page received (`counts` stage; the beacon only runs in this stage, never in the timing runs). Seeks per output frame:

| Fixture | Mode | Seeks in total | Per frame |
|---|---|---|---|
| `fixture`, 30 frames | off | 33 | 1 (frame 0: 4) |
| | fixed 8 | 301 | 10 (frame 0: 11) |
| | adaptive | 889 | 20 on 22 frames, 36 on 3, 68 on 4, 69 on 1 |
| `hold`, 60 frames | off | 62 | 1 (frame 0: 3) |
| | fixed 8 | 601 | 10 (frame 0: 11) |
| | adaptive | 1490 | 20 on 52 frames, 36 on 3, 68 on 4, 70 on 1 |

- Per frame: N samples plus 2 constant seeks (fixed), or 2 probes plus 16, 32 or 64 samples plus 2 (adaptive). 20 = 16 + 2 + 2, 36 = 32 + 2 + 2, 68 = 64 + 2 + 2.
- Sub-frame times do reach the page: 825 distinct seek times in the adaptive run, not 30.
- **Static frames are not skipped.** In `hold`, frames 30 to 59 do not move at all and all 30 of them were captured with the 16-sample floor and the 2 probes. The producer log says `static-frame dedup: disabled (no GSAP tweens (non-GSAP animation))`, `staticDedup: { enabled: true, armed: false, skipReason: "ineligible" }`. The dedup predicts static frames by walking the GSAP timeline, so a seek-only runtime (ADR 0033) is never eligible, blur or not. The sharp render also captures all 60 frames. The adaptive probes do tell a still frame from a moving one (it uses the floor and not 32 or 64), but the floor is 16.
- The adaptive thresholds (3 and 6) are on the mean absolute byte difference of the two window-edge probes over the whole frame, as read in `probeDiffMagnitude`. On `hd`, where the box is the same share of the frame, the per-frame cost matched `fixture`, so the counts did too (counts themselves were not taken on `hd`).

## Determinism

Three checks, all on `fixture`.

1. **Cold vs reseek at the page** (`diff`). The 8 sample times of the fixed-8 plan for 12 probe frames (96 times) captured once on a fresh page each, and once on one page after an unrelated seek each. Worst byte difference: 0/255 per sample and 0/255 after blending. The page is a pure function of `t`, as ADR 0033 needs. The sample times come from an integer grid of 4096 ticks per frame, so they are the same on every host.
2. **The producer's own frames are the average of those samples.** My average of the 8 captures per probe frame vs the producer's decoded fixed-8 frame: mean absolute byte difference 0.6 to 0.9 (VP9 loss and the producer's tick rounding), against 0.7 to 7.8 for the sharp frame (frames where the box rests are close to sharp, as they should be).
3. **Render to render** (`diff`, `repeat`, `which`, `where`). Same clip rendered again in the same process:

| Mode | PNG sequence, identical frames of 30 | Worst PNG difference | WebM decoded, worst difference |
|---|---|---|---|
| off | 30, 30, 30 (3 runs) | 0 | 0, 0, 0 |
| fixed 8 | 30, 25, 29 | 0, 255, 4 | 0, 92, 92; 4 in another pair |
| adaptive | 27, 28, 30 | 2, 2, 0 | 0, 0, 0, 0 |

- A WebM pair is the largest difference between run 0 and runs 1 and 2. VP9 turns a few-pixel PNG difference into a larger one in the frames after it, so the WebM figures can exceed the PNG ones.
- Where fixed 8 differs, it is a handful of pixels: mean absolute difference over the frame 0.001 to 0.011 of 255, and in one pair four pixels on the edge of a blue dot, alpha 228 against 232. The 255 values are single pixels.
- The differing frames change from run to run (frames 5, 26 to 29 in some runs). Frames 4 and 25 differ from my reference by 13 and 3 in every run, so that is systematic (the producer's tick rounding), not noise.
- The run with a 255/255 pixel began at host load 27; the clean fixed-8 run at load 8.7; the run with a 4/255 PNG difference and 92/255 in WebM began at load 16. So load is a suspect, not a proven cause. A quiet-host rerun is open.
- Adaptive is steadier than fixed 8 in these runs (more samples average the noise away), but its 2/255 PNG differences show the probe thresholds can flip a frame between sample counts.

What this means for the 2/255 gate of ADR 0033's verify (slice 6): it holds at the page, on the sample times. A gate on two renders of the same blurred clip would have failed in 2 of 3 fixed-8 runs here.

## Look, alpha, element CSS

Decoded WebM frames with libvpx (alpha kept). Box shape in the alpha channel at three instants:

| Mode | 0.1 s (fast): width, partly covered pixels | 0.3 s | 0.9 s (rest) |
|---|---|---|---|
| off | 44 px, 1672 | 47 px, 153 | 49 px, 156 |
| adaptive | 52 px, 2023 | 48 px, 182 | 49 px, 160 |
| fixed 8 | 52 px, 2011 | 48 px, 180 | 49 px, 159 |

- Blur widens the box by 8 px while it moves fast and does nothing at rest. Adaptive and fixed 8 look the same on this clip, to 0.6 % in the partly covered pixel count.
- Alpha survives: a blurred edge is partially transparent, the total alpha mass is unchanged (1389 against 1391 at 0.1 s).
- Element CSS (ADR 0021) composes with the sprung transform and the blur. Box centre at 0.1 s, 0.3 s, 0.9 s with `translate: 0px 30px`: (69.1, 72.1), (125.2, 72.1), (109.7, 72.1) blurred, against (69.1, 72.1), (125.2, 72.1), (109.7, 72.1) sharp and (69.2, 44.5), (125.4, 44.5), (110.0, 44.5) blurred without the CSS. The blurred box with CSS is 52 px wide at 0.1 s as without it.

## Linux and the capture mode

Not run (the only host is macOS). Read in `@hyperframes/engine` and `@hyperframes/producer` 0.9.30:

- The engine throws `[MotionBlur] sub-frame motion blur requires screenshot capture mode` when the session is in `beginframe` (`resolveSessionMotionBlur`), and requires PNG capture.
- `beginframe` is chosen only on Linux with headless shell, when the render is not forced to screenshot (`createCaptureSession`). The orchestrator forces screenshot for every alpha format (`callerForced = cfg.forceScreenshot || needsAlpha && !cfg.useDrawElement`), and `webm` is an alpha format. Every Frameshell clip render is alpha WebM, so a Linux render never launches `beginframe`, with or without blur. It does not fall back and does not throw; it is the screenshot path that was measured here.
- `drawElement` fast capture (the other non-screenshot mode) is default-off here: it needs macOS or Windows, a non-software GPU mode and worker encode, and the default GPU mode is software. Forcing it on this machine (`PRODUCER_EXPERIMENTAL_FAST_CAPTURE=true`) still rendered `off` and `fixed8` through screenshot (`gateReason: render_mode_hint`), no error. `PRODUCER_BROWSER_GPU_MODE=hardware` (or `auto`) is not tried.
- The user's shell environment reaches the producer (the adapter only sets the binary paths), so those two variables are a way to change the capture mode under Frameshell.

To close this: run the opt-in real tests with a blur case on a Linux CI host (software GL, headless shell) and read `drawElement.mode` and `staticDedup` from the perf summary.

## The producer's refusals

Read, not exercised: `assertMotionBlurSupported` throws for the `hdr_layered` capture route, which HDR content and shader transitions both use, with a message that starts `[MotionBlur] sub-frame motion blur is not supported on the "hdr_layered" capture route`. The error comes out of `executeRenderJob`. Sharp and segmented SDR routes are supported. With blur on, video frame windowing is switched off.

## Not measured

- Linux and Windows; a real GPU mode; the `drawElement` path beyond the one forced run.
- Compositions with images, video elements, text, shadows, sub-compositions or 3D (#473): the per-sample cost of anything but flat colour. The 3D-plus-blur cap is still open in the cross-rules comment on #451.
- More than one worker (`workers` was 1), clips longer than 2 s, peak memory and disk.
- A quiet host. Wall times above carry the load of a shared machine; only the ratios of per-frame screenshot time are stable.
- Why fixed 8 is not repeatable, and whether the same happens in the adapter's own render (`plugins/hyperframes`), which differs from this harness only in a copied composition directory.
- `cuts()` (slice 4), the two-variant cache (slice 3) and anything in the wire.

## Facts for the ADR

- Fixed `samples` 8 costs about 8x the capture of a sharp frame and is the only mode whose cost does not depend on the content. Adaptive costs 16 samples plus 2 probes on a still frame, so a clip that is mostly still is as expensive per frame as one that moves a little.
- The setting `samples: 1..64` maps directly to `samplesPerFrame`; `blend: "linear"` costs nothing extra; `pageMotionBlur: "off"` is accepted.
- The blurred render's repeatability needs an owner call: accept sub-2/255 PNG noise and gate the verify at the page, or find the cause first.
- Capture mode, static-frame dedup and the refusal route are producer behaviour that changes with a HyperFrames bump; the real test of slice 2 should assert `drawElement.mode` and the sample counts.
