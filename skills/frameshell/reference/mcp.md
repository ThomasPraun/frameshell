# MCP tools

`frameshell mcp` serves every daemon operation as a typed MCP tool, plus images and the app's UI state. Register it once per project (Claude Code: `claude mcp add frameshell -- frameshell mcp`); the tools act on the project the server started in (each takes an optional `cwd` for another one). A server started outside any project (Claude Desktop runs one for all projects) acts on the project open in the app window the user used last, and each result ends with `Project: <dir>`: check it is the project you mean, since it follows the user switching windows; pass that dir as `cwd` to stay on it. No window open: ask the user to open the project in Frameshell, or pass `cwd`.

## CLI or MCP

Both reach the same daemon, journal the same operations and take the same arguments (`clip.add` → `clip_add`, `--snap-window` → `snapWindow`). Pick per task:

- **MCP only:** seeing pixels (`frame_capture` and `frames_strip` return the image itself), the app (`ui_state`, `ui_*`), `history_diff`, `clip_renders`, `asset_list`, `job_list`, `export_presets`.
- **CLI:** loops over many operations from one shell call (dozens of `cut`s), and every environment where the MCP server is not registered.
- **One channel per transaction.** A transaction groups one session's operations: the CLI's session is `FRAMESHELL_SESSION`, the server's is its own. Begin, edit and commit through the same one.

Tool results mirror the CLI's `--json`. Mutating tools return `revision` and `operation.tx`; errors come back as `<ErrorCode>: <message>` plus `data` with the fix.

## Check what you built

Look after every change the viewer would see: an overlay, a transform, a title, a subtitle style, a cut in the middle of a gesture.

- `frame_capture { at: 12.5 }`: the composited frame at that timeline second, rendered by the export compiler, so it matches `render` (works with the app closed). `preset` renders at that preset's size.
- `frames_strip { from: 0, to: 30, count: 9 }`: one contact sheet of evenly spaced frames with each tile's time and clip. Use it to review a whole edit or find where a shot changes.
- Without MCP: `frameshell frame --at 12.5 --out /tmp/f.png`, then open the PNG with your image-reading tool.
- `inspect_point { at: 12.5, x: 0.71, y: 0.14 }` (or `unit: "pixel"` with project pixels): the clips under that point, topmost first, the one seen there (`target`), and in a generated clip the DOM element painting it, as the user's Pick tool reports it (`elements[0]`, then its ancestors). CLI: `frameshell inspect --at 12.5 --point 0.71,0.14`. `segment: true` (CLI `--segment`) on a photo of an image project also returns `segment` (see [image-projects.md](image-projects.md)).

Done = you looked at a frame inside every changed visual element's time span and it shows what the user asked for.

## What the user sees: `ui_state`

`ui_state` returns the app's playhead, whether it plays, the selection (`clips`, `words` as transcript + word id, a time `range`, the History entry marked, a preview `region` with the clips under it, the `points` picked with the Pick tool with the clip and element at each), the open editor tabs and the visible timeline span. Read it to resolve "this clip", "here", "these words" when the prompt has no `[frameshell]` line. `{ connected: false }` means no app window shows the project: ask the user instead.

## Take the user somewhere: `ui_*`

Navigation only; each returns `ui_state` after the move.

| Tool | Use |
|---|---|
| `ui_seek { at }` | Put the playhead on a moment you want them to watch. |
| `ui_play` / `ui_pause` | Play from the playhead / stop. |
| `ui_select { clips?, words?, range? }` | Point at what you mean; replaces their selection. |
| `ui_select { points: [{ at, x, y }] }` | Show the user the element you mean: each point is inspected as `inspect_point` does and outlined as a pick in their preview ("is this the box?"). |
| `ui_open_file { file }` | Open a script, composition or timeline in an editor tab. |
| `ui_show_tx_diff { target }` | Open History on your `tx_…`/`op_…` with its changes marked on the timeline: the way to walk them through an edit. |

They fail with `UiNotConnected` when no app window shows the project.

## Resources

Read-only views, same content as the CLI's `--json`: `frameshell://status`, `frameshell://timelines/{timeline}`, `frameshell://timelines/{timeline}/history`, `frameshell://transcripts/{file}`, `frameshell://scripts/{file}/outline`. Subscribed timeline resources update on every change from any client.
