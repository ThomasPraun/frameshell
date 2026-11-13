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


Claude Code: **Connect Claude Code** in the agent guide (shown when Claude Code's settings exist) or `frameshell setup claude-code [--status | --remove] [--command path]` adds, at user level, the server to `~/.claude.json` (`mcpServers.frameshell`, as `claude mcp add --scope user` writes it) and a `UserPromptSubmit` hook to `~/.claude/settings.json` (both under `CLAUDE_CONFIG_DIR` when set). Code: `packages/cli/src/claude-code-setup.ts`, editing helpers shared with Claude Desktop in `packages/cli/src/config-file.ts`. Only Frameshell's entries change (comments and layout of the rest stay), each changed file is first copied to `<file>.frameshell-backup`, running it again changes nothing, and `--remove` takes the entries out. The hook command is `frameshell ask --take --target claude --hook`: it reads the prompt's JSON on stdin for the directory (`cwd`), starts no daemon and loads no plugin, prints nothing outside a Frameshell project or with the app closed, and always exits 0 (exit 2 would block the prompt). What it prints (the `[frameshell]` lines sent from "Chat about this") joins the prompt's context. The app passes its stable shim as the command; the CLI uses `frameshell` from PATH unless `--command` says otherwise.

Operations are attributed to `FRAMESHELL_SESSION` when set (app terminals set it), else to a session id made for this server run. They are journaled as `agent:<label>:<session>` when `FRAMESHELL_AGENT` names the agent, else when the MCP client's name does (`claude-code` becomes `agent:claude:…`, the same label its app terminals get), or when the app detected one in its terminal. Operations from one session group into transactions until an idle gap, so the model can revert its own work.

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
| `image_cutout(timeline, clip, mask)` | Image projects: the photo clip with a grayscale mask PNG as alpha, cropped to the mask, written as `assets/<photo>-cutout-<n>.png` and added as a layer right above the photo, exactly over it, in one transaction (ADR 0022). Same as `frameshell image cutout`. |
| `inspect_point(timeline, at, x, y, unit?, segment?)` | What a point of the frame shows (ADR 0011): clips under it topmost first, the one seen there, and in a generated clip the DOM element painting it, probed in its live page in managed headless Chrome with the app's Pick script. Elements need a trusted project; footage paints its whole box. `segment`: on a photo in an image project, three mask PNGs under `.frameshell/context/` and their boxes (ADR 0022). Same as `frameshell inspect`. |
| `frame_capture(timeline, at, preset?, projectFormat?, out?)` | The composited frame at `at` seconds, rendered by the daemon with the export compiler (single-frame plan, same as `frameshell frame`), as a PNG image scaled to fit 1280x1280, plus frame index and clip. `projectFormat` lays it out in that format of the project (ADR 0027). `out` also keeps the full-size image, as PNG, JPEG or WebP by its extension or `format` (`quality` 1-100); how an image project exports (ADR 0017). |
| `cover(timeline, text?, at?, color?, out?, preset?, format?, quality?)` | A cover image: the frame where `text` is first spoken (or `at`, else the first picture) with the word drawn big over it, as the export compiler renders it (the `cover` method; `frameshell cover`). Not returned as an image: JSON with `path`, `frame`, `at`, `source`, `text`, `readability` (the word's capitals at 180 px wide against the 12 px that read) and `warnings`; default file `exports/<timeline>-cover.png`. The `render` tool takes `cover` to make frame 0 of the video the same composition. |
| `review(timeline?, file?, from?, to?, sheets?, platform?, every?, projectFormat?)` | Contact sheet, phone sheet, fast-motion strips, loop seam and `metrics.json` of a timeline, or of an exported video with `file` (#457): written to `.frameshell/review/<n>/` (last 10 runs kept, project files untouched) and returned as images (at most 8, the first image of every sheet before a second of any, each scaled to fit 1568 px), then JSON with every sheet's path and size, its tiles' labels (`12.50 cut`: seconds and why) in reading order, the fastest moments with their energy, `metrics` and `warnings`. `metrics` (picture: longest still stretch, largest gap between visual events, near-blank frames, empty frame 0; subtitle cues too short to read; for a `file` loudness LUFS, range, true peak and phone band; `craft` warnings) is measured on grey frames and the sound, a timeline has no loudness. `sheets`: any of `contact`, `phone`, `motion`, `seam`, `safe`, `metrics` (default the first four and `metrics`, plus `safe` with `platform` or on a vertical film whose style guide names platforms). Same as `frameshell review`. |
| `analyze(file, name?, threshold?)` | Measure a reference video (#471): `file` is any video (absolute, or relative to `cwd`; only read). Written to `.frameshell/analysis/<name>/` (default name: the file name; a run of the same name replaces it; project files untouched) and returned as images (the contact sheet at 2 frames a second, cuts marked, and the shots sheet, the middle frame of every shot; at most 8, each scaled to fit 1568 px), then JSON: `shots` (`startFrame`, `endFrame`, `start`, `end`, `length` in seconds rounded down, `cutScore`, `image`, `palette`), `stats` (`shotCount`, `cutsPerMinute`, average, median, shortest and longest length), `palette`, `look` (brightness, contrast, saturation, warmth, an 8 x 6 `grid`; each shot has the four figures, its grid is in `analysis.json`), `rhythm` (`shotLengthCv`, `stillShare`, `longestStill`, big changes, `largestGap`, `bursts`), `events` (`flash`, `appear` / `disappear` with a `region`, `hold`, `hit` with an `offset` to a big change of the picture), `loudness` (LUFS, LU, dBTP), `tempo` (null without a steady beat; the beat lists are in `analysis.json`), every sheet's path and its tiles' labels, and `warnings`. `threshold` (0.05 to 0.95, default 0.3) is the scene score that opens a shot. A background `analyze` job. Same as `frameshell analyze`. |
| `frames_strip(timeline, from, to, count?, preset?, projectFormat?)` | `count` (2 to 16, default 6) evenly spaced frames from `from` to `to`, tiled into one contact sheet at most 1280 px wide, plus the time, frame and clip of each tile. |
| `clip_verify(timeline, clip, probes?, tolerance?)` | Not an image: JSON. Whether a generated clip paints a pure function of time (ADR 0033): its live page captured in managed headless Chrome at `probes` times (default 12), cold and after a reseek, compared per channel against `tolerance` (default 2 of 255). `ok`, per-probe `max`, `distinct` pictures, and the `worst` time, pixel and element. Needs the plugin trusted and an adapter with a live preview. Same as `frameshell clip verify`. |

## UI state and navigation

What the user sees in the app, and a way to take them somewhere (SPEC §7b, decision 20). The app publishes its state to the daemon; navigation is routed daemon → app window. MCP never talks to Electron, and nothing is pixel automation: each tool is one command the app applies to its shared stores (playhead `preview/transport.ts`, selection `selection.ts`, editor tabs, History panel).

| Tool | Does |
|---|---|
| `ui_state` | Playhead, playing, duration, selection (`clips`, `words`, time `range`, History entry marked, preview `region` with the clips under it, topmost first, picked `points` with the clip and element at each, the `person` picked in the People panel with their `spans`), editor tabs, timeline seconds `visible` in the timeline panel. `{ connected: false }` when no app window shows the project. |
| `ui_seek(at)` / `ui_play` / `ui_pause` | Drive the preview's transport. |
| `ui_select(clips?, words?, range?, reveal?, points?, person?)` | Replace the selection; unknown clip ids fail. `reveal` scrolls to the first clip. `points` (`{ at, x, y }`, fractions of the frame) are inspected by the daemon (`inspect.point`) and shown as picks, the playhead at the first (ADR 0011). `person` (`{ id, what? }`, id or exact name, `speaks` or `onscreen`) picks them as the People panel does: their spans of the main timeline and the words of their linked voices (ADR 0020); the daemon resolves the name, an unknown person fails with `InvalidOperation`. |
| `ui_open_file(file)` | Open a project file in an active editor tab. |
| `ui_show_tx_diff(target)` | History panel on a `tx_…`/`op_…`, its changes marked on the timeline. |

Navigation tools return the app's state after the command. No app: `UiNotConnected`; refused or no answer within 5 s: `UiCommandFailed` with the reason. The app reports every change within 200 ms (reports at most every 100 ms, only when something changed). Several windows on one project: the one focused last (else the one that reported last) gets commands. Wiring: daemon broker `packages/core/src/ui/broker.ts`, main `apps/desktop/src/main/ui-bridge.ts`, renderer `apps/desktop/src/renderer/src/ui-link.ts`. Internal methods `ui.publish`, `ui.reply`, `ui.detach`, `ui.active` and the `ui.command` notification carry it.

## References from the app (ADR 0025)

Each `frameshell mcp` process registers its client with the daemon as an **agent target** of its project on MCP `initialize` (a server started outside any project: on the project of its first call, re-registered when that follows another window), and the daemon drops it when the process exits. Target id = the client's agent label: `clientInfo.name` `claude-code` (Claude Code 2.1.317) becomes `claude`, the label its app terminals get. Several sessions of one client on one project share one target and one inbox. The app's "Chat about this" sends to a target with `inbox.put`; references wait in memory until read.

| Tool | Does |
|---|---|
| `inbox_take` | Takes (and removes) the references waiting for this client, oldest first: `[frameshell]` lines, then any request. `target` reads another one. |
| `inbox_wait(timeout?)` | Same, blocking until one arrives or `timeout` seconds pass (default 300, max 3600). |

`target.register`, `target.unregister`, `target.list` and `inbox.put` are internal; `target.changed` tells the app who is there, what waits and who read. The CLI side is `frameshell ask --take` / `--wait`. Wiring: `packages/core/src/targets/inbox.ts`, MCP `DaemonLink.register` in `packages/mcp/src/server.ts`, CLI `packages/cli/src/ask-command.ts`, app `renderer/src/ask/` (`chat-targets.ts`, `agent-targets.ts`).

### Claude Code channels (opt-in, research preview)

Without anything else, Claude Code reads references when it calls `inbox_take` or when its prompt hook runs `frameshell ask --take`. A **channel** lets Claude Code react to a reference at once, even idle, with no message from the person. It is off by default and **a Claude Code research preview**: flags and rules may change.

```sh
claude mcp add frameshell -- frameshell mcp --channel     # or set FRAMESHELL_CHANNEL=1 in the server's env
claude --dangerously-load-development-channels server:frameshell
```

- With `--channel`, `frameshell mcp` declares the `experimental['claude/channel']` capability and holds an `inbox.wait` for its client. Each reference arrives as `notifications/claude/channel`: `content` = the reference's `[frameshell]` lines, `meta` = `target` and `sent_at` (keys are letters, digits and underscores; Claude Code drops others). Claude Code shows it to the model as `<channel source="frameshell" target="claude" sent_at="...">...</channel>`.
- Frameshell is not on Claude Code's channel allowlist, so the development flag above is needed: an interactive session only (ignored with `-p`), a confirmation dialog on start, and `server:frameshell` is the name given to `claude mcp add`. On Team and Enterprise plans an admin must first turn channels on (`channelsEnabled` managed setting); the flag does not bypass it. Claude Code drops events silently when the session did not load the server as a channel or policy blocks it.
- A pushed reference is **taken** from the inbox, so it counts as read in the app and `inbox_take`, `--take` and the hook find nothing again: no double delivery. The cost: if Claude Code is not listening (session not started with the flag, org policy), the event is lost, not queued. Without `--channel` nothing changes.
- One-way: there is no reply tool. The hook and `inbox_take` remain the supported path; use a channel only for the reaction without a prompt.

Research on the other mechanism, Claude Code's cross-session messaging: [`docs/research/claude-code-channels-messaging.md`](research/claude-code-channels-messaging.md).

## Review mode (ADR 0019)

The person may turn on review mode for a project in the app (off by default). While it is on, every timeline change an MCP client makes waits as one **proposal** per transaction until the person accepts or rejects it in the app; nothing reaches the timeline file before. With it off, tools behave as without it.

| Tool | Does |
|---|---|
| `proposal_status` | The switch, the open proposal (author, label, state `building` or `ready`, operations, timelines, age) and the last decisions. |
| `proposal_wait(timeout?)` | Blocks until the open proposal is decided: `accepted`, `rejected`, `stale` (the person changed the same clips; `conflicts` names them) or `aborted`; `pending` after `timeout` seconds (default 300, max 3600), so call it again when the MCP client's own tool timeout is shorter. |
| `proposal_diff(tx?)` | What the open proposal adds, removes, moves or changes per timeline, in the shape of `history_diff`. |

While a proposal is open, another author's change, a new `tx_begin`, and its author's change once it is ready fail with `ProposalPending`; the error says to call `proposal_wait`. The author's own reads (`timeline_show`, `track_list`, `frame_capture`, `inspect_point`, and the timeline resource) show the proposal's version; `view: "current" | "proposal"` picks one. `render` always exports the file.

There is no accept, reject or switch tool: `proposal.accept`, `proposal.reject` and `review.set` are internal registry methods (skipped like `handshake`), and the daemon refuses them with `ProposalState` (reason `forbidden`) for any caller but the app (author `ui`). Review exists so the person decides; an agent that could accept its own proposal would make it pointless.

## Asset credits (ADR 0026)

Optional `credits.json`: where third-party assets came from. `asset_import` records it when given `sourceUrl`, `licence`, `author`, `title` or `credit` (one source per call); nothing is written otherwise.

| Tool | Use |
|---|---|
| `credits_set(asset, sourceUrl?, licence?, author?, title?, credit?)` | Record or complete an asset's provenance (`licence: "own"` for the person's footage). Fields left out keep their value while the file is unchanged. |
| `credits_check` | Read-only. Judges every asset the timelines place; `ok` is false when any is unverified (`unrecorded`, `no-licence`, `no-credit`, `changed`, `missing`). Returns the credit lines and `text` for the video description. The CLI `frameshell credits` exits 1 on `ok: false`. |

`render` also adds a warning for placed assets with no verified provenance, but only in a project whose ledger already holds an entry.

`render` with `loop: true` (ADR 0039) exports a file meant to repeat: audio ends faded, refused with `cover`, warnings for a broken cycle or a black end, and the finished job's `warnings` (`job_list`) says when the last frame repeats frame 0. `render` with `preset: "gif"` (ADR 0039) writes a silent looping GIF with the same loop rules, fitted inside 1200x1200, at most 30 fps and 350 frames (more is refused before queuing); `warnings` in the job report a file over 15 MB.

## People (ADR 0020)

Optional `people.json`: who is who across transcripts, multicam angles and faces. Until a tool writes it (`people_add` creates it), the people tools only read (an empty list, suggestions from multicam angles alone): no download, no job, no transcript change.

| Tool | Does |
|---|---|
| `people_list`, `people_add`, `people_rename`, `people_remove`, `people_link`, `people_unlink` | Edit people and their links (`speaker`, `angle` or `face`, one per call). Linking a speaker or renaming its person writes the name into the transcript. Links whose target is gone are `missing`, never removed. |
| `people_scan(assets?, force?)` | Face scan job (kind `people`): YuNet + SFace, locally, cached in `.frameshell/people/`. The only tool that downloads the face models. |
| `people_suggest(download?)` | Suggested links with `sg_…` ids (`speaker`, `face-speaker`, `face`, `angle`) and `hints`. Computes voice prints (CAM++, local) only when a person already has a linked speaker, downloading CAM++ and ONNX Runtime Web (~60 MB) once; faces come from cached scans only. `download: false` (what the app sends until the person asks) leaves voices out instead and returns `voiceDownload.bytes`. |
| `people_confirm(suggestions, reject?, person?)` | Apply or dismiss suggestions. Confirm only what the person agreed to or what is certain. |
| `people_ranges(person, kind?, timeline?)` | Timeline spans where the person speaks or is on screen; cut from the last span to the first. |

People changes are not timeline operations: review mode does not hold them, `history` does not list them. A link an agent makes (`people_link`, `people_confirm`) carries `by` and shows as "Confirmed by agent" in the People panel, where the person can unlink it or undo it with Cmd/Ctrl+Z. Nothing leaves the machine: prints stay in `.frameshell/people/`, never in `people.json`.

## Subject matte (ADR 0032)

| Tool | Does |
|---|---|
| `matte_prepare(asset)` | Matte job (kind `matte`): which pixels of each frame of a video are the person in front, MediaPipe's selfie segmenter on every proxy frame, smoothed and refined, cached per content in `.frameshell/cache/mattes/` as a grayscale video (frame N = proxy frame N). Returns its path; a second call returns it at once. The only tool that downloads the matte model. Same as `frameshell matte`. |

`track_set(track, behind: "<plate>")` puts a video track behind the person in front on a lower video track: export, `frame_capture` and `frames_strip` draw the plate's media clips again above it through their mattes while it shows a clip (not while a shown track between them does), making a missing one first (a render job's `matte` step). The preview does not draw it yet. `behind: null` clears it; removing or moving the plate track clears it too, with a warning.
## Sound effects (ADR 0038)

| Tool | Does |
|---|---|
| `sound_sfx(kind, variant?, seed?, pitch?, length?)` | Synthesize a sound effect offline (`click`, `tick`, `pop`, `whoosh`, `riser`, `thump`, `impact`, `shutter`; `variant` 1 to 3) into `assets/sound/<kind>-<key>.wav` and import it. The same arguments always give the same file (`state: "cached"`, nothing written); `seed` is a family seed, `pitch` multiplies every frequency, `length` is for `whoosh` and `riser`. `peakAt` is the second of the take that must land on the cue; nothing is placed on a timeline. Records the take as `own` work in `credits.json` when the project keeps one (`credited`). Idempotent per `idempotencyKey`. |
| `sound_place(cues?, cuts?, typing?, track?, timeline?)` | Make the takes (as `sound_sfx`) and place them in one transaction `Sound: …` (one proposal in review mode): `cues` are `{ at, kind, … }` with `at` seconds or a marker (`hook+0.5`), `cuts` puts a sound on the start of every clip after the first of a track (or the numbered `which`), `typing` is a run of tick or click keys between `from` and `to`. The take's `peakAt` falls on the time plus the offset of its `role` (a riser ends 75 ms before it); the clip starts on a frame. Sounds go on the audio track `SFX` (more where they overlap) with a gain from the style's `sfxUnderVoice` and the `tier`. Returns each clip, `skipped` sounds and `warnings` for crowded frames, short gaps and repeated takes. Idempotent per `idempotencyKey`. |
| `sound_music(preset, bpm?, meter?, bars?, length?, sections?, chords?, accents?, seed?, place?, at?, track?, gain?, timeline?)` | Synthesize a music bed offline (`synthwave`, `lofi`, `minimal`) from a seeded 16-step sequencer into `assets/sound/music-<preset>-<key>.wav` (48 kHz 24-bit stereo, -14 LUFS, sample peak at most -1 dBFS) and import it, with its exact beat grid `beats/sound/music-<preset>-<key>.beats.json` (`detector: "exact"`). Whole bars (`bars`, `length`, else to the end of the timeline) ending on a final hit (`hitAt`) that rings 2.5 s; `sections` `[{ kind, bars?, at? }]` (`intro`, `full`, `dark`, `build`, `gap`, `drop`, `outro`; `at` a time on the timeline, moved to the nearest bar), `accents` (times that get a crash and a big kick). With `place` (default) one transaction `Music: …` (one proposal in review mode) puts it at `at` on the audio track `Music` with a gain from the style's `musicUnderVoice`, and points the timeline's `tempo` at it when there was none. The same arguments always give the same file (`cached`). Records the take as `own` work in `credits.json` when the project keeps one. Idempotent per `idempotencyKey`. |

## Music on the cut (ADR 0037)

| Tool | Does |
|---|---|
| `music_fit(timeline?, clip, end, from?, hit?, exact?, dryRun?, skip?)` | Fit a music clip (a media clip of an audio track) so the track's own final hit lands on `end` (seconds, or a marker id or label) and it plays unspliced before it. The hit is `hit` (source seconds) or the last sharp jump in level near the end of the part the clip plays, with a `confidence` and the other `candidates`. Slides the clip at its speed (the intro is dropped before `from`, default 0; a track too short starts late, never looped); `exact` keeps the start and changes the speed by at most 1.7 % to land the hit exactly (a doubtful hit never does). `dryRun` returns the plan and its `steps`. A clip with duck keys gets duck again in the same transaction (`skip: ["duck"]` leaves them). One transaction `Music fit: …` (one proposal in review mode). |

## Batch variants (ADR 0040)

| Tool | Does |
|---|---|
| `voiceover_place(script, timeline?, lines?, at?, start?, gap?, track?, replace?, dryRun?)` | Put the takes `voiceover_generate` wrote on a timeline as phrase clips, in one transaction `Voiceover: …` (one proposal in review mode): each take is cut at its silences and every phrase becomes a clip on the audio track `Voiceover`, keeping the take's spacing. `at` maps a line id (`hook-1`) or one phrase (`hook-1.2`) to seconds, a marker (`hook+0.5`) or a grid point (`beat:9`, `bar:3`); lines with no `at` follow by `gap` seconds. Fails on overlap or on clips already playing the takes unless `replace` is true. Returns every clip (`dryRun` plans only). Idempotent per `idempotencyKey`. |
| `batch_render(file, out?, formats?, rows?, failed?, force?, dryRun?)` | Render one template timeline once per row of a batch file (`*.batch.json`): each row sets adapter clip props (`<clipId>.props.<path>`) or swaps a media clip's asset (`<clipId>.asset`, in/out kept) in memory, never under `timelines/`. Every row × format is checked first (a bad row fails with InvalidOperation naming `row` and `slot`); then rows render one at a time as `render` jobs into `exports/<batch name>/`, with `manifest.json` there rewritten on each job change. `dryRun` returns the plan only. Re-run: `rows` (ids, or `first..last` in file order) renders only those rows, `failed` only rows the manifest lists as not done (failed, canceled, or left queued/running by a stopped daemon); a chosen row whose entries are all `done` with its files in place is skipped (`skipped`) unless `force`. Never generates voiceover. Idempotent per `idempotencyKey`. |

## Beat grid (ADR 0029)

| Tool | Does |
|---|---|
| `beats_measure(asset, bpm?, resetEdits?)` | Beat grid job (kind `beats`): the tempo, every beat in source seconds, which beat starts a bar and a confidence of a music file, measured locally in a worker thread and written to `beats/<name>.beats.json`. `bpm`: the tempo you expect (the grid is the nearest octave). `low: true` in the result means it may be double time or a bar off; `alternatives` lists the other tempi. Keeps the person's `edits` unless `resetEdits`. Idempotent per `idempotencyKey`. |
| `beats_show(asset)` | The grid with the file's `edits` applied (`beats`, `downbeats`, `current`). Correct a grid by writing `edits` (`tempo`, `downbeat`, `offset`) into the file with `file_write`; it is validated. |
| `tempo_set(timeline?, clip? \| bpm?, offset?, meter?, clear?)` | The timeline's beat grid (ADR 0029): `clip` follows the measured grid of that music clip's asset (after `beats_measure`) and moves with the clip; `bpm` is a nominal grid for blocking before music exists; `clear` removes it. Journaled, revertible; removing the clip clears the tempo with a warning. |
| `tempo_show(timeline?)` | The stored tempo and its grid on the timeline clock (`beats` and `bars` in timeline seconds, `bpm`, `low`), or `problem` when the music has no beats file yet. `timeline_show` with `grid: true` embeds the same grid. Every time argument of `clip_add`, `clip_move`, `clip_trim`, `clip_split`, `clip_key`, `cut`, `transition_*` and `marker_*` takes `snapTo: "beat" \| "bar"` to land on it (refused on a LOW confidence grid). |

## Style (ADR 0028)

Optional `style.json`: the project's style guide as numbers (colours, fonts, type sizes, motion personality and overrides, sound levels under the voice, platforms, rules, banned list).

| Tool | Does |
|---|---|
| `style_show(view?)` | Every style value as `{ value, source }` (`file`, `personality`, `default`; a null default = not decided, ask the person), `from` (the user style it was copied from, with `status` `same`, `changed` or `missing`) and the safe zones of the platforms it names. `style` is null without a file. `view: "proposal"` shows an open review-mode proposal's version. Read-only; an invalid file fails with `InvalidProjectFile`. |
| `style_set(path, value)` | One value by its dotted path (`colors.accent`, `motion.duration.quick`, `fonts.display`, `banned`); `null` removes it so the personality's or default value applies. Creates `style.json` when missing. Journaled in the caller's transaction (ADR 0036): `revert` with its `op` undoes it; held by review mode. |
| `style_apply(name, replace?)` | Copy a user style (`style_list`) or a motion personality in, value by value (`replace: true` overwrites the file); `changes` lists every value that changed; records `from`. Journaled and held like `style_set`. |
| `style_save(name, force?)` | The project's `style.json` as user style `name` (`styles/<name>.json` in Frameshell's config folder). Not journaled. |
| `style_list` | User styles on this machine (id, SHA-256, personality, `error` when invalid) and the motion personalities. |

Every change of `style.json` goes through the config journal, `file_write` too (a write that changes a value is a `file.write` config operation). Nothing renders from the style yet.

## Resources

Compact JSON, the same as the matching `--json` CLI output:

| URI | Content |
|---|---|
| `frameshell://status` | `status`: daemon, project, plugin trust, jobs, rejected edits, open transactions, review mode and the open proposal |
| `frameshell://timelines/{timeline}` | `timeline.show` |
| `frameshell://timelines/{timeline}/history` | `history` |
| `frameshell://transcripts/{file}` | `transcripts/{file}` as written, e.g. `raw-01.words.json` |
| `frameshell://scripts/{file}/outline` | `script.outline` (one resource per `scripts/**/*.md`); the stdio contract test reads it |

Subscribed timeline and history resources get `notifications/resources/updated` on the daemon's `timeline.changed` event, from any client (CLI, app, file edit). A timeline not listed before, and a transcript written by this server's `transcribe`, send `notifications/resources/list_changed`. A subscribed `frameshell://status` gets it on every `proposal.changed`. A transcript this server's `transcribe_speakers` rewrote gets `notifications/resources/updated` when subscribed. After a lost daemon connection the server reconnects on the next request, renews its event subscription and marks every subscribed resource updated.

## Not yet

- Change notifications for transcripts written by other clients: they need daemon asset events (#69).
