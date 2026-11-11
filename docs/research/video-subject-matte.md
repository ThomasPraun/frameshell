# Video subject matte: spike (#461)

"Text behind the head" needs to know, frame by frame, which pixels are the person in front: a **matte**. This spike measured the two licence-clean candidates the owner's decision on #461 named (MediaPipe's selfie segmenter and MODNet) on the ONNX Runtime Web pin Frameshell already runs for face detection and photo segmentation, at the proxy's 540p, with the refinement recipe from the ticket. It records the licences as read first-hand, the numbers, and the recommendation slice 1 of ADR 0032 implements.

Decided in [ADR 0032](../adr/0032-video-subject-matte.md). Where the ADR's names differ from this note, the ADR wins.

## Recommendation

- **Model: MediaPipe selfie segmenter, the general 256×256 model** (`onnx-community/mediapipe_selfie_segmentation`, fp32, 0.46 MB). About **10 ms per frame** for the model on one WebAssembly thread, frames of any aspect squeezed to the square. On the drawn figures below it matched the figure at IoU 0.98 to 0.99 on every background, with the least flicker of all the models tried.
- **Not the landscape 144×256 model**, although the ticket's recipe names it: it was faster (6 ms) but lost the figure's top on a dark background (IoU 0.92 against 0.99) and flickered 14 times more on a still, noisy frame. A 9:16 phone video would also squeeze it worse.
- **Not MODNet** (Apache-2.0, kept as the measured fallback): 0.45 s per frame at 288 px short side and 1.4 to 2 s at its reference 512 px, so 13 to 60 minutes per minute of 30 fps video. On the drawn figures it kept the head but dropped the torso on two of three backgrounds (IoU 0.21 to 0.54).
- **Refinement, per frame, in TypeScript:** coarse alpha smoothed forward then backward over time (exponential, time constant 0.18 s per pass, so no lag), upscaled to the frame, a guided filter against the frame's gray picture (radius 8 px, eps 2e-3, coefficients fitted at half size), then the contrast curve `(m - 0.5) × 1.6 + 0.5`. All from the #461 recipe except the half-size fit (He and Sun's fast guided filter), which cut the filter's CPU time from 34 to 15 ms per 540p frame with the same edges.
- **Whole asset, once per content** (decision 5): about **45 ms of CPU per 540p frame** in the daemon (model 20 ms with its input, refinement 23 ms) plus ffmpeg decoding and encoding in their own processes. Expected on an idle Apple M3: about 1.5 minutes per minute of 30 fps video. Measured on this shared machine: 3 minutes per minute (see below).
- **Output:** a luma video beside the proxy's frames: H.264 at proxy size, CFR at the project fps, GOP 15, no B-frames (frame N of the matte is frame N of the proxy), full range with neutral chroma, so the luma bytes are the matte (0 background, 255 subject). 10 s of a moving figure at 960×540 took 0.54 MB.

## Licences (read first-hand on 2026-11-10)

| Model | Weights licence | Where it says so | File pinned |
|---|---|---|---|
| **MediaPipe selfie segmenter** (general and landscape) | **Apache-2.0** | Google's model card, "Model Card MediaPipe Selfie Segmentation" (PDF linked from the MediaPipe Image Segmenter guide, `storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Selfie%20Segmentation.pdf`, SHA-256 `ef2e8d35…dade60`): section "Licensed under: Apache License, Version 2.0", authors Tingbo Hou, Siargey Pisarchyk, Karthik Raveendran (Google), dated May 6, 2021. The card says the training images include "consented images of people" captured with a mobile AR application. | `onnx-community/mediapipe_selfie_segmentation` at `be49485c8e027524be38591817fc5cd31bd9d00e`, `onnx/model.onnx`, 462,352 bytes, SHA-256 `3241ac4ad8aa35bdaf33946776db29f7c283a413aa0b0dacb9483594b4531aad` (matches the Hugging Face large-file oid). The repository is tagged apache-2.0; it is a conversion of Google's `selfie_segmenter.tflite`, a derivative the licence allows. |
| **MODNet** | Apache-2.0 | GitHub `ZHKKKe/MODNet`: the API reports SPDX Apache-2.0, and the README's License section says "The code, models, and demos in this repository (excluding GIF files under the folder `doc/gif`)" are under Apache-2.0. The official weights are in a Google Drive folder linked from `pretrained/README.md`. | Not pinned. Measured from `Xenova/modnet` at `fa2fa546052fba4c08921230a26cc69a333fca12` (`onnx/model.onnx`, 25,888,640 bytes, SHA-256 `07c308cf…584df9`), tagged apache-2.0, a third-party ONNX conversion. |
| u2net_human_seg | not clean | Excluded by ADR 0032 decision 4: the weights were trained on the Supervisely Person dataset, described as non-commercial, and carry no licence of their own. Not measured. | — |
| Robust Video Matting | GPL-3.0 | Excluded by #461. Not measured. | — |

The model card also lists out-of-scope uses: several people at different scales, people further than about 4 m from the camera, and any surveillance or identity recognition. Frameshell's use (a subject in front of the camera, to place graphics behind) is the card's intended "human segmentation from videos in interactive applications".

## Measurements

Machine: Apple M3, 8 GB, macOS 26.3, Node 22.16, `onnxruntime-web` 1.30.0 (`dist/ort.wasm.min.mjs`, the four files the manager installs, tarball SHA-256 matching the pin), `numThreads = 1` as in `loadOnnxModel`. The machine was shared with other agents' builds and tests: load average 10 to 33 on 8 cores during the runs. Wall times are therefore upper bounds; CPU times (`process.cpuUsage`) are steadier and are what the 1.5-minute estimate is built on. Each model was loaded once, warmed up with one run, then run 15 times per picture; the table gives the median and, in brackets, the fastest run.

**Pictures** (synthetic, generated by the spike script, never committed): 960×540 frames of a drawn head-and-shoulders figure (skin-coloured face with eyes, nose and mouth; dark hair cap with 60 strands 1 to 2 px wide flying out; blue shirt), with a 4 px dark mic stand from the bottom left to a capsule under the chin. Three backgrounds: a grey **checkerboard** (32 px squares), a **dark** wall (luma about 20, like the hair), and a **room** (light wall gradient, floor, shelf). Ground truth is the drawing's own mask.

**Measures:** IoU of the matte (above 0.5) with the figure; mean matte value over the hair strands ("hair", 1 = all kept) and over the mic ("mic"); mean matte value in a 24 px ring of background around the figure ("ring", 0 = no halo). Refined = after the guided filter and contrast.

| Model (input) | Background | Model time per frame | IoU raw → refined | Hair | Mic | Ring |
|---|---|---|---|---|---|---|
| **Selfie general (256×256)** | checker | 9.3 ms [8.9] | 0.978 → **0.984** | 0.14 | 0.96 | 0.052 |
| | dark | 9.3 ms [8.8] | 0.984 → **0.993** | 0.07 | 0.68 | 0.023 |
| | room | 9.3 ms [8.9] | 0.973 → **0.980** | 0.23 | 0.98 | 0.060 |
| Selfie landscape (256×144) | checker | 6.2 ms [5.7] | 0.982 → 0.990 | 0.09 | 0.82 | 0.037 |
| | dark | 6.0 ms [5.7] | 0.914 → 0.919 | 0.03 | 0.45 | 0.042 |
| | room | 6.3 ms [5.9] | 0.977 → 0.982 | 0.24 | 0.97 | 0.053 |
| MODNet (512×288) | checker | 444 ms [432] | 0.930 → 0.936 | 0.12 | 0.81 | 0.013 |
| | dark | 628 ms [493] | 0.207 → 0.207 | 0.08 | 0.21 | 0.006 |
| | room | 622 ms [474] | 0.990 → 0.992 | 0.08 | 0.99 | 0.017 |
| MODNet (896×512) | checker | 1.92 s [1.38] | 0.447 → 0.444 | 0.07 | 0.84 | 0.011 |
| | dark | 1.88 s [1.57] | 0.211 → 0.209 | 0.06 | 0.64 | 0.097 |
| | room | 1.59 s [1.33] | 0.540 → 0.541 | 0.08 | 0.84 | 0.015 |

Model times are from the first and quietest run (load 10 to 15). The quality columns are from the last run, with the half-size guided filter the code ships; the first run, with the full-size filter, gave the same IoU within 0.001. A run under load 30 gave the same masks and up to 2.5 times the model times.

**Over time** (30 frames at 30 fps, dark background):

| Model | Flicker on a still figure with sensor noise (mean change per frame, 0..255): coarse → smoothed; refined → refined after smoothing | Figure moving 4 px per frame: IoU without → with smoothing |
|---|---|---|
| **Selfie general** | 0.115 → 0.004; 0.219 → 0.185 | 0.989 → 0.990 |
| Selfie landscape | 1.593 → 0.049; 1.406 → 0.179 | 0.962 → 0.983 |
| MODNet 288 | 1.145 → 0.063; 1.109 → 0.112 | 0.189 → 0.189 |

The smoothing removes nearly all of the model's own flicker without dragging moving edges (IoU unchanged or better). What remains after refinement comes from the noise of the guide picture itself, through the guided filter.

**Refinement cost per 540p frame** (CPU time, `process.cpuUsage`, 30 runs): guided filter at full size 34.4 ms, fitted at half size 14.9 ms; the whole refinement (upscale, half-size guided filter, contrast) 23.0 ms; the selfie model with its input and output 19.6 ms.

**End to end** (`matteVideo`, the code slice 1 ships, in one process): a 10 s 960×540 30 fps clip of the figure swaying ±80 px on the room and checkerboard backgrounds, 300 frames. With the full-size guided filter, under load 17: 29.1 s, 97 ms per frame (model 9.8 ms, refine and encode 78 ms), so **2.9 minutes per minute of video**. After the half-size fit the same run under load 25 took 84 s (wall time dominated by the load); the CPU times above put it at about 45 ms per frame on an idle machine, **about 1.5 minutes per minute**. The matte file: 0.54 MB for 10 s; frame 0 had 22.7 % of pixels above 250 and 73.3 % below 5 (the rest is the soft edge).

## Edges, as seen

- **Hair:** single strands 1 to 2 px wide are lost by every model (7 to 24 % kept). The selfie model keeps a soft halo where many strands meet the cap; the guided filter sharpens the cap's outline but cannot bring back strands the model never saw at 256 px. On the dark background the guide cannot separate dark hair from a dark wall at all.
- **Mic:** a 4 px stand touching the subject is mostly kept by the selfie model on light backgrounds (0.96 to 0.98) and about two thirds on the dark one; the capsule under the chin is kept everywhere. The ticket's warning ("mic arms dropped") holds for arms that leave the body; a stand drawn into the body was kept.
- **Halo:** the ring of background around the figure stays at 2 to 6 % matte after refinement (it was 5 to 9 % raw): the guided filter pulls the edge in.
- **A drawn figure without a face is not a person:** the same head-and-shoulders drawing with a plain skin oval and no eyes or mouth gave an empty matte (IoU 0.07). With two eyes, a nose and a mouth it gave 0.997. The opt-in test figure (`packages/core/test/matte-fixture.ts`) has a face for this reason.

## What did not work or was not tried

- **MODNet on the drawn figures:** it treated the blue shirt as background on two of three backgrounds. It is a portrait-matting model trained on photographs; real footage may fare better, but it is 50 times slower than the selfie model either way.
- **A colour guide** for the guided filter (a 3×3 solve per pixel) would separate dark hair from a dark wall better; not tried, as it would roughly triple the refinement time.
- **More than one WebAssembly thread** is still unavailable in Node (`docs/research/photo-segmentation.md`).
- **Real footage:** no real recording was used (no media is committed and none was downloaded for this spike). The owner's acceptance should run `frameshell matte` on a real talking-head take, with a held object and a mic arm.

## How it is fed (for the implementation)

- **Input** `pixel_values`: float32 `[1, 3, 256, 256]`, RGB in 0..1, no mean or scale (`preprocessor_config.json`: rescale 1/255, no normalize). The frame is squeezed to the square by area averaging.
- **Output** `alphas`: float32 `[1, 1, 256, 256]`, person probability 0..1.
- The landscape model has the same names at `[1, 3, 144, 256]`. MODNet takes `input` `[1, 3, H, W]` (sides multiple of 32, RGB normalized to -1..1) and gives `output` `[1, 1, H, W]`.
