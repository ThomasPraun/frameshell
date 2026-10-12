---
status: accepted
---

# Detachable panels: auxiliary windows that share the project window's state

Amends SPEC decision 17, §3.2 and §10. The workspace is one window per project, laid out as decision 17 fixes. The user wants to move a panel out to its own OS window and dock it back: the preview large or full screen on a second monitor, or a terminal running the agent beside it. Free docking (dragging panels anywhere) stays rejected.

## Context (verified in the tree)

- **Windows:** `main/index.ts` creates one `BrowserWindow` per project, sandboxed, with context isolation and no node integration. `setWindowOpenHandler` denies every popup. Each `WindowState` owns the project, the file watcher, the daemon subscriptions, a `TerminalManager` and the live-page URLs. Every IPC handler resolves its state with `stateOf(event.sender)`, which throws for an unknown webContents. The menu routes undo, redo and View items to `BrowserWindow.getFocusedWindow()`.
- **Layout:** hand-rolled flexbox with `Splitter.tsx`. The model is in `shared/layout.ts` (`PanelId` = sidebar, terminal, timeline; `centerSplit`; collapse). It is saved per project by `main/layout-store.ts`. Window size and position are not saved.
- **State lives in the renderer, as module singletons:**
  - the playhead: `preview/transport.ts`, the one store the project rules allow;
  - the selection: `selection.ts`;
  - the timeline feeds;
  - the Ask agent handler;
  - `ui-link`.
- **Preview player:** it owns the `AudioContext` and the `AudioWorklet`, so audio plays from whichever renderer hosts `PreviewPanel`.
- **Terminals:** node-pty lives in main, one `TerminalManager` per window, output sent to the creating webContents. A terminal view's unmount kills its pty. Scrollback exists only in xterm. So today a remounted terminal panel loses its session.
- **Ask agent:** it types through an imperative ref into that window's `TerminalPanel`.
- **E2E:** the harness drives `app.firstWindow()` only.

## Decision

**1. Auxiliary windows share one renderer (as VS Code does).** Detaching a panel opens a child window from the project window's renderer, with `window.open("about:blank", "frameshell-panel:<panel>")`. The panel's React subtree renders into that window's document through a portal. There is still one JavaScript realm per project, so the following stay single, with no sync:
- the playhead;
- the selection;
- the timeline feeds;
- the preview's audio clock;
- `ui-link`;
- the Ask agent.

Main changes:
- `setWindowOpenHandler` allows exactly `about:blank` with a `frameshell-panel:` frame name. It denies everything else as today, and applies the parent's sandboxed web preferences without a preload.
- `did-create-window` registers the child under the parent's `WindowState`, so `stateOf`, the menu and `getFocusedWindow` routing resolve it to its project window.

Renderer rules:
- Panel code uses its own document's window (`element.ownerDocument.defaultView`) for `requestAnimationFrame`, `ResizeObserver`, `matchMedia`, focus and fullscreen. A minimized project window must not stall the preview shown in a detached window.
- Stylesheets are copied into the child document, and new ones are mirrored there during development.
- Global key handling is installed on every window of the project, so Space, ←/→, Cmd/Ctrl+L, `I`, undo and redo work from any of them.

**2. What can be detached.** Any panel:
- the preview;
- each terminal tab, on its own;
- the timeline;
- the editor tabs, which include the transcript;
- the sidebar views: explorer, history, plugins.

The preview and terminals ship first; the others follow in the same mechanism. A detached panel leaves a placeholder in its slot with "Docked in another window", plus "Bring back".

**3. Docking back and closing.**
- Closing a detached window docks its panel back; the "Dock back" button in its title bar does the same.
- Closing the project window closes its detached windows. Reopening the project restores them where they were.
- Nothing ever closes a terminal or its session except the terminal's own close button, or closing the project window.

**4. Terminals outlive their view.** A pty belongs to its project window, not to a mounted view.
- The view's unmount detaches from the pty; it no longer kills it. Only an explicit close kills it.
- Main keeps a ring buffer of each pty's recent output, about 10,000 lines and capped at 4 MB.
- A new channel `terminal:attach` replays that buffer into a remounted xterm before live output resumes, so moving a terminal between windows keeps the agent running and its screen intact.
- Sessions still die with the project window. Persistent sessions across app restarts stay on the v1.0 roadmap.

**5. Ask agent's target.**
- The target is the last focused terminal whose foreground program is an agent, in any window of the project; if no terminal runs an agent, the last focused terminal.
- The target terminal's tab flashes briefly, so the user sees where the reference went.
- If its window is behind, it is not raised; the user keeps their focus.

**6. Preview size.**
- `F` toggles full screen for the preview, in the project window or in a detached one. Transport controls show on hover, and Escape leaves full screen.
- Separately, Cmd/Ctrl+Shift+Enter maximizes the focused panel inside its window: the other panels hide, and the same key restores them. It covers the timeline maximize shortcut SPEC §10 promises, which the app does not have yet.

**7. Persistence.**
- **Per project, as today** (`layout-store`): panel sizes, collapse state, `centerSplit`.
- **Global, in `configDir`** (`resolveAppDirs`, a user decision): which panels are detached, plus their window's display, bounds and full-screen state. Saved per set of connected displays. A window whose display is gone opens on the primary display.

**8. Spike first.** Before part 1, a throwaway branch checks the risks of point 1:
- rAF and timers in a child window while the project window is minimized or hidden;
- WebCodecs, `OffscreenCanvas` transfer and the `AudioWorklet` from a canvas living in the child document;
- xterm and its WebGL renderer in a child document;
- the live-preview iframe in a child document;
- copied styles and fullscreen.

If one of these fails without a workaround, this ADR is revisited before any panel ships.

## Considered options

- **Independent windows that sync state through main.** Each window would be a full renderer with its own stores, mirrored by IPC. That needs a second playhead, which the project rules forbid, and moves the audio clock between processes when the preview moves. Every store and every feed would need a sync protocol. Rejected.
- **Free docking (drag panels anywhere, tabs into tabs).** It is a layout engine of its own (dockview-style), and decision 17 rejected it for focus. It stays rejected; detach and maximize cover the multi-monitor need.
- **`<webview>` or `BrowserView` per panel.** Separate processes again, with the same sync problem as independent windows. Rejected.
- **Move xterm's DOM between documents without remounting.** It avoids the replay, but xterm binds to its document (renderer, input handling). It is fragile across panel moves. Rejected for the ring buffer, which also helps any remount.

## Consequences

- One project renderer now drives several OS windows. A slow panel slows them all, as it already slows the single window.
- Code that touches the global `window` or `document` inside panels must use the owner document's window. That becomes a rule in `apps/desktop` and is caught by tests in a detached window.
- Terminals survive remounts, so the cleanup that killed a pty on unmount moves to the explicit close path. Every place that relied on unmount to free a pty must be checked.
- Detached-window placement is global and outlives projects; panel sizes stay per project, as before.

## Implementation plan (each part ships and is tested alone)

0. **Spike** (label `spike`). The point 8 checks, in a throwaway branch, reported on its issue.
1. **Mechanism + preview.**
   - Main: the window-open allowlist and child registration under `WindowState`; menu routing.
   - Renderer: the portal host; the owner-window rule in preview code.
   - Interaction: detach and dock back for the preview, with the placeholder; `F` full screen; global keys in every window; placement saved in `configDir`.
   - Tests: main unit tests (allowlist, `stateOf` for a child); e2e for detaching the preview, playing, checking the frame advances while the project window is minimized, and docking back. The harness learns to wait for and drive a second window.
2. **Terminals.**
   - Pty lifetime off the view; the ring buffer and `terminal:attach`; detach per terminal tab; the Ask agent target rule and flash.
   - Tests: unit tests for the ring buffer and replay; e2e for detaching a terminal running a command, checking output continuity, and Ask agent from a detached preview reaching a terminal in another window.
3. **Other panels and maximize.**
   - Timeline, editor tabs and sidebar views detach.
   - Cmd/Ctrl+Shift+Enter maximizes the focused panel in place.
   - Tests: e2e per panel kind.

Docs with the parts: SPEC decision 17, §3.2 and §10, and the CHANGELOG. Release 0.6.0 after part 3.

## Side effects

- **Main:**
  - `setWindowOpenHandler` stops denying the `frameshell-panel:` popups (and only those).
  - `stateOf`, the menu routing and the closed handlers learn about child windows.
  - `TerminalManager` loses kill-on-unmount and gains the ring buffer.
  - A new IPC channel `terminal:attach` is added in `shared/api.ts`.
- **Renderer:**
  - The portal host.
  - Owner-window lookups in preview, timeline, terminal and transcript code.
  - Global key listeners per window.
  - The Ask agent target moves from a ref to a project-wide registry of terminals.
- **Storage:** a new global file in `configDir`; the per-project layout file keeps its shape.
- **Security:** child windows are `about:blank` documents scripted by the project renderer, with the same sandbox and no preload. Any other `window.open` is still denied. The renderer CSP is unchanged.
- **Protocol and daemon:** none. The daemon, MCP and `ui_state` see one view per project, as today.
- **E2E:** the harness's single-window assumption (`firstWindow`) stays valid for existing specs; new specs use the second-window helper.
