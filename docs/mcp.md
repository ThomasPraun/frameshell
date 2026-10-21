# MCP server

`frameshell mcp` serves the [Model Context Protocol](https://modelcontextprotocol.io) over stdin/stdout (SPEC §7b, decision 20). It is one more client of `frameshelld`, like the CLI and the app: tools map to daemon methods, and it starts the daemon when none is running. Implementation: `packages/mcp`.

## Register it

Claude Code, from the project directory. Outside the app's integrated terminals, `frameshell` needs **File → Install 'frameshell' Command in PATH** first (the Linux `.deb` installs it already) (see the README's Install section).

```sh
claude mcp add frameshell -- frameshell mcp
```

Tools act on the project enclosing the directory the server starts in (every tool also takes an optional `cwd`). Running from a source checkout, point at the built CLI instead:

```sh
claude mcp add frameshell -- node /path/to/frameshell/packages/cli/dist/bin/frameshell.js mcp
```

Other clients (Codex, Cursor…) take the same command: `frameshell mcp`, stdio transport.

### Which project (ADR 0014)

A call without `cwd`, and every resource, acts on:

1. the project enclosing the server's directory, when there is one;
2. else the project of the app window the user focused last (a detached panel counts as its project's window; it stays active while the app is in the background). This is how one global server works, e.g. Claude Desktop's, started outside any project: switching windows switches the project. The result then ends with a line `Project: <dir> (…)`, and subscribed resources are marked updated (plus `list_changed`) when the project changes;
3. else nothing: tools fail with `ProjectNotFound` ("Open a project in Frameshell, or pass cwd"), and resources list only `frameshell://status`.

An explicit `cwd` always wins. The daemon answers step 2 with the internal `ui.active`; the app sends `focused` with each `ui.publish` (main `ui-bridge.ts`, `browser-window-focus`), so a window playing in the background does not take over. Resolution: `packages/mcp/src/project.ts`.
Claude Desktop (macOS, Windows): **Connect Claude Desktop** in the app's agent guide, above the terminals, adds the server to `claude_desktop_config.json` (`main/claude-desktop.ts`): only the `mcpServers.frameshell` key changes, through the stable `frameshell` shim in the app's data directory, and the old file goes to `claude_desktop_config.json.frameshell-backup`. Claude Desktop starts the server outside any project, so tools act on the project of the app window the user works in (below).


Operations are attributed to `FRAMESHELL_SESSION` when set (app terminals set it), else to a session id made for this server run. They are journaled as `agent:<label>:<session>` when `FRAMESHELL_AGENT` names the agent, or when the app detected one in its terminal. Operations from one session group into transactions until an idle gap, so the model can revert its own work.

## Tools

One tool per public method of the daemon registry (`methods` in `packages/protocol/src/methods.ts`), generated at startup:

- Name: method name in snake case, `.` replaced by `_` (`clip.add` → `clip_add`, `ui.openFile` → `ui_open_file`). `frame` is exposed as `frame_capture`.
- Description: the registry's model-facing description; method names in backticks are rewritten to tool names.
- Input schema: the method's Zod params as JSON Schema. `cwd` is optional and defaults as in [Which project](#which-project-adr-0014).
- Output: the method's result as compact JSON. Mutating tools return `revision` and `operation.tx` (and `operation.id`); `inverse` patches are left out, since `revert` takes the tx or op id.
- Errors: tool results with `isError: true` and text `<ErrorCode>: <message>` plus `data` (valid ranges, available ids, the fix). Protocol errors are only for malformed MCP requests.

A new registry method becomes a tool with no change here (internal methods, such as `handshake` and `events.*`, are skipped). `packages/mcp/test/tools.test.ts` fails when a public method has no tool.

Observe tools return images:

| Tool | Returns |
|---|---|
| `inspect_point(timeline, at, x, y, unit?)` | What a point of the frame shows (ADR 0011): clips under it topmost first, the one seen there, and in a generated clip the DOM element painting it, probed in its live page in managed headless Chrome with the app's Pick script. Elements need a trusted project; footage paints its whole box. Same as `frameshell inspect`. |
| `frame_capture(timeline, at, preset?, out?)` | The composited frame at `at` seconds, rendered by the daemon with the export compiler (single-frame plan, same as `frameshell frame`), as a PNG image scaled to fit 1280x1280, plus frame index and clip. `out` also keeps the full-size image, as PNG, JPEG or WebP by its extension or `format` (`quality` 1-100); how an image project exports (ADR 0017). |
| `frames_strip(timeline, from, to, count?, preset?)` | `count` (2 to 16, default 6) evenly spaced frames from `from` to `to`, tiled into one contact sheet at most 1280 px wide, plus the time, frame and clip of each tile. |

## UI state and navigation

What the user sees in the app, and a way to take them somewhere (SPEC §7b, decision 20). The app publishes its state to the daemon; navigation is routed daemon → app window. MCP never talks to Electron, and nothing is pixel automation: each tool is one command the app applies to its shared stores (playhead `preview/transport.ts`, selection `selection.ts`, editor tabs, History panel).

| Tool | Does |
|---|---|
| `ui_state` | Playhead, playing, duration, selection (`clips`, `words`, time `range`, History entry marked, preview `region` with the clips under it, topmost first, picked `points` with the clip and element at each), editor tabs, timeline seconds `visible` in the timeline panel. `{ connected: false }` when no app window shows the project. |
| `ui_seek(at)` / `ui_play` / `ui_pause` | Drive the preview's transport. |
| `ui_select(clips?, words?, range?, reveal?, points?)` | Replace the selection; unknown clip ids fail. `reveal` scrolls to the first clip. `points` (`{ at, x, y }`, fractions of the frame) are inspected by the daemon (`inspect.point`) and shown as picks, the playhead at the first (ADR 0011). |
| `ui_open_file(file)` | Open a project file in an active editor tab. |
| `ui_show_tx_diff(target)` | History panel on a `tx_…`/`op_…`, its changes marked on the timeline. |

Navigation tools return the app's state after the command. No app: `UiNotConnected`; refused or no answer within 5 s: `UiCommandFailed` with the reason. The app reports every change within 200 ms (reports at most every 100 ms, only when something changed). Several windows on one project: the one focused last (else the one that reported last) gets commands. Wiring: daemon broker `packages/core/src/ui/broker.ts`, main `apps/desktop/src/main/ui-bridge.ts`, renderer `apps/desktop/src/renderer/src/ui-link.ts`. Internal methods `ui.publish`, `ui.reply`, `ui.detach`, `ui.active` and the `ui.command` notification carry it.

## Resources

Compact JSON, the same as the matching `--json` CLI output:

| URI | Content |
|---|---|
| `frameshell://status` | `status`: daemon, project, plugin trust, jobs, rejected edits, open transactions |
| `frameshell://timelines/{timeline}` | `timeline.show` |
| `frameshell://timelines/{timeline}/history` | `history` |
| `frameshell://transcripts/{file}` | `transcripts/{file}` as written, e.g. `raw-01.words.json` |
| `frameshell://scripts/{file}/outline` | `script.outline` (one resource per `scripts/**/*.md`); the stdio contract test reads it |

Subscribed timeline and history resources get `notifications/resources/updated` on the daemon's `timeline.changed` event, from any client (CLI, app, file edit). A timeline not listed before, and a transcript written by this server's `transcribe`, send `notifications/resources/list_changed`. A transcript this server's `transcribe_speakers` rewrote gets `notifications/resources/updated` when subscribed. After a lost daemon connection the server reconnects on the next request, renews its event subscription and marks every subscribed resource updated.

## Not yet

- Change notifications for transcripts written by other clients: they need daemon asset events (#69).
