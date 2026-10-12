---
status: accepted
---

# Pick and inspect: point at a pixel, the agent gets the clip and the element

SPEC decisions 20 and 21, §7b, §10; extends ADR 0010. A composed video often has footage at the bottom and generated clips (HyperFrames HTML, Remotion React) above it. Today the user can drag a region on the paused preview and press Cmd/Ctrl+L. The agent then gets normalized corners, a time and a PNG, and must guess which clip, and which part of its composition, the user means. With this decision the user pauses, clicks the title they mean, and the agent gets the clip stack under that pixel and the DOM element inside the generated clip ("`#scene-2 > .card > h1` in `overlays/intro.html`"). "Make this box blue" then needs no follow-up question. The agent can ask the same question itself, from the CLI or MCP, without the app.

## Context (verified in the tree)

- **Click on the paused preview** selects the topmost clip by its box (`layerAt` in `renderer/src/preview/transform-edit.ts`). A transparent full-frame overlay therefore hides the footage below it. A generated span has a `size` only once its render is ready, so a clip still rendering cannot be clicked at all.
- **Region tool:** the "Select region" transport button. A drag selects `SelectedRegion` (`selection.ts`: normalized corners plus `at`); a drag under 1 % counts as a click and selects nothing.
- **Region reference:** `[frameshell] region (x0,y0)–(x1,y1) @ <time> · frame <png>` (`ask/reference.ts`). It names no clip. Before typing, `composeReference` awaits `captureContextFrame`. The daemon `frame` method waits for every generated clip's render (`clips.ensure`), so Ask agent blocks while any render runs.
- **Live pages (ADR 0010):** the host bridge `LIVE_BRIDGE` (`main/live-protocol.ts`) is the app's code, inserted after the adapter's `head` for every adapter. It accepts only `{ seek }` from the parent. A page exists only for the topmost clip whose render is `queued` or `rendering`, and only one at a time. Once the render is ready nothing loads it. The iframe has an opaque origin, so the renderer can reach its DOM only through `postMessage`.
- **What each page is:**
  - **HyperFrames:** the project's own entry HTML. The runtime inlines `[data-composition-src]` sub-compositions, and scripts (GSAP, variable bindings) change the DOM at run time.
  - **Remotion:** the adapter's bundle of the user's entry (ADR 0009), built with `environment: "production"`. React therefore has no `_debugSource`, which React 19 removed anyway. The bundle is not minified, so component function names survive and the fiber chain on a DOM node (`__reactFiber$…`) yields `Video > Scene2 > Card > Title`.
- **Per-pixel alpha** is known only to the preview engine worker, which keeps each layer's alpha plane per frame. The engine protocol has no pixel query.
- **`ui_state`** publishes clips, words, range and history. SPEC §10 says it also exposes the selection's region, but it does not.
- **Daemon and Chrome:** the daemon already ensures `chrome-headless-shell` (Remotion's `livePreview` launches it for `selectComposition`). Core has no Chrome driver dependency, and no daemon method evaluates a composition's DOM.
- **`gc`** (`packages/core/src/gc.ts`) never sweeps `.frameshell/context/`, so captures pile up.

## Decision

**1. Hit stack.** A pure function returns every layer under a point at a time, topmost first: `layersAt(program, at, point)` beside `layerAt`, on the same `layerBox` placement as export (`composite.ts`). Nested clips appear as `<nested>/<clip>`. Each layer is marked as painting that pixel or not:
- For a media clip with alpha, the engine answers a new `alphaAt` request for that layer and frame. Media without alpha paints its whole box.
- For a generated clip, the element probe (point 3) answers: no visible element there means transparent.
- The **target** is the first layer that paints the pixel.
- Plain clicks use the same stack, so a click goes through transparent overlay areas and can select a clip that is still rendering.

**2. Pick tool.** It replaces the "Select region" transport button, with the shortcut `I`. Activating it pauses playback.
- **Hover:** the element under the cursor is outlined, with a label (tag, short selector, clip), as in a browser inspector. The outline is drawn by the app from the box the probe returns; nothing is drawn inside the page.
- **↑ / ↓:** move the highlight to the parent or back to the child.
- **Click:** picks the highlighted element (or, over footage, the target clip).
- **Drag:** selects a region, as today.
- **Shift+click:** adds to the pick, keeping each item's own time, so items from several moments share one reference.
- **Escape:** clears the pick; pressing `I` again leaves the tool.

The selection store gains `points: SelectedPoint[]`, where each point holds `{ x, y, at, stack, element }`. They are shared like every other selection kind.

**3. Element probe.** The host bridge gains one request, `{ source: "frameshell-preview", probe: { id, x, y, depth } }`, with x and y in project pixels (the frame is laid out at project resolution). The reply is `{ source: "frameshell-live", probe: { id, elements } }`. The bridge runs `document.elementsFromPoint`, skips hidden and fully transparent elements, and returns for the hit (and up to `depth` ancestors for ↑):
- **selector:** the full path from the composition root, plus `id` and `data-*` attributes.
- **text:** shortened.
- **element facts:** tag, classes and the box in project pixels.
- **computed styles:** background, color, font family, size and weight, opacity, border, border-radius.
- **HTML:** an outer HTML snippet, capped at 2 KB.
- **`generated`:** true when no source file in the page's root contains the element's `id`, classes or text, so a script created it. The page is not given file access: the app checks the source files after the probe.

The probe is generic: the app still knows neither HyperFrames nor Remotion.

**4. Adapter enrichment (plugin API, additive, `apiVersion` stays `"1"`).** `window.frameshellLive` may define `describe(element): Record<string, unknown>`. The bridge merges its result into the element under `adapter`.
- **HyperFrames** returns `{ source }`: the nearest `[data-composition-src]` host's file, else the entry.
- **Remotion** returns `{ components }`: the fiber chain of named components, outermost first.

There is no file:line for React for now. The hook leaves room for source maps later.

**5. Pages on demand.** While Pick is active, the app requests live pages for the generated clips under the cursor, even when their render is ready. They are mounted invisibly (opacity 0, above the canvas) and seeked to the paused time, only to answer probes. At most 4 pick pages stay open, least recently used dropped first, and all are dropped on leaving Pick or changing frame. The visible preview is unchanged: a ready render still shows the render. Pages run only in trusted projects (ADR 0010). In an untrusted project Pick gives the clip stack alone, and the reference says `elements unavailable: untrusted project`.

**6. Reference.** A point line:

```
[frameshell] point (0.71,0.14) @ 00:01:05.20 · clip c_0100 hyperframes overlays/intro.html · element #scene-2 > .card > h1 "Nuevo lanzamiento" · under c_0002 media · details .frameshell/context/e_1956_1.json · frame .frameshell/context/f_1956.png
```

- **Clip and element:** `clip` is the target. `element` carries a short selector, the quoted text and, for Remotion, `react Video > Scene2 > Card > Title`. `under` lists the rest of the stack.
- **Details file:** `details` points to the JSON with the full stack and every element fact, named `e_<frame>_<n>.json`, where `n` is the item's place in the pick.
- **Region line:** gains `clips …` (every clip intersecting it) and up to 10 visible elements mostly inside it, in its details file.
- **No blocking:** Ask agent types at once. The frame capture runs only when every generated clip at that time has a ready render; otherwise the line says `frame pending`, and the agent can call `frame_capture` later.

**7. Agent side.**
- **Daemon method `inspect.point`** `{ cwd, timeline, at, x, y }` (normalized x and y) returns the same stack and elements as the details JSON. For generated clips it loads the clip's live page in managed `chrome-headless-shell` and runs the same probe script as the app's bridge (one source file in `@frameshell/protocol`, injected in both places).
  - **Chrome driver:** the Chrome DevTools Protocol over `--remote-debugging-pipe`, with a small client in core and no new dependency.
  - **Serving the page:** CDP `Fetch` interception, with the same containment as `frameshell-live:` and no open port.
  - **Trust:** same rule as the app. Untrusted means stack only.
- **CLI:** `frameshell inspect --at <time> --point x,y` (or `--px X,Y`), with `--json`.
- **MCP tool:** `inspect_point`.
- **`ui_state`:** `selection` gains `region` and `points`, closing the gap with SPEC §10.
- **`ui_select`:** accepts `points`, so the agent can highlight what it understood ("is this the box?"). That is navigation, not a pixel click: SPEC §7b's rule stands.

**8. Cleanup.** `gc` (and the sweep on open) deletes files in `.frameshell/context/` older than 7 days.

## Implementation notes

Found while building the parts; the decision above stands.

- **Part 2 (2026-10-11):**
  - Pick pages are kept while the tool is on and seeked again for a new frame, not dropped on every frame change: a probe waits for the seek it needs.
  - The live page URL of a clip is asked of main once per clip and render identity, shared by the live preview and the Pick tool: main revokes a clip's previous URL when asked again.
  - Where no element paints, a page whose `body` or `html` has a background is the hit (`body`/`html`): that is the composition's own background, not the layer below.
  - The probe script lives in `@frameshell/protocol/probe` (browser-safe subpath): the app's bridge injects it now, the daemon's `inspect.point` will.
  - The renderer may not write under `.frameshell/`, so details files go through a new internal daemon method, `context.write` (`PROTOCOL_VERSION` 31).
  - `generated` (element absent from the source files) moves to part 3 with the adapters' source facts.
- **Part 3 (2026-10-11):**
  - `generated` is decided in the app against the file the adapter names (`source`): HyperFrames elements only, since a Remotion element's source file is unknown. True only when the element's id, classes and leading text all miss that file; unknown (absent) when there is nothing to look for.
  - Remotion `components` keep Remotion's own components (`Sequence`, `AbsoluteFill`): the composition's components cannot be told from them in a production bundle. At most 8, innermost kept.
  - The point line adds `in <file>` when the element comes from another file than the clip's source.
- **Part 4 (2026-10-12):**
  - `inspect.point` places clips with the export geometry (`layerRect`) but cannot read footage alpha without decoding: footage and stills paint their whole box (at 5 % opacity or more). The app's picks keep the engine's alpha.
  - It takes `unit: "fraction" | "pixel"`, so the CLI's `--px` and MCP callers need no project resolution of their own.
  - The page is served from a reserved origin (`http://frameshell-inspect.invalid`) through CDP `Fetch` interception, with the same root containment as `frameshell-live:`; other origins reach the network, as for renders. The live page is asked for before Chrome starts, so an untrusted project never starts it.
  - `ui.select` points are inspected in the daemon and sent to the app resolved: the app shows them without probing pages itself.
  - `markGenerated` moved to `@frameshell/protocol/probe`, so the app and the daemon decide `generated` alike.

## Considered options

- **The HyperFrames runtime's own picker** (`__HF_PICKER_API`, `enable-pick-mode`). It would be free for HyperFrames, but it ties the app to one adapter, which ADR 0010 avoids, and its selectors are one level deep. Rejected in favour of the generic probe.
- **Source locations for React** from a development bundle (`jsxDEV` `__source`) or from Remotion's sequence stack traces plus source maps. A second bundle per entry, or more Remotion internals to watch, for a gain the agent mostly gets by searching for the component name. Deferred; the `describe` hook can carry it later.
- **Probe only in the daemon.** One code path, but hover highlighting at headless round-trip latency is unusable. Rejected for the app; kept for the agent.
- **Always-on hover in the normal click mode.** Noisy next to the move and scale handles. Rejected: Pick is a tool.
- **Videos always opaque.** Simpler, but a render with alpha covering half the frame would capture clicks on the other half. Rejected.

## Consequences

- Live pages now also load for clips whose render is ready, while Pick is active. Each page is a full Chrome renderer, hence the cap of 4.
- Element facts describe the DOM at that moment, after scripts ran. A selector can name something no source file contains; `generated: true` tells the agent to look for the script that creates it.
- The reference no longer waits for renders, so its `frame` may be missing. The agent can always capture it with `frame_capture`.
- `.frameshell/context/` stops growing without bound.

## Implementation plan (each part ships and is tested alone)

1. **Hit stack, clips in the reference, non-blocking Ask agent, `ui_state` region, `gc` sweep.**
   - Code: `layersAt` and the engine `alphaAt`; plain clicks use the stack; the region line names its clips; `frame pending`; `ui_state.selection.region`; `gc` of `.frameshell/context/`.
   - Wire: `PROTOCOL_VERSION` bump (`ui_state` shape).
   - Tests: unit tests for `layersAt` (alpha, transparent overlay, nested, still rendering), for the reference and for `gc`; e2e for a click through a transparent overlay.
2. **Pick tool.**
   - Code: the bridge probe; pages on demand with the cap; hover outline and label; ↑/↓; Shift+click across times; details JSON; region elements; untrusted fallback.
   - Tests: bridge unit tests (probe shape, selector paths, transparency); e2e with a fixture plugin page (no Chrome needed, as in ADR 0010 slice 3).
3. **Adapter enrichment.**
   - Code: the `describe` hook in the plugin API; HyperFrames `source`; Remotion component chain.
   - Tests: unit tests per adapter; opt-in real Chrome tests as in ADR 0010.
4. **Agent side.**
   - Code: the CDP client and `inspect.point`; CLI `inspect`; MCP `inspect_point`; `ui_select` points; `ui_state.selection.points`.
   - Wire and docs: `PROTOCOL_VERSION` bump; skill updated (`pnpm gen:skill`).
   - Tests: core unit tests with a fake adapter page; an opt-in real Chrome test; skill-docs test.

Docs with the parts: SPEC decisions 20 and 21, §7b and §10, the `plugin-api` README, the agent skill's `selection.md`, `cli.md` and `mcp.md`, and the CHANGELOG. Release 0.5.0 after part 4.

## Side effects

- **Protocol:** `ui_state` and `ui_select` change shape, and a new method `inspect.point` is added, so `PROTOCOL_VERSION` bumps (parts 1 and 4). The MCP tool list grows from the registry; the skill must name `inspect` and `inspect_point`, or `skill-docs.test.ts` fails.
- **Plugin API:** additive optional `frameshellLive.describe`; existing adapters keep working.
- **Desktop:**
  - The engine protocol gains `alphaAt`.
  - The selection store gains `points`, and every consumer of `Selection` must handle the new kind: reference, ui-link, the context menu.
  - "Select region" is replaced by Pick, so e2e specs that press it must be updated.
  - Plain clicks now go through transparent areas, a visible behaviour change for anyone used to the box hit.
- **Live pages:** the bridge grows (probe) but `seek` is unchanged. Pages load in more cases (Pick), still only in trusted projects.
- **Ask agent:** no longer blocks on renders. The `frame` field becomes optional in practice, and the skill says how to get a pending one.
- **Cache:** none. `RECIPE_VERSION` and `CACHE_LAYOUT_VERSION` do not change.
