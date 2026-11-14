---
status: accepted
---

# three.js in generated clips: a pinned bundle copied into HyperFrames compositions, rendered on SwiftShader

3D product shots, titles and logos for launch films ([#473](https://github.com/ThomasPraun/frameshell/issues/473), epic #451), the lighter 3D route beside Blender (ADR 0035). The owner chose option A of the proposal on #473 on 2026-11-11 with every recommendation, after a spike; the spike ([`docs/research/three-in-hyperframes.md`](../research/three-in-hyperframes.md), PR #531) was approved on 2026-11-13 with its five corrections, which this ADR records. Extends ADR 0033 (motion runtime); ADR 0033 is unchanged except a cross-link. **Slices 1 and 2 are built; slices 3 to 5 are not.**

## Context (verified)

- ADR 0033: HyperFrames is the motion host. The motion runtime is copied into each composition on scaffold, frozen per clip and hashed as an input; `bind(id, paint)` registers a seek-only timeline and must be called synchronously. Templates (`hyperframes new --template`, `update`) and the core determinism verify (`clip.verify`, 12 probes cold vs reseek, 2/255) are built.
- The adapter hashes every file of the composition directory except `node_modules`, renders a copy in-process with `@hyperframes/producer` 0.9.30 and the managed `chrome-headless-shell` 154. The producer's GPU mode defaults to `software` (`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`); `PRODUCER_BROWSER_GPU_MODE` can switch it to hardware GL.
- The daemon runs clip renders in their own queue, one at a time (`clipJobs`, concurrency 1). For a WebGL canvas the producer uses one capture worker and screenshots (`workerCount: 1`, static-frame dedup off).
- Spike (three 0.187.0, MIT, macOS arm64, pinned Chrome): the product shot paints in about 0.1 s and renders at 0.24 to 0.33 s per 1080p frame on a loaded machine; 12 probes cold vs reseek are byte-identical and two renders are byte-identical; alpha survives to VP9. Five findings changed the draft decision, below.

## Decision

1. **Own ADR, decision row 47 of the SPEC.** A third-party library in shipped plugin files, a GL-mode pin and new check rules.
2. **Vendored pinned bundle, no CDN.** `three` is an exact devDependency of `@frameshell/hyperframes`. `pnpm gen:three` (`plugins/hyperframes/scripts/build-three.mjs`) bundles the whole `three` namespace plus `RoomEnvironment`, `RoundedBoxGeometry`, `TextGeometry`, `FontLoader` / `Font` and `GLTFLoader` with esbuild into one minified classic IIFE that sets `window.THREE`, with the full MIT notice in its header, and writes it as a string to `plugins/hyperframes/src/three-runtime.ts`. The generator refuses any input outside the `three` package; a drift test reruns it with `--check`. The full namespace (782 KB raw, 200 KB gzip in the spike) is chosen over a curated list (666 KB) so a template or an agent never meets a missing class.
3. **Copied only into 3D compositions.** A template marked 3D (`ThreeTemplate`, `three: true`) gets `frameshell-three.js` next to `frameshell-motion.js` on `hyperframes new --template`, at the composition root (never under `node_modules`, which the cache key skips). `hyperframes update` refreshes it like the motion runtime: older Frameshell copies are replaced, an edited, newer or foreign file is kept unless `--force`.
4. **One clock.** The motion runtime's `bind`: `paint(t)` sets every pose from `t` and calls `renderer.render` once. `hyperframes check` adds `three_animation_loop` (`setAnimationLoop`) and `three_clock` (`THREE.Clock`, `getDelta`, `getElapsedTime`) as errors and `three_mixer_update` (`mixer.update(delta)`, use `setTime(t)`) as a warning; the linter already blocks `requestAnimationFrame` and `Math.random` in author code.
5. **Readiness through `window.__hf.buildReady` (correction 1).** In three 0.187 `LoadingManager` keeps its counters in closures, so the HyperFrames three adapter never waits on `THREE.DefaultLoadingManager`. A 3D composition puts one promise per asset group in `window.__hf.buildReady.<key>`, synchronously from its script: the 0.9.30 runtime holds `__renderReady` (render and live preview) until every promise settles, and a rejection is a startup error, so a missing model fails the render with its path. After the loads the page repaints the last time, since the live page gets no further seek.
6. **Soft shadows are VSM (correction 2).** r187 has no `PCFSoftShadowMap`; `PCFShadowMap` stays hard. Template defaults: VSM, 1024 map, radius 8, 8 blur samples, MSAA 4 (`antialias: true`), PMREM 256 from `RoomEnvironment`, neutral tone mapping. A ground of `ShadowMaterial` stays inside the shadow camera (past its edge VSM draws a dotted line). Never a 4096 map.
7. **No `TTFLoader` (correction 3).** It imports opentype.js from a CDN at run time and cannot be bundled. 3D text uses `TextGeometry` with a typeface JSON generated at build time (Archivo Black, OFL), or the existing font path for DOM text over the canvas.
8. **A 3D-aware check (correction 4).** The linter scans local scripts, and the bundle's own `Math.random` (UUIDs) and render loop (`WebGLAnimation`) would block every 3D composition. `check` drops findings located in a Frameshell three.js bundle (recognised by its header, any version) and the linter's `requestanimationframe_in_composition` while no other script of the composition calls `requestAnimationFrame`; the scene code is linted as before.
9. **SwiftShader for every HyperFrames render, one at a time (correction 5).** The adapter sets `PRODUCER_BROWSER_GPU_MODE=software` before each render, so no daemon environment flips a render to the machine's GPU. Clip renders stay serial (the clip queue), and the producer captures a canvas with one worker; a slow 3D clip delays other clip renders, as a Blender final does. Hardware GL may come later, opt-in only, if templates exceed the budget.
10. **Cost budget.** About 1 s per 1080p frame for a draft-quality product shot; above it, lower MSAA, the shadow map and PMREM size first, then reopen.
11. **No dedicated `three` clip type.** Revisit only if a template fails `clip.verify` or the cost budget on HyperFrames.
12. **Blender bridge.** A GLB exported from Blender is loaded by a three.js template from the composition directory (hashed like every file); no code link between the plugins. GLBs are plain glTF binary: the bundle has no Draco, KTX2 or Meshopt decoder.
13. **Motion blur (cross rule with #501).** A 3D template with motion blur is capped at 8 fixed samples with a warning.

### Settled in slices 1 and 2

- The bundle is 0.82 MB with the notice; `scripts/` is not published, `src/three-runtime.ts` builds into `dist`.
- `product-shot` (`plugins/hyperframes/src/templates/product-shot.ts`) on the shared studio of `templates/three-kit.ts` (renderer, PMREM, key, fill and rim light, ground, `ready`): the built-in rounded box or a GLB fitted to the same size, a label texture, finish presets, a push-in, a glint sweep, spin and orbit props, a DOM headline, layout per format through `M.pick`. Transparent unless `backdrop`.
- `plugins/hyperframes/test/three-real.test.ts` (opt-in) renders it with a generated GLB and a texture: the model is in the first frame, alpha is kept, `clip.verify` passes with tolerance 0, and a missing model fails the render naming the file. `templates-real` lays it out in the four formats.

### Slices

1. `gen:three`, drift test, GPU-mode pin, seek-safety rules, 3D-aware check (done).
2. `product-shot` template with a real-render test (done).
3. `title-3d` (Archivo Black typeface JSON at build time, converter licence to check) and `logo-3d` (SVG extrude, `SVGLoader` +29 KB).
4. The 3D playbook reference in the plugin skill (studio defaults, materials, camera, beat sheet, failure and fix, Blender bridge), GLOSSARY.
5. Motion blur cap for 3D once #501 lands; hardware GL and the live-vs-export parity only if needed.

## Consequences

- **Plugin size** grows by the bundle (0.82 MB raw in `dist`), and each 3D composition carries a copy, hashed on every key check.
- **A re-pin is a deliberate PR:** bump `three`, `pnpm gen:three`, run the opt-in `three-real` and `templates-real` tests. Old clips keep their copy until `update`.
- **Pixels of existing clips** do not change: software GL was already the producer's default. Someone who had set `PRODUCER_BROWSER_GPU_MODE=hardware` now renders on SwiftShader; the GL mode is not in the cache key, so earlier hardware renders stay cached until something else changes.
- **Live preview** in the app runs WebGL on the GPU while export and `clip.verify` (core's Chrome falls back to SwiftShader) do not: small shading differences between the live page and the export are expected (ADR 0010 already labels live clips).
- **Pick and element mode** see a 3D scene as one `<canvas>`: element mode moves or scales the whole picture; object changes are props.
- **Coupling to HyperFrames internals** grows: `window.__hf.buildReady` is an undocumented hook of the 0.9.30 runtime. `three-real` must pass on every HyperFrames bump.
- **Unchanged:** schema, JSON Schema, protocol (`PROTOCOL_VERSION`), plugin API, cache layout, core, desktop, the Remotion and Blender plugins.
- **Not covered by the spike:** Linux, Windows and other CPUs (SwiftShader runs generated CPU code), transmission, large GLBs against the producer's ready timeout (45 s).
