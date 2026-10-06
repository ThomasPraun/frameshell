---
name: hyperframes
description: Write HyperFrames HTML compositions and place them on the Frameshell timeline as `hyperframes` clips (titles, lower thirds, animated overlays). Use when a video needs generated graphics over or between footage.
---

# HyperFrames clips

A `hyperframes` clip is an HTML page rendered headlessly to VP9 WebM with alpha, then layered over the footage below it. The daemon renders it in the background and caches the result; preview shows a progress placeholder until the render is ready.

## Steps

1. Scaffold: `frameshell hyperframes new <name> [--duration <s>]` writes `compositions/hyperframes/<name>/index.html` at the project resolution. Edit that file.
2. Add the clip on a video track above the footage:
   `frameshell clip add <track> --type hyperframes --source compositions/hyperframes/<name>/index.html --start <s> --duration <s> [--props '{"title":"Launch"}']`
3. Wait for the render: `clip.renders` (MCP `clip_renders`) until the clip's `state` is `ready`. `failed` carries the render error in `error`: fix the composition and check again. A 1440p clip renders at about 3x its real length.
4. Check the result with `frame_capture` / `frameshell frame --at <s>` at a time the clip covers.

Done = every hyperframes clip is `ready` and a captured frame shows it where intended.

## Composition rules

- One directory per composition. Every file in it counts: editing any file re-renders every clip using it; unchanged clips reuse the cache. Keep images, fonts and scripts (e.g. `gsap.min.js`) inside the directory so the render is offline and reproducible.
- The root element carries `data-composition-id`, `data-width`, `data-height` (the project resolution, from `frameshell.json`) and `data-duration` (seconds). The render is exactly that size and length.
- Timed elements carry `data-start`, `data-duration` and `data-track-index`. Animate with CSS animations or a paused GSAP timeline registered as `window.__timelines["<composition id>"]`; HyperFrames drives the clock, so wall time never applies.
- Transparency: leave `html`, `body` and the root unpainted; the footage shows through. Backgrounds on inner elements (cards, panels) are kept, including partial alpha.
- Props are composition variables: declare each one with its default as an array on the root, `<html data-composition-variables='[{"id":"title","type":"string","label":"Title","default":"Title"}]'>` (`type`: `string`, `number`, `color`, `boolean`, `enum`, `font` or `image`), and read them with `window.__hyperframes.getVariables()`: the clip's `props` merged over the defaults. An object (`'{"title":"Title"}'`) is not a declaration; the render fails with the array to use instead. Changing `props` (`frameshell clip set <clip> --props …`) re-renders that clip only.
- Clip `in` is composition seconds shown at the clip's start; `duration` is how long it plays. Moving, trimming or changing `transform` (`--x --y --scale --opacity`) never re-renders.

## Export

`frameshell render` waits for pending renders and overlays each one with its alpha. Generated clips may sit on the first video track (over black) or on any track above it.
