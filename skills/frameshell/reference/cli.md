# `frameshell` CLI

Thin client of the daemon: it starts `frameshelld` when none runs, acts on the project enclosing the current directory, and exits 0 (ok), 1 (command failed) or 2 (usage error). Add `--json` to parse the output. Timeline commands take `--timeline <id>` (default `main`). `frameshell --help` lists every flag; this page says what each command is for and what to watch.

## Project

| Command | Use |
|---|---|
| `frameshell init [dir] [--name <name>]` | Scaffold a project: `frameshell.json`, empty `timelines/main.json`, `assets/`, `transcripts/`, `scripts/`, `compositions/`, and this skill under `.claude/skills/frameshell/` (`--no-skill` leaves it out). Fails on an existing project. |
| `frameshell status` | Daemon, project, plugin trust, jobs, refused direct edits, open transactions. First command in a new session. |
| `frameshell doctor [--install]` | ffmpeg/ffprobe and encoders; exit 1 with the fix when rendering is blocked. `--install` downloads the managed binaries. |
| `frameshell import <file…> [--link] [--wait]` | Copy media into `assets/` and ingest it (proxy, audio sidecar, waveform, thumbnails). Without `--wait` it returns at once; `status` shows progress. |
| `frameshell script outline <file>` | Scenes (`## ` headings) of a Markdown script with their `scriptRef` anchors and linked clips. |
| `frameshell mcp` | Serve the MCP tools on stdio (see [mcp.md](mcp.md)). |

## Timeline

| Command | Use |
|---|---|
| `frameshell timeline show` | Every track and clip: ids, `start`/`end` (timeline), `in`/`out` (source), speed. `--json` is compact on purpose. |
| `frameshell track list` | Tracks bottom to top (first video track = bottom layer). |
| `frameshell track add <video\|audio\|subtitles> [--name n] [--index n]` | New track, on top unless `--index`. Subtitle tracks need `--follows <track>`; `--preset big-keyword\|plain`, `--position top\|center\|bottom`. |
| `frameshell track set <track> …` | Rename (`--name`, `--clear-name`); subtitle `--follows`, `--preset`, `--position`. |
| `frameshell track remove <track> [--force]` | `--force` when it holds clips. |
| `frameshell clip add <track> [asset] …` | Place media (`--start`, `--in`, `--out` or `--duration`, `--speed`), or an adapter clip (`--type hyperframes --source <html> --duration s --props '<json>'`). Overlay placement `--x --y --scale --opacity`. `--ripple` inserts, moving later clips right. `--snap` snaps media `in`/`out` into pauses. |
| `frameshell clip move <clip> [--start s] [--track t]` | Same length, new place; refused on overlap. |
| `frameshell clip trim <clip> [--in s \| --start s] [--out s \| --end s]` | `--in`/`--out` in source seconds, `--start`/`--end` in timeline seconds. Snaps like `cut`. `--ripple` moves later clips by the length change: the inverse of `cut`. |
| `frameshell clip split <clip> --at s` | Left part keeps the id; the right part's id is in `changes.added`. |
| `frameshell clip remove <clip>` | Leaves a gap; to close it use `cut`. |
| `frameshell clip set <clip> …` | `--speed`, `--gain` (dB, negatives as `--gain=-6`), `--muted`/`--unmuted`, `--x --y --scale --opacity`, `--props '<json>'` (replaces), `--script-ref <script#scene>`/`--clear-script-ref`. |
| `frameshell cut [track…] --from s --to s` | Remove a timeline range on every video and audio track (or the listed ones) and close the gap. Edges snap into audio pauses; `--snap-window s` widens the reach, `--no-snap` cuts exactly. |

Mutations print `revision · op <id> · tx <id>`, plus a `snapped … -> …` line per snapped edge and any `warning:`. In `--json`: `revision`, `operation.id`, `operation.tx`, `changes.added/updated/removed`, `snaps`, `warnings`.

## History

| Command | Use |
|---|---|
| `frameshell tx begin "<label>"` | Group the next operations of this session (every timeline) until commit or abort. Without it, a session's operations group until ~10 s idle. |
| `frameshell tx commit` | Keep them. |
| `frameshell tx abort` | Undo them all, or nothing when someone changed the same clips since (the error lists the conflicts). |
| `frameshell history [--since <tx>]` | Operations by transaction with author and touched ids; `--since` shows only what came after `<tx>`. |
| `frameshell revert <tx\|op>` | Undo a transaction or one operation as a new operation. Refused with the conflicting later operations when they touched the same clips: revert those first, newest first. |

`status` lists open transactions; one left open by a closed shell is ended with `FRAMESHELL_SESSION=<its session> frameshell tx commit` (or `tx abort`).

## Media, export, frames

| Command | Use |
|---|---|
| `frameshell transcribe <asset> [--language l] [--model m] [--provider p]` | Word-level transcript to `transcripts/`. Word ids stay stable across re-runs; human `edits` are kept. |
| `frameshell transcribe --verify <export> [--timeline id]` | Re-transcribe an export and report words lost at cuts; exit 1 when any was. |
| `frameshell render [--preset p] [--out file]` | Export; waits for the job and prints progress on stderr. Pending generated-clip renders are awaited. |
| `frameshell frame --at <s> --out <file.png> [--preset p]` | Write the composited frame at timeline second `s`, exactly as export renders it. Open the PNG to look at it. |

## Plugins

| Command | Use |
|---|---|
| `frameshell plugin install <spec>` | `github:<user>/<repo>[#ref]`, `git+<url>[#ref]` or an npm name. Pins it in `frameshell.json` and links the skills it ships into `.claude/skills/`. |
| `frameshell plugin remove <name>` | Unpin, uninstall, unlink its skills. |
| `frameshell plugin list` | Plugins with status and what they contribute (commands, clip types, providers, presets, skills). |
| `frameshell <plugin> <command> …` | A plugin command, e.g. `frameshell hyperframes new intro --duration 8`. |

A project that declares plugins loads them only once trusted: commands needing them fail with `ProjectNotTrusted` until the user agrees and you re-run with `--trust`.
