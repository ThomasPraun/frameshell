---
status: accepted
---

# Video subject matte: text and graphics behind the person

A video track can be put **behind the subject** of a lower track: a big word or a logo sits between the background and the person, in preview and in export. The person is lifted by a **matte**, a grayscale video computed once per asset and cached as derived media; the timeline never stores it. SPEC decision 31. Decided by the owner on 2026-11-10 in #461 (epic #451), from a draft with four options (track flag desugared on read, duplicate clip with a matte field, baked subject asset, and the same flag with MODNet) and the spike in [`docs/research/video-subject-matte.md`](../research/video-subject-matte.md).

## Context (verified in the tree)

- **Runtime:** the `onnxruntime-web` 1.30.0 pin (MIT), a one-shot worker runner (`worker-task.ts`), one model loader (`onnx-web.ts`), and the frame reader of face detection (ffmpeg rawvideo, `multicam/faces.ts`). Photo segmentation (ADR 0022) deferred video: "a mask would have to follow the picture over time".
- **Composition:** tracks stack in file order; preview and export share `packages/schema/src/composite.ts`, where `withTrackMutes` is a pure timeline-to-timeline rewrite applied inside `flattenTimeline` at every nesting level.
- **Alpha:** the preview draws through a separate alpha plane (`AlphaMasker`, `copyLuma` in `engine.worker.ts`, ADR 0002); export decodes VP9 alpha with libvpx and has `alphamerge` in the pinned ffmpeg.
- **Derived media:** cached by content hash (`MediaService`, `RECIPE_VERSION`), proxies CFR at the project fps with the short side at most 540, swept by `gc`.
- **Licences, read first-hand:** MediaPipe's selfie segmenter is Apache-2.0 per Google's model card; MODNet is Apache-2.0 (README: code and models). u2net_human_seg's weights have no licence of their own and were trained on a non-commercial dataset. Robust Video Matting is GPL-3.0.
- **The spike** (Apple M3, one WebAssembly thread, 540p, drawn figures on checkerboard, dark and room backgrounds): the selfie segmenter's general 256×256 model runs in about 10 ms a frame and matched the figure at IoU 0.98 to 0.99 on every background; the landscape model lost the figure's top on dark; MODNet took 0.45 to 2 s a frame and dropped the torso on two backgrounds. Forward-backward smoothing removed the model's flicker without dragging moving edges. Fine hair strands are lost by every model.

## Decision

1. **Composition: a track flag, turned on read into a synthetic subject layer** by one pure function in `packages/schema/src/composite.ts`, inside `flattenTimeline` at every nesting level, like `withTrackMutes`. The layer copies the plate track's media clips with an internal matte marker; preview and export both read the rewritten timeline. The matte is cached derived media, so plate edits (trim, move, ripple, keys, transitions) never desync the subject.
2. **Field: `behind: <plateTrackId>`** on a video track, explicit and validated: it names a video track listed earlier (lower in the stack), never itself. Not a boolean that takes the nearest track below.
3. **Model: decided by the spike.** The **MediaPipe selfie segmenter, general 256×256 model** (Apache-2.0, `onnx-community/mediapipe_selfie_segmentation`, fp32, 0.46 MB), pinned by revision and SHA-256 after its model card was read first-hand. The model id is part of the matte's cache key, so another model (MODNet, a landscape or GPU model) can be added later as a new pin without touching composition.
4. **u2net_human_seg is excluded:** its weights were trained on the non-commercial Supervisely Person dataset and carry no licence of their own. This overturns the ticket's first note that called it licence-clean.
5. **Matte scope: the whole asset, once per content.** Edits never re-run it. About 1.5 minutes per minute of 30 fps video on an idle Apple M3 (45 ms of CPU a frame), with progress and an ETA.
6. **Plate scope in v1:** media clips on video tracks only. No program tracks (multicam shots), generated clips, nested timelines as plates, or image projects.
7. **Export with the matte not ready waits for the matte job**, as export waits for generated clip renders.
8. **Plate track removed or reordered** so that `behind` no longer names a video track below: the flag is cleared in the same transaction, with a warning.
9. **Resolution:** the matte is made at proxy size (540 short side) and upscaled for export in v1. A higher-resolution matte for 4K comes later.
10. **Face cover** (a word must never cover the face) is checked by the skill and `review` (#457), not enforced by the compositor.

**Compositor order** follows ADR 0031: grade → transition shape → alpha/matte mask → backdrop. The matte multiplies the plate's own alpha after its grade and transition shape and before any backdrop.

**The matte file** (slice 1): `.frameshell/cache/mattes/<key>.mp4` with a `<key>.json` record written after it (its presence marks it complete). The key holds 20 hex digits of the content hash, `MATTE_VERSION`, and a hash of the model pin, the project fps and the proxy `RECIPE_VERSION`. The video is H.264 at the proxy's size, CFR at the project fps, GOP 15 and no B-frames, so **frame N of the matte is frame N of the proxy**; full range with neutral chroma, so the luma bytes are the matte (0 background, 255 subject). It is made in three passes over the proxy, one frame in memory at a time: the model on each frame with the coarse alpha smoothed forward in time into a scratch file; the scratch file smoothed backward in place (exponential, 0.18 s per pass: no lag); then each frame refined (upscale, guided filter radius 8 px and eps 2e-3 against the frame's gray picture, fitted at half size, contrast `(m - 0.5) × 1.6 + 0.5`) and encoded.

**Open for the slices** (from the review of the draft): the subject layer reuses the plate's decoded frame where it can (decoder count against the ADR 0001 thresholds); matte frames map to source time the same way in preview (proxy) and export (source plus `alphamerge` with the matte scaled to the plate), including speed, VFR sources and `in`. The matte follows the proxy's frame grid, which already maps source time to frames for the preview.

## Considered options

- **Explicit duplicate clip with a `matte: subject` field.** Rejected: two clips that must stay in sync by hand, every key and transition duplicated, two History entries for one intent.
- **Bake a subject asset (VP9 with alpha) into `assets/`.** Rejected: large files that are not regenerable, a lossy re-encode of the person, the same desync as the duplicate clip, and derived data treated as source (SPEC §6.3).
- **MODNet as the v1 model.** Rejected by the spike: 50 times slower than the selfie segmenter (0.45 to 2 s a frame) and worse on the drawn figures. It stays the measured fallback.
- **The landscape selfie model the ticket's recipe names.** Rejected by the spike: lost the figure on a dark background and flickered 14 times more; 9:16 footage would be squeezed further.
- **Mattes only inside effect windows ±0.5 s.** Rejected for v1 (decision 5): faster on long takes, but edits would re-run it.
- **HyperFrames' `remove-background`.** Rejected in #478: native onnxruntime-node and ffmpeg from PATH.
- **Grayscale VP9 WebM for the matte.** Not taken: H.264 on the proxy's GOP lets the preview's existing H.264 decode path read it frame for frame; both are lossy 4:2:0.

## Consequences

- **Manifest:** one model pin (`mediapipe-selfie`); `docs/binaries.md` gains a "Video subject matte" section; the Real binaries workflow mattes a drawn moving figure.
- **Protocol:** `PROTOCOL_VERSION` bump. New method `matte.prepare { cwd, asset }` (MCP tool `matte_prepare`), job kind and step `matte`, `gc` entry kind `matte`, progress stage `matte`. Slice 2 adds `behind` to the track schema and `track.set`.
- **Cache:** `.frameshell/cache/mattes/`, swept by `gc` per content, model and fps (`MediaService.gc`). `RECIPE_VERSION` and `CACHE_LAYOUT_VERSION` do not change; `MATTE_VERSION` is the matte's own.
- **CLI and skill:** `frameshell matte <asset>` prints the matte's path; the skill's CLI reference names it. The skill teaches 30-55 % cover, no face cover, 1.5-4 s effects and skipping two-person shots with slice 4.
- **Tests:** `FRAMESHELL_MATTE_STAND_IN=1` (daemon option `matteStandIn`) takes what is brighter than mid-gray as the subject and downloads nothing; the e2e of slice 4 uses it.
- **Not covered:** two people in one shot give one merged matte; fine hair strands and mic arms away from the body are often lost; a colour guide for the guided filter; GPU or multi-threaded inference; mattes for generated clips or nested timelines.

## Implementation plan (each slice ships and is tested alone)

1. **Spike and core matte job, no schema change:** the research note, `packages/core/src/matte/` (model pin, worker on `worker-task.ts`/`onnx-web.ts`, the ffmpeg rawvideo reader shared with face detection, guided filter and forward-backward smoother as pure tested functions), the luma matte under `.frameshell/cache/mattes/` with its `gc` area, `matte.prepare` and `frameshell matte <asset>`, the stand-in, and an opt-in real-download test.
2. **`behind` flag and compositor in export:** schema field and validation, `track.set --behind`, inverse patch, plate removal clears the flag, `withSubjectLayers` inside `flattenTimeline`, `alphamerge` in the export compiler with golden tests, export waits for the matte job.
3. **Preview:** the subject layer through the engine worker's alpha path, decoder count measured against ADR 0001.
4. **App UI and skill:** a track header item and a matte status, strings in English and Spanish, e2e with the stand-in, the skill's recipe for words behind the head.

## Side effects

- **`sampleFaceFrames`** (`multicam/faces.ts`) now reads through the shared `readRawFrames` (`media/raw-frames.ts`) with the same ffmpeg arguments: face detection and people scans read the same frames as before.
- **`MediaService`** gains `ingested` (waits for an asset's ingest; called before a job, never inside one, so the shared queue cannot deadlock) and a `gc` area for mattes. Without the area nothing breaks, but mattes accumulate.
- **Job, step and `gc` kind enums** gain `matte`: clients that switch over them see a new value (the app only routes `people` jobs by kind).
- **Installer and first run:** unchanged. 0.46 MB of model, plus 33 MB of runtime when face detection never ran, arrive with the first matte.
