---
status: accepted
---

# Drag to edit composition elements

Adds v0.16 and closes the "direct drag-to-edit of composition elements" gap listed in ADR 0017. A person double-clicks a generated clip in the paused preview and drags a title or a logo inside it, to move it or scale it. The drag is saved as an **element adjustment** on the clip in the timeline; the composition's source file is never touched. Research and prototype: `docs/research/drag-to-edit-elements.md` (#291). Decided by the owner on 2026-10-23.

## Context (verified in the tree)

- Layer handles move and scale whole clips. Each drag is one `clip.set` with the changed `transform` fields, by `ui` (`placementEdit`, `apps/desktop/src/renderer/src/preview/transform-edit.ts`).
- Pick (ADR 0011) names the element under a point. The probe (`packages/protocol/src/probe.ts`) returns a selector anchored at the nearest `id` (else `body`), with `:nth-child` where siblings look alike. It also returns the element's box in page pixels and the adapter's `describe` facts. `generated: true` marks elements absent from the source file, which a script created.
- Live pages (ADR 0010) run in a sandboxed iframe. The host bridge (`apps/desktop/src/main/live-protocol.ts`) accepts `{ seek }` and probe requests. A page is shown only for the topmost clip whose render is `queued` or `rendering` (`liveTarget`, `renderer/src/preview/live.ts`). Pick also loads pages on demand for clips whose render is ready.
- The render cache key covers plugin, `type`, `source`, `props`, inputs and format (`clipCacheKey`, `packages/core/src/clips/cache-key.ts`). Keys drop `undefined` members before hashing.
- HyperFrames `render` copies the composition into `outDir` before rendering (`plugins/hyperframes/src/adapter.ts`). The Remotion live `head` already injects a `<style>`, and its render serves the bundle directory (`serveUrl: bundle.dir`).
- Installed plugins carry only their engines as runtime dependencies. `@frameshell/plugin-api` is a devDependency (ADR 0008), so a runtime helper in it would not reach an installed plugin.
- The journal is per timeline (SPEC §6.2). Composition files are outside it and outside review mode (ADR 0019).

**Guiding principle: simple for the person and the agent, optional, nothing mandatory.** A clip without adjustments is unchanged byte for byte: the same file, the same render key. An adjustment is a short, flat entry that an agent reads and writes like any clip field.

## Decision

1. **An optional clip field.** Adapter clips gain `elements`: CSS selector → `{ x?, y?, scale? }`.
   - `x` and `y` are a move in the composition's CSS pixels (default 0).
   - `scale` is a uniform factor about the element's centre (default 1, > 0).
   - Example: `"elements": { "#title": { "y": -40, "scale": 1.2 } }`.
   - The source file stays as it is. The agent never moves adjustments into the source by itself. The skill explains the field, and says that an agent rewriting a composition anyway may move a value into the code and clear its entry.
2. **One CSS sheet, made by the host.** Core turns `elements` into CSS (`elementStyles` in `@frameshell/schema`). Each element gets `translate: Xpx Ypx !important` and `scale: S !important`, rules sorted by selector.
   - These separate transform properties add to whatever `transform` the composition animates (GSAP, inline styles), so an animated title keeps its animation, offset by the adjustment.
   - A selector containing `{ } < > ;` or `/*` is refused.
3. **Adapters insert it last.** Plugin API, additive, `apiVersion` stays `"1"`:
   - `RenderContext.elementCss?: string` and `LiveContext.elementCss?: string` carry the sheet.
   - An adapter that applies the sheet declares `elementStyles: true` on `ClipAdapter`.
   - `clip.set` with `elements` fails with a clear message when the clip's adapter does not declare it. Otherwise the preview would show what the render ignores.
   - **HyperFrames:** adds `<style data-frameshell-elements>` before `</head>` of the copied entry.
   - **Remotion:** serves a copy of the bundle directory, hard-linked where possible, whose `index.html` carries the sheet.
4. **Cache key.** `elements` joins `clipCacheKey`. When absent it drops out, so existing keys do not change and `CACHE_LAYOUT_VERSION` stays. Any later change to how the CSS is made must bump it.
5. **Operation.** `clip.set` takes `elements`, merged per selector. A selector set to `null` removes that entry, and `elements: null` clears all of them.
   - The operation is journaled like any clip field, and its inverse is the clip patch (ADR 0004).
   - CLI `clip set --elements '<json>'`. The MCP tool follows from the registry.
6. **Review mode.** `elements` lives in the timeline, so an agent's change to it is a timeline change: with review mode on it becomes a proposal like any other. A drag in the app is by `ui` and applies at once (ADR 0019).
7. **Gesture.** In the paused preview, double-clicking a generated clip enters its elements:
   - **Selection:** the element under the cursor gets handles (body: move, corners: uniform scale).
   - **Step to a block:** at drag start the app steps from an inline element (`display: inline`, not replaced) to its nearest block ancestor, since inline boxes ignore `translate` and `scale`.
   - **Leaving:** Escape returns to the clip. A normal drag outside element mode still moves the whole clip.
   - **One step per drag:** a drag is one `clip.set` by `ui`, one undo step.
   - **Units:** screen pixels convert to CSS pixels with the ratio of the element's probed box to its CSS box. For Remotion the ratio includes the page's `scale`.
   - **Where it works:** image and video projects alike, trusted projects only (pages run only there). Elsewhere the double-click does nothing beyond Pick's clip selection.
8. **Feedback while dragging.**
   - **Topmost clip:** the clip's live page is shown at its layer box and the engine skips that clip's render layer for the drag. The bridge gains `{ elements: css }`, which swaps the sheet without a reload.
   - **Covered clip:** when another picture covers the clip (the ADR 0010 topmost rule), only the element's outline moves.
   - **After the drop:** the new key renders in the background and live preview covers the wait. The drag page stays until the new key's page reports `ready`, so nothing blanks.
   - **Undo:** undo restores the old key, whose render is cached.
   - **Who owns the live sheet:** the host bridge applies the first sheet and the swaps, so adapters handle only `render`.
9. **Fragile selectors.** A selector without an `id` in its path, or with `:nth-child`, is saved anyway.
   - **Note:** the inspector marks it "may not follow code edits", with an Ask agent shortcut that asks the agent to give the element an `id`.
   - **No match:** the bridge counts the matches of every selector. An adjustment that matches nothing at the shown time is marked in the inspector and reported to the agent as a warning.
   - **Nothing blocks.**
10. **Inspector.** In element mode the clip inspector lists the clip's adjustments (selector, x, y, scale) with a reset each. Reset removes the entry.

## Considered options

- **An adapter hook that patches the source** (HTML/CSS, JSX). Rejected:
  - Elements a script creates have no markup to patch.
  - A written `transform` loses to animations.
  - Remotion source may live outside the project (ADR 0009).
  - The edit would bypass the journal and review mode.
- **Overrides inside `props`.** Rejected: `props` belong to the adapter. HyperFrames hands them to the page as composition variables, and Remotion validates `{ composition, inputProps }` strictly.
- **A runtime CSS helper in `@frameshell/plugin-api`.** Rejected: installed plugins do not ship it. The host makes the sheet once instead.
- **A CSS transform on the whole iframe while dragging.** Rejected: it moves the clip, not the element.
- **Outline-only feedback always.** Rejected: the page is already loaded for probing, and the real result shows scale and overlaps.
- **Rotation, text and size edits in v1.** Deferred. `rotate` composes the same way and needs no model change. Text belongs to the source or the composition variables.
- **Keys per element.** Deferred. Additive later, on the clip's own clock like ADR 0018 keys.

## Consequences

- Schema: optional `elements` on adapter clips; JSON Schema regenerated. A timeline without it is unchanged.
- Protocol bump: `clip.set` `elements`, bridge message `{ elements }`, match counts. CLI flag and skill updated (`pnpm gen:skill`).
- Each drop re-renders the clip, at the same cost as any composition edit (ADR 0002, 0009).
- A selector can stop matching after a code edit. The element then simply stops moving, and the inspector and the agent are told.
- A selector that matches several elements moves all of them, as CSS does.
- A composition that animates the `translate` or `scale` CSS properties itself is overridden for that element. This is rare: GSAP and Remotion animate `transform`.
- Not covered: rotation, text, width and height, keys per element, untrusted projects.

## Implementation plan (each part ships and is tested alone)

1. **Model and host.**
   - Code: `elements` in the schema, `elementStyles`, the cache key, the plugin API fields and flag, `clip.set` `elements` with the adapter check, the CLI flag, skill, `PROTOCOL_VERSION`.
   - Tests: schema, `elementStyles` (sorting, refused selectors), key stability without `elements`, `clip.set` merge, `null` and undo, skill-docs.
2. **HyperFrames render.**
   - Code: the sheet in the copied entry; `elementStyles: true`.
   - Tests: an opt-in real render with a markup element and a script-made one (as the spike's `elements-real.test.ts`).
3. **Live sheet in the bridge.**
   - Code: the first sheet and the `{ elements }` swap; match counts.
   - Tests: bridge unit tests; e2e with the fixture plugin page.
4. **App gesture.**
   - Code: double-click into elements, handles, inline step-up, engine layer skip, one `clip.set` per drag, outline fallback, keeping the page until the new one is ready, inspector list, reset, fragile and unmatched notes, Ask agent shortcut; strings in en and es.
   - Tests: unit tests for the geometry; e2e for drag, undo and Escape.
5. **Remotion render.**
   - Code: the bundle copy with the sheet; `elementStyles: true`.
   - Tests: an opt-in real render.

Docs with the parts: SPEC §5.3, §6.5, §8.2, §10 and §12, the `plugin-api` README, both adapters' skills, the core skill, and the CHANGELOG.

## Side effects

- **Plugin API:** additive optional fields and flag. Adapters without the flag keep working; their clips cannot take `elements`.
- **Render cache:** no existing key changes. `CACHE_LAYOUT_VERSION` and `RECIPE_VERSION` stay.
- **Live pages:** the bridge grows (sheet, swap, counts), and `seek` and the probe are unchanged. Pages still load only in trusted projects.
- **Desktop:** the engine gains a per-clip skip for the duration of a drag. Double-click on a generated clip, which does nothing today, gets a meaning.
- **Review mode:** agent edits of `elements` are proposals; `ui` drags are immediate.
