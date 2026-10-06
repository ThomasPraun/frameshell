---
name: frameshell
description: Edit video in a Frameshell project (`frameshell.json`) with the `frameshell` CLI or its MCP tools. Cut footage by transcript (silences, retakes), place clips, overlays and subtitles, export and verify. Also covers resuming after the human's timeline edits and resolving pasted `[frameshell]` selection lines. Use whenever the directory holds `frameshell.json` or the user mentions Frameshell.
---

# Frameshell

Frameshell is an IDE for video. You edit the project from the terminal; the human watches the preview and the timeline, corrects by hand, then asks you to continue. The daemon `frameshelld` writes every project file. Each change you make through the `frameshell` CLI or an MCP tool becomes an **operation** with an author, grouped in a **transaction** the human can revert as one.

## Ground rules

- **Change the project through `frameshell` commands or MCP tools.** Read any project file freely. Direct edits of `timelines/*.json` are guarded (see [project-model.md](reference/project-model.md)); the commands validate, snap and journal for you.
- **Read before you edit.** `frameshell timeline show --json` lists every track and clip with ids and times. Use those ids; after each change, take new ids from the command's output (`changes.added`).
- **Two clocks, both in seconds.** Timeline time: `start`, `cut --from/--to`, `frame --at`, `[frameshell]` lines. Source time: a clip's `in`/`out` and every transcript word. A source time `s` inside a clip plays at timeline time `clip.start + (s - clip.in) / speed`.
- **Parse `--json`.** On failure the JSON carries `error.code`, `error.message` and `error.data` (valid range, available ids, the fix). Apply the fix and retry.
- **One session per piece of work.** Inside the Frameshell app terminal `FRAMESHELL_SESSION` is already set. Elsewhere each shell your harness starts gets its own session, and a transaction only groups its own session's operations. When `echo $FRAMESHELL_SESSION` prints nothing, prefix every `frameshell` command with the same `FRAMESHELL_SESSION=<id>` (e.g. `FRAMESHELL_SESSION=agent-edit frameshell cut --from 3 --to 4`). MCP tools keep one session per server run.
- **Trust is the user's call.** Plugins run with full access to the machine. Pass `--trust` only after the user said they trust this project's plugins.

## Work loop

1. **Orient.** `frameshell status` shows the project, running jobs, open transactions and refused direct edits. No project: `frameshell init`. Then `frameshell timeline show --json`.
2. **Open a transaction** named in the user's words: `frameshell tx begin "remove silences"`. One transaction per step the human might want to undo whole.
3. **Edit.** Every mutation prints its `revision`, `op` id and `tx` id; `cut` and `clip trim` also print where each edge **snapped**.
4. **Check the result** the way the change is visible: `timeline show` for structure, `frame --at <s>` (MCP `frame_capture`) for anything on screen, `transcribe --verify` after an export that cut speech.
5. **Commit:** `frameshell tx commit`. Tell the user what changed and the `tx` id.

Done = transaction committed, result checked, tx id reported. That tx id is your **resume point**.

## Resume from the human's edits

When the user says they changed something, or just "continue":

1. `frameshell history --since <resume point> --json` lists every operation after your last transaction, grouped by transaction, with `author`: `ui` (the app), `file` (a direct file edit), another `cli:`/`agent:` session.
2. Read each as intent. A `clip.add`/`clip.trim` with `ripple` over a range you cut = the human restored it: keep that material. A `revert` of your transaction = they rejected that change. `history_diff` (MCP) shows the clips an entry moved.
3. `frameshell timeline show --json` again: ids and times have moved.
4. Continue from the current state. Keep every human change; redo rejected work only when asked.

Lost the resume point? `frameshell history --json`: your transactions carry your author (`agent:<label>:<session>` or `cli:<session>`); the last one is it.

## In the app: what the human sees

When you guide the human through the app, name only these places; do not invent controls.

- **Transcript view.** Opened by the `Transcript` button in the editor tab strip, or by clicking a `transcripts/*.words.json` file in the Explorer sidebar (`Open JSON` there shows the raw file). It lists the words of every asset on the timeline, in source order, with "N of M words on the timeline". A word you cut is **struck through**; clicking it restores it (a `ui` operation in history). Clicking or dragging over kept words selects them and moves the playhead there; right-click offers "Ask agent".
- **Timeline panel.** Clips per track. A cut removes the range and closes the gap: the clip splits at the cut and later clips move earlier.
- **History** (sidebar tab beside Explorer). Transactions newest first: author (`You`, `Terminal`, `agent: <label>`, `File`, `Plugin`), label, operation count, time. Selecting one marks its changes on the timeline (`+` added, `−` removed, `↔` moved, `~` changed); `Revert` undoes it. `ui_show_tx_diff` opens it on your transaction.
- **App terminal tools.** In an app terminal the ffmpeg, ffprobe and whisper-cli Frameshell uses are on `PATH` and in `$FRAMESHELL_FFMPEG`, `$FRAMESHELL_FFPROBE`, `$FRAMESHELL_WHISPER_CLI` (e.g. `"$FRAMESHELL_FFMPEG" -i assets/talk.mp4 -af volumedetect -f null -`). Prefer the variables: a login profile may put another ffmpeg first on `PATH`. Unset = not downloaded when the terminal opened; Frameshell downloads them on first use, a new terminal then sees them.

## Reference

| When | Read |
|---|---|
| Editing footage by its words: import, transcribe, silences, retakes, subtitles, export, verify | [transcript-editing.md](reference/transcript-editing.md) |
| Any CLI command: what it does, key flags, output | [cli.md](reference/cli.md); `frameshell --help` has every flag |
| MCP tools, CLI or MCP, frame capture, what the user sees in the app (`ui_state`, `ui_*`) | [mcp.md](reference/mcp.md) |
| The prompt holds a `[frameshell] …` line | [selection.md](reference/selection.md) |
| Project files on disk: `frameshell.json`, timeline, transcript, script; direct file edits | [project-model.md](reference/project-model.md) |
| Titles, lower thirds, animated overlays (HyperFrames clips) | The `hyperframes` skill, exposed when `@frameshell/hyperframes` is installed (`frameshell plugin list` shows its skills) |
