# Generated clips (render cache, adapters, verify, compare)

| Working on | Read |
|---|---|
| Render cache, keys, background renders, export layers, render per format (`formatSizes`; SPEC §6.5) | `renderer.ts`, `cache-key.ts`, `timing.ts` |
| Adapters | `plugins/hyperframes` (ADR 0002; root size per format `src/frame-size.ts`, ADR 0027), `plugins/remotion` (bundle as cache input, outside-project code, `refreshRenders`; ADR 0009), `plugins/blender` (ADR 0035); contract `ClipAdapter` in `packages/plugin-api/src/index.ts` |
| Motion determinism verify (`clip verify`: probes cold vs after reseek in headless Chrome, 2/255, worst frame + element; ADR 0033) | `verify.ts`, `packages/core/src/inspect/live-page.ts`, `inspect/chrome.ts`; wire `clip-verify.ts` in `packages/protocol/src`; CLI `clip verify` in `packages/cli/src/timeline-commands.ts`; real test `plugins/hyperframes/test/motion-real.test.ts` |
| Text fit (`clip.textFit`: live page at settled times, own-text elements, frame edge + scroll overflow of the holding box less tight line-height; props tried for the check only via `ClipRenderer.live` `props`; #803) | `text-fit.ts` (script uses probe `selector`, `seek` from `verify.ts`); wire `clip-verify.ts` in `packages/protocol/src`; CLI `clip text-fit`; real test `plugins/hyperframes/test/text-fit-real.test.ts` |
| Look sheet (`clip.compare`: one frame, props/`source` variants) | `ClipComparer` in `compare.ts`; wire `packages/protocol/src/clip-compare.ts` |
| Element adjustments (clip `elements`, CSS sheet + selector check, render key, adapters insert sheet, live bridge swap, probe `unit`; ADR 0021) | `packages/schema/src/element-styles.ts`; engine `setElements`; `renderer.ts`; `plugins/hyperframes/src/adapter.ts`, `plugins/remotion/src/elements.ts` (bundle copy); `LIVE_BRIDGE` in `apps/desktop/src/main/live-protocol.ts`; `packages/protocol/src/probe.ts` |
| Motion blur (clip `motionBlur`, adapter capability, HyperFrames producer mapping; ADR 0041) | `packages/schema/src/motion-blur.ts`; engine `setMotionBlur`; `#keyOf` in `renderer.ts`; `producerMotionBlur` in `plugins/hyperframes/src/adapter.ts`; `cuts()` guard + `frameshell-fps` meta: `packages/motion/src/CLAUDE.md`; spike `docs/research/motion-blur.md` |

## Rules

- Clip cache entry layout or key recipe changed: bump `CACHE_LAYOUT_VERSION` (`cache-key.ts`).
- Motion blur = 2 entries: sharp draft first + blurred final, `ensure` tier; refusal falls back sharp. Resolved settings in render key. 3D blur cap 8 samples `plugins/hyperframes/src/webgl.ts` (ADR 0041, 0042).
- Finals (Blender EEVEE draft + Cycles final, ADR 0041 decision 11): `ClipAdapter.finals`, `ClipRenderer.finals`. Still final = clip narrowed to one frame (`stillClip`, `stillFinalAt` in `ClipRenderer.ensure`, `still` in key), `finals.windowed` adapters only; whole final preferred.
- Clips that ask get beats + markers + words (ADR 0029 decision 8): words = daemon `wordsOf`, one placer `placeWords`; HyperFrames `onBeats` prop asks beats.
- Adapter notes `RenderContext.warn` kept in entry meta, shown by `ensure` `onWarning` (job, `frame`, `review`).
- gc = plugin hook `ClipAdapter.gc`; core `ClipRenderer.gc` only gathers inputs, layout stays in the plugin (Blender `state-gc.ts`).
- Style token sheet `styleTokenCss`: adapter opts in `styleTokens`, sheet hash in clip key only then.
- `clip.compare` reuses `grade/compare.ts` frame pick + `writeSheet`, never a second tiler.
- `clip verify` page server shared with `inspect.point`.
