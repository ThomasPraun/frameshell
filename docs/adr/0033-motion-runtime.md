---
status: accepted
---

# Motion runtime: seek(t) springs on the HyperFrames clock, templates as scaffolded compositions

Motion clips whose picture is a pure function of time ([#465](https://github.com/ThomasPraun/frameshell/issues/465)) and brand-aware templates built on them ([#466](https://github.com/ThomasPraun/frameshell/issues/466)), part of #451. Decided by the owner on 2026-11-10: option B of the proposal on #465, with all its recommendations. The binding spike is in [`docs/research/motion-runtime.md`](../research/motion-runtime.md).

## Context (verified in the tree)

- **Adapters (ADR 0002, 0010).** A clip adapter renders one file that preview and export both play, so parity holds for any adapter. Live preview is the only second path: it loads the composition page with `window.frameshellLive.seek(seconds)`.
- **HyperFrames adapter.** `plugins/hyperframes/src/adapter.ts` renders in-process with `@hyperframes/producer` 0.9.30 (#479, PR #492) and the managed ffmpeg and Chrome. Every file of the composition directory is a cache input. Size comes from the composition's `data-width` and `data-height`. `plugins/hyperframes/src/scaffold.ts` (`hyperframes new`) writes one CSS-animated template, and its stage carries `data-no-timeline`.
- **HyperFrames page runtime.** It drives the root timeline registered in `window.__timelines[<composition id>]`, and on every seek it dispatches an undocumented `hf-seek` event.
- **Element mode (ADR 0021).** It writes `translate` and `scale` with `!important`. These compose with an animated `transform`, so a runtime that writes only a 2D `transform` and `opacity` keeps element mode working. Pick (ADR 0011) needs a DOM page, so a canvas-only engine would lose Pick and element mode.
- **Keyframe eases (ADR 0018).** `easeFraction` in `packages/schema/src/composite.ts` places whole clips: `in` is f², `out` is f(2−f), and `in-out` is f²(3−2f), a cubic smoothstep (not quadratic). That is clip-level placement, not motion inside a composition.
- **Motion personalities (ADR 0028, PR #497).** They carry a spring as `{ response, damping }` and an ease as cubic-bezier control points.
- **GSAP licence.** The "no charge" licence of `gsap` 3.15 prohibits use in tools that let people build visual animations without code (read 2026-11-10).

## Decision

1. **HyperFrames is the only host in v1.** The runtime is a dependency-free page script bound to the HyperFrames clock. The page stays a DOM HyperFrames composition, so render, live preview, Pick and element mode keep working. A Remotion binding (`useCurrentFrame()` → seek) comes later, only if needed.
2. **Runtime delivery: copied into each composition directory on scaffold.** The copy is frozen per clip and hashed with the composition's inputs, so a plugin upgrade never changes an existing clip's pixels. An `update` command applies runtime fixes on request.
3. **No GSAP in Frameshell templates**, because of its "Prohibited Uses" clause. The skill may still recommend GSAP for compositions the agent writes for the user.
4. **Command:** `frameshell hyperframes new --template <t>` in the plugin. No core change.
5. **One source for spring math and presets: `packages/schema`** (`src/motion.ts`), next to the motion personalities of ADR 0028. The runtime bundles it. A `spring` ease for ADR 0018 keys will use the same file later.
6. **Determinism verify is a core command** for any adapter with `livePreview` (fits #457 and #478). It probes frames cold and after a reseek, and fails above 2/255.
7. **Motion blur** gets its own ticket, after #475.
8. **`packages/motion` is a private workspace package**, bundled into the plugin. Publishing it to npm comes later.
9. **HyperFrames version:** built on #479 / PR #492 (0.9.30), not 0.8.92.

### Settled in slice 1

- **Binding.** `bind(compositionId, paint)` calls `paint(0)` at once and registers a seek-only object (`play`, `pause`, `seek`, `time`, `duration`) in `window.__timelines[compositionId]`. It must be called synchronously from the composition's script, and the stage must not carry `data-no-timeline`. Until the timeline is first driven, the `hf-seek` event paints instead. On 0.9.30 both paths render frame-exact (spike).
- **Spring model.** The spring is the closed-form step response of a damped oscillator. `response` is the period of the undamped oscillation in seconds; `damping` is the ratio ζ. Under-, critically and over-damped springs are solved analytically.
  - **Presets:** snappy {0.22 s, ζ 0.80} overshoots about 1.5 %, default {0.40, 0.86} about 0.5 %, heavy {0.50, 1.0} not at all, playful {0.50, 0.45} about 20 %.
  - **`settle(preset, eps)`** gives the lead-in time a spring needs before the next beat.
  - **`track()`** retargets by superposition: each retarget adds a step of the target change, so position and velocity stay continuous.
  - **Role eases:** enter out-quint, snap out-expo, pop out-back, camera and colour in-out-quart, exit in-expo, progress linear.
  - **`stagger`** with a 0.5 s budget, and **`durationFromDistance`**: (9 + 1.15·√px) frames at 60 fps, times a weight.
- **What the runtime writes.** `write(element, pose)` sets a 2D `transform` (translate, rotate, scale) and `opacity`, every field on every frame, with opacity clamped to 0..1. It never writes `translate`, `scale` or `rotate` (element adjustments own them), and never 3D transforms or `will-change`. Opacity and colour never spring.
- **Packaging.** `pnpm gen:motion` bundles `packages/motion` (with `@frameshell/schema/motion`) into `plugins/hyperframes/src/motion-runtime.ts` as a string, so the plugin's own files carry it (ADR 0008). A test fails when the bundle drifts from its sources.
- **Format injection.** `pick()` per format follows the formats ADR (0027), which owns the meaning of `RenderContext` width and height.

### Settled in slice 2

- **Scaffold.** `frameshell hyperframes new <name> --template <id> [--duration s]` (plugin only, no core or protocol change) writes `index.html` and a copy of `frameshell-motion.js` (frozen per clip). Without `--template` the CSS scaffold is unchanged. The first set is `kinetic-headline` and `end-card` (#466 T1); the second group adds `lower-third`, `logo-lockup`, `checklist` (ticks on a beat set by props), `comparison`, `counter` (count up or down in about a second, optional glow) and `big-word` (for a track with `behind`, ADR 0032). The UI demo group adds `cursor-click`, `cursor-drag-drop`, `cursor-marquee`, `cursor-text-select`, `app-window` (CRM, spreadsheet or inbox) and `typing-field`: the cursor is a carrier (4 to 7 % of the short side, starts outside the frame so it never fades in, arcs, an optional hesitation, a click of 0.84 in 0.1 s and back in 0.22 s) and what it clicks reacts on the click's own frame; the cursor kit (`cursor-kit.ts`) is page-script text shared by those six, kept in the template files, not in the runtime. All are in `plugins/hyperframes/src/templates/`, one file each, listed in `TEMPLATES`; a template says whether it is an `overlay` (transparent by default) and the ones meant to work alone as well as over footage carry `bg` and `backdrop` props. Glass cards belong to #462.
- **Typed props.** A template declares its props as HyperFrames composition variables: numbers with `min` and `max`, `#rrggbb` colours, an image path inside the composition directory, enums. The runtime's `props()` resolves them against `getVariables()` and clamps or falls back to the default, so a wrong `clip set --props` never breaks the picture.
- **Layout per format.** The runtime reads the root's `data-width` and `data-height` (`stage()`), classes the frame by aspect ratio (wide above 1.2, tall below 0.9, else square: 4:5 is tall) and `pick(wide, square, tall)` chooses. A template sizes text as a fraction of the short side and places it with fractions of the frame, so the four built-in formats read correctly (checked in managed Chrome at 16:9, 1:1, 4:5 and 9:16). The scaffold is written at the project resolution; per-format render sizes stay slice 4.
- **Brand tokens at scaffold time.** The plugin reads `style.json` leniently (colours `bg`, `ink`, `ink2`, `accent`, `card`; fonts `display` and `ui`; brand `product`, `cta`, `url`) and writes them as the defaults of the props. It does not import the schema package, since a plugin ships only its own files, and core owns validation. A style font file under `assets/fonts/` is copied into the composition and declared with `@font-face`. Later edits of `style.json` do not reach a scaffolded composition; that is the injection of slice 4. The personality's spring does not feed templates yet: they use the presets by role.
- **`update`.** `frameshell hyperframes update [<composition>] [--dry-run] [--force]` replaces a frozen copy whose header names an older version. An edited copy of the same version, a newer one or a file without the Frameshell header is kept unless `--force`.
- **Raster of near-1 scales.** Chrome keeps the earlier raster of a layer for a scale within about 0.6 % of 1, so the same time painted a pixel differently depending on the seek order (found by the real-Chrome cold-vs-reseek test). The UI demo templates write every scale through `put()`, which writes such a scale as exactly 1; a template author who scales a filled shape with a tail near 1 (a spring) needs the same.
- **Runtime 0.2.0.** Adds `pick`, `stage`, `props`, `resolveProps` and `formatClass`. `bind` also writes `window.__timelines ??= {}` literally, because `@hyperframes/lint` looks for that text in a composition's scripts (`missing_timeline_registry`); templates pass `hyperframes check --strict` clean.
- **Structure.** A template's wrapper is not a timed element (no `data-start`), so the linter does not ask for sub-compositions; the root carries the duration.

### Settled in slice 3

- **`clip.verify`.** A core method (daemon, CLI `frameshell clip verify <clip> [--probes n] [--tolerance 0-255]`, MCP `clip_verify`), for any adapter with a `livePreview`; the page is the live page `clip.live` returns, so the check needs no change in an adapter. Params: `timeline`, `clip` (flattened id as `clip.renders` reports), `probes` (default 12, 2 to 48), `tolerance` (default 2, of 255 per channel). It reads only: no render, no file, no job.
- **What a probe is.** `probes` composition times at `in + (i + 0.37) x duration / probes`, 3 decimals. Cold: a fresh page per probe seeks straight to the time and is captured. Reseek: one page seeks to another probe (about half the list away: index `i + max(1, floor(n/2) - 1)`), then to the time, and is captured. Captures are PNGs of the page at the project resolution with a transparent background, so alpha counts; identical bytes are identical pictures, and only differing pairs are decoded (by the managed ffmpeg) and compared channel by channel.
- **What it reports.** Per probe: `at`, `reseekFrom`, `max` (largest channel difference), `pixels` (pixels over the tolerance), `ok`. Overall `ok`, `distinct` (different cold pictures), `warnings` and `worst`: the probe time with the largest difference, its first worst pixel and the element painting it (selector, tag, id, classes, text, box; the probe script of `inspect.point` run while the reseek page still shows that probe, else on a fresh page at that time when the reseek left the pixel empty). `ok: false` makes the CLI exit 1. `distinct: 1` with several probes warns that the clip never moves or the page ignores `seek`, the failure the binding spike found when a timeline is not registered.
- **Reuse.** Chrome, the page server (`inspect/live-page.ts`, shared with `inspect.point`) and the element probe are those of ADR 0011; the probe times and the 2/255 budget are those of the real-Chrome test of slice 1, which now runs through `ClipVerifier` (`plugins/hyperframes/test/motion-real.test.ts`, opt-in) and passes on the motion runtime.
- **Not covered.** Frames that straddle a scene handoff (the adapter knows the handoffs, the daemon does not), and the cached render itself: the check is of the live page, and the render of a HyperFrames clip paints through the same page script.

### Slices

1. Spike, pure math in `packages/schema`, `packages/motion` with `bind` and `write`, the bundle in the plugin, and an opt-in real render test (12 probes cold vs reseek, element CSS on a sprung element).
2. Templates, `hyperframes new --template`, and `update` (done: two templates of the #466 first set; the rest of that set follows as more template files).
3. Core determinism verify (done: `clip.verify`).
4. Format injection and style tokens into compositions.

## Consequences

- **Unchanged:** schema files and JSON Schema (motion clips are `type: hyperframes`), protocol (no `PROTOCOL_VERSION` bump in slice 1; slice 3 adds `clip.verify`), plugin API (`apiVersion` "1"), cache layout (the runtime copy is an ordinary input file).
- **Coupling to HyperFrames internals.** The binding relies on the `__timelines` duck typing (`play`, `pause`, `seek`) and on `hf-seek`. `plugins/hyperframes/test/motion-real.test.ts` must pass on every HyperFrames bump; a break freezes motion compositions on frame 0.
- **Slow fixes.** A frozen runtime copy fixes an old clip only through `update`.
- **Authoring rules (in the plugin skill since slice 2):** no CSS transitions, timers, `requestAnimationFrame`, `Date` or unseeded random; no `will-change`, `translate3d` or 3D transforms; never the `translate`, `scale` or `rotate` properties; fonts and images ready before frame 0.
- **Personalities.** The springs in `MOTION_PERSONALITIES` (ADR 0028) point at `SPRING_PRESETS` and its eases at `EASE_CURVES`, so the numbers have one source. `energetic` (response 0.22, damping 0.45) has no preset and stays inline.
- **Unblocks** #466 (templates), #453 (motion-film playbook), the `pick` part of #469, #458 (beats as runtime input) and #468 (tokens read by templates).
