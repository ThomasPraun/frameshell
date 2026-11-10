---
name: hyperframes
description: Write HyperFrames HTML compositions and place them on the Frameshell timeline as `hyperframes` clips (titles, lower thirds, animated overlays). Use when a video needs generated graphics over or between footage.
---

# HyperFrames clips

A `hyperframes` clip is an HTML page rendered headlessly to VP9 WebM with alpha, then layered over the footage below it. The daemon renders it in the background and caches the result. Until the render is ready, the human's preview plays the page itself, live at the playhead and labelled "Live". It does so when the clip is the topmost picture; otherwise the preview shows a progress slate. The render, not the live page, is what export uses.

## Steps

1. Scaffold: `frameshell hyperframes new <name> [--duration <s>]` writes `compositions/hyperframes/<name>/index.html` at the project resolution. Edit that file.
2. Check it: `frameshell hyperframes check [<composition>]` (see [Check](#check)). Run it after every edit of a composition and before you wait for a render: a lint error found here costs a second, the same mistake found by a failed render costs minutes.
3. Add the clip on a video track above the footage:
   `frameshell clip add <track> --type hyperframes --source compositions/hyperframes/<name>/index.html --start <s> --duration <s> [--props '{"title":"Launch"}']`
4. Wait for the render: `clip.renders` (MCP `clip_renders`) until the clip's `state` is `ready`. `failed` carries the render error in `error`: fix the composition, run `check` again. A 1440p clip renders in about 2x its real length.
5. Check the result with `frame_capture` / `frameshell frame --at <s>` at a time the clip covers.

Done = `check` passes, every hyperframes clip is `ready` and a captured frame shows it where intended.

## Check

`frameshell hyperframes check [<composition>] [--strict] [--json]` lints compositions in the daemon, offline, with the HyperFrames linter (`@hyperframes/lint`) plus the seek-safety rules below. `<composition>` is a name from `hyperframes new` (`intro`), a composition directory, or an HTML entry such as `compositions/hyperframes/intro/index.html`; with none it checks every `compositions/hyperframes/<name>/index.html` (pass the path for a clip `source` kept elsewhere).

- Each finding is `file:line:column  severity  rule  message`, with a `fix:` line. `--json` returns `{ output, data, failed }`: `data.findings` per composition carry `file`, `line`, `column`, `rule`, `severity`, `message`, `fix`.
- Errors block: exit 1 (`failed: true`). Warnings do not, unless you run `check --strict`. Fix every error; read each warning and fix it unless you meant it.
- Use `check`, never `npx hyperframes`: the HyperFrames CLI renders and previews on its own, outside Frameshell's cache, ffmpeg and Chrome.

## Authoring rules

These are the rules that make a composition render the same on every frame and every worker. They follow the guidance of HyperFrames (Apache-2.0, github.com/heygen-com/hyperframes) in our own words; `check` enforces most of them.

- **One root.** The entry is one `index.html` with one `data-composition-id` root. Further scenes live in their own files, each wrapped in a `<template>`, and the root mounts them with `data-composition-src`. A file with timed content outside a `<template>` is a second root.
- **No selectors built from template literals.** `` gsap.to(`#${id}`, …) `` and the like hide the target from the checker and from the Pick tool: write the selector out, one tween per target (or a plain loop over a literal array).
- **Never animate layout.** `margin`, `padding`, `width`, `height`, `top` and `left` snap to whole pixels and stutter under a frame-by-frame seek. Animate `x`, `y`, `scale`, `rotation` and `opacity`.
- **Fonts are local.** (The `hyperframes new` scaffold uses a system font stack as a placeholder: replace it.) Declare each family with `@font-face` pointing at a file inside the composition directory. A system or web font changes between machines and between the live page and the render.
- **`fromTo` over a CSS start state.** Do not set a start transform in CSS and then tween to the end: a seek to the middle reads the CSS, not the tween. Write both ends in the tween: `tl.fromTo(el, { y: 40, opacity: 0 }, { y: 0, opacity: 1 }, 0)`.
- **No CSS `transition`, no `requestAnimationFrame`, no wall time.** The clock is HyperFrames', not the browser's.

### GSAP is sought, not played

The render and the live page set the paused timeline to a time (`tl.totalTime(t)`) instead of playing it. Write timelines that give the right frame wherever they are set:

1. One timeline, tweens placed with position parameters (`"<"`, `"<0.2"`, `"label+=0.3"`). No `delay` chains.
2. No ScrollTrigger: a clip does not scroll.
3. Stacked `from` / `fromTo` tweens on one property need `immediateRender: false` on the later ones, or a seek shows the wrong first frame.
4. Function-based values are evaluated at the first render, and each render worker starts fresh: never `Math.random()` or `gsap.utils.random()` (not even `gsap.utils.random(min, max, snap, true)`, which only returns a generator; the linter blocks all of them). Use fixed values, a hash of the element index, or a small seeded PRNG such as mulberry32 with a constant seed.
5. Never `repeat: -1`: give a finite repeat or an explicit duration.
6. No `onComplete`, `onUpdate`, `onStart` or DOM-reading callbacks: put the change in a tween.
7. Relative values (`"+=20"`) and `overwrite: "auto"` read state at the first render: prefer absolute values or `fromTo`.

Two judgement checks the linter cannot make: do not tween more than a third of the animated elements at once, and give a tween that travels more than a third of the frame an intermediate key so the motion reads.

## Composition rules

- One directory per composition. Every file in it counts: editing any file re-renders every clip using it; unchanged clips reuse the cache. Keep images, fonts and scripts (e.g. `gsap.min.js`) inside the directory so the render is offline and reproducible.
- The root element carries `data-composition-id`, `data-width`, `data-height` (the project resolution, from `frameshell.json`) and `data-duration` (seconds). The render is exactly that size and length.
- Timed elements carry `data-start`, `data-duration` and `data-track-index`. Animate with CSS animations or a paused GSAP timeline registered as `window.__timelines["<composition id>"]`; HyperFrames drives the clock, so wall time never applies. A composition with no GSAP timeline (CSS animations only, as the scaffold) carries `data-no-timeline` on its root; without it every render first waits 45 s for a timeline that never comes.
- Transparency: leave `html`, `body` and the root unpainted; the footage shows through. Backgrounds on inner elements (cards, panels) are kept, including partial alpha.
- Props are composition variables: declare each one with its default as an array on the root, `<html data-composition-variables='[{"id":"title","type":"string","label":"Title","default":"Title"}]'>` (`type`: `string`, `number`, `color`, `boolean`, `enum`, `font` or `image`), and read them with `window.__hyperframes.getVariables()`: the clip's `props` merged over the defaults. An object (`'{"title":"Title"}'`) is not a declaration; the render fails with the array to use instead. Changing `props` (`frameshell clip set <clip> --props …`) re-renders that clip only.
- Live preview serves the composition directory as it is, so the rules above also make the live page work: files inside the directory, a `[data-composition-id]` root, and no wall-clock animation. It runs in a sandboxed frame without `localStorage` or cookies. Fonts and timing can differ slightly from the render: judge the result with `frame_capture` once the clip is `ready`.
- The human can point at an element with the Pick tool: its `[frameshell] point` line names the element's selector and, when it lives in a `data-composition-src` sub-composition, that file (`in …`). `(created by a script)` means its id, classes and text are nowhere in that file: edit the script that builds it (GSAP, bindings), not the markup. Stable `id`s on elements you will want to change make picks easy to act on.
- Clip `in` is composition seconds shown at the clip's start; `duration` is how long it plays. Moving, trimming or changing `transform` (`--x --y --scale --opacity`) never re-renders.

## Export

`frameshell render` waits for pending renders and overlays each one with its alpha. Generated clips may sit on the first video track (over black) or on any track above it.
