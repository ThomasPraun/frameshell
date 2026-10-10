---
name: remotion
description: Write Remotion (React) compositions and place them on the Frameshell timeline as `remotion` clips, including components imported from the user's own web app. Use when a video needs React-built scenes, UI demos, data-driven graphics or overlays over or between footage.
---

# Remotion clips

A `remotion` clip is a composition of a Remotion project, rendered headlessly to VP9 WebM with alpha and layered over the tracks below it. Frameshell bundles the project's entry with webpack, renders in the background and caches the result; preview shows a progress placeholder until the render is ready. Remotion itself comes from the Remotion project (its `node_modules`), never from Frameshell: the user's Remotion version and licence apply.

If a Remotion best-practices skill is installed, follow it for composition code. The rules below are what Frameshell adds.

## Steps

1. Get a Remotion project:
   - New: `frameshell remotion new <name> [--duration <s>]` adds `compositions/remotion/src/<Name>.tsx` at the project's size and fps. The first call also creates the project (package.json pinning Remotion, `src/index.ts`, `src/Root.tsx`); install it once with `npm install` in `compositions/remotion`. Later calls print the `<Composition>` line to add to `src/Root.tsx`.
   - Existing: any Remotion project works, inside or next to the Frameshell project. `source` is its entry (the file that calls `registerRoot`), relative to the Frameshell project, e.g. `../web/video/src/index.ts`.
2. Add the clip on a video track:
   `frameshell clip add <track> --type remotion --source compositions/remotion/src/index.ts --start <s> --duration <s> --props '{"composition":"intro","inputProps":{"title":"Launch"}}'`
   `props.composition` is a `<Composition id>`; `props.inputProps` (JSON) are merged by Remotion over its `defaultProps`. Nothing else goes in `props`.
3. Wait for the render: `clip.renders` (MCP `clip_renders`) until the clip's `state` is `ready`. `failed` carries the error (bundle errors, a missing composition with the list of ids): fix and check again. A render takes roughly 1.5-2x the composition's length at 1440p, plus a few seconds to bundle.
4. Check the result with `frame_capture` / `frameshell frame --at <s>` at a time the clip covers.

Done = every remotion clip is `ready` and a captured frame shows it where intended.

## Composition rules

- **`remotion.config.ts` applies** as with Remotion's CLI: its webpack override (Tailwind via `@remotion/tailwind-v4`, path aliases, Sass) and its OpenGL renderer. Output settings in it (codec, image format, CRF) are ignored: renders are always PNG frames to VP9 with alpha. Reading the config needs `@remotion/cli` installed in the Remotion project. Editing the config re-renders.
- **Tailwind:** install `tailwindcss` and `@remotion/tailwind-v4` (same version as `remotion`) in the Remotion project, enable it in `remotion.config.ts`, and import a CSS file with `@import "tailwindcss";` from the entry or the composition.
- **Code outside the project is fine.** Components imported from the user's web app are bundled like any other file, with the Remotion project's React. Any edit to bundled code, inside the project or not, re-renders the clips using that entry; unchanged code reuses the cache.
- **Transparency:** paint no background on the root (`<AbsoluteFill>` without `background`) and the footage below shows through, partial alpha included. A full-frame scene paints its own background.
- **Format:** Frameshell renders at the project's fps and resolution, keeping the composition's length in seconds. Same aspect ratio: rendered at the composition's size and scaled, so pixel layouts keep their proportions. Other aspect ratio: rendered at the project's size, so lay out from `useVideoConfig()` (`width`, `height`). Always time animations from `useVideoConfig().fps` (`spring({ frame, fps })`, `2 * fps` frames), never a hard-coded frame rate.
- **Length:** the render is the whole composition. Clip `in` is composition seconds shown at the clip's start; `duration` is how long it plays. Moving, trimming or changing `transform` (`--x --y --scale --opacity`) never re-renders; changing `props` re-renders that clip only.
- **Audio is dropped:** clip renders are video only. Put voice-over and music on audio tracks as media clips (`frameshell import`, then `frameshell clip add`).
- **Deterministic frames:** a frame must depend only on `useCurrentFrame()` and props. Ship images and fonts with the Remotion project (`public/` + `staticFile()`), and wait on async loading with `delayRender()` / `continueRender()`; never animate with timers, CSS transitions or `Date.now()`.

## Layers

Track order is stacking order: Remotion and HyperFrames clips can sit on any tracks above the footage and overlap freely. To move several layers as one unit, put them in a nested timeline (`type: "timeline"`) and place that.

## Export

`frameshell render` waits for pending renders and overlays each one with its alpha.
