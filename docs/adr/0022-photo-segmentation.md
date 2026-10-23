---
status: accepted
---

# Photo segmentation: point at parts inside a photo, cut them out

Closes the gap ADR 0017 left open ("parts inside a photo"). In an image project, a Pick click on a photo now names the part of the photo under it as a **mask**, so "the person on the left" or "the sky" can be pointed at. The agent's first operation on a mask is a **cut-out**: a new layer holding only that part. SPEC decision 28. Decided by the owner on 2026-10-23, from the spike in [`docs/research/photo-segmentation.md`](../research/photo-segmentation.md) (#290).

## Context (verified in the tree)

- **Pick in a photo (ADR 0011):** Pick (`inspect.point`, the app's Pick tool) returns the clip stack and, for generated clips, the DOM element under a point. On a photo it names only the clip. Points reach the agent as a `point` reference line with a details file `e_<frame>_<n>.json` under `.frameshell/context/` (`ask/reference.ts`, `context.write`).
- **Sweeping `.frameshell/context/`:** `gc` sweeps only names matching `f_<frame>.png` or `e_<frame>_<n>.json` (`CONTEXT_ENTRY` in `packages/core/src/context.ts`), after 7 days.
- **Image projects (ADR 0017):** a photo is a still media clip on a video track (a layer). It is placed by `transform` (`x`, `y` offsets in project pixels from centered, `scale`, `opacity`; `TransformSchema`) through `layerBox` in `composite.ts`. Tracks have no hidden flag.
- **Face detection (ADR 0016, `multicam.faces`) built the runtime this needs:**
  - The `onnxruntime-web` 1.30.0 pin: a managed `module` package, WebAssembly, one tarball for every platform from the npm registry, SHA-256 pinned, no mirror.
  - A daemon worker thread that runs a model on it single-threaded (`faces-worker.ts`, `loadYunet`).
  - Models pinned by URL, revision and SHA-256 (`docs/binaries.md`).
- **Plugins:** `@frameshell/whisper-cpp` is a plugin, but its binary and models are pinned in the core manifest and fetched through the host (`context.ensureBinary`, `context.ensureModel`). Plugins load only in trusted projects (SPEC §8).
- **The spike, on an Apple M3 with one WebAssembly thread and a 1024 px photo:** MobileSAM encodes a photo in about 2.6 s, then answers each click in about 0.17 s, for a 44.7 MB download. Other point-prompted models with permissive licences were 2 to 3 times slower or 3.5 times larger. Matting models cannot be pointed. Licences ruled out EdgeSAM and RMBG. BiRefNet-lite does not fit in WebAssembly memory.

**Guiding principle: simple and optional.** No new tool to install, nothing downloaded until someone points inside a photo, one new operation.

## Decision

1. **Model: MobileSAM**, the ONNX export in `Acly/MobileSAM` at a pinned revision: `mobile_sam_image_encoder.onnx` (28.2 MB) and `sam_mask_decoder_multi.onnx` (16.5 MB). Licence Apache-2.0 (MobileSAM's weights; the decoder is SAM's). Pinned in the core manifest as two models with SHA-256, downloaded from Hugging Face, no mirror, listed in `docs/binaries.md`.
2. **Runtime: the existing `onnxruntime-web` pin, unchanged.** A daemon worker thread loads both models, single-threaded, as `faces-worker.ts` does.
3. **Built into core, downloaded on first use.** Not a plugin: the pins would be in core anyway, and Pick must work in untrusted projects. The first segmentation installs the runtime (if face detection has not) and the models, with progress. `doctor` lists binaries only: the runtime appears there as on-demand (never reported missing), the two models are not listed, and nothing but the first segmentation downloads them. The installer does not grow.
4. **Image projects only, still media clips only.** Video projects, footage and generated clips are not segmented in v1. A video frame becomes an image project with File > New Image from Frame (ADR 0017).
5. **Prepare when Pick turns on.** In an image project, turning on the Pick tool asks the daemon to prepare every photo layer: internal method `segment.prepare { cwd, asset }`, called once per photo the program shows, which encodes the asset at most 1024 px on the long side. The daemon keeps each embedding in memory by asset content hash: 4 MB each, at most 8, least recently used dropped first. A click on a prepared photo costs about 0.2 s. A click before preparation finishes waits for it. No segmentation while hovering.
6. **What a segmented point is.** `inspect.point` gains `segment: boolean` (default false). When true and the target is a still media clip in an image project:
   - **Mapping:** the daemon maps the point through the inverse of the clip's placement into the asset's own pixels. It runs the decoder with that one point, at the asset's full size.
   - **Masks:** SAM returns three answers to one point: part of a part, a part, the whole. Each is written as an 8-bit grayscale PNG at the asset's size, 255 inside and 0 outside, named `m_<frame>_<x>_<y>_<k>.png` (`<frame>` as in `f_<frame>.png`, `x`,`y` the click in asset pixels, `k` = 1 to 3, smallest first). The same click gives the same files.
   - **Result:** `segment` holds `masks`, the three masks smallest first, each with `mask` (project-relative path), `bbox` (`[x, y, w, h]` in asset pixels), `frameBox` (normalized `[x0, y0, x1, y1]` in the frame), `area` (share of the asset) and `score` (the model's own estimate of mask quality, 0..1). `chosen` is the index with the best score. Also in `segment`: `asset`, `size` and the `model` pin. It is part of the point's own shape (`InspectedPoint`), so a pick in the app carries it into the reference and the details file.
   - **When nothing is segmented:** anywhere else (including a video project, which ignores the option) `segment` is absent and `segmentUnavailable` says why (`not an image project`, `not a still image`, `black`).
7. **Pick in the app.** In an image project, a click on a photo shows the chosen mask's outline over the preview. ↑ / ↓ steps to the larger or smaller mask. (A photo has no DOM parents, so these are the keys that move between an element's parent and child elsewhere.) Shift+click adds points as today, each with its own mask. Escape clears the pick.
8. **Reference.** The point line gains one part after the clip, naming the chosen mask:
   ```
   [frameshell] point (0.21,0.48) @ 00:00:00.00 · clip c_0003 media assets/team.jpg · segment .frameshell/context/m_0_1210_1530_3.png bbox 880,610 920x2414 px (18 %) · details .frameshell/context/e_0_1.json · frame .frameshell/context/f_0.png
   ```
   The details file gains `segment`: the chosen mask's fields plus the other two masks, so the agent can take a smaller or larger one without asking.
9. **Cut-out: `image.cutout { cwd, timeline, clip, mask }`** (mutating). `clip` is a still media clip in an image project. `mask` is a project-relative grayscale PNG at that asset's size: a Pick mask, or one the agent made another way. The daemon:
   - **The image:** writes `assets/<asset stem>-cutout-<n>.png` (first free `n`): the asset with the mask as alpha, cropped to the mask's bounding box, made by the managed ffmpeg (`alphamerge`, `crop`). It imports the file as an asset.
   - **The layer:** in one transaction labelled `Cut out <asset name>`, it adds a track directly above the clip's track and a still clip of the cut-out on it. The clip is placed to lie exactly over the original: same `opacity`, and `scale` and `x`/`y` set so the crop, fitted to the frame on its own, covers the same pixels (scale times the ratio of the two fits; offset moved by the box center's distance from the photo center, fitted and scaled). Keyframes and fades of the photo are not copied; a warning says so.
   - **Result:** the new asset, track and clip ids, and the transaction.
   - **Failures:** InvalidOperation (not a still media clip, not an image project, mask size differs from the asset's, empty mask), ClipNotFound, AssetNotFound, or the Binary* errors.
   - **Revert:** reverting removes the track and the clip. The PNG stays in `assets/`, like any imported file.
10. **Background removal is not an operation.** It is a cut-out followed by hiding the photo (`clip set --opacity 0`) or removing its layer: two journaled steps the agent takes, each revertible. The skill says so.
11. **Agents.**
    - CLI: `frameshell inspect --at <s> --point x,y --segment` (or `--px`), and `frameshell image cutout <clip> --mask <png>`.
    - MCP: `inspect_point` gains `segment`, and the tool `image_cutout` comes from the registry. `segment.prepare` is internal and not a tool: `inspect.point` prepares on demand.
    - The skill gains a short paragraph: read `segment` from a point reference, pick another size from the details file if needed, cut out, then hide the original for background removal.

## Considered options

- **A plugin (a segmentation provider like `whisper-cpp`).** Rejected: it adds a package and a provider contract while the pins stay in core, and plugins do not load in untrusted projects, where Pick must still work.
- **SAM 2.1 tiny.** Best masks, but 156 MB and 7.4 s per photo. Rejected for v1. The two-file layout (encoder, decoder) is the same, so it can replace MobileSAM later with a new pin.
- **SlimSAM-77 quantized (14 MB).** Rejected: twice MobileSAM's encode time. It is the fallback if the download size ever matters more than the first click.
- **Background removal or matting models (MODNet, U-2-Netp, BiRefNet, RMBG).** Rejected: they cannot be pointed at a part. MODNet handles people only. BiRefNet does not fit in WebAssembly memory. RMBG's licence is non-commercial.
- **Encode on the first click.** Rejected: the first click would wait about 3 s. Preparing on Pick hides that while the person aims.
- **Soft (alpha) masks in v1.** Deferred: the decoder's logits give a soft edge for free, but binary masks are easier for an agent to check and to combine. A feathered cut-out can come with the masked effects ADR.
- **A blur behind text, or other masked effects.** Deferred to their own ADR: they need an effect with a mask on clips in the schema, the export compiler and the preview engine.
- **Segmentation in video projects.** Deferred: a mask would have to follow the picture over time (SAM 2 video tracking), and that is a different feature.

## Consequences

- **Manifest:** two model pins (`mobilesam-encoder`, `mobilesam-decoder`), and `docs/binaries.md` gains a "Photo segmentation" section. The Real binaries workflow segments a drawn shape on every platform.
- **Protocol:** `PROTOCOL_VERSION` bump. `inspect.point` gains `segment` and its result `segment` and `segmentUnavailable`. New methods: `image.cutout` (mutating) and internal `segment.prepare`.
- **Context files:** `CONTEXT_ENTRY` must also match `m_<frame>_<x>_<y>_<k>.png`, or `gc` keeps masks forever.
- **CLI, MCP and skill:** `inspect --segment`, `image cutout`, `image_cutout`. The skill is regenerated (`pnpm gen:skill`), and `skill-docs.test.ts` must see the new names.
- **App:**
  - Pick prepares photos in image projects, draws the mask outline, and ↑ / ↓ means a mask size on a photo.
  - The preview's context menu gains "Cut out as layer" on a segmented pick.
  - Strings go in `shared/i18n/` in English and Spanish.
- **Memory:** up to 8 cached embeddings (32 MB) plus the two sessions (about 200 MB resident in the spike) while Pick is on in an image project. The worker's models are freed after 5 minutes without a segmentation request; the embeddings stay until the daemon exits.
- **Cache:** none on disk. `RECIPE_VERSION` and `CACHE_LAYOUT_VERSION` do not change.
- **Not covered:** masked effects (blur, color), soft edges, exclude points (negative clicks), box prompts, video projects, GPU or multi-threaded inference.

## Implementation plan (each part ships and is tested alone)

1. **Segmenter in core:** pins, worker, embedding cache, `segment.prepare`, a test on a drawn shape (opt-in real download, as for faces).
2. **Segment a point:** `inspect.point` `segment`, mask files, `CONTEXT_ENTRY`, CLI `--segment`, MCP, skill.
3. **Pick inside photos:** preparing on Pick, outline, ↑ / ↓, reference `segment` part, details file, e2e.
4. **Cut-out:** `image.cutout`, CLI, MCP, skill, context-menu item, e2e.

Docs with the parts: SPEC §7, §7b, §9, §10, the agent skill, `docs/binaries.md`, the CHANGELOG.

## Side effects

- **`inspect.point`:** its result gains optional fields only. Existing callers and the app's point handling keep working. `ui.select` points pass through `inspect.point` and are unaffected while `segment` is false.
- **Pick keys:** ↑ / ↓ change meaning only over a segmented photo, where they did nothing before.
- **`gc`:** sweeping masks needs the pattern change in `context.ts`. Without it nothing breaks, but masks accumulate.
- **Installer and first run:** unchanged. The roughly 45 MB of models, plus 33 MB of runtime when face detection never ran, arrive only on the first segmentation.
