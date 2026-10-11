---
status: accepted
---

# Live preview: adapters serve a page, the app drives it in a sandboxed iframe

SPEC §3.4, §8.2, roadmap v0.2. Today a generated clip (`hyperframes`, `remotion`) shows a slate until its background render is ready (`RenderSlates.tsx`), so every composition edit means waiting for the render: about 22 s for HyperFrames and 13 s for Remotion on an 8 s 1440p card (ADR 0002, 0009). With live preview, a generated clip whose render is not ready plays its composition directly in the preview, seeked to the playhead. The cached render stays the reference, because it is what export overlays: once it is ready, the preview switches back to it.

## Context (verified in the tree)

- Adapters run in the daemon (Node). `ClipAdapter` (`packages/plugin-api/src/index.ts`) has `type`, `propsSchema`, `inputs()` and `render()`; `PLUGIN_API_VERSION = "1"`. The SPEC already reserves an optional `livePreview()`.
- The preview engine (`preview/engine.worker.ts`) composites every video layer into one `OffscreenCanvas` in a Worker, on the audio clock. A DOM element cannot be drawn between two layers of that canvas. The only DOM layers today are the render slates and the subtitles, which sit above the canvas in `PreviewPanel.tsx`.
- Program time maps to composition time as in export: a `generated` span shows render frame `in + (frame − start)` (`preview/program.ts`). `clip.renders` addresses nested clips as `<nested clip>/<clip>` and returns a cache `key` that changes when the composition, props, inputs or project format change.
- The renderer CSP (`renderer/index.html`) allows no frames. Windows run with `sandbox: true`, `contextIsolation: true` and no `nodeIntegrationInSubFrames`, so the preload never reaches a subframe. `frameshell-media:` (`main/media-protocol.ts`) serves only proxies, clip renders and still images.
- **HyperFrames** (`@hyperframes/core` 0.8.92) injects a runtime into the page. It exposes `window.__player` (`play`, `pause`, `seek`, `renderSeek(t)`, `getTime`) and a postMessage bridge (`source: "hf-parent"`, `type: "control"`, actions `play`/`pause`/`seek`/`set-muted`…; replies `source: "hf-preview"`). The runtime script is exported as `getHyperframeRuntimeScript()` (`@hyperframes/core/runtime-script`). Props reach the page as `window.__hfVariables`, which `getVariables()` merges over the declared defaults.
- **Remotion**: the adapter already bundles the entry into `.frameshell/remotion/<entry>/<hash>/` with the user's `@remotion/bundler` (ADR 0009). That page is what `@remotion/renderer` drives, through `window.remotion_setBundleMode({ type: "composition", … })` and `window.remotion_setFrame(frame, id, attempt)` (`make-page.js`, `seek-to-frame.js` in 4.0.527). These are internals, not public API. Scaffolded projects do not depend on `@remotion/player`.

## Decision

**1. Contract (plugin API, additive, `apiVersion` stays `"1"`, as with `refreshRenders`).**

```ts
interface ClipAdapter {
  // …existing members
  /** Optional. A page that plays the clip's composition at any time, for the preview while no render is ready. */
  livePreview?(clip: unknown, context: LiveContext): Promise<LivePage>;
}

/** Project facts for one live page. Like RenderContext without outDir, progress and signal. */
interface LiveContext {
  readonly projectDir: string;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  ensureBinary(name: string): Promise<string>;
}

interface LivePage {
  /** Project-relative directory served to the page; nothing outside it is reachable. */
  root: string;
  /** Project-relative entry HTML inside `root`. */
  entry: string;
  /**
   * Script text the host inserts at the start of the entry's <head> on every load; never written to disk.
   * It must define `window.frameshellLive = { ready: Promise<void>, seek(seconds): void | Promise<void> }`:
   * show composition time `seconds` (render time = composition time, as for `render`), muted.
   */
  head: string;
}
```

The adapter supplies the glue code that connects its engine to the page, so the app never has to know HyperFrames or Remotion. The host adds its own small bridge script after `head`. That bridge turns the parent's `postMessage({ seek })` calls into `frameshellLive.seek` calls and posts back `{ shown: seconds }` and errors.

**2. Daemon.** A new method `clip.live { cwd, timeline, clip }`, registered in `methods.ts`, uses the same clip addressing as `clip.renders` (`c_0200/c_0100` for a clip inside a nested timeline). It calls the adapter's `livePreview` and returns `{ root, entry, head, key }`. Errors: a new code, `LiveUnavailable`, when the adapter has no `livePreview`, its plugin is missing or untrusted, or `livePreview` threw (the message is the adapter's); `ClipNotFound`; `TimelineNotFound`; `OutsideProject` when `root` or `entry` escapes the project. It only reads; it never writes project files.

**3. Main process.** A new privileged scheme, `frameshell-live://<token>/…`, has one token per live page. It serves files under `root` only, with the same `realpath` containment checks as `serveMedia`. For `entry` it inserts `head` and the bridge script; other files are served as they are. `Access-Control-Allow-Origin: *` is set because the frame has an opaque origin. Main asks the daemon for `clip.live`, so the renderer only receives a URL, never HTML. A token is dropped when its project closes.

**4. Renderer.**
- **When live is used:** a `generated` span at the playhead whose render is `queued` or `rendering`, whose adapter supports live, and which is the topmost visible layer at that frame. It replaces that clip's slate. In every other case the program plays as today: `ready` uses the render, `failed`/`unavailable` show the slate with its error, and a live clip under another layer keeps the slate (slice 5 lifts this).
- **Mounting:** `<iframe sandbox="allow-scripts" allow="autoplay 'none'">`, sized to the project format and placed with the same `layerRect` and opacity the engine uses, so position, scale and opacity match export. Renderer CSP gains `frame-src frameshell-live:`.
- **Sync:** paused or scrubbing sends one seek per playhead change. While playing, one seek per animation frame with composition time derived from `transport` (the audio clock), the frame shown is best effort: the page never holds back the program clock, and a seek still running is replaced by the next one (only the latest seek is kept). Live pages stay muted, because renders are video only (ADR 0009) and live must not sound different from export.
- **Reload:** a new `key` for the clip in `clip.renders` means its inputs changed. The app then calls `clip.live` again, which matters for Remotion because a new bundle means a new `root`, and reloads the frame. No new watcher is needed. When the render becomes `ready`, the frame unmounts and the engine plays the render.

**5. Adapters.**
- **HyperFrames:** `root` = the composition directory, `entry` = `source`. `head` sets `window.__hfVariables` to the validated props as JSON, then the runtime from `getHyperframeRuntimeScript()`, then glue where `ready` waits for `__playerReady`/`__player`, `seek(t)` = `__player.renderSeek(t)` (render-accurate) and media is muted.
- **Remotion:** `root` = the current bundle directory (built by `inputs()`), `entry` = its `index.html`. The adapter runs `selectComposition` in the daemon and overrides the format exactly as for `render`. `head` calls `remotion_setBundleMode` with that composition and the serialized props on load, and `seek(t)` = `remotion_setFrame(round(t·fps), id, attempt)`; `ready` waits for `remotion_renderReady`. These globals are Remotion internals: if one is missing, `livePreview` fails with a clear message and the preview keeps the slate, the same policy as the config internals in ADR 0009. The user's Remotion licence applies to live preview as it does to rendering.

## Considered options

- **`@remotion/player` (what SPEC §3.4 names).** It needs `@remotion/player` in the user's project (scaffolds do not include it) and a direct reference to the composition component, which only the user's `registerRoot` tree holds. That means a second webpack build per entry. It would be public API, but it means extra dependency, extra bundling and a different code path from renders. Kept as the fallback if Remotion's internal globals change too often.
- **Offscreen `BrowserWindow` whose paint events feed bitmaps into the engine as a layer.** Gives exact layer order and runs on the engine's clock. But a 1080p frame costs ~8 MB per copy through IPC to the worker, CPU paint and a hidden window per clip. Rejected for v0.2; reconsider if slice 5 proves insufficient.
- **iframe always on top of the canvas.** Simplest, but it hides layers above the clip and is wrong compared with export. Rejected; the "topmost layer only" rule avoids showing anything export would not show.
- **`<webview>` tag.** Process isolation comes for free, but the tag is discouraged by Electron, heavier, and needs `webviewTag: true`. A sandboxed cross-origin iframe already runs out of process under site isolation. Rejected.
- **Live always, render only for export.** That is SPEC decision 4's rejected "all-live" option: preview and export would drift. Rejected.

## Consequences

- Composition code (project HTML/JS, the user's Remotion bundle) now also runs inside the app, not only in headless Chrome. It runs only for trusted projects, because adapters load only there (SPEC §6.6). It gets an opaque origin, no preload, no `window.frameshell`, and no access to the parent page. It may still reach the network, as it can when rendering.
- Live and render can differ in fonts, timing or GPU effects. The preview labels a live clip ("Live, rendering 40%") so nobody mistakes it for the export.
- While playing, a heavy composition may show stale frames. Sync is exact only while paused.

## Decisions taken (2026-10-10)

1. Live only while the render is not ready. No "force live" toggle for now; it can come later without changing the contract.
2. Remotion is driven through the bundle's internal globals, not `@remotion/player`. SPEC §3.4 is updated accordingly; `@remotion/player` stays the fallback if the internals change too often.
3. Live pages may reach the network, as renders in headless Chrome do. No CSP is injected into them.
4. Ship with the topmost-layer rule. Slice 5 (live under other layers) waits for real use to show it is needed.

## Implementation plan (each slice ships and is tested alone)

1. **Contract + daemon:** `livePreview`, `LiveContext`, `LivePage` in plugin-api; host passes them through; `clip.live` and the `LiveUnavailable` code in `methods.ts`; `PROTOCOL_VERSION` 28 → 29. Tests: core unit tests with a fake adapter (paths inside the project, `LiveUnavailable`, nested clip address, untrusted project).
2. **HyperFrames adapter:** `livePreview` with the runtime and variables. Tests: unit (page shape, props JSON escaping in `head`), plus an opt-in real test that loads the page in managed headless Chrome and checks that `seek(1)` and `seek(5)` give different pixels.
3. **App:** `frameshell-live:` scheme with head injection and containment; iframe in `PreviewPanel` under the topmost-layer rule; seek on pause, scrub and play; reload on key change; switch to the render when ready; CSP. Tests: main unit tests for the scheme (containment, injection); e2e with a fixture plugin whose page draws its seek time as text, which needs no Chrome.
4. **Remotion adapter:** bundle-mode glue, checks for the internals, format override. Tests: unit with a fake bundle page, plus an opt-in real test as in slice 2.
5. **Below other layers (deferred, decision 4):** the engine splits its layers into two canvases at the live layer, with the iframe between them. Tests: engine unit test of the split; e2e with an overlay above a live clip.

Docs with the slices: SPEC §3.4 and §8.2, the `plugin-api` README, the skills of both adapters, CHANGELOG (Added, plugin API additive).

## Implementation notes (2026-10-10)

Found while building the slices; the decision above stands.

- **Insertion:** the app inserts `head` with a function replacement. The HyperFrames runtime contains `$&`-style sequences that a string replacement would expand.
- **Storage:** a frame sandboxed without `allow-same-origin` throws on `localStorage`. Remotion reads it, so the Remotion `head` installs in-memory `localStorage` and `sessionStorage`. The HyperFrames runtime needed none.
- **Remotion background:** Remotion's page CSS paints `body` `#1f2428`. As `take-frame.js` does for PNG frames, the live page makes it transparent, so the footage below shows as in the render. The page is scaled by the same factor `render` passes.
- **Remotion environment:** the Remotion `head` sets the globals `setPropsAndEnv` sets (`remotion_puppeteerTimeout`, `NODE_ENV=production`, …). The page then runs in Remotion's rendering environment: media is driven per frame and makes no sound. Whether `<OffthreadVideo>`, which asks the renderer's frame server, shows anything live is not verified.
- **Remotion internals check:** before serving a bundle, `livePreview` checks that its scripts mention `remotion_setBundleMode`, `remotion_setFrame` and `remotion_renderReady`. When one is missing, the failure names it and the slate stays.

## Side effects

- **Plugin API:** additive optional member; `apiVersion` stays `"1"`, so existing plugins keep working.
- **Protocol:** new method `clip.live` and error code `LiveUnavailable`, so `PROTOCOL_VERSION` bumps. The MCP tool list grows automatically from the registry; check the skill-docs test.
- **Cache:** none. `CACHE_LAYOUT_VERSION` and the render keys do not change, and live pages are never cached or written to disk.
- **Desktop:** a new privileged scheme in `main/index.ts`, `frame-src` in the CSP, and a new IPC call in `shared/api.ts`. The engine, playhead and audio stay unchanged until slice 5.
- **Adapters:** HyperFrames imports `@hyperframes/core/runtime-script`, which is already installed through `@hyperframes/producer` but should become a direct dependency at the same pin. Remotion gains no dependency.
