# Motion runtime (ADR 0033)

- Springs, presets, role eases, `track`: one source (`index.ts`, `packages/schema/src/motion.ts`). Bundle shipped in plugin as `plugins/hyperframes/src/motion-runtime.ts` (generated, `pnpm gen:motion`).
- Page `bind` via `__timelines` + `hf-seek`. `write` only 2D `transform`/`opacity` on a 1/32 px + 0.02° grid. Every seek changes `html` filter: Chrome repaint threshold + partial raster.
- `beats.ts` (runtime 0.6.0): `beatAt`/`sinceBeat`/`springOnBeat`/`markers` read `window.frameshellTiming`, pure, nominal-BPM fallback; `words()` = its `words` list or `[]`, no fallback (ADR 0029 d8).
- `cuts` in `index.ts`: motion blur `cuts()` guard + `frameshell-fps` meta (ADR 0041).
- Real test `plugins/hyperframes/test/motion-real.test.ts`. Spike `docs/research/motion-runtime.md`; repaint causes `docs/research/motion-blur.md`.
