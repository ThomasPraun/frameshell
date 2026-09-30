# `[frameshell]` selection lines

In the app, the user selects something and presses Cmd/Ctrl+L ("Ask agent"): the app types one line per selected item into your prompt, each starting with `[frameshell]`, then the user writes the request ("make this shorter", "remove these words"). The lines are **what "this" means**: resolve them before acting, and act on exactly those ids.

Times in the lines are timeline times as `HH:MM:SS.hh` (`00:03:12.40` = 192.4 s). Ids are the project files' ids. Several items may share one line when the terminal program has no bracketed paste; split on `[frameshell]`.

| Line | Means | Resolve with |
|---|---|---|
| `[frameshell] subtitle "hola a todos" · 00:03:12.40–00:03:14.10 · clip c_0012 · words w_000123–w_000127` | Spoken words, played by that clip in that time span | `frameshell timeline show --json`: the clip's `asset`, `in`, `speed`; the words by id in that asset's transcript (`transcripts/<asset minus extension>.words.json`). A lone `word w_…` is one word. |
| `[frameshell] clip c_0012 · media assets/raw-01.mp4 · 00:00:12.40–00:00:31.00 · track t_1a2b3c` | One clip (type, asset or source, span, track) | `timeline show --json` for its full fields. |
| `[frameshell] range 00:01:00.00–00:01:12.50` | A timeline time range | Use directly, e.g. `frameshell cut --from 60 --to 72.5`. |
| `[frameshell] region (0.62,0.08)–(0.94,0.22) @ 00:01:05.20 · frame .frameshell/context/f_0421.png` | A rectangle of the preview frame at that time | Corners are fractions of the frame, origin top-left: multiply by the project `resolution` for pixels. Open the PNG to see what they point at; `frame_capture` renders the same moment again after a change. |
| `[frameshell] asset assets/logo.png` / `[frameshell] file scripts/launch.md` | A project file | Read it; place an asset with `clip add`. |
| `[frameshell] scene scripts/launch.md#intro "Intro" · clips c_0100 c_0101` | A script scene and the clips linked to it | `frameshell script outline scripts/launch.md --json`. |
| `[frameshell] transaction tx_0042` / `[frameshell] operation op_0310` | A history entry | `frameshell history --json` (find the id), `history_diff` (MCP) for the clips it changed, `frameshell revert <id>` to undo. |

Done resolving = every id in the lines found in the current timeline, transcript or history. An id that is gone means the project changed since the user selected: say so and read `ui_state` or ask, rather than guessing.
