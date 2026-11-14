---
status: accepted
---

# Motion blur of generated clips by sub-frame accumulation, fixed 8 samples

Motion blur for motion graphics ([#501](https://github.com/ThomasPraun/frameshell/issues/501), epic #451), split out of ADR 0033 by its decision 7. The owner chose option A of the proposal on #501 with every recommendation on 2026-11-11, after a cost spike, and on 2026-11-14 a fixed sample count of 8 over the producer's adaptive mode. The spike and the cause of the repeatability problem it found are in [`docs/research/motion-blur.md`](../research/motion-blur.md). SPEC decision 46. **Slices 0, 1, 2, 4, 5 and 6 are built; slice 3 (two cached variants) is not.**

## Context (verified)

- A generated clip renders once per cache key (ADR 0002); preview and export both play that file. The key (`clipCacheKey`, SPEC §6.5) holds the plugin, type, source, props, `elements` (left out when empty, ADR 0021), the style sheet hash (ADR 0028), the hashed inputs and the format.
- `@hyperframes/producer` and `@hyperframes/engine` 0.9.30 (Apache-2.0, already pinned) ship sub-frame accumulation: `motionBlur { samplesPerFrame, shutterAngle, shutterPhase, blend }`. For each output frame the page is seeked to sample times on an integer grid of 4096 ticks per frame and the captures are averaged, premultiplied (alpha kept), in sRGB or linear light. Without `samplesPerFrame` it is adaptive: 2 probes, then 16, 32 or 64 samples. It refuses the `hdr_layered` capture route (HDR content, shader transitions) with an error starting `[MotionBlur]`. A separate page-side blur (`data-motion-blur` on the composition) is turned off with `pageMotionBlur: "off"`.
- The motion runtime (ADR 0033) paints any time, sub-frame times included, as a pure function of `t`.
- Spike, on the `motion-real` fixtures: adaptive costs 21x to 27x the screenshot time of a sharp frame and does not skip still frames (static-frame dedup needs GSAP tweens, a seek-only page is never eligible); fixed 8 costs 7.4x to 8.1x; linear and sRGB blends cost the same; the sprung element plus element CSS blurs as expected. Every Frameshell clip render is alpha WebM, which forces screenshot capture, so Linux `beginframe` never applies.
- Fixed-8 renders were not byte-repeatable with motion runtime 0.2.0. The cause was Chrome's repaint threshold and partial raster, made visible by the producer's uncaptured seeks; motion runtime 0.3.0 (#605, ADR 0033 "Settled in #501") writes poses on a grid Chrome always repaints and re-rasters the page on every seek. Since then repeated blurred renders are byte-identical, PNG and WebM.

## Decision

1. **The producer's sub-frame accumulation**, not our own capture or a render at k×fps blended by ffmpeg. One capture pipeline (ADR 0002, 0033).
2. **A clip field, `motionBlur`, on generated clips** (`AdapterClipSchema`, beside `elements`): `{ shutter?, samples?, blend? }`. Not in `props` (page variables) and not a composition attribute (that name is HyperFrames' own page blur). `{}` is on with the defaults; absent is off. `clip.set` merges it field by field, `null` clears; it is shared by every format (refused with `format`), and refused on media and nested clips and on shots.
3. **Fixed 8 samples per frame**, not adaptive: adaptive is over the ~20x bound and gives a still frame 16 samples. `samples` 1 to 64 stays settable; there is no adaptive setting.
4. **Shutter 180°, centred** (`shutter` 1 to 360 degrees of one frame; the producer's phase is `-shutter / 2`). Capping at 360 keeps every sample within half a frame of its frame instant, which the cut guard relies on.
5. **Blend in linear light** by default; `blend: "srgb"` gives the After Effects look.
6. **A capability, not a guess.** `ClipAdapter.motionBlur: true` says an adapter applies `RenderContext.motionBlur` (`{ shutter, samples, blend }`, defaults filled in). Both are optional, so the plugin API stays "1". Only for such an adapter does the host pass the blur and count it in the key; clips of other adapters render sharp, and `clip.set` stores the field with a warning saying so.
7. **In the cache key, resolved, only when present.** The key holds the settings with defaults filled in, so `{}` and `{ shutter: 180, samples: 8, blend: "linear" }` give one key, and changing a default later re-renders. Without blur the key is the recipe's as before, so existing keys and `CACHE_LAYOUT_VERSION` (1) are unchanged.
8. **HyperFrames mapping.** The adapter declares the capability and passes `motionBlur { samplesPerFrame, shutterAngle, shutterPhase: -shutter/2, blend }` and `pageMotionBlur: "off"` only when the clip has blur, so authors' page attributes on other clips are left alone. A producer refusal becomes an error that names the clip and says to clear the blur.
9. **No blur across a cut.** Cuts between timeline clips need nothing: each clip renders on its own. Inside one composition, `@frameshell/motion` gets `cuts(seconds[], fps?)`, a time guard (`bind(id, (t) => paint(guard(t)))`): a sample on the other side of a declared cut from its frame instant (`round(t·fps)`) is clamped to the cut, so the frame before a cut shows the outgoing scene up to its last instant and the frame on the cut only the new scene. The fps comes from `<meta name="frameshell-fps">`, which the adapter writes into a blurred render's entry; without it (live preview, sharp renders) the guard passes every time unchanged, and frame times always pass. Motion runtime 0.4.0. GSAP or CSS compositions get a skill rule instead: no hard cut inside a blurred composition, or split it into clips.
10. **Repeatable by construction.** The sample times are an integer grid; a page painted by motion runtime 0.3.0 or later is the same picture whatever was painted before. A real test renders the same blurred clip twice and requires identical decoded frames. A composition not painted by the motion runtime can still hit Chrome's repaint threshold; the plugin skill says how to avoid it. The sequential probe for `clip verify` is not decided; `clip verify` is unchanged.
11. **Two variants (decided, slice 3, not built).** A clip whose final is expensive keeps two cached entries: the sharp one first (live preview, `export --quality draft`), the blurred one after it (the preview swaps it in when ready; final and untiered exports wait for it). A producer refusal then exports the sharp render with a warning. Until slice 3, a clip with blur has one entry, the blurred one, which preview and every export wait for, and a refusal fails the render.

## Consequences

- **Cost:** a blurred clip renders about `samples` times as long as a sharp one (8x by default; about 30 ms per sample on flat colour at any size, more for images, text and 3D). Until slice 3 the preview waits for it too.
- **Wire:** `clip.set` takes `motionBlur`: `PROTOCOL_VERSION` bump. The CLI has `clip set --motion-blur`, `--motion-blur-shutter`, `--motion-blur-samples`, `--motion-blur-blend` and `--clear-motion-blur`; MCP `clip_set` follows from the registry; the skill says when to use it.
- **Schema:** optional field, JSON Schema regenerated; files without it are unchanged.
- **Coupling:** `motionBlur` and `pageMotionBlur` are producer options outside its documented surface; the opt-in `motion-real` test renders with blur and must pass on every HyperFrames bump.
- **Compositions scaffolded earlier** keep their frozen runtime copy and get `cuts()` through `frameshell hyperframes update`.
- **Remotion and Blender** adapters do not declare the capability: their clips stay sharp with a warning until they do (Blender has its own blur, ADR 0035).
- **3D** (ADR 0042 decision 13): a 3D template with blur is capped at 8 samples with a warning, in ADR 0042's slice 5.

## Slices

0. Spike and numbers (done, `docs/research/motion-blur.md`; cause fixed in motion runtime 0.3.0, #605).
1. Schema field, cache key, plugin-API capability (done).
2. HyperFrames adapter mapping and an opt-in real test (done: blur widens the fast spring, the rest pose stays).
3. ClipRenderer variants: sharp first, then blurred; status per variant, `gc` keeps both, `ensure(…, tier)`, export tiers, preview swap, refusal falls back to sharp with a warning.
4. `cuts()` in `packages/motion`, `pnpm gen:motion` (done, runtime 0.4.0; a real test shows the frame on a declared cut has no trace of the scene before it).
5. `clip.set motionBlur`, engine op and inverse, CLI, skill (done).
6. Determinism: the same blurred clip rendered twice gives identical frames (done, opt-in real test). A blurred-render probe in `clip verify` waits for the owner's decision on the sequential probe.
