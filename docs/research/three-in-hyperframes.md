# three.js in a HyperFrames composition (#473, spike 0)

Spike 0 of [#473](https://github.com/ThomasPraun/frameshell/issues/473) (epic #451), the measurements the owner's decision of 2026-11-11 asks for before ADR 0042 (option A: a pinned three.js bundle copied into the composition, rendered on SwiftShader). No shipped code changed. Spike code and raw results: [`spikes/three-in-hyperframes/`](../../spikes/three-in-hyperframes/) (own npm package, never in the pnpm workspace; `results/` holds the JSON behind every table below).

Setup: three.js 0.187.0 (latest on npm, 2026-11-11), esbuild 0.25.12, `@hyperframes/producer` / `core` / `lint` 0.9.30, managed Chrome Headless Shell 154.0.8037.57, the producer's software flags (`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`), macOS 26 arm64, 8 cores, Node 22.16. The spike drives the **built** plugin: the real `createHyperframesAdapter` render (VP9 alpha WebM), the real `livePreview`, and the motion runtime's `bind` as the clock.

## Result in one table

| Question | Answer |
|---|---|
| Licence | three 0.187.0 is MIT (npm `license` field and the `LICENSE` file in the tarball, "Copyright 2010-2026 three.js authors"). Every file in the bundles below comes from the `three` package itself (esbuild metafile: no other package, no remote import). Compatible with Apache-2.0; ship the MIT notice in the bundle banner. |
| Bundle size, minified | **Full namespace + the four addons: 782 KB raw, 200 KB gzip, 164 KB brotli.** Curated names + addons: 666 KB / 170 KB / 140 KB. Core only: 732 KB (full) or 589 KB (curated). Upstream `three.core.js` + `three.module.js` are 1.44 MB + 0.64 MB unminified, and 0.187 ships no minified build. |
| ms per 1080p frame | Product shot with PMREM, 3 lights, soft shadows, clearcoat, MSAA 4, transparent clear: **about 0.1 s paint + 0.08 s capture in a live page; 0.24 to 0.33 s per frame through the real render** on a machine at load average 15 to 24 on 8 cores. Well inside the 1 s budget. |
| Determinism, 12 probes cold vs reseek | **0/255 worst difference: byte-identical** on all 12, and the 12 probes are 12 different pictures. The producer's lossless PNG frames are byte-identical to the cold probes, and two producer renders are byte-identical (30 of 30 frames). Budget is 2/255. |
| Alpha | Transparent clear works end to end: corner alpha 0, backdrop panel 128 (129 after VP9), subject 255, ground shadow 102 (0.4 x 255). |
| Loader readiness | **`THREE.DefaultLoadingManager` does not gate the render in 0.187; the HyperFrames three adapter never waits.** A promise in `window.__hf.buildReady` does, in renders and in live preview. This changes decision 2's reasoning, see below. |

## What the spike changes in the draft decision

Everything in decisions 1 to 8 of #473 still stands except these points, which ADR 0042 and the slices should take from here:

1. **The readiness gate is not `DefaultLoadingManager`.** The draft lists "a classic global `THREE` makes HyperFrames' own readiness gate work" as a pro of option A. It does not, with three 0.187: `LoadingManager` keeps `itemsLoaded` and `itemsTotal` in closure variables, so `typeof THREE.DefaultLoadingManager.itemsLoaded` is `"undefined"` (recorded in `results/loaders.json`). The HyperFrames three adapter (`hyperframe.runtime.iife.js`, `getReadyPromise`) requires both to be numbers and otherwise returns no promise. Option A is still right (offline, hashed, synchronous `bind`); the templates need their own gate, below.
2. **Gate the assets with `window.__hf.buildReady`.** The 0.9.30 runtime holds `window.__renderReady` false until every promise in `window.__hf.buildReady` settles, and a rejection becomes a startup error that names the key (`dist/runtime/diagnostics.js`). The template sets `__hf.buildReady.three = loadEverything()` synchronously from its script. Measured: with the loads started 5 s late, the render took 9.8 s instead of 5.2 s and frame 0 and the last frame were byte-identical to the fully loaded reference; `frameshellLive.ready` waited too (7.1 s, loads finished at that point).
3. **Soft shadows are VSM, and VSM is the expensive part.** r187 removed `PCFSoftShadowMap` (it logs a warning and falls back to `PCFShadowMap`), and `PCFShadowMap` kept hard edges at `shadow.radius` 1, 4, 8 and 24 (crops compared). A real soft edge needs `VSMShadowMap`. Its blur passes scale with the shadow map area and tap count, so the template defaults matter a lot, see the cost table.
4. **`TTFLoader` cannot be bundled.** In 0.187 it does `import opentype from "https://cdn.jsdelivr.net/npm/opentype.js@1.3.4/+esm"`; esbuild leaves that as a runtime require of a CDN URL. This confirms the draft's choice of a typeface JSON generated at build time. Archivo Black (ADR 0006) comes from the npm package `@expo-google-fonts/archivo-black`, so the TTF is available at build time; no TTF-to-typeface converter was evaluated (its licence is the open point the draft already lists), which stays for slice 3.
5. **`hyperframes check` would block every 3D composition.** `@hyperframes/lint` scans the local script files too, and the vendored bundle trips `non_deterministic_code` (`Math.random()` in three's UUID generator, `frameshell-three.js:2`) and `requestanimationframe_in_composition` (three's `WebGLAnimation`), both at **error** severity, which blocks. Neither can change a pixel. Slice 1 has to exempt the vendored file from these two rules (or the bundle from the scan) in `check.ts`; the spike's own `performance.now()` timing code also trips `non_deterministic_code`, so templates must not time anything. Separately, the 2D motion control composition already gets `missing_timeline_registry` (error) because the linter does not see `bind`, so `check` on motion compositions needs the same attention.
6. **WebGL canvas renders are serial.** The producer's trace for these renders says `needsAlpha: true`, `forceScreenshot: true`, `workerCount: 1` and "static-frame dedup disabled (canvas/webgl)". Cost per frame does not divide by cores.

## Bundle size

`spikes/three-in-hyperframes/src/bundle.mjs`: esbuild, `format: iife`, `minify`, `target: chrome120`, one banner line with the MIT notice, result assigned to `globalThis.THREE`. "Curated" imports only the ~65 names the scene uses (tree-shaken); "full" assigns the whole namespace (nothing tree-shakes).

| Bundle | Raw KB | gzip KB | brotli KB |
|---|---:|---:|---:|
| core, full namespace | 731.8 | 185.3 | 151.8 |
| core, curated names | 588.6 | 149.1 | 123.8 |
| **full + RoomEnvironment, RoundedBoxGeometry, TextGeometry + FontLoader, GLTFLoader** | **782.5** | **200.4** | **164.2** |
| curated + the same four addons | 665.7 | 169.5 | 140.2 |
| curated + RoomEnvironment | 596.0 | 150.7 | 125.0 |
| curated + RoundedBoxGeometry | 590.2 | 149.7 | 124.2 |
| curated + TextGeometry + FontLoader | 594.4 | 151.2 | 125.1 |
| curated + GLTFLoader | 654.4 | 166.0 | 137.7 |
| curated + SVGLoader (for a `logo-3d`) | 617.4 | 158.9 | 131.7 |

Per addon on the curated core: GLTFLoader +66 KB raw (it pulls `BufferGeometryUtils` and `SkeletonUtils`), SVGLoader +29 KB, RoomEnvironment +7 KB, TextGeometry + FontLoader +6 KB, RoundedBoxGeometry +2 KB. Every candidate is inside the `three` package, so one MIT notice covers all of them. The full-namespace bundle is 117 KB bigger than the curated one but lets a template or an agent use any class without a "not a constructor" error; at under 0.8 MB per composition copy both are cheap to hash. Which to ship is the owner's call in ADR 0042 (decision 4 already lists the addons). DRACO, KTX2, Meshopt and EXR loaders are not in any bundle: a GLB must be plain (uncompressed) unless a later slice adds them.

## The scene

`spikes/three-in-hyperframes/composition/index.html`, 1920 x 1080, 30 fps, one `<canvas>` painted by `bind("three", paint)`:

- WebGL2 on `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0)), SwiftShader driver)`, `MAX_SAMPLES` 4, `antialias: true` (4x MSAA on the default framebuffer), `alpha: true`, `premultipliedAlpha: true`, `setClearColor(0, 0)`, `NeutralToneMapping`, sRGB output, `setPixelRatio(1)`.
- PMREM studio environment: `PMREMGenerator.fromScene(new RoomEnvironment(), 0.04, ...)`, 256 px, once at load.
- Three lights: a key `DirectionalLight` with the shadow, a rim `SpotLight`, a fill `HemisphereLight`.
- Subject: a `RoundedBoxGeometry` body in `MeshPhysicalMaterial` with `clearcoat: 1`; a label plane with a `TextureLoader` texture (256 px checker PNG); a GLB crate loaded with `GLTFLoader` (hand-written box with an embedded PNG, generated by `src/fixtures.mjs`, nothing committed).
- A `ShadowMaterial` ground (opacity 0.4) and a translucent backdrop panel (`opacity: 0.5`) for partial alpha.
- `paint(t)` sets a turntable, a camera orbit and the crate's spin from `t` only (`FrameshellMotion.ease`) and renders once. No clock, no `setAnimationLoop`, no random source. After the loads finish it repaints the last time, because the live preview has no further seek to pick them up.

Default template-like settings used below unless stated: VSM shadow, 1024 px map, radius 8, 8 blur taps, MSAA 4, PMREM 256.

## ms per frame

The machine was shared with other work: load average 15 to 24 on 8 cores during the runs, and 30 to 47 during the last repeat of the table. Absolute numbers are inflated and noisy (run to run up to 50 %), so treat them as upper bounds and compare variants only within a run. Paint time is measured in the page with a 1x1 `readPixels` after `render()` (`gl.finish()` does not wait for the GPU process in Chrome: it returned 0.4 ms for a 700 ms paint); "capture" is the PNG screenshot the producer also does.

**Live page, per variant** (`src/bench.mjs`, median of 15 seeks; quietest run, `results/bench-main-quiet-run.json`):

| Variant (1080p unless stated) | Paint ms | Capture ms |
|---|---:|---:|
| **default: VSM 1024, radius 8, 8 taps, MSAA 4** | **102** | 79 |
| MSAA off | 80 | 76 |
| shadows PCF (hard edges) | 56 | 77 |
| shadows off | 56 | 78 |
| VSM 1024, 16 taps | 132 | 74 |
| VSM 512, radius 4 | 73 | 78 |
| VSM 2048, radius 16, 16 taps | 358 | 76 |
| PMREM 128 | 107 | 79 |
| 720p | 77 | 55 |
| 2160p | 273 | 218 |

An earlier run of heavier VSM settings (`results/bench-vsm-first-run.json`: map 2048, radius 24, 25 taps) cost 670 ms paint; the same with a 4096 map 2 s; a 1024 map 192 ms. The cost drivers are the VSM blur (map size squared times taps) and, far behind, the resolution; MSAA costs about 20 ms. The repeat on the loaded machine (`results/bench-main-contended-run.json`) gave the default 147 ms minimum and 206 ms median, in the same order.

**Cold costs, once per page** (PMREM 1.2 to 2.4 s, first paint including shader compile 0.5 to 1.5 s, page ready 2.5 to 7 s): paid once per render and once per live preview load, not per frame.

**Real render through the adapter** (`src/render.mjs`: 60 frames at 1080p to VP9 alpha WebM, three interleaved repeats, same stage and runtime for the control):

| | Seconds (min / median of 3) | ms per frame (min / median) |
|---|---:|---:|
| 2D control (a CSS box) | 5.4 / 5.6 | 91 / 94 |
| **product shot** | **14.6 / 20.1** | **243 / 334** |
| product shot, no timing readback | 16.1 / 20.3 | 269 / 339 |

The control's 91 ms per frame is mostly the producer's fixed start (about 3 s: browser, runtime ready, fonts) divided by 60; the scene adds about 150 ms (minimum) to 240 ms (median) per frame over it. The no-readback variant is no faster: the readback is not the cost. A 10 s clip at 30 fps would take about 75 to 105 s plus the fixed start. Against decision 7's budget of about 1 s per 1080p frame for a draft-quality product shot, the default settings leave 3x headroom on a loaded machine; shadows 2048+ with a wide blur would not (0.7 s paint alone).

## Determinism

`src/determinism.mjs`, default scene, 1080p, 12 probe frames on the 30 fps grid (1, 3, 6, 8, 11, 13, 16, 18, 21, 23, 26, 28):

| Check | Result |
|---|---|
| Cold (fresh page per probe) vs after seeking from an unrelated probe first, same page | worst difference **0** of 255 on all 12 probes (budget 2); 12 distinct pictures; no page error or console warning |
| Producer lossless PNG sequence (the real render path) frame k vs the cold probe of frame k | worst difference **0** |
| Two producer renders, all 30 frames | **30 of 30 byte-identical** |

So on this machine, the same Chrome and SwiftShader, three.js with PMREM, VSM, clearcoat, MSAA and loaded assets paints a pure function of `t`. Not measured: other machines, Linux, Windows, another CPU (SwiftShader runs LLVM-generated CPU code, so different SIMD targets are the risk), and the hardware-GL live preview in the Electron app against the SwiftShader export.

## Alpha

Decoded VP9 WebM (libvpx, `-c:v libvpx-vp9`, as `render-real` does) against a lossless screenshot of the live page, `results/render.json`:

| Point | Live screenshot RGBA | Decoded WebM RGBA |
|---|---|---|
| corner (6, 6) | 0, 0, 0, 0 | 0, 0, 0, 0 |
| backdrop panel (700, 250) | 223, 229, 249, 128 | 223, 228, 249, 129 |
| subject body (850, 380), t = 0 | 13, 24, 44, 255 | 13, 24, 43, 255 |
| ground shadow (420, 640), t = 1 | 0, 0, 0, 102 | 0, 0, 0, 102 |

Share of pixels in the WebM at t = 0: 67.2 % transparent, 23.4 % partial, 9.3 % opaque. `alpha: true` + `premultipliedAlpha: true` + `setClearColor(0, 0)` gives straight-alpha PNGs through the producer's screenshot capture (`omitBackground`); the only loss is VP9's 1/255 rounding. `preserveDrawingBuffer` was left `false` and nothing broke.

## Loader readiness

`src/loaders.mjs`, 15-frame renders (lossless PNG sequence) compared with a live page whose loads have finished; "complete" means frame 0 matches that reference.

| Loading style | Render s | Frame 0 vs loaded reference | Verdict |
|---|---:|---|---|
| `loadAsync` started in the script, default manager | 6.4 | 0 pixels differ | complete, but not because of a gate (see below) |
| same, started 400 ms after the script | 5.8 | 0 differ | complete: finishes inside the producer's ~3 s session start |
| same, started 5 s after | 5.3 | 292 871 bytes differ (>2/255), assets missing in **every** frame | **not waited for** |
| started 5 s after, with `DefaultLoadingManager.itemStart("hold")` until done | 5.2 | same as above | **not waited for**: the three adapter sees no counters |
| fetch + `createImageBitmap` + `GLTFLoader.parse`, no manager | 6.9 | 145 bytes differ, worst 4 | complete by timing; the 4/255 is ImageBitmap vs `ImageLoader` decoding |
| **loads wrapped in `window.__hf.buildReady.three`, started at once** | 5.7 | 0 differ | complete |
| **same, started 5 s after** | **9.8** | **0 differ, last frame too** | **render waited for the promise** |
| nothing loaded (control) | 6.8 | assets absent | as expected |

Live preview: `frameshellLive.ready` took 7.1 s with the `buildReady` promise (loads finished) and 2.9 s with the manager hold (loads not finished). The promise form also makes a failed load a clear startup error instead of a render with a missing object. A GLB loaded with the default manager in the first 3 s looks fine in every test, which is exactly why a template that relies on it would pass here and fail on a slow disk or a large model.

## Recommendations for ADR 0042 and slices 1 to 3

- Keep option A as decided. Correct decision 2/3's wording: the readiness gate is `window.__hf.buildReady`, not `DefaultLoadingManager`. Slice 2's template wraps the texture, GLB and font loads in one promise there, and a rejected promise is the load failure.
- Template defaults for "soft shadows on SwiftShader": VSM, 1024 px map, radius about 8, 8 blur taps, MSAA 4, PMREM 256 (about 0.1 s paint at 1080p); a "high" preset may use a 2048 map with radius 16 and 16 taps (about 0.36 s paint) and should say so. Never 4096 maps.
- Bundle: ship the full namespace + four addons (782 KB raw, 200 KB gzip) unless the owner prefers the curated list (666 KB, but every class a template uses must be on it). Add SVGLoader (+29 KB) only when `logo-3d` needs it. No TTFLoader.
- Slice 1 must also exempt the vendored bundle from `non_deterministic_code` and `requestanimationframe_in_composition` in `check.ts` (decision 3's seek-safety rules then police the template's own code), and the templates must carry no `performance.now()`.
- The #501 cap of 8 samples for 3D with `motionBlur` is consistent with these numbers: one paint is about 0.1 to 0.3 s, so 8 samples would cost roughly 0.8 to 2.4 s per frame (an estimate, motion blur was not run); 16 to 64 would be several seconds to over a minute per frame.

## Not covered (left for later slices)

- Hardware GL (`PRODUCER_BROWSER_GPU_MODE=hardware`) and the pixel parity between the Electron live preview and the SwiftShader export.
- Linux and Windows SwiftShader, other CPUs.
- `MeshPhysicalMaterial` `transmission`, `TextGeometry` with a real typeface generated from Archivo Black, `SVGLoader` extrusion, animation clips through `AnimationMixer.setTime`, Draco/KTX2/Meshopt GLBs, large GLBs and textures (load time against the producer's own timeouts).
- Motion blur with 3D (sampled subframes of the above).
- Whether a different GLB exporter (Blender) adds extensions the bundle lacks.

## Reproduce

```sh
pnpm install --frozen-lockfile && pnpm build
export FRAMESHELL_TEST_BINARIES_DIR=<repo>/.cache/test-binaries
cd spikes/three-in-hyperframes && npm install
npm run bundle                   # sizes
node src/bench.mjs               # ms per frame per variant (BENCH_SET=vsm for the first, heavier run)
node src/render.mjs              # adapter render vs 2D control, alpha
node src/determinism.mjs         # 12 probes, producer frames, render vs render
node src/loaders.mjs             # readiness; node src/live-ready.mjs for the live preview
node src/lint.mjs                # @hyperframes/lint on the composition
```
