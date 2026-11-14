---
status: accepted
---

# Film finish: grain and vignette per clip, letterbox per timeline

ADR 0031 decision 10 split grain, vignette and letterbox into their own ticket (#500, epic #451). #500 asked for all three per clip, like `grade`, plus `clip set --grain/--vignette/--letterbox`, inspector rows and a skill rule (never grain on screen recordings or UI). A #384 comment adds that these belong in ffmpeg at export, not in a generated page, and #478 says to build in core. The owner decided on 2026-11-11: option B of the proposed decision on #500, every recommendation accepted (the ten points below). It amends ADR 0031's per-part order and ADR 0027's override keys. It ships in slices; **slice 1 (letterbox) is built.**

## Context (verified in the tree, 2026-11-11)

- None of the three existed. `clipBase` carried no look fields besides `grade` and `backdrop` (ADR 0031), and the timeline file's own fields were `tracks`, `groups`, `markers` and `tempo`.
- Export: `videoGraph` (`packages/core/src/export/compiler.ts`) ends in one unlabelled line; `compileRender` and `compileFrame` append `burnSubtitles` (or the cover word) to it, so anything appended before that sits above every picture and under the captions. Export runs in segments, with a one-frame cover segment.
- Preview: the engine canvas draws the pictures; a live generated clip is an iframe above it (ADR 0010); render slates and the caption canvas are DOM layers above that (`PreviewPanel.tsx`).
- Formats (ADR 0027): non-primary formats re-block (cover) and never letterbox; `formatTimeline` is the one place a timeline is rewritten for a format.
- Measured on the pinned ffmpeg 9.0.2 (darwin-arm64): `noise` with a seed is deterministic but not frame-addressable (frame 60 of a full run differs from frame 0 of a run trimmed to start there); a bounded `color` → `noise` → `trim=end_frame=64` → `loop` plate is. ffmpeg's `vignette` is a lens-angle model that cannot carry radius and softness. `drawbox` paints limited-range black, so on a full-range (`yuvj`) frame it gives Y=16, not 0.

## Decision

1. **Letterbox per timeline:** one optional timeline field `letterbox { aspect }` with its own operation (`letterbox.set`), not `clip set --letterbox`. Bars are black: top and bottom when `aspect` is wider than the frame, at the sides when narrower. Bars belong to the output frame: on a clip they would cut a picture-in-picture or vanish under overlays.
2. **Other formats:** off by default. A per-format `letterbox` override joins ADR 0027 decision 5's key list in a later slice; until then ADR 0027's "re-block, never letterbox" holds there.
3. **Captions over the bars,** subtitle layout unchanged (a caption placed low reads over the bottom bar).
4. **Whole timeline only** in v1: no ranges, no animated bars.
5. **Per-part order:** grade → vignette → grain → transition shape → alpha or matte mask → backdrop (amends ADR 0031's cross decision: the lens darkens before the emulsion adds grain).
6. **Preview grain statistically matched** (same amount and size, a TS PRNG at preview resolution; a test pins mean and standard deviation of the luma delta), not pixel-exact.
7. **Grain determinism:** seed = `grain.seed` if set, else the low 31 bits of an FNV-1a hash of the clip id (the subject-matte copy, ADR 0032, keeps the plate's seed); phase = timeline frame mod 64. Export plate: bounded `color` → `noise` (`allf=t+u`, `all_seed`) trimmed to 64 frames, looped, scaled by `size`, `blend grainmerge` keeping alpha. L = 64 changes only with a golden update.
8. **Vignette by our own smoothstep formula** (`strength` 0-1, `radius` 0-1.5 of the half-diagonal, `softness` 0-1): one pure schema function with a parity test; the export plate is rasterised once per layer size and overlaid. ffmpeg's `vignette` is not used.
9. **Scope v1:** video projects; media and adapter clips; multicam shots skipped with a warning; nested timeline hosts refused. Image projects later.
10. **Ship order:** vignette and letterbox first, grain second, independent of grade (#384).

Units: grain `amount` 0-1 (a pinned mapping to `noise` strength), `size` 1-4 project px; letterbox `aspect` > 0 (2.39, 1.85, 4/3).

Cross rules (owner, same comment): the vignette slice builds the preview's per-part offscreen pass that backdrop (#462) and grade (#384) reuse; a `--loop` export (ADR 0039) with grain whose length is not a multiple of 64 warns that the seam shows; the ADR 0027 amendment (the `letterbox` key and ADR 0039's `video.fit: "inside"`) is one amendment (ADR 0027 decision 13).

### Letterbox and the format fit are different things

A preset or format of another aspect than the source *fits* a picture into the frame (`layerRect`, `pad`; GLOSSARY "Cover" calls that letterboxing). That fit happens per layer, inside the frame, and only when sizes disagree. The timeline's `letterbox` is a deliberate look over the finished frame: it is drawn after every layer, on the frame's own pixels, whatever the sources are. They combine: a 4:3 clip fitted into a 16:9 primary gets its pillarbox from the fit, and a `letterbox { aspect: 2.39 }` then adds bars top and bottom over that whole frame. In a non-primary format the fit becomes the ADR 0027 cover, and the letterbox is left out.

## Slices

1. **Letterbox:** timeline field, pure `letterboxBars`, engine operation with inverse and review-mode routing, wire method and `PROTOCOL_VERSION` bump, export `drawbox` on the final video line before the captions (primary format only), preview bars in the `PreviewPanel` overlay under the captions, CLI, skill, golden. Built, see below.
2. Vignette per clip: schema field, `vignetteGain` and its parity test against the export plate, export overlay in the per-piece chain, the preview's per-part offscreen pass, `clip.set vignette`, shot warning, nested-host refusal, CLI `clip set --vignette`, golden.
3. Grain per clip: schema field, `grainSeed`/`grainPhase`, the looped seeded plate and `blend grainmerge`, a framemd5 test that frame N is equal across segment splits, `frame` and the cover frame, the preview PRNG pass and its statistics test, the subject-matte copy keeping the seed, the ADR 0001 frame budget, CLI `clip set --grain`, skill rule, golden, the `--loop` seam warning.
4. Inspector rows for grain and vignette, a timeline letterbox control (en + es, e2e), the per-format `letterbox` override (ADR 0027 decision 5), the letterboxed rectangle in `inspect.point` and review (#457) text checks, image projects.

## Slice 1 as built

- **Schema** (`packages/schema/src/timeline.ts`): optional `letterbox: { aspect }` on the timeline (`LetterboxSchema`, `aspect` a positive number), JSON Schema regenerated. Older hosts reject files that carry it (strict schema). `packages/schema/src/finish.ts` holds `letterboxBars(frame, aspect)` without Zod: the picture keeps `round(width / aspect)` rows (or `round(height × aspect)` columns, at least one), the first bar gets the floor of the rest and the second the odd pixel, and an aspect equal to the frame's to the pixel gives no bars. Export and the preview both call it.
- **Formats:** `formatTimeline` (the one rewrite for a non-primary format) leaves `letterbox` out, so export of another format, its captures and the preview's format switcher draw no bars without a check of their own.
- **Operation** `letterbox.set { aspect? , clear? }` (`packages/core/src/timeline/engine.ts`): replaces the whole letterbox; `clear: true` removes it (a warning when there was none); nothing to set, or `clear` with `aspect`, is InvalidOperation. Warnings when the primary frame already has that aspect (no bars show) and when the project has other formats (bars show in the primary only). Journaled; the inverse patch carries `letterbox` as one value (`TimelinePatch.letterbox`, `null` removes it), keyed `letterbox` in revert conflicts and review-mode rebase (`packages/core/src/history/revert.ts`), related to no other entity. Review mode holds it in the transaction's proposal like any operation; `timeline.show` lists it.
- **Wire** (protocol 130): method `letterbox.set` in the registry (MCP tool `letterbox_set` follows), `letterbox` in `TimelineView` and `TimelinePatch`. Idempotency replays it like every mutating method.
- **Export** (`letterboxChain` in `compiler.ts`): one `drawbox=…:color=black:t=fill` per bar appended to the graph's last line, before `burnSubtitles`, the cover word and the `fps` change, in every segment (the cover frame included) and in `frame` captures. A full-range frame (`yuvj444p`, JPEG captures) gets its bars in the limited twin (`format=yuv444p,drawbox…,format=yuvj444p`) so black stays 0. A timeline without the field gives byte-identical plans: every existing golden stays, and `letterbox-plan.json` is new. `letterbox-render.test.ts` renders frames with the managed ffmpeg and checks that exactly the pixels `letterboxBars` names are 0 and that a caption line inside the bottom bar is burned over it.
- **Preview:** the compiled `Program` carries the view's `letterbox`; `letterboxOverlay` (`preview/program.ts`) turns `letterboxBars` of the shown frame into fractions, and `PreviewPanel` draws them as black DOM bars after the live iframe and the render slates and before the caption canvas, taking no clicks. `preview-letterbox.test.ts` checks them against the `drawbox` rectangles `compileFrame` writes for the same timeline, at the project size and another capture size, and that a non-primary format has none.
- **CLI:** `letterbox set <aspect>` (`2.39`, `2.39:1`, `4:3`, `4/3`) and `letterbox clear`; `timeline show` prints `Letterbox: 2.39:1`. The app's History lists it as "Change letterbox".
- Not in slice 1: no UI control (slice 4); `inspect.point` and review text checks still use the whole frame; image projects are not refused, and their export and preview draw the same bars, but nothing is promised there yet.

## Consequences

- A timeline file with `letterbox` cannot be opened by a version before protocol 130 (strict schema), like any new field.
- Captions keep their place: a style that puts them low reads over the bottom bar. Review (#457) and `inspect.point` should learn the letterboxed rectangle (slice 4).
- Grain (slice 3) costs about 1 ms per frame per grained piece and a looped plate of about 32 MB (half-res 1080p, 64 frames) per piece; a shared plate per (seed, size) or a cap is that slice's to decide. Not measured at 4K.
- Nothing here changes the clip render cache, `RECIPE_VERSION` or `CACHE_LAYOUT_VERSION`: finishing is compositor work.

## Considered options

- **A. Everything per clip, as the ticket said.** Rejected: a seeded `noise` is not frame-addressable, ffmpeg's `vignette` cannot carry radius and softness, and a per-clip letterbox is ill-defined (bars belong to the frame).
- **C. One timeline-level finish pass** for all three. Rejected: grain could not be left off a screen recording or a title, against the skill rule and ADR 0031's per-part placement.
