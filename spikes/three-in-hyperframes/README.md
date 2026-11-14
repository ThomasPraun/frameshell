# Spike: three.js inside a HyperFrames composition (PROTOTYPE, throwaway)

Spike 0 of [#473](https://github.com/ThomasPraun/frameshell/issues/473) (epic #451, ADR 0042 pending). Answers: bundle size of three.js plus candidate addons,
ms per 1080p frame of a product shot on the pinned Chrome with the producer's software GL flags, cold vs reseek determinism, alpha,
and loader readiness. Findings and numbers: [`docs/research/three-in-hyperframes.md`](../../docs/research/three-in-hyperframes.md).

Self-contained npm package, never part of the pnpm workspace. It drives the **built** plugin and core (`pnpm build` at the repo root first),
so it exercises the real adapter, the motion runtime (`bind`) and the managed Chrome, ffmpeg and ffprobe.

| Path | What |
|---|---|
| `src/bundle.mjs` | esbuild IIFE bundles of three 0.187.0 (full namespace vs curated names, with and without addons), raw/gzip/brotli sizes |
| `composition/index.html` | The product shot: PMREM `RoomEnvironment`, 3 lights, soft shadows, clearcoat, MSAA, transparent clear, a loaded texture and GLB |
| `composition/baseline.html` | 2D control composition at the same size, for render-time subtraction |
| `src/fixtures.mjs` | Generates the checker PNG and a small GLB (embedded PNG) in code: no model files committed |
| `src/lib.mjs` | Project assembly, managed binaries, live page server (the plugin's `livePreview`), PNG-sequence render, pixel helpers |
| `src/smoke.mjs` | One frame to `out/smoke.png` |
| `src/bench.mjs` | ms per frame on the live page per variant (paint with readback, screenshot, cold start) |
| `src/render.mjs` | Render through the adapter (WebM alpha) vs the 2D control; alpha samples of the decoded WebM |
| `src/determinism.mjs` | 12 probes cold vs reseek; producer PNG sequence vs cold; render vs render |
| `src/loaders.mjs` | Readiness of a GLB and a texture under several loading styles (default manager, held manager, `window.__hf.buildReady`, fetch) |
| `src/live-ready.mjs` | Does the live preview wait for those gates |
| `src/lint.mjs` | What `@hyperframes/lint` says about the composition with the vendored bundle |
| `src/log-to-json.mjs` | Turns a bench stdout log into a results JSON |
| `results/` | The measured JSON behind the research note (committed; `out/` is not) |

## Reproduce

```sh
pnpm install --frozen-lockfile && pnpm build          # repo root
export FRAMESHELL_TEST_BINARIES_DIR=<repo>/.cache/test-binaries   # ffmpeg + chrome-headless-shell (downloaded once)
cd spikes/three-in-hyperframes
npm install
npm run bundle                 # out/bundles/*.js + sizes.json
node src/smoke.mjs
node src/bench.mjs             # a few minutes
node src/render.mjs
node src/determinism.mjs
node src/loaders.mjs
```

`out/` (bundles, projects, renders, results) is gitignored.
