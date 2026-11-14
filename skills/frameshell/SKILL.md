---
name: frameshell
description: Edit video, or a still image made of layers, in a Frameshell project (`frameshell.json`) with the `frameshell` CLI or its MCP tools. Cut footage by transcript (silences, retakes), edit a talking-head take into a vertical reel (short, TikTok), make a video from an audio recording, cut a conversation with several people (multicam: one file per person, cameras with separate mics or a gallery-view call recording, a director that switches to whoever speaks), write a script to record on camera (a shoot script, from the person's own script), generate a voiceover from a script with a speech provider, make sound effects (whoosh, click, riser, impact) offline, make a motion film from a brief with no footage (product launch, promo), place clips, overlays and subtitles, export and verify. Also covers resuming after the human's timeline edits and resolving pasted `[frameshell]` selection lines. Use whenever the directory holds `frameshell.json` or the user mentions Frameshell.
---

# Frameshell

Frameshell is an IDE for video. You edit the project from the terminal; the human watches the preview and the timeline, corrects by hand, then asks you to continue. The daemon `frameshelld` writes every project file. Each change you make through the `frameshell` CLI or an MCP tool becomes an **operation** with an author, grouped in a **transaction** the human can revert as one.

## Ground rules

- **Change the project through `frameshell` commands or MCP tools.** Read any project file freely. Direct edits of `timelines/*.json` are guarded (see [project-model.md](reference/project-model.md)); the commands validate, snap and journal for you.
- **The media in `assets/` is the person's footage.** Never edit, move, overwrite or delete it (imported copies are read-only). Write derived media under a new name and import it.
- **Read before you edit.** `frameshell timeline show --json` lists every track and clip with ids and times. Use those ids; after each change, take new ids from the command's output (`changes.added`).
- **Two clocks, both in seconds.** Timeline time: `start`, `cut --from/--to`, `frame --at`, `[frameshell]` lines. Source time: a clip's `in`/`out` and every transcript word. A source time `s` inside a clip plays at timeline time `clip.start + (s - clip.in) / speed`.
- **Parse `--json`.** On failure the JSON carries `error.code`, `error.message` and `error.data` (valid range, available ids, the fix). Apply the fix and retry.
- **One session per piece of work.** Inside the Frameshell app terminal `FRAMESHELL_SESSION` is already set. Elsewhere each shell your harness starts gets its own session, and a transaction only groups its own session's operations. When `echo $FRAMESHELL_SESSION` prints nothing, prefix every `frameshell` command with the same `FRAMESHELL_SESSION=<id>` (e.g. `FRAMESHELL_SESSION=agent-edit frameshell cut --from 3 --to 4`). MCP tools keep one session per server run.
- **Trust is the user's call.** Plugins run with full access to the machine. Pass `--trust` only after the user said they trust this project's plugins.

## Work loop

1. **Orient.** `frameshell status` shows the project, running jobs, open transactions and refused direct edits. No project: `frameshell init`. When it warns that the project is in a synced folder (Dropbox, iCloud Drive…), tell the person before working. Then `frameshell timeline show --json`.
2. **Open a transaction** named in the user's words: `frameshell tx begin "remove silences"`. One transaction per step the human might want to undo whole.
3. **Edit.** Every mutation prints its `revision`, `op` id and `tx` id; `cut` and `clip trim` also print where each edge **snapped**. `cut` also warns when it slices a generated clip: edit the audio before building visuals.
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

## Review mode

The person can turn on review mode (`frameshell status` prints `Review mode: on`). Your changes then do not touch the timeline or the project's formats: each transaction waits as one **proposal** the person accepts or rejects in the app. You cannot decide it. Your own `timeline show` and `format list` show your proposal's version.

- Close the transaction (`tx commit`), tell the person it waits for their review, then `frameshell proposal wait` (MCP `proposal_wait`). Exit 0 `accepted`: continue. 3 `rejected`: nothing applied; ask what to change. 4 `stale`: they changed the same clips or formats (`conflicts` lists the ids, `format:<id>` for a format); `timeline show` (or `format list`) again and redo the change. 5 `aborted`. 6 `pending`: still waiting; run it again.
- A change refused with `ProposalPending` means a proposal is already open (yours or another session's): run `proposal wait`, then retry.
- A new timeline file you write waits in the proposal too: it is not in `timelines/` until accepted, so put its whole content in one write. `tx abort` of changes made before review mode was on proposes the undo: wait for it like any proposal.
- `frameshell proposal status` shows the open proposal; `proposal diff` lists the clips it adds, removes or moves, and the formats it adds or removes. A `frameshell.json` write that changes `formats` waits in the proposal too, while its other keys apply at once. `style set`, `style apply` and a `style.json` write wait in it the same way (`style:<path>` keys in `conflicts`); `style show` reads your version, and so do `frame --format <id>` and `review --format <id>` for a format only your proposal adds. A hand edit of `formats` in `frameshell.json` or of `style.json` (an editor, a restored backup) is journaled as a `file.edit` by `file`, or waits as a proposal by `file` in review mode. `history --since <tx>` shows later what was accepted.

## In the app: what the human sees

When you guide the human through the app, name only these places; do not invent controls.

- **Transcript view.** Opened by the `Transcript` button in the editor tab strip, or by clicking a `transcripts/*.words.json` file in the Explorer sidebar. It lists the words of every asset on the timeline, in source order. Each asset section shows "N of M words on the timeline" and an `Open JSON` link to the raw file. A word you cut is **struck through**; clicking it restores it (a `ui` operation in history). Clicking or dragging over kept words selects them and moves the playhead there; right-click offers "Chat about this".
- **Timeline panel.** Clips per track. A cut removes the range and closes the gap: the clip splits at the cut and later clips move earlier. Markers (`marker add`) show on a lane under the ruler; the person adds, renames and deletes them from the ruler's menu, and dragged clips snap to them. A tempo (`tempo set`) draws a beat grid, bars stronger than beats, that dragged clips snap to too.
- **Layers panel** (image projects, in place of the timeline). One row per video track, topmost layer first: select, rename, opacity, move up or down, delete. `Export image` in the preview header saves PNG, JPEG or WebP. In a video project, File > New Image from Frame (Cmd/Ctrl+Shift+S) starts an image project from the frame at the playhead.
- **People** (sidebar tab, multicam and video projects). Suggestions on top with Confirm and Dismiss (a face shows its frame; a name field when nobody is named), `Scan faces`, then each person with their voices, angles and faces (`missing` marks, "Confirmed by agent"). Clicking a person selects their words in the transcript view and their spans on the timeline (Speaks / On screen); Cmd/Ctrl+Z there undoes the last people change, yours included.
- **History** (sidebar tab beside Explorer). Transactions newest first: author (`You`, `Terminal`, `agent: <label>`, `File`, `Plugin`), label, operation count, time. Selecting one marks its changes on the timeline (`+` added, `−` removed, `↔` moved, `~` changed); `Revert` undoes it. `ui_show_tx_diff` opens it on your transaction.
- **App terminal tools.** In an app terminal the ffmpeg, ffprobe and whisper-cli Frameshell uses are in `$FRAMESHELL_FFMPEG`, `$FRAMESHELL_FFPROBE`, `$FRAMESHELL_WHISPER_CLI` (e.g. `"$FRAMESHELL_FFMPEG" -i assets/talk.mp4 -af volumedetect -f null -`). Managed downloads are also on `PATH`; `binaries` overrides are only in the variables. Prefer the variables: a login profile may put another ffmpeg first on `PATH`. Unset = not downloaded when the terminal opened; Frameshell downloads them on first use, a new terminal then sees them.

## Reference

| When | Read |
|---|---|
| Editing footage by its words: import, transcribe, silences, retakes, subtitles, export, verify | [transcript-editing.md](reference/transcript-editing.md) |
| A short-form reel, short or TikTok from a take of the person talking to camera: intake, vertical canvas and other formats, passes (words, `cleanup`, captions, graphics plan on markers, a big word behind the head, zooms, voice and `duck`), draft and final renders, the cover, safe zones, notes as rules, checks before handing over | [reels.md](reference/reels.md) |
| A title loop, banner, GIF for a README or X, or any file that repeats: `render --loop`, `render --preset gif`, what a seam is, authoring so the last frame leads into the first, the warnings and what they ask for | [loops.md](reference/loops.md) |
| Variants of one finished edit (languages, product rows, sizes) from data rows: `batch` with a `*.batch.json` (slots into clip props and assets), `--dry-run`, the manifest, re-running failed rows (`--failed`, `--rows`, `--force`), per-language voiceover rows, and why batch is never a way to make episodes | [batch.md](reference/batch.md) |
| A motion film from a brief with no footage (launch film, product promo): intake, three storylines, assumptions with a free alternative to every paid item, style guide, beat grid and time budget, storyboard in bars and the OK, board, animatic, cuts, sound and music on the grid, formats, finals | [motion-films.md](reference/motion-films.md) |
| Before showing a reel or a generated video: contact and phone sheets of the export, a fresh critic, the scoring rubric with caps, comparing versions, scoped fix notes, when to stop | [critique.md](reference/critique.md) |
| "Make it like this video": measure a reference (`analyze`): shot table, cuts per minute, contact sheet, palette, look, rhythm, events (flashes, elements appearing, holds, sound hits), the activity curve and its eases, ink (how much text and graphics cover), mouth against voice, loudness, tempo; compare our film with it (`analyze diff`: activity alignment, SSIM, a side-by-side sheet); labelling what is MEASURED, ESTIMATED or a DECISION, taking the grammar and never the content | [reference-video.md](reference/reference-video.md) |
| A video made from an audio recording (podcast, talk, voice note): simple, medium or explainer, the scene plan, building clips per scene | [video-from-audio.md](reference/video-from-audio.md) |
| A story-led animated short (60-70 s, vertical) told by the person's own voice: five true-story pitches, script budget, `sources.md`, the shot list as a contract (reads, camera with a reason, beats in frames, acting line), flat characters in lit sets with a 3D hero prop, captions, platform rules; a song-led film | [story-shorts.md](reference/story-shorts.md) |
| A conversation with one file per person, cameras with separate mics, or a gallery-view call recording (podcast, interview, panel, Zoom/Meet/Teams): multicam group, sync check, mics, template, `direct`, reviewing low-confidence shots, keeping the human's shots, reframing for 9:16, correcting who speaks by hand; one file or mic for several people (speakers on transcript words) | [multicam.md](reference/multicam.md) |
| Writing a script to record (YouTube, podcast, a call with several people) from the person's own script or idea: shoot script format (`shoot: true`, `**Name:**` speakers, `[LABEL: …]` cues, `[FREE: …]`), the original stays untouched, `script check`; takes compared against it, deviations, choosing takes (`shoot add`, `shoot status`, `shoot accept`), the first cut (`shoot assemble`) | [shoot-scripts.md](reference/shoot-scripts.md) |
| A narration generated from text: voiceover script (`voiceover: true`, `{display\|spoken}` respellings, numbers spelled out), `voiceover generate` then `voiceover place` (phrase clips on markers or beats), cached takes in `assets/voiceover/`, phrases and misreads of each take, paid providers need the person's confirmation (`--yes`) | [voiceover.md](reference/voiceover.md) |
| Sound effects made offline (click, tick, pop, whoosh, riser, thump, impact, shutter): `sound sfx`, seeds and variants, `sound place` on markers, cuts and typing runs (offset by role, gain by tier, warnings), how many and where (taste), credits; a music bed made offline (`sound music`: synthwave, lo-fi, minimal; parts, drop on a marker, exact beat grid, final hit) | [sound.md](reference/sound.md) |
| Music on the cut: the track's last hit landing on the end-card cut (`music fit --end <marker or second>`), where the music then starts, `--exact` varispeed within 1.7 %, `--hit`, dry run, duck keys after a move, candidate tracks at one loudness (`music candidates`), cuts moved onto the beat (`music grid`), `duck --level` | [music.md](reference/music.md) |
| An image project (`"kind": "image"` in `frameshell.json`): a still picture made of layers, edited by pointing at it, exported as PNG, JPEG or WebP | [image-projects.md](reference/image-projects.md) |
| Dissolves, fades, wipes, pushes, irises, dip cuts (picked by cause), zooms and other animated clip properties (`transition set`, `clip key`), framing a clip for vertical around a face (`clip reframe`), music ducking under speech (`duck`) | [transitions.md](reference/transitions.md) |
| Who is who across files: people linked to transcript speakers, angles and faces (`people add`, `people link`, `people list`), voices and faces suggested across files (`people suggest`, `people confirm`), when a person speaks or is on screen (`people ranges`), speaker names in transcripts | [people.md](reference/people.md) |
| Music with a beat grid: `beats measure` and `beats show`, confidence and LOW grids, `edits` (half or double time, bar start, offset), the file `beats/<name>.beats.json`; the timeline's `tempo set` and `--snap-to beat\|bar\|marker` | [project-model.md](reference/project-model.md#beat-grid) |
| Third-party assets (textures, sounds, fonts, music, logos): fetching them safely, recording source and licence on import, `credits` before export, the credit text for the video description; capturing a brand (logo, colours, fonts) from the person's site with `brand capture` | [credits.md](reference/credits.md) |
| Any CLI command: what it does, key flags, output | [cli.md](reference/cli.md); `frameshell --help` has every flag |
| MCP tools, CLI or MCP, frame capture, what the user sees in the app (`ui_state`, `ui_*`) | [mcp.md](reference/mcp.md) |
| The prompt holds a `[frameshell] …` line, or the user says "this" or "what I sent" from the app while you run outside its terminals (`inbox_take`, `frameshell ask --take`) | [selection.md](reference/selection.md) |
| Project files on disk: `frameshell.json`, timeline, transcript, script; direct file edits | [project-model.md](reference/project-model.md) |
| The person's style: colours, fonts, type sizes, motion personality, sound levels, platforms and safe zones, rules and banned list (`style.json`, `style show`) | [project-model.md](reference/project-model.md#style) |
| Titles, lower thirds, animated overlays (HyperFrames clips) | The `hyperframes` skill, exposed when `@frameshell/hyperframes` is installed (`frameshell plugin list` shows its skills) |
| React-built scenes, UI demos, overlays from the user's React code (Remotion clips) | The `remotion` skill, exposed when `@frameshell/remotion` is installed |
