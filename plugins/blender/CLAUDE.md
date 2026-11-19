# Blender plugin (`@frameshell/blender`, ADR 0035)

- Files: `src/` (`adapter.ts`, `blender.ts` runner + version, `finals.ts` estimate, `deps.ts` links, `state-gc.ts` gc), `python/` (`render.py`, `deps.py`, Apache-2.0). Core: `ClipAdapter.finals`, `ClipRenderer.finals`, `confirmFinals` in `packages/core/src/export/service.ts`; `BLENDER_PACKAGE` in `packages/core/src/binaries/manifest.ts`; `ClipComparer` in `packages/core/src/clips/compare.ts`, wire `packages/protocol/src/clip-compare.ts`. Playbook `skills/blender/SKILL.md`; `docs/binaries.md` "Blender".
- User's own Blender, never downloaded: `binaries.blender` override first, then standard paths (`UserInstall.standardPaths`, `findUserInstall`); `userInstall` package. Range 4.5 LTS + 5.x.
- EEVEE draft + Cycles final = two cached renders (ADR 0041 decision 11). Final only for final exports; confirm over 5 min (`render --yes`).
- Still final = `frame`/`clip compare --final` only, never `review`.
- Look sheet = `clip.compare`: one frame, props/`source` variants, one scene per light setup.
- Key = `.blend` + in-project links + version + length. `inputs(clip, ctx)`: `ctx.signal` kills listing Blender on daemon stop.
- gc = plugin hook `ClipAdapter.gc`; layout stays in `state-gc.ts`; clear `BlendDeps` memory on delete.
- Tests: stub Blender; real test `FRAMESHELL_TEST_BLENDER`.
