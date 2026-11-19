# Media (ingest, proxies, energy, beats, loudness, audio effects bake)

| Working on | Read |
|---|---|
| Ingest (proxy recipe, cache, job queue; SVG + font files = non-media assets, `kind` in `asset.list`) | `recipe.ts`, `service.ts`, `kind.ts`; queue `packages/core/src/jobs/queue.ts`; clip priority set in `clips/renderer.ts` `#render` |
| Cut snapping to audio energy (pauses, envelope cache; ADR 0003) | `energy.ts`, `energy-store.ts`, `packages/core/src/timeline/snap.ts` |
| Beat grid (ADR 0029 slice 2) | `packages/schema/src/beats.ts`; `beats.ts` (DSP), `beats-store.ts` (store, file naming via `asset-names.ts`, `classifyBeatsCache`), `beats-worker.ts`, `beats-watcher.ts`; CLI `packages/cli/src/beats-commands.ts`; tests on synthetic click tracks `packages/core/test/beat-fixture.ts` |
| Beat detector on real + generated music (#689: harness, failure classes, learned-detector go/no-go + licence read) | `docs/research/beats-real-music.md`; `spikes/beats-real-music/` (`make-corpus.mjs`, `fetch-cc0.mjs`, `run.mjs`) |
| Per-asset EBU R128 loudness cache (`.frameshell/loudness/`, gc kind `loudness`; whole file or played part `SoundRange`, `playedRange`) | `loudness-store.ts`, `loudness-plan.ts` (gain maths, `planLevels`); ADR 0037 |
| Audio effects bake (ADR 0031) | `audio-fx.ts`; `packages/schema/src/effects.ts` |
| Audition (`audio.inspect`) | `spectrogram.ts` (pure), `audio-inspect.ts`; `packages/core/src/sound/CLAUDE.md` |

## Rules

- Proxy recipe changed: bump `RECIPE_VERSION` (cache key), else stale proxies reused.
- Beats file `beats/<stem>.beats.json`: `detector` incl. `exact`, human `edits`, `effectiveBeatGrid`; `nominalBeatFrame` rounds once per index. `file.write` validates. `beats.measure` job + `beats.show`.
- Beat detector = pure DSP in a worker thread; onset cache `.frameshell/beats/`, gc class `beats`. Never sweep `beats/`.
- Detector changed: rerun the `spikes/beats-real-music/` harness (failure classes, learned-detector go/no-go); its CC0 set is fetched on demand, never committed.
- Audio effects bake: `.frameshell/audio-fx/`, key, `afftdn` latency pad, `audio-fx` job, gc. Export reads bake (`RenderInput.audioFx`, `audioGraph` in `export/compiler.ts`). Preview plays bake as sidecar (`audio.bakes`).
