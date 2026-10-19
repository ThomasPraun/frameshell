# `frameshell` CLI

Thin client of the daemon: it starts `frameshelld` when none runs, acts on the project enclosing the current directory, and exits 0 (ok), 1 (command failed) or 2 (usage error). Add `--json` to parse the output. Timeline commands take `--timeline <id>` (default `main`). `frameshell --help` lists every flag; this page says what each command is for and what to watch.

## Project

| Command | Use |
|---|---|
| `frameshell init [dir] [--name <name>]` | Scaffold a project: `frameshell.json`, empty `timelines/main.json`, `assets/`, `transcripts/`, `scripts/`, `compositions/`, and this skill under `.claude/skills/frameshell/` (`--no-skill` leaves it out). Fails on an existing project. |
| `frameshell status` | Daemon, project, plugin trust, synced-folder warning, jobs, refused direct edits, open transactions. First command in a new session. |
| `frameshell doctor [--install]` | ffmpeg/ffprobe and encoders; exit 1 with the fix when rendering is blocked. `--install` downloads the managed binaries. Also says which `frameshell` PATH runs and whether it is this CLI (a note, never an exit 1). |
| `frameshell import <file…> [--link] [--wait]` | Copy media into `assets/` and ingest it (proxy, audio sidecar, waveform, thumbnails). Without `--wait` it returns at once; `status` shows progress. |
| `frameshell gc [--dry-run]` | Free disk: delete regenerable files under `.frameshell/` nothing uses (proxies, sidecars, waveforms, thumbnails, transcription audio of deleted or replaced assets; clip renders no clip keys; Ask agent captures in `.frameshell/context/` older than 7 days). `--dry-run` lists them first. Never touches `assets/`; deleted outputs rebuild on demand. |
| `frameshell script outline <file>` | Scenes (`## ` headings) of a Markdown script with their `scriptRef` anchors and linked clips, and for scenes with a `<!-- words: ... -->` comment the timeline span of their words. |
| `frameshell mcp` | Serve the MCP tools on stdio (see [mcp.md](mcp.md)). |

## Timeline

| Command | Use |
|---|---|
| `frameshell timeline show` | Every track and clip: ids, `start`/`end` (timeline), `in`/`out` (source), speed. `--json` is compact on purpose. |
| `frameshell track list` | Tracks bottom to top (first video track = bottom layer). |
| `frameshell track add <video\|audio\|subtitles> [--name n] [--index n]` | New track, on top unless `--index`. Subtitle tracks need `--follows <track>`; `--preset big-keyword\|plain`, `--position top\|center\|bottom`. |
| `frameshell track set <track> …` | Rename (`--name`, `--clear-name`); subtitle `--follows`, `--preset`, `--position`. |
| `frameshell track remove <track> [--force]` | `--force` when it holds clips. |
| `frameshell clip add <track> [asset] …` | Place media (`--start`, `--in`, `--out` or `--duration`, `--speed`), or an adapter clip (`--type hyperframes --source <html> --duration s --props '<json>'`). Overlay placement `--x --y --scale --opacity`. `--ripple` inserts, moving later clips right on every video, audio and program track; `--ripple-track <track>` (repeatable) limits that to the clip's track plus the named ones. `--snap` snaps media `in`/`out` into pauses. |
| `frameshell clip move <clip> [--start s] [--track t]` | Same length, new place; refused on overlap. |
| `frameshell clip trim <clip> [--in s \| --start s] [--out s \| --end s]` | `--in`/`--out` in source seconds, `--start`/`--end` in timeline seconds. Snaps like `cut`. `--ripple` moves later clips by the length change: the inverse of `cut`. `--ripple-track <track>` (repeatable) as for `clip add`. |
| `frameshell clip split <clip> --at s` | Left part keeps the id; the right part's id is in `changes.added`. |
| `frameshell clip remove <clip>` | Leaves a gap; to close it use `cut`. |
| `frameshell clip set <clip> …` | `--speed`, `--gain` (dB, negatives as `--gain=-6`), `--muted`/`--unmuted`, `--x --y --scale --opacity`, `--props '<json>'` (replaces), `--script-ref <script#scene>`/`--clear-script-ref`. |
| `frameshell multicam create <asset> <asset>… [--name <angle>…] [--group-name n]` | One video file (with sound) per person. Measures every file's offset against the **first** by audio cross-correlation, adds a group, a program track and one `grid` shot over the whole length. Prints each file's offset and confidence; below 0.5 the file got no shared sound to match, is **not** shifted (offset as the first file) and `warning:` says so: check it by watching or listening, then fix it with `multicam offset`. `--name` once per file in order (default: file name). Only the first 10 minutes of each file are matched. |
| `frameshell multicam offset <group> <angle> <seconds>` | Set one angle's offset by hand: the group second where its file's time 0 plays (absolute, not negative; smaller = that angle plays earlier against the others). To start an angle before the others, raise theirs. Refused when a shot would play past the group's new end: trim it first. |
| `frameshell cut [track…] --from s --to s` | Remove a timeline range on every video, audio and program track (or the listed ones) and close the gap. Edges snap into audio pauses; `--snap-window s` widens the reach, `--no-snap` cuts exactly. |

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
| `frameshell inspect --at <s> (--point x,y \| --px X,Y) [--timeline id] [--json]` | What a point of the frame shows: the clips under it (topmost first, which one is seen) and, in a generated clip, the DOM element painting it (selector, text, box, styles, file or React components, ancestors). `--point` takes fractions of the frame, `--px` project pixels. Use it to find what "the box at the top right" is before editing it, and to check the edit landed. Generated clips load in headless Chrome (a second or two each) and need a trusted project. |

## Plugins

| Command | Use |
|---|---|
| `frameshell plugin install <spec>` | `github:<user>/<repo>[#ref]`, `git+<url>[#ref]`, an npm name, or a local tarball from `npm pack` (`./name-1.0.0.tgz`; one from outside the project is copied to `vendor/`; pinned with its sha256: a changed file is never installed). Pins it in `frameshell.json` and links the skills it ships into `.claude/skills/`. |
| `frameshell plugin remove <name>` | Unpin, uninstall, unlink its skills. |
| `frameshell plugin list` | Plugins with status and what they contribute (commands, clip types, providers, presets, skills). |
| `frameshell <plugin> <command> …` | A plugin command, e.g. `frameshell hyperframes new intro --duration 8`. |

A project that declares plugins loads them only once trusted: commands needing them fail with `ProjectNotTrusted` until the user agrees and you re-run with `--trust`.
