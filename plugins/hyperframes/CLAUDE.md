# HyperFrames plugin

| Working on | Read |
|---|---|
| Motion templates (`hyperframes new --template`: typed props, `pick` per format, `style.json` tokens read leniently at scaffold; `hyperframes update` refreshes frozen runtime copies; ADR 0033) | `src/templates/` (`kit.ts` shared, `tokens.ts`, one file per template; add to `TEMPLATES`), `src/scaffold.ts`, `src/update.ts`; tests `test/templates.test.ts`, real `test/templates-real.test.ts` |
| Motion runtime copy | `src/motion-runtime.ts` (generated): `packages/motion/src/CLAUDE.md` |
| 3D in generated clips (ADR 0042) | `scripts/build-three.mjs` → `src/three-runtime.ts` (generated), `src/templates/three-kit.ts` (shared studio), `templates/product-shot.ts`, `templates/logo-3d.ts` (SVGLoader extrude), `templates/title-3d.ts`; `scripts/build-typeface.mjs` → `src/title-typeface.ts` (generated); real test `test/three-real.test.ts`; playbook `skills/hyperframes/3d-playbook.md`; spike `docs/research/three-in-hyperframes.md` (PR #531); Chrome SwiftShader flag in `clip.verify`: `packages/core/src/inspect/chrome.ts` |
| Adapter (render job, element sheet, `producerMotionBlur`) | `src/adapter.ts`; root size per format `src/frame-size.ts` (ADR 0027); 3D blur cap 8 samples `src/webgl.ts` (ADR 0041, 0042) |
| Brand component hook (`hyperframes new --component`) | `src/templates/components.ts` |

## Rules

- `fx-*` overlays (#802) share `src/templates/fx-kit.ts` (props, hit schedule via `stepTimes`, one canvas cleared per frame, end fade): an effect adds only its `draw` body. Real tests open Chrome with `test/chrome-args.ts`.
- Code windows share `src/templates/code-kit.ts` (tokenizer, `align`, layout): never copy.
- Checklist `onBeats` = the reference for beat-driven templates; step times clamped to `D - OUT - 0.2` via `stepTimes` `last` in `templates/kit.ts` (ADR 0029 d8).
- three.js: pinned bundle `pnpm gen:three` + drift test; copied only by `ThreeTemplate`s; `__hf.buildReady` gates assets (`buildReady`); VSM shadows; check skips the bundle; renders pinned to SwiftShader (`PRODUCER_BROWSER_GPU_MODE=software`). Templates `product-shot`, `logo-3d`.
- `title-3d` letters = Archivo Black typeface JSON from `pnpm gen:typeface` (opentype.js devDependency, script only, never in three bundle); copied via `ThreeTemplate.assets`; refreshed by `update`.
