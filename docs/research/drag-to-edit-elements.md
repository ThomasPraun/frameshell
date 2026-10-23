# Drag to edit composition elements in the preview (#291)

Spike for [#291](https://github.com/ThomasPraun/frameshell/issues/291), an ADR 0017 follow-up. Pick (ADR 0011) can already name an element inside a generated clip, such as a HyperFrames title or a Remotion logo. Moving or resizing that element still means asking the agent. This spike asks who writes a drag, how the preview follows it, and what it does to renders. It ends with a recommendation for the ADR.

Owner principle: simple for the human and the AI, optional, nothing required. The agent must be able to read and change whatever a drag writes.

## Recommendation

A **per-clip map of element adjustments in the timeline**. The host turns it into one CSS sheet, and the page applies that sheet last, both live and in the render. The source stays untouched.

```json
{ "id": "c_0100", "type": "hyperframes", "source": "compositions/hyperframes/intro/index.html",
  "elements": { "#title": { "x": 0, "y": -40, "scale": 1.2 } } }
```

- **Key:** the selector the Pick probe returns (`ProbedElement.selector`, `packages/protocol/src/probe.ts`).
- **Values:** in the composition's CSS pixels. `x`/`y` default to 0 and `scale` to 1.
- **Applied as** `translate: Xpx Ypx !important; scale: S !important`. These are the individual transform properties. They **compose with** the `transform` a composition animates (GSAP, inline styles) and do not replace it, so an animated title keeps its animation, moved by the offset.

The prototype (below) shows that this works for HyperFrames, in a render and on a live page, for elements written in the markup and for elements a script creates.

## 1. Write path

### Options

| | (a) Adapter patches the source | (b) Override map in the timeline (recommended) | (c) Override map in `props` |
|---|---|---|---|
| Element identity | Needs the element's markup. Elements a script creates (`generated: true`, ADR 0011) have none, so they cannot be patched | A CSS selector also matches elements a script creates later. The prototype moves a script-made `#gen` | as (b) |
| Animated elements | A written `transform` is overwritten each frame by GSAP or inline styles | `translate`/`scale` compose with `transform` (prototype: inline `transform` kept) | as (b) |
| Remotion | Rewriting JSX, possibly outside the project (ADR 0009): not robust | CSS sheet in the page, see below | `props` = `{ composition, inputProps }`, strictly validated (`plugins/remotion/src/adapter.ts`): an extra key is refused or leaks into the user's `inputProps` |
| Agent readability | Best: it is in the source | A short, flat field in the timeline JSON. `timeline.show`, the MCP tools and history show it | Mixed into composition variables (`window.__hfVariables`) |
| Undo, history, review mode | Composition files are outside the journal (SPEC §6.2: journal per timeline), so a drag would not be one journaled `ui` step, and review mode (ADR 0019) would not see it | `clip.set` patch, inverse for free (ADR 0004), one `ui` step per drag like `placementEdit` (`renderer/src/preview/transform-edit.ts`); diff in the History panel | as (b) |
| Cache key | Changes through `inputs()` (file hash) | Add `elements` to `clipCacheKey`. When absent it drops out of the canonical form, so **existing keys do not change** | `props` are already in the key |
| Plugin API | New write hook per adapter | Additive: optional `elementCss` on `RenderContext`/`LiveContext`, plus a capability flag | none, but every adapter must know a reserved key |

**Rejected:**
- **(a)** fails for script-made elements and for Remotion, falls outside the journal, and fights animations.
- **(c)** collides with adapter-owned `props` validation and composition variables.

### The host makes the CSS, adapters only insert it

Plugins ship as tarballs whose runtime dependencies are only their engines (`plugins/hyperframes/package.json`: `@frameshell/plugin-api` is a devDependency, ADR 0008). A shared runtime helper in `plugin-api` would therefore not reach an installed plugin. Instead, core builds the CSS once (`elementStyles(elements)`) and passes it to the adapter as `context.elementCss`. The adapter only places the string last in its page, so every adapter applies the same rules. Selectors carrying `{ } < > ;` or `/*` are refused, so a selector cannot end the rule or the `<style>` element.

### What the adapter declares

An adapter declares support with an optional flag, for example `elementStyles: true` on `ClipAdapter`. `clip.set` with `elements` on a clip whose adapter lacks the flag fails with a clear message. Without the flag, the preview would show a change that the render silently ignores. `apiVersion` stays `"1"`, as with `livePreview`, `refreshRenders` and `describe`.

### Per adapter

- **HyperFrames:** `render` already copies the composition into `outDir` before rendering (`plugins/hyperframes/src/adapter.ts`). It adds `<style data-frameshell-elements>` before `</head>` of the copied entry. The runtime inlines sub-compositions into the same document, so one sheet covers them.
- **Remotion:**
  - **Live:** easy. The live `head` already injects a `<style>` (`plugins/remotion/src/live.ts`, the transparent body).
  - **Render:** `renderMedia` takes `serveUrl: bundle.dir` and has no CSS option. The adapter can copy the bundle directory into `outDir` (or hard-link its files), add the sheet to its `index.html`, and serve that copy. This costs a few MB per render, which is small next to a 13 s render (ADR 0009). It is not prototyped.
  - **Identity:** the weak spot. Components rarely set `id` or classes, so probe selectors are positional (`div > div:nth-child(2) > h1`). A `<Sequence>` mounts and unmounts its children over time, so `:nth-child` can point at a different element at another time. Ship Remotion second, and flag positional selectors (see question 4).

### Element identity in general

- **Selectors anchored on an `#id`** (the probe stops at the nearest id) survive edits that keep the id. The HyperFrames scaffold uses ids (`#stage`, `#card`).
- **Class and `:nth-child` paths** break when the structure changes. The override then matches nothing: the element simply stops being moved, and nothing fails. Proposed follow-up: the live bridge counts matches per selector, the inspector marks adjustments that match nothing, and the agent gets the same fact as a warning.
- **Several matches:** a selector that matches several elements at another time moves all of them. That is the same rule as CSS, and easy to explain to the agent.
- **Inline elements:** `translate`/`scale` do nothing on non-replaced inline boxes (a `<span>`). At drag start the app should step up to the nearest element that is not `display: inline` (the ↑ of the Pick tool, done automatically).

## 2. Live feedback and after the drop

**During the drag:**
- The clip's live page is already loaded for probing (Pick pages on demand, ADR 0011 §5).
- The bridge gains one message, `{ elements: css }`, that swaps the sheet without a reload. Measured in headless Chrome: 2.3 ms for the swap and relayout on a small page.
- For the drag, the page is shown at the clip's layer box, and the engine skips that clip's render layer. This is the state live preview already shows while a render is not ready (`liveTarget`, `renderer/src/preview/live.ts`).
- The topmost-layer rule of ADR 0010 still holds. When another picture covers the clip, or the project is untrusted (no pages), the app shows only the element's outline box moving, and the result appears after the render.

**Rejected:**
- **CSS transform on the whole iframe:** it moves the whole clip, not the element.
- **Proxy box only, always:** it gives no feedback for scale or for overlaps, although the page is already there.

**After the drop:**
- One `clip.set { clip, elements }` is sent as the `ui` author.
- The cache key changes, so the clip renders again in the background. Prototype: under 1 s for a 6-frame 160x90 clip; about 22 s for an 8 s 1440p HyperFrames clip (ADR 0002) and 13 s for Remotion (ADR 0009).
- Meanwhile `liveTarget` shows the live page, as for any render in progress.
- Undo restores the previous key, whose render is still in the cache, so it shows at once.
- To avoid a blank moment between the drag page and the new key's live page, the app keeps the drag page visible until the new page reports `ready`.

**Host or adapter for live:** the host bridge (`apps/desktop/src/main/live-protocol.ts`) should own the live sheet, both the first one and the swaps. The adapter then only handles `render`. The prototype put the live sheet in the HyperFrames `head` only to keep it short.

## 3. What a drag changes in v1

- **Move** (body drag) and **uniform scale** (corner drag, about the element's centre). These are the same gestures and math as `dragPlacement`. The app converts screen pixels to composition CSS pixels with the ratio of the element's probed box to its CSS box. For Remotion this ratio includes the page's `scale`.
- **Not in v1:** rotation, which composes the same way through the `rotate` property and can come later with no model change. Also not in v1: text editing (text is source or composition variables, the agent's job), size by width or height (that is layout, not transform), keys per element (ADR 0018 keys are clip-level; adding them later is additive).
- **Reset:** the inspector lists the clip's adjustments with a reset each. Resetting removes the entry.

## 4. Prototype

Branch `spike/drag-elements` (pushed, not for merge). The branch adds:

- **Schema:** `elements` on `AdapterClipSchema` (`packages/schema/src/timeline.ts`).
- **`elementStyles()`:** in `packages/schema/src/element-styles.ts`.
- **Cache key:** `elements` added to `clipCacheKey`.
- **Contexts:** `elementCss` passed in both contexts (`packages/core/src/clips/renderer.ts`, `packages/plugin-api/src/index.ts`).
- **HyperFrames:** applies the sheet in `render` (copied entry) and in `livePreview` (end of `<head>`, plus `window.frameshellElements(css)` to swap it).

The opt-in test `plugins/hyperframes/test/elements-real.test.ts` (`FRAMESHELL_TEST_REAL_HYPERFRAMES=1`) uses a real producer, managed Chrome and ffmpeg:

| Check | Result |
|---|---|
| Render: markup `#box` (with an inline `transform`, as an animation sets) moved 100 px | passes: red at the new place, clear at the old one |
| Render: script-made `#gen` moved (130, 60) and scaled 0.5 about its centre | passes |
| Live: page starts with the sheet; boxes at the moved places | passes |
| Live: `frameshellElements` swap without reload | passes, 2.3 ms |
| Existing adapter unit tests and `clip-cache-key` tests | pass. The live sheet is emitted only when there is CSS: the fake DOM of the unit tests has no `createElement` |

**What broke or stays open:**
- **Live sheet placement:** done by the adapter here, and should move to the host bridge (section 2).
- **Remotion:** not built.
- **App:** gestures, engine layer skip and `clip.set` params not built.
- **Units:** not checked when the composition's own size differs from the project's.

## Design questions for the owner (all answered as recommended, 2026-10-23: ADR 0021)

1. **Where do the adjustments live?** Recommended: a new optional clip field, `elements`, keyed by selector. Not in `props` and not in the source file.
2. **How does the user start an element drag?** Recommended: double-click a generated clip in the paused preview to enter its elements. Handles then go round the element under the cursor, as when entering a group in design tools, and Escape goes back to the clip. In the Pick tool, a drag keeps selecting a region.
3. **What can a drag change in v1?** Recommended: move and uniform scale only. Rotation, text and keys come later.
4. **What happens with a fragile selector** (no id, positional, typical in Remotion)? Recommended: save it anyway and show "may not follow edits" in the inspector, with an Ask agent shortcut that asks the agent to give the element an id. Nothing blocks.
5. **Should the agent bake adjustments into the source?** Recommended: no automatic baking. The skill says the field exists and that the agent may move a value into the source and clear the entry when it rewrites the composition anyway.

## Proposed issues if adopted

1. ADR 0021: element adjustments (accepted 2026-10-23, `docs/adr/0021-drag-to-edit-elements.md`).
2. Schema and core:
   - `elements` field and `elementStyles`, cache key (no `CACHE_LAYOUT_VERSION` bump: absent fields keep keys; any later change to the CSS recipe must bump it).
   - Additive plugin API: `elementCss` and the capability flag.
   - `clip.set` `elements` (per-selector merge, `null` removes), CLI `clip set --elements`, MCP from the registry.
   - Skill update; `PROTOCOL_VERSION` bump; JSON Schema regenerated.
3. HyperFrames render applies `elementCss`, with a real test, as in the prototype.
4. Live: the host bridge applies the first sheet and the `{ elements }` swaps; the drag page stays visible until the new key's page is ready.
5. App:
   - Element handles (double-click, move and scale), the engine skipping the dragged clip's layer, one `clip.set` per drag.
   - Inspector list with reset.
   - Fallbacks: outline only when the clip is not topmost or the project is untrusted.
   - e2e with the fixture plugin page.
6. Remotion: render applies the sheet through a patched bundle copy; positional selector note.
7. Adjustments that match nothing: the bridge counts matches, the inspector shows a badge, the agent gets a warning.
