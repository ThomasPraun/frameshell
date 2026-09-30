# MCP server

`frameshell mcp` serves the [Model Context Protocol](https://modelcontextprotocol.io) over stdin/stdout (SPEC §7b, decision 20). It is one more client of `frameshelld`, like the CLI and the app: tools map to daemon methods, and it starts the daemon when none is running. Implementation: `packages/mcp`.

## Register it

Claude Code, from the project directory:

```sh
claude mcp add frameshell -- frameshell mcp
```

Tools act on the project enclosing the directory the server starts in (every tool also takes an optional `cwd`). Running from a source checkout, point at the built CLI instead:

```sh
claude mcp add frameshell -- node /path/to/frameshell/packages/cli/dist/bin/frameshell.js mcp
```

Other clients (Codex, Cursor…) take the same command: `frameshell mcp`, stdio transport.

Operations are attributed to `FRAMESHELL_SESSION` when set (app terminals set it), else to a session id made for this server run. They are journaled as `agent:<label>:<session>` when `FRAMESHELL_AGENT` names the agent, or when the app detected one in its terminal. Operations from one session group into transactions until an idle gap, so the model can revert its own work.

## Tools

One tool per public method of the daemon registry (`methods` in `packages/protocol/src/methods.ts`), generated at startup:

- Name: method name with `.` replaced by `_` (`clip.add` → `clip_add`, `tx.begin` → `tx_begin`). `frame` is exposed as `frame_capture`.
- Description: the registry's model-facing description; method names in backticks are rewritten to tool names.
- Input schema: the method's Zod params as JSON Schema. `cwd` is optional and defaults to the server's directory.
- Output: the method's result as compact JSON. Mutating tools return `revision` and `operation.tx` (and `operation.id`); `inverse` patches are left out, since `revert` takes the tx or op id.
- Errors: tool results with `isError: true` and text `<ErrorCode>: <message>` plus `data` (valid ranges, available ids, the fix). Protocol errors are only for malformed MCP requests.

A new registry method becomes a tool with no change here (internal methods, such as `handshake` and `events.*`, are skipped). `packages/mcp/test/tools.test.ts` fails when a public method has no tool.

Observe tools return images:

| Tool | Returns |
|---|---|
| `frame_capture(timeline, at, preset?, out?)` | The composited frame at `at` seconds, rendered by the daemon with the export compiler (single-frame plan, same as `frameshell frame`), as a PNG image scaled to fit 1280x1280, plus frame index and clip. `out` also keeps the full-size PNG. |
| `frames_strip(timeline, from, to, count?, preset?)` | `count` (2 to 16, default 6) evenly spaced frames from `from` to `to`, tiled into one contact sheet at most 1280 px wide, plus the time, frame and clip of each tile. |

## Resources

Compact JSON, the same as the matching `--json` CLI output:

| URI | Content |
|---|---|
| `frameshell://status` | `status`: daemon, project, plugin trust, jobs, rejected edits, open transactions |
| `frameshell://timelines/{timeline}` | `timeline.show` |
| `frameshell://timelines/{timeline}/history` | `history` |
| `frameshell://transcripts/{file}` | `transcripts/{file}` as written, e.g. `raw-01.words.json` |
| `frameshell://scripts/{file}/outline` | `script.outline` (one resource per `scripts/**/*.md`); the stdio contract test reads it |

Subscribed timeline and history resources get `notifications/resources/updated` on the daemon's `timeline.changed` event, from any client (CLI, app, file edit). A timeline not listed before, and a transcript written by this server's `transcribe`, send `notifications/resources/list_changed`. After a lost daemon connection the server reconnects on the next request, renews its event subscription and marks every subscribed resource updated.

## Not yet

- UI state and navigation tools (`ui_state`, `ui_seek`…): #33.
- Change notifications for transcripts written by other clients: they need daemon asset events (#69).
