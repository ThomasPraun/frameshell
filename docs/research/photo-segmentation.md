# Pointing at parts inside a photo: segmentation spike (#290)

Pick (ADR 0011) names the clip under a click, and inside a photo that is all it can name. In an image project (ADR 0017) "the person on the left" or "the sky" cannot be addressed, masked or cut out. This spike measured segmentation models that run on the ONNX Runtime Web pin Frameshell already has for face detection (`docs/binaries.md`, `packages/core/src/multicam/faces.ts`). It recommends a model, where it lives, what Pick returns and the first operation.

Decided in [ADR 0022](../adr/0022-photo-segmentation.md) on 2026-10-23. Where the ADR's file names or method shapes differ from the sketches below, the ADR wins.

## Recommendation

- **Model: MobileSAM**, the ONNX export in [`Acly/MobileSAM`](https://huggingface.co/Acly/MobileSAM) (image encoder plus SAM's multi-mask decoder). It has the fastest encoder measured: about **2.6 s once per photo**, then about **0.17 s per click**, on one WebAssembly thread of an Apple M3. It adds a **45 MB** download, and it gives clean masks for objects, parts and people. Licence: Apache-2.0 (MobileSAM code and weights; the decoder is SAM's, also Apache-2.0). The export's card says MIT. Both are permissive.
- **Runtime: the existing `onnxruntime-web` 1.30.0 pin**, unchanged, in a daemon worker thread like `faces-worker.ts`. Nothing new to pin besides two model files.
- **Core, not a plugin.** The pins would sit in the core manifest anyway (see below), and Pick has to work in untrusted projects.
- **First operation: cut-out as a new layer.** It writes a PNG with alpha to `assets/` and puts it on a new track right above the photo, at the same place. Background removal is that cut-out with the photo layer hidden, so it needs no operation of its own. A blur behind text needs a clip effect the schema does not have yet: later.

## Measurements

Machine: Apple M3, 8 GB, macOS 26.3, Node 22.16, `onnxruntime-web` 1.30.0 (`dist/ort.wasm.min.mjs`, the same four files the face detection pin installs), `numThreads = 1` as in `loadYunet`. Photos: the three SAM notebook samples (`truck.jpg`, `dog.jpg`, `groceries.jpg`), scaled to 1024 px on the long side (1024×683 and 1024×684). For each model, the session was loaded once and warmed up with one run. Then the encoder ran 3 to 5 times, and the decoder 5 times for each click. The machine was shared with other agents' jobs (load average 9 to 20 on 8 cores), so the times are upper bounds. The first run of an encoder was sometimes 3 to 6 times slower under that load (MobileSAM once took 16 s). The table gives the median over every run and, in brackets, the fastest run.

| Model | Licence | Download | Split | Encode once (1 thread) | Decode per click | Quality on the samples |
|---|---|---|---|---|---|---|
| **MobileSAM** (TinyViT encoder, SAM decoder) | Apache-2.0 | **44.7 MB** (28.2 + 16.5) | encoder / decoder | **2.6 s** [2.3 s] | **0.17 s** | Truck, window, bag, dog all right; a few speckles near the border in large background masks |
| EfficientSAM-Ti | Apache-2.0 | 41.4 MB (24.8 + 16.6) | encoder / decoder | 5.2 s [5.1 s] | 0.13 s | Good edges; a click on the truck's side picked only the rear panel (the part, not the whole) |
| SlimSAM-77 (pruned SAM ViT-B) | Apache-2.0 | 39.8 MB (23.3 + 16.6) | encoder / decoder | 5.7 s [4.2 s] | 0.13 s | Like MobileSAM, slightly cleaner edges |
| SlimSAM-77, quantized | Apache-2.0 | 13.8 MB (8.9 + 4.9) | encoder / decoder | 5.3 s [4.5 s] | 0.11 s | Same masks as fp32 to the eye (area within 0.5 %) |
| SAM 2.1 Hiera tiny | Apache-2.0 | 155.6 MB (134.4 + 21.2) | encoder / decoder | 7.4 s [6.9 s] | 0.11 s | Best: the grocery bag with its contents, the cleanest edges |
| SAM 2.1 Hiera tiny, int8 encoder | Apache-2.0 | 74.2 MB (53.0 + 21.2) | encoder / decoder | 7.9 s [7.4 s] | 0.11 s | Same as fp32; int8 is not faster on WebAssembly |
| MODNet (portrait matting) | Apache-2.0 | 25.9 MB | one pass, no prompt | 1.2 s [1.15 s] | n/a | Soft alpha, good on the person in `dog.jpg`; fails on things (truck: 3 % of the frame, a fragment) |
| MODNet, quantized | Apache-2.0 | 6.6 MB | one pass | 1.4 s | n/a | Empty mask on the truck |
| U-2-Netp (salient object) | Apache-2.0 | 4.6 MB | one pass, 320×320 | 0.95 s | n/a | Finds "the subject" (truck, car and bags) with coarse 320 px edges; cannot be pointed |
| BiRefNet-lite | MIT | 224.0 MB | one pass, 1024×1024 | **does not run**: `std::bad_alloc` in `OrtRun` | n/a | Exceeds the 4 GB heap of 32-bit WebAssembly |

The MobileSAM row also counts eleven runs outside the batch on `truck.jpg` and `dog.jpg`, which took 2.3 to 2.9 s. Its process held 80 to 580 MB resident at exit, depending on garbage collection. The image embedding a click needs is 4 MB (256×64×64 floats).

Every download above was checked against its Hugging Face large-file SHA-256 at a pinned revision:

| File | Source (revision) | Size | SHA-256 |
|---|---|---|---|
| `mobile_sam_image_encoder.onnx` | `Acly/MobileSAM` (`0d3b403339b4674a82493d5e97964dd78089ddc8`) | 28,157,093 | `580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749` |
| `sam_mask_decoder_multi.onnx` | same | 16,496,559 | `8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe` |
| `vision_encoder_quantized.onnx` | `Xenova/slimsam-77-uniform` (`5850ab45f587c112167512ffef949107115e26a0`) | 8,882,165 | `cce23c7b2e5d4f330932738fb67ba518e04b0d99ccdd1cccd22a7da4e01f2971` |
| `prompt_encoder_mask_decoder_quantized.onnx` | same | 4,903,810 | `cb90b279f549d2cab7fd6e20c38522438c65d84bdcca3d2a764cff7d857fdce2` |
| `efficientsam_ti_encoder.onnx` | `yunyangx/EfficientSAM` (`1cf49585c39567bfc49e991ab8eb31f491ad4877`) | 24,799,761 | `84ed466ffcc5c1f8d08409bc34a23bb364ab2c15e402cb12d4335a42be0e0951` |
| `efficientsam_ti_decoder.onnx` | same | 16,565,728 | `a62f8fa5ea080447c0689418d69e58f1e83e0b7adf9c142e2bd9bcc8045c0b11` |

URL form: `https://huggingface.co/<repo>/resolve/<revision>/<file>`. These repositories also host the SAM 2.1 (`onnx-community/sam2.1-hiera-tiny-ONNX`, `814a0666…`, weights in `.onnx_data` files loaded through the `externalData` session option), MODNet (`Xenova/modnet`), BiRefNet-lite (`onnx-community/BiRefNet_lite-ONNX`) and U-2-Netp (`BritishWerewolf/U-2-Netp`) files.

### How MobileSAM is fed (for the implementation)

- **Encoder** `input_image`: float32 `[H, W, 3]`, RGB 0..255, the photo scaled so its long side is 1024. The graph normalizes and pads itself. Output `image_embeddings` `[1, 256, 64, 64]`.
- **Decoder:** `point_coords` `[1, n+1, 2]` in that 1024 space, plus a padding point `(0,0)` with label `-1`. `point_labels` takes 1 (include) or 0 (exclude). `mask_input` is zeros `[1,1,256,256]` with `has_mask_input` `[0]`. `orig_im_size` is `[H, W]` as float32.
- **Output:** `masks` `[1, 4, H, W]` are logits at `orig_im_size`; above 0 is inside. `iou_predictions` `[1, 4]` scores them. Masks 1 to 3 are SAM's three answers to one point (small part, part, whole object), so the decoder returns size alternatives at no extra cost. `orig_im_size` may be the photo's full source size: the mask comes back at full resolution, upsampled from 256².

### What did not work

- **More than one WebAssembly thread in Node:** `numThreads = 4` fails in Node with `no available backend found … fetch failed`. The threaded build fetches its worker script from a `file:` URL, which Node's `fetch` refuses. Preloading `env.wasm.wasmBinary` did not help. Single-thread is what face detection uses; making threads work is an optional speed-up for later.
- **BiRefNet-lite** (fp32, fixed 1024×1024 input) runs out of WebAssembly memory. Its fp16 file (114.5 MB) was not tried: it would still be the largest download here, for one-pass background removal only.

## Rejected options

- **EdgeSAM:** S-Lab License 1.0, non-commercial redistribution only.
- **RMBG-1.4 / RMBG-2.0 (BRIA):** non-commercial licences.
- **BiRefNet-lite, BEN2 (MIT, 219-223 MB):** too large, and BiRefNet does not fit in the WebAssembly heap.
- **SAM 2.1 tiny:** best masks, but 3.5× the download and 2.8× the encode time of MobileSAM.
- **EfficientSAM-Ti:** twice MobileSAM's encode time for similar masks. OpenCV's zoo copy (same source as YuNet) is one fused graph, so the encoder would rerun on every click.
- **SlimSAM-77 quantized:** the smallest point-prompted model (13.8 MB), but twice MobileSAM's encode time. It is the fallback if 45 MB is too much.
- **MODNet, U-2-Netp:** no point prompt. MODNet handles people only, and U-2-Netp guesses one subject at 320 px. Neither answers "this part".
- **SAM ViT-B/L/H:** 360 MB to 2.5 GB.
- **`onnxruntime-node` or a native runtime:** rejected for face detection already (about 300 MB of native addons, signing).

## Plugin or core

Core, as an on-demand managed model like face detection:

- `@frameshell/whisper-cpp` is a plugin, but its binary and models are still pinned in the core manifest and fetched by the host (`context.ensureBinary`, `context.ensureModel`). A segmentation plugin would add a package and a provider contract and keep the pins where they are now.
- Plugins load only in trusted projects (SPEC §8). Pick, and so pointing inside a photo, must work in any project, like the clip stack does today (ADR 0011).
- The runtime is in core already (`ONNX_RUNTIME_WEB`), and so is the worker pattern (`faces-worker.ts`).
- Installer size does not change: models download on first use with pinned SHA-256, from Hugging Face, with no Frameshell mirror. `doctor` lists them and never reports them missing.

A provider interface (other models, a GPU runtime) can come later if a second model ever needs it.

## What Pick returns

On an image project's photo layer, a Pick click also segments the point. The mask is in the **asset's own pixels**, not the frame's: the layer may be scaled or moved, and an operation works on the source file. The click is mapped through the inverse of the layer's placement (`layerBox`, `composite.ts`) before it reaches the decoder.

Files under `.frameshell/context/`, swept by `gc` after 7 days like the others:

- `m_<frame>_<n>.png`: 8-bit grayscale at the asset's size, 255 inside and 0 outside (binary in v1).
- `e_<frame>_<n>.json`: the details file, which gains a `segment` entry:

```json
{
  "segment": {
    "clip": "c_0003",
    "asset": "assets/team.jpg",
    "mask": ".frameshell/context/m_0_1.png",
    "size": [4032, 3024],
    "click": [1210, 1530],
    "bbox": [880, 610, 920, 2414],
    "frameBox": [0.08, 0.11, 0.39, 0.97],
    "area": 0.18,
    "score": 0.94,
    "model": "mobilesam@0d3b4033"
  }
}
```

`bbox` is `[x, y, w, h]` in asset pixels. `frameBox` is normalized `[x0, y0, x1, y1]` in the frame, so the agent can relate the mask to text it places.

The point line gains one part, after the clip:

```
[frameshell] point (0.21,0.48) @ 00:00:00.00 · clip c_0003 media assets/team.jpg · segment .frameshell/context/m_0_1.png bbox 880,610 920x2414 px (18 %) · details .frameshell/context/e_0_1.json · frame .frameshell/context/f_0.png
```

- **Ambiguity:** one click gives SAM's three answers. While the click is highlighted, ↑ / ↓ step to the larger or smaller mask. These are the same keys that move between an element's parent and child in ADR 0011. The chosen one is written.
- **Latency:** the 2.6 s encode starts when the Pick tool turns on in an image project, for each photo layer. The embedding is cached in memory by asset hash, so clicks cost about 0.2 s. No segmentation while hovering in v1: 0.17 s per decode is too slow to follow the cursor.
- **Agent side:** `inspect.point` gains `segment: true` (CLI `frameshell inspect --at 0 --px X,Y --segment`, MCP `inspect_point`). It writes the same mask file and returns the same `segment` object, so the agent can point by itself. `context.write` must accept the `m_*.png` names, or the daemon writes masks itself (it runs the model anyway).

## First operation: cut-out layer

`image.cutout` (mutating, one transaction) takes `{ clip, mask }`, where `mask` is any grayscale PNG at the clip asset's size. The Pick mask fits, and so does one the agent made some other way. It:

1. Writes `assets/<asset-stem>-cutout-<n>.png`: the asset with the mask as alpha (ffmpeg `alphamerge`), cropped to the mask's bounding box. The managed ffmpeg already does this; no new tool.
2. Imports it and adds a still clip on a new track directly above the clip's track, placed so the cut-out lies exactly over the original (same transform plus the crop offset).

So "take the person out of this photo" is one call. Background removal is the agent hiding or deleting the photo layer afterwards (two journaled steps, one revert). The CLI is `frameshell image cutout --clip c_0003 --mask <png>`, with an MCP tool from the registry and a context-menu item "Cut out as layer" on a segmented pick.

Why not the others in v1: background removal needs nothing beyond the cut-out. A blur behind text needs a blur effect with a mask on clips, which the schema, the export compiler and the preview engine all lack: it is its own ADR.

## Questions for the owner (with the recommended answer)

1. **Which model?** MobileSAM: 45 MB, about 3 s for the first click on a photo and a fifth of a second after. SlimSAM quantized is 14 MB but twice as slow. *Recommended: MobileSAM.*
2. **Built in or a plugin?** Built in, downloaded the first time someone points inside a photo, like face detection. A plugin would not work in untrusted projects. *Recommended: built in, on demand.*
3. **When should the photo be prepared?** As soon as the Pick tool is turned on in an image project, so the first click is fast. The alternative is waiting until the first click. *Recommended: on Pick.*
4. **A click can mean a part or the whole (the shirt or the person). How does the user choose?** ↑ / ↓ grows or shrinks the selection, as with elements today. *Recommended: yes.*
5. **Video projects too?** Not in v1. A frame of a video can become an image project already (File > New Image from Frame). *Recommended: image projects only.*

## Proposed issues

1. **ADR:** segmentation in image projects (model, core managed model, mask reference format, `image.cutout`). An addendum to ADR 0017 or a new ADR.
2. **Core: MobileSAM pin and segmenter.** Model pins in the manifest and `docs/binaries.md`, the worker on `onnxruntime-web` (the `loadYunet` pattern), an embedding cache by asset hash, and a Real binaries test that segments a drawn shape.
3. **Daemon + agent: segment a point.** `inspect.point` `segment`, mask files in `.frameshell/context/` swept by `gc`, CLI `--segment`, MCP, the skill (`pnpm gen:skill`), and a `PROTOCOL_VERSION` bump.
4. **App: Pick inside photos.** Pre-warm on Pick, an outline of the mask on click, ↑ / ↓ alternatives, the `segment` part in the point line and the details file, and English and Spanish strings.
5. **`image.cutout`:** the daemon method, journal label, CLI, MCP, skill, the "Cut out as layer" context-menu item, and e2e coverage.
6. **Later, not scheduled:** a masked blur effect (needs an ADR), exclude points (label 0) with Shift+Alt+click, hover preview, multi-threaded WebAssembly in Node.
