---
status: accepted
---

# Loop-safe export: `render --loop`, audio ends faded, the seam checked after the render, a GIF preset

#474 (epic #451) asks for exports that repeat without a seam (title loops, banners, GIFs for X and READMEs): a render option that renders frames 0 to N-1 only, a 2 ms half-sine fade on the first and last audio samples of an MP4, and a GIF preset. The owner's comment on the ticket: a loop is a first key identical to the last, with a frame range that leaves out the duplicate last frame, and the seam is checked with a strip across it, not a single still. The owner decided on 2026-11-11: option A, every recommendation of the proposed decision accepted (the eight points below). It ships in slices; **slices 1 (the `loop` option) and 2 (the GIF preset) are built.**

## Context (verified)

- `compileRender` already renders the half-open range `[0, layout.frames)`: a loop needs no new range, only the promise that frame N-1 is not a copy of frame 0.
- Audio is mixed into a lossless file, measured with two-pass `loudnorm`, then `aresample` + `atrim=end_sample` in the mux (ADR 0005). Every audio item already has a 2 ms equal-power fade at its edges; the extra fade at the file's ends is applied after `loudnorm`, whose dynamic mode can move the edges.
- The cover frame (#476, `render.cover`) replaces frame 0 with another frame: it breaks a seam by construction.
- A job's result had no place for a finding made after the file was written (`warnings` of `render` come from the plan, before queueing).
- Formats (ADR 0027 decision 4): the format owns the frame, a preset of another aspect is refused. A fixed-size GIF preset would be refused in other formats (slice 2).
- #478: never depend on the `hyperframes` CLI; techniques from outside are rebuilt in core. Nothing here touches HyperFrames.

## Decision

1. **Loop is an export option**, `render.loop` (CLI `render --loop`), not a timeline or preset property. The intent is not stored: pass it on every export. A timeline `loop` default and looped preview playback may come later on top of this.
2. **Duplicate seam frame.** After the render, one ffmpeg step decodes frames 0, 1, the middle and N-1 at 160 px (gray) and compares them. When frame N-1 differs from frame 0 by less than 0.5 of 255 (mean absolute difference) while the picture moves elsewhere in the file (frame 1 or the middle at least 2 away from frame 0), the job gets a warning naming the frame and the fix: end the last key one frame earlier, or trim one frame. A file that never moves (a held title) gets none. The timeline's length is never changed.
3. **`--loop` with `cover` is refused** (`InvalidOperation`: the cover replaces frame 0 and breaks the seam), before anything is queued. Warnings in `render.warnings`: the output frame rate makes frames x output fps / fps not whole, so the cycle is a fraction of a frame; frame 0 or the last frame is black (a fade from or to black, or no picture). While looping, the thumbnail warning for a black frame 0 (which advises a cover) gives way to the loop one.
4. **One `gif` preset** fits the format inside 1200x1200 through a new optional preset field `video.fit: "inside"`, honoured by ADR 0027's aspect check (slice 2). This and #500's letterbox key are one ADR 0027 amendment.
5. **GIF frame rate** is capped at 30 (24 and 25 keep theirs).
6. **More than 350 output frames are refused** before rendering; **over 15 MB is warned** after.
7. **No WAV loop sidecar.** MP4 and MOV audio gets a 2 ms half-sine (`afade curve=hsin`) at sample 0 and the last sample, S = round(0.002 x rate) samples each; silent exports are unchanged.
8. **Quality tiers do not apply to GIF** (the existing H.264-only warning).

GIF pipeline (slice 2): FFV1/bgr0 Matroska segments, concat, `palettegen=stats_mode=diff`, `paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, gif muxer `-loop 0`. The pinned ffmpeg's gif muxer already writes the 4,4,5,4,4,4 centisecond delays at 24 fps; a test pins them by reading the GCE bytes.

Grain and loops (#500, decision recorded there): grain phase is the timeline frame mod 64; when `--loop` meets grain and N is not a multiple of 64, a warning says the seam will show.

## Slices

1. **`render.loop`**: refusal with `cover`, the cycle and black-end warnings, audio fades in `muxStep`, the post-render duplicate check, `JobInfo.warnings`, golden plan, real-ffmpeg tests, CLI, MCP, skill. Built, see below.
2. GIF container and preset (`video.fit`, palette passes, caps, GCE delay test). Built, see below.
3. Seam sheet and jump metric: #457, reusing the frame comparison of slice 1.

## Slice 1 as built

- `packages/protocol/src/methods.ts`: `render.loop`; `JobInfo.warnings` (every job kind, empty when none); `PROTOCOL_VERSION` bumped.
- `packages/core/src/export/compiler.ts`: `RenderInput.loop`, `RenderPlan.loop` (present only when true, so other plans and goldens are byte-identical), `loopWarnings`, `loopFades` in `muxStep`.
- `packages/core/src/export/seam.ts`: `loopSeamWarning`, run by the render job after the file is renamed into place; a check that cannot run adds a warning and never fails the render. `JobUpdate.warning` appends to the job's `warnings`.
- CLI `render --loop` prints the job's warnings after `Rendered <file>`; `--json` carries them in `job.warnings`.

## Consequences

- Loop intent is not in the project; an agent passes `--loop` each time.
- MP4 loops still depend on the player: AAC priming and the edit list make the seam not sample-exact in most players, so the 2 ms fades hide clicks, not a gap. MOV with PCM or WebM with Opus are the honest loop containers for audio.
- The duplicate check reads one extra decode of the file (every frame up to the last is decoded; cheap at 160 px output, not free for long 4K files).
- A very slow drift (under 0.5 gray levels per frame) can read as a duplicate; the warning then costs nothing but the person's attention.

## Slice 2 as built

- `packages/schema/src/plugin.ts`: `ExportPresetSchema` takes container `gif`, video codec `gif` and the optional `video.fit: "inside"`. `audio` is optional in the type and a refine keeps the rules: a `gif` preset has none, every other container needs it, container and codec `gif` go together, and `video.fit` is for a `gif` preset only (other codecs need even sizes, which a fitted box does not give). The plugin contract widens the same way (`ExportPreset` in `plugin-api`): a third-party plugin that reads `preset.audio` now handles undefined. The schema is not in `json-schema/`, so nothing regenerates.
- `packages/core/src/export/presets.ts`: the built-in `gif` preset (box 1200 x 1200, `fit: "inside"`, no fps of its own), `GIF_MAX_FPS` 30, `GIF_MAX_FRAMES` 350, `GIF_WARN_BYTES` 15 000 000 bytes (`gifSizeWarning` words the job warning in MB), and `fitInside`, which scales the format's frame down to the box with its own aspect and never up (a 640 x 360 project stays 640 x 360), keeping odd sizes. ADR 0027 decision 13 records the amendment: `outputSize` in `export/service.ts` returns `fitInside` for such a preset, so the aspect refusal of decision 4 does not apply and a default preset with `fit` is not reported as overridden.
- `packages/core/src/export/compiler.ts`: a plan with container `gif` gets lossless segments (`ffv1`, `bgr0`, Matroska `.mkv`; the graph's pixel format is `bgr0`, so no chroma subsampling comes before the palette), an output rate of `min(preset fps or project fps, 30)`, an empty audio plan (`tracks: []`, no codec args) and the loop rules without `loop` (`RenderPlan.loop` is true): `cover` is refused with `field: "cover"`, the cycle and black-end warnings apply. More than 350 output frames throws `InvalidOperation` (`data.frames`, `data.max`) in `compileRender`, so `render` refuses before queuing and any other caller of the compiler does too. Plans of other containers are byte-identical: every existing golden stays, and `gif-plan.json` is new. `paletteStep` (`palettegen=stats_mode=diff` over the concat of the segments into `palette.png`) and `gifStep` (`paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, `-loop 0`, `gif` muxer) replace the audio passes and `muxStep`.
- `packages/core/src/export/service.ts`: `executeRender` runs the two GIF steps under the `mux` job step (no new `JobInfo.step` value); in `planRender`'s queued job body (so single renders and `batch.render` rows alike), a finished file over `GIF_WARN_BYTES` adds a job warning with its size and the seam check of slice 1 runs on every GIF (`loop` is `params.loop` or a `gif` container). The result's `encoder` is `gif`.
- Delays: the pinned ffmpeg's `gif` muxer writes them from rounded cumulative times in 1/100 s, so nothing sets them. `packages/core/test/export-gif.test.ts` reads the Graphic Control Extensions of real renders: 24 fps gives 4,4,5,4,4,4 repeating (48 frames = 200 cs), 25 fps a flat 4, 30 fps 3,4,3, and the NETSCAPE2.0 extension carries loop count 0. A daemon `render` with `preset: "gif"` gives 1200x675 and 675x1200 in 16:9 and 9:16, and the 350 frame refusal leaves the job queue untouched.
- Protocol 114: the `gif` preset appears in `export.presets` and `render` takes it; no new field or method.
- Left as is: `cover` with a `gif` preset takes the preset's 1200 x 1200 box as the frame size, so the image is a letterboxed square (a cover of a GIF has no use). `frame` goes through `outputSize` and gets the fitted size (for example 1200 x 675). The 15 MB warning is tested through `gifSizeWarning`, since a real 15 MB GIF is not a tiny fixture.
- A `gif` row of `batch.render` (ADR 0040) goes through `planRender` like a single render: more than 350 frames is refused before any row is queued.
