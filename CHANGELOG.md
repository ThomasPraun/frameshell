# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Zoom a screen recording to where the action is: Shoot now records the mouse pointer's position while it records a
  whole screen (a hidden `.screen.pointer.json` next to the screen file), and `frameshell clip zoom <clip> --follow
  pointer` (MCP `clip_zoom`) pushes in where the pointer rests and eases back out when it moves on, as `scale`, `x`
  and `y` keys in one transaction. Given the Shoot session's `screen` shot, it places the screen file over the shot
  (muted, on a new `Screen zoom` track) and zooms that. Only the position is recorded, not clicks (ADR 0049, #797).
- A Claude Code mod (`mods/frameshell`, installed with `/plugin install frameshell --marketplace
  ThomasPraun/frameshell`): a pane beside the chat with the project's jobs, the review proposal waiting for the
  person and a frame of the timeline (`/frameshell frame <seconds>`), a band above the prompt while a proposal
  waits, and a status line entry. Read-only: proposals are still accepted in the app (#798).
- A generated clip's inspector opens with its own section: plugin type, live render state, the whole reason of a
  failed render (or where to trust the project's plugins), its composition with Open, and a Motion blur switch with
  the blurred render's state. The clip's context menu has "Open composition" (#746).

- Daemon event `transcription.progress` (protocol 185): every `transcribe` run of a project, from any client, announces
  its steps and its end to subscribers. The app shows a transcription started from the CLI or by the agent in the
  status bar, as it does for its own (#742).

- File > New Project from Video… (Ctrl+N, ⌘N on macOS) and File > New Video from an Idea… start a project from any
  window: they open the welcome screen (a window already on it, else a new one) already choosing videos or showing
  the idea form (#740). Help > Welcome Screen shows the welcome screen again.

- Release notes start with one download per OS (Windows, macOS Apple silicon and Intel, Linux AppImage and deb) above
  the generated changes (#740).

- View > Shoot (Ctrl+Alt+R, ⌘⌥R on macOS) and View > Teleprompter (Ctrl+Alt+P) open those sidebar views, showing a
  hidden sidebar first (#737). Disabled in image projects.

- A global shortcut ends a recording shoot from any app (#744): Ctrl+Alt+Shift+S (⌘⌥⇧S on macOS), held only while
  a session records, so remote help or a person in a call app can stop it while Frameshell's windows are hidden from
  captures. The Shoot view says so while recording; when another app owns the keys, End stays the only way and no
  hint shows.

- Cut words in the transcript view: select words and press Delete (or Backspace), use "Cut selected words" on the
  toolbar, or "Cut word" in the word's menu. The words leave the timeline as one undo step, later clips move up, and
  each cut edge sits halfway to the next word so no neighbour loses a syllable. The toolbar hint now wraps instead of
  being cut off (#741).

- Export video from the app: File > Export video… (Cmd/Ctrl+E) and an Export video button in the preview header of a
  video project ask where to save the MP4, render it in the background with the progress on the button, then name the
  file, say what the export left out and offer Show file. Before, a film could only be exported with `frameshell render`
  in a terminal (#738).

- Put media on the timeline without an agent: right-click a video, sound or picture in `assets/` in Files and choose
  Add to timeline (it goes at the end of the first track of its kind, a Video or Audio track is added when there is
  none), or drag it from Files onto a track to place it there. One undo takes it off. The empty timeline says so (#738).
- Website: a docs section at frameshell.dev/docs (and /es/docs), in English and Spanish. Getting started (install,
  connect your AI, your first video), how it works, editing by hand, history and review, a guide per kind of video
  (cutting by words, subtitles, shorts, multicam, shoot, video from audio or from an idea, titles, transitions, colour,
  music, sound, voiceover, images, brand, people, reference video, variants, export), plugins, CLI and MCP, a FAQ and
  troubleshooting. The header's Docs link goes there instead of the specification.

### Changed

- Timeline by hand (#747): track headers show sound and picture switches that mute and hide the track with one
  click (lit while on; the header menu still has them); "Zoom to fit" and the 0 key fit the clips themselves, so a
  10 s video fills the panel instead of a sixth of it (the panel still opens on at least a minute); Ctrl+wheel past
  the last clip zooms around the clips' end, so they stay in view; `M` names a new marker at the playhead, also in the
  ruler and empty-lane menus; tooltips name tracks and clips (`V1 · Interview`, "generated (titles)") and never show
  their ids; a track's menu stops offering "Add subtitles of V1" once V1 has a subtitle track, and the toolbar's
  subtitle button picks a track without subtitles first.

- The timeline hatches a generated clip only until its render is ready, and marks a failed render red with the
  reason in its tooltip (#746).

- Clip inspector wording per clip: a video clip offers "Use an image instead…", not "Replace image…"; Transitions
  and Keyframes have visible headings; the Look menu shows the look a clip took, or "Adjusted" (#746).

- New project from video or audio asks about transcription once: the form's "Transcribe what is said" box now shows
  the real download size on this computer (or that there is nothing to download), and no native box asks again after
  Create (#742).

- A long setup step in the status bar (loading the transcription model, transcribing) shows how long it has run, and
  after a minute with no percentage says it is slow without a GPU, with a smaller model as the way out (#742).

- Shoot takes are transcribed in the script's language when the project sets none, guessed from the script's words
  (Spanish, English, Portuguese, French, German), instead of English by default (#742).

- "Chat about this" with no agent running copies the reference to the clipboard, shows the terminal and says to start
  an agent, instead of typing it at a shell prompt where Enter would run it (ADR 0048, #743).

- Desktop: on Windows the app's terminals detect the agent running in them (Claude Code, Codex, ...) from the process
  table, as macOS and Linux do from the foreground process, so Chat about this types at it without Connect Claude Code
  (ADR 0048, #743).

- The agent skill has rules for talking to the person: say what was measured, never "I listened" or "I watched"; ask
  whether a note is a wish or a complaint before changing anything; ask the goal, references, format and length before
  any new kind of film; show the storyboard before any paid run. `project-model.md` adds how to make a style your own:
  three lists (safe to change, changes its character, cannot change), at most five changes a round, one frame first,
  before next to after (#803).

- `frameshell history sound <tx|op>` (MCP `history_sound`) proves a sound edit touched only what it meant to: per
  track, the time ranges where the level moved 1 dB or more between right before and right after the transaction,
  whether sound came in, went or changed level, and by how many dB. Measured like the sound review, from each clip's
  envelope with its gain and fades, never mixed (#803).

- Five particle and light overlays for HyperFrames clips, `fx-sparks`, `fx-confetti`, `fx-glow`, `fx-shockwave` and
  `fx-rays` (`frameshell hyperframes new <name> --template fx-sparks`): seeded, drawn as a pure function of time on a
  transparent canvas, coloured by the style's accent and ink, with hits at set times or on the music's beats
  (`onBeats`), so a sound placed on the same beat lands on the same frame (#802).

- `frameshell analyze` prints a short card first (`card.md`, about 300 tokens): every headline number with its
  MEASURED, ESTIMATED or DECISION label, then the layers to open next with their size (`shots.md`, one line per shot;
  `analysis.json`, every value). `--full` prints every value as before; the result gains `card` and `layers` (#801).

### Fixed

- The real HyperFrames tests start their own headless Chrome without its sandbox when they run as root (a CI or
  cloud container), as the producer's renders already do; before, they failed there before drawing anything.
- Removing a download (`frameshell doctor --remove`, the app's Downloads) waits while a one-off request may be using
  it, such as a frame capture or a clip check, as it already did for jobs and transcriptions. Before, the file could
  disappear under a running ffmpeg or Chrome (#790).
- The Plugins view, `frameshell plugin catalog` and the MCP catalog size the speech model the project transcribes
  with (its model, else this machine's default) instead of always whisper-cpp's default; a model added with
  `model add` counts as already on disk (#789).
- Desktop, Spanish and every language: History names entries by their title, never their id. A revert reads
  "Revertir «Mover clip»", the timeline's change legend names the entry and gives way to the counts, and a terminal
  session's id moves to the author's tooltip. The app's own journal labels ("Move clip", "Apply look", "Delete 2 clips")
  are shown translated; the journal stays English. Counts agree in number ("1 eliminado"), undo and redo say what came
  back ("Deshecho: Mover clip"), and file-system failures (EACCES, EPERM, ENOTDIR, EEXIST, ENOSPC, EROFS, ENOENT) read as
  sentences with their path and stay in the status bar until closed. The idea form's checks, an untitled video's folder
  and an image-from-frame folder use the UI language (#748).
- Desktop: export notices say where the file went. An OpenTimelineIO or Premiere XML hand-off names what the file
  leaves out with a "Details" list instead of a CLI command, and stays until closed; it and Export image offer
  "Show in folder". Save dialogs open in the project's `exports/` folder, made when missing (Windows opened its
  parent). An image saved without an extension gets `.png`; one the app cannot write is refused by name (#749).
- Desktop: formats and safe zones from the app. The preview's format switcher is always there: the main format reads
  "Main · 1920×1080", others by aspect ("9:16 · 1080×1920"), and "Add format" adds a built-in one through the daemon
  (journaled like `format add`). The idea form lets you mark which ticked format is the main one; before, the first in
  the fixed list always won. The two unlabelled dashed rectangles gave way to a "Safe zones" switch with a platform
  choice (Instagram Reels, TikTok, YouTube Shorts, YouTube) drawn from `safe-zones.ts`, labelled and shaded, following
  the frame's shape until you pick one. A narrow preview stacks its tools, playback buttons and notice instead of
  letting the notice cover the tools (#750).
- Desktop, image projects (#751):
  - New image from this frame at the very end of a video takes the last frame instead of failing after the size
    question. The size question no longer offers the same size twice, and the folder names the size
    (`interview frame 00-02 1080x1920`).
  - GIF and WebP layers come in at their own size: sizes are read from the file header, not Electron's PNG/JPEG
    reader. A picture bigger than the canvas fits inside it, so it can still be seen and grabbed. Replace image keeps
    the new picture's own size in an image project.
  - Scale reads against the picture's own pixels (100 % = each pixel once).
  - Layers has an "Add image…" button, also in the empty state, and the empty-canvas hint can be read.
  - A video dropped on an image project is named as staying in `assets/` only.
  - The new-project form shows the layer order (bottom first, which sets the size) with Up and Down, drops files that
    are not media (a `.txt`), and explains that pictures among videos become still clips.
  - The inspector speaks of layers, not clips or track letters.
  - The Angles tab is gone from image projects.
  - A layer whose name is cleared shows its file name without the extension.
  - Pick asks before downloading its photo model (with its size), and a failed download reads as one sentence.
- Desktop, new video from an idea (#752, #740):
  - The brief is kept in the project as `brief.md`, so the agent can read it and it survives a restart. Before, it
    lived only in the app's memory.
  - The agent guide shows the film's prompt with "Copy prompt" even with no agent running, for Claude Desktop or
    ChatGPT. Hiding it or using it no longer loses it: one link offers it again.
  - The form asks what the video is about (optional), and that goes into the brief and the prompt.
  - 90 seconds reads "About 90 seconds", not 2 minutes.
  - The form:
    - fits a 1280x720 window, scrolling;
    - shows its error above the buttons, and the error goes once you edit;
    - plans the folder as you type;
    - takes `www.example.com`;
    - keeps the draft on Cancel and closes on Escape.
  - The welcome lede mentions starting from an idea.
  - An empty idea project talks about its brief instead of footage: the timeline hint, the transcript hint, and its
    own agent suggestions. Plugins lists HyperFrames first, and the suggestion chips wrap instead of being cut off.
- Face search no longer crashes on small videos. A 320x180 clip reached the face detector at its own size, which YuNet
  refuses (sides must be multiples of 32: "failed to call OrtRun()… broadcast… 10 by 11"); every frame now goes to it
  at the detector's size, scaled up when smaller (#753).
- Desktop, People (#753):
  - Links and choices read files by name: "Ben in camera-a", "All of camera-a", "Face in talk at 0:04", and a recorded
    take "mic (recorded 15:44)" instead of `shoot/20261120-154402/mic.words.json`.
  - With nobody in People yet, the voices your transcripts name are listed with "Add as person" (and play), instead of
    an empty panel with linking hidden behind a right-click.
  - A face search that finds nothing new says so. A long failure wraps under the button instead of widening the
    sidebar, and the Speaks / On screen switch no longer overlaps its neighbour.
- Desktop, Plugins (#753):
  - Downloads keep their names readable in a narrow sidebar: size and Remove wrap under the name. Each says what it is
    for ("Model for transcribing speech", "Program for reading and exporting video"), and programs not downloaded yet
    show their download size. `doctor` reports each pinned build's download size (`pinned.bytes`).
  - A plugin error shows its first line, the rest under "Details". A plugin from a terminal that never ran reads
    "Declared, not run until you trust this project" instead of claiming it is installed.
- Desktop, Connect your AI (#753): an X at the top and a footer that stays in view; "Check again" also sits in the card
  of an app that looks not installed. A settings file that does not parse disables Connect and offers "Show the file".
- Desktop, voiceover without the terminal (#756):
  - A script that names no voice opens "No voice yet" instead of a CLI message: pick one of the voices there are and
    Generate, or, with none, "Open Plugins". `voiceover.generate`'s missing-provider refusal carries `available`.
  - Place says why it refused in the dialog's language: Replace is the answer (the box is highlighted), a start before
    0, a timeline with no tempo for `beat:`, or a time that is not one. "2,5" is 2.5 seconds.
  - The report plays each line's take (▶), lines are numbered, and progress reads "Saying line 2 of 3" instead of the
    line's id (progress `values` carry `index` and `total`). After Stop, "Continue" goes on, reusing the takes made.
  - The cost box names an official provider by its plugin's name.
- Desktop: the transcript view's Transcribe button also works with whisper.cpp, asking before the first download as a
  new project does; the hint no longer sends you to the terminal (#756).
- Desktop: with no shoot script yet, the teleprompter and the Shoot view offer a box to write or paste one.
  It is saved as `scripts/shoot.md` with `shoot: true` and read at once (#737).
- Desktop, first run (#740):
  - The welcome screen shows the steps from a new project to an exported video.
  - The terminal's agent guide leads with "Connect Claude Desktop or ChatGPT" as the main button, with the
    terminal agents after it.
  - Installing a plugin shows the seconds so far and says that npm downloads it, which can take a minute or two.
- Desktop, audio editing you can see and hear (#757):
  - Gain keys draw the volume they play as a line across the clip; a muted clip is dimmed, and a clip that ducks
    under the voice says "ducked". The inspector's mute button reads "Muted" while on, with a hint on the gain box.
  - A track's header menu keeps the clips you selected, and names the track by its name ("Delete track Logos").
  - Audition: one file opens "Listen", the rows show their length, a click on the spectrogram plays from there with
    a playhead, and "Use this" is "Show in Explorer", which is what it does.
  - A timeline that cannot be read says which file, keeps the validation details folded, and offers to open the file
    or go to History.

- A narrow preview (1280 px window, terminal open, a project with formats) keeps Play and every transport button: the
  frame tools fold under the buttons, the panel title gives way to the timecode and duration, a custom letterbox field
  no longer scrolls the panel sideways, an open inspector leaves the picture about half the panel and scrolls instead
  of adding a sideways bar, long inspector hints wrap, and render slates stay inside a small frame (#745).

- Native dialogs and the Windows taskbar say "Frameshell" instead of the package name `@frameshell/desktop` (#742).

- The status bar, `frameshell status` and Help > Copy diagnostics name the release version of the daemon
  (`frameshelld 0.19.0`) instead of `0.0.0` (#739): inside a packaged app the daemon reports the app's stamped
  version, since the workspace packages stay at `0.0.0`.

- The Shoot view keeps the picked camera, microphone, screen and system audio when another view shows (#737): the
  devices are still freed a second after the view goes, and opened again as picked when it comes back. The microphone
  picked last is remembered on the machine and picked first next time when it is still connected.

- Sidebar view tabs that do not fit are no longer cut off without a sign (#736): the strip fades at the edge where
  tabs go on, scrolls with the mouse wheel, keeps the active tab in sight, and ends in a "+N" button whose menu lists
  every view out of sight (English and Spanish).

- Changing the language (View > Language) no longer kills the terminal (#754): the reloaded window shows the shells
  it had, with their output, and an agent running in one goes on. The same holds for any reload of the window.

- Window menu lists the open project windows on Windows and Linux, to switch between projects (macOS lists them
  itself) (#754).

- Release builds leave Reload, Force Reload and Developer Tools out of View, so Ctrl+R no longer reloads the window
  by accident; `FRAMESHELL_DEVTOOLS=1` brings them back (#754).

- A new agent proposal clears a History pick, so its diff shows on the lanes instead of the old entry's marks (#754).

- Take and History times follow the UI language instead of the system's (#754).

- Shoot view after End (#744): "Saving…" now shows how long the files have been saving; the finished message names
  the timeline the multicam group went to (the shoot's own, e.g. `timelines/<script>.json`, or main) instead of always
  saying main; Spanish "Se guardaron N archivos". A take's "N differences, review below" is a link to its rows, and
  differences the scene view does not show (speech outside every scene, another scene) are listed under the last take,
  each with Accept. A take, or a whole session, whose microphone stayed nearly silent (loudest 100 ms window under
  -45 dBFS) is flagged right after it is cut or ended. The teleprompter's voice following hears the microphone only
  while a shoot records: before Start and after End it reads "Ready" and the mic is left alone.

- Built-in terminal on Windows and Linux: Ctrl+V pastes the clipboard's text into any program, Claude Code included,
  which read it as "paste an image" before. With no text on the clipboard (an image), the program still gets its ^V.
  Ctrl+Shift+V keeps working (#743).

- Starting an agent from the agent guide puts the keyboard in its terminal, so its first question (folder trust) can be
  answered without a click (#743).

- Agents on Windows find `frameshell` from Git Bash (Claude Code runs its commands there): the app writes an `sh` twin
  of its `frameshell.cmd`, so the bare name works and matches the project's `Bash(frameshell *)` permission (#743).

- A fade or transition chosen in the clip inspector, or from a clip edge's right-click menu, changes only that clip's
  track. Before, a fade on the music also faded the picture when both started at the same time, with nothing on screen
  saying so (#755).

## [0.19.0] - 2026-11-20

### Added

- Connect your AI, one panel for connecting the AI apps people already use, desktop apps first: big cards for Claude
  Desktop and the ChatGPT desktop app (it uses the MCP servers setting it shares with Codex; ChatGPT on the web is not
  supported), then a smaller "For developers" group with Claude Code, Codex CLI (same file as the ChatGPT app, one
  state), Gemini CLI, and a copyable snippet for Cursor, VS Code and other MCP clients. Opens from a "Connect your AI"
  button in the project window's title bar, a card on the welcome screen and a link in the agent guide, which no longer
  has its own connect buttons. Connect and Disconnect work inline (no native dialog): state, "restart the app to
  finish", backups and errors show on each card, and every open reads the apps' settings again. English and Spanish.
- Open the desktop AI app from Connect your AI (no protocol change): once Claude Desktop or the ChatGPT desktop app
  is connected its card offers Open, which starts the app and puts a starter phrase on the clipboard ("Work on my open
  Frameshell project: <name>.", or a general one with no project open; English and Spanish) with a note to paste it
  there. An app that looks not installed offers Download (the official pages, claude.ai/download and
  chatgpt.com/download) next to Open, and an Open that does not find the app says so and offers Download. Claude
  Desktop starts through its `claude:` URL protocol; OpenAI documents no URL scheme for the ChatGPT app, so it starts
  by name (Start menu on Windows, `open -a` on macOS). Linux has no Open for either: Claude Desktop has no Connect
  there and the ChatGPT desktop app no Linux build.
- Connect Codex (and the ChatGPT desktop app, which shares its file) and Gemini CLI: `frameshell setup codex|gemini
  [--status | --remove] [--command path]` add Frameshell's MCP server to `~/.codex/config.toml` (the
  `[mcp_servers.frameshell]` table; `CODEX_HOME` when set) or `~/.gemini/settings.json`, with long tool timeouts for the
  blocking waits (an hour). Only Frameshell's entries change and every other byte stays (comments, CRLF), with a backup;
  a Codex file that does not parse (new dependency `smol-toml`) is refused untouched. The functions (`connectCodex`,
  `codexState`, `connectGemini`, ...) are exported from `@frameshell/cli` for the app. Docs: `docs/mcp.md` "Connect
  other AI apps" (ChatGPT web is not supported).
- Plugins view in the app (no protocol change): the Plugins sidebar tab, empty until now, lists the official plugins
  from `plugin.catalog` for the project with what each is for, what it needs (Blender found or not, `OPENAI_API_KEY`
  set or not: the app never shows or asks for the key), whether it is paid and sends audio or text off the computer,
  what it downloads on first use and its state (not installed, installed, did not load, off until trusted), with
  Install (official plugins only) and Remove (confirmed first). A project that declares plugins nobody decided on, or
  that were refused, shows a banner saying plugins run with full access to the computer, with Trust and Don't trust:
  `project.trust` is sent only on that click. A Downloads section lists this computer's managed downloads (ffmpeg,
  whisper.cpp, headless Chrome, models) on disk with their size and total, and what is not downloaded yet, with Remove
  (`binaries.remove`, confirmed first; a refusal such as BinaryInUse is shown). The Shoot view's transcription notice
  links to the view, and its install command and the voiceover report's come from the official table. Plugin
  descriptions in the app are in English and Spanish; the skill's app description names the view. The official
  plugin table is also exported as the subpath `@frameshell/protocol/official-plugins` (for the app's renderer),
  with `installCommand(plugin)` for the terminal command.
- The agent skill over MCP, so a client that never loads `.claude/skills` (Claude Desktop) learns the workflows and the
  options too: `frameshell://skill` (SKILL.md) and `frameshell://skill/{path}` (every reference file) are listed and
  readable as `text/markdown` with no project open, served from the skill bundled into core (new export
  `@frameshell/core/skill`; `createMcpServer({ skill })`). The server instructions say to read it first and to call
  `plugin_catalog` to see which options exist. The skill gains *Options, not obligations*: the person's request decides
  the tools; offer the plugins and downloads that fit, with what each needs, costs and takes, from `plugin catalog`;
  never install, download, trust or spend without a yes; no plugin at all is a plain edit. The reference rows for
  transcription, voiceover, motion films, HyperFrames and Remotion point to it.
- Remove managed downloads to free disk (`PROTOCOL_VERSION` 184): new method `binaries.remove { name }` deletes a binary
  package (every installed version and its `.failed.json` markers under `<dataDir>/binaries/<package>/`) or a pinned
  model (`<dataDir>/models/<id>/`) and returns the bytes freed; it downloads again on next use. Machine-wide. Refused with
  the new error `BinaryInUse` while the package installs, while jobs or a transcription run (the daemon does not know
  which downloads they use), or while the system keeps its files open (Windows). It never touches a `binaries` override,
  Blender, or a model registered with `model.add`. `doctor` gains `downloads`: what is on disk with bytes each, still
  read-only. CLI: `frameshell doctor --remove <name>` (plain `doctor` lists the downloads too); MCP tool
  `binaries_remove` from the registry; skill `cli.md` row.
- Official plugin catalog, first part of the opt-in plugins work (`PROTOCOL_VERSION` 183): one table of the official
  plugins in `packages/protocol/src/official-plugins.ts` (package, what it provides, a one-line purpose, what it needs
  from the person, paid or cloud, the managed downloads it uses) replaces the three copies the daemon's install hints
  and the app's transcription setup kept. New read-only method `plugin.catalog` (MCP tool `plugin_catalog`) and
  `frameshell plugin catalog [--json]` list those plugins for the project: installed or not, load status as
  `plugin.list` reports it (untrusted code is never run; pinned plugins of a trusted project load and sync as there), trust state, download sizes for this machine and whether each
  is already on disk, and whether the need is met where it is cheap to tell (Blender found as `doctor` finds it; an
  `OPENAI_API_KEY` set or not, never the key). A test keeps the table equal to the `plugins/` directories and the
  binary manifest.
- Requirements of `review` reach clips inside nested timelines, follow-up of #457 (epic #451; no protocol change,
  `PROTOCOL_VERSION` stays, descriptions only): every per-clip requirement (`appearsBy`, `before`, `keepsMoving`,
  `staysInFrame`) and clip waiver names a clip inside a nested timeline by the id the flattened film gives it,
  `<nested clip id>/<its clip id>`, and is judged on that clip's span; `staysInFrame` reads its boxes from the same
  flattened timeline. A bare inner id fails with a message naming the path or paths to use instead of judging every
  placement; a waiver on it says so in the run's warnings. The flattened timeline is read only when the file has clip
  requirements or a clip waiver (a flatten failure is a warning), and shots of program tracks inside a nested clip
  cannot be named. This closes the "not yet" of the sixth slice of #457 below for nested clips.
- Premiere XML export, slice 2 of #701 (ADR 0047; no protocol change, `PROTOCOL_VERSION` stays): File > Export
  Premiere XML… in the app (video projects; en + es), sharing one hand-off path with File > Export OpenTimelineIO…: main
  asks where to save, the daemon writes, a notice counts what the file leaves out and names the CLI command that lists
  it (the OTIO menu and its wording are as before; the IPC channel is now one `timeline:export-handoff` with the kind).
  Clip gain (`audio.gain`) is written as an Audio Levels filter on the audio clip (linear 10^(dB/20), at most +12 dB with
  a warning when clamped; a clip with no sound to level is still named in `warnings`); the OTIO file is byte-identical.
  Opt-in reader test `FRAMESHELL_TEST_OTIO=1 pnpm test packages/core/test/premiere-real` reads the file with the
  OpenTimelineIO `fcp_xml` adapter (`otio-fcp-adapter`) and runs in CI next to the OTIO real-library test. ADR 0047's
  wording on dissolves is corrected (explicit `start`/`end`, accepted by FCP7-family readers; Premiere's own spelling is
  unverified), the UNC path spelling is pinned by a test and noted as unverified, and the review leftovers are closed
  (TSDoc, the CLI help comment, one project read per export). Neither the Audio Levels filter nor the dissolves have
  been opened in Premiere Pro yet.
- Small fixes, wave 27 (slice SF8, parts of #382 and #689; protocol 182):
  the `ConfirmationRequired` and `ConfirmationStale` data of `transcribe` carries `costUnknown` (true when the provider
  gives no usable estimate and does not declare itself free; not in the confirmation token, so tokens are unchanged).
  `cost` null with `costUnknown` false is a free remote provider with no estimate: the app's box now says "charges
  nothing, but the audio still leaves this machine" for it, as it does for an estimate of 0. A daemon that does not send
  the field reads as unknown in the app (the safe side). One `formatCost` in `@frameshell/protocol` (`cost.ts`) replaces
  the twins in `packages/core` and the app: 4 decimals under 1, else 2, `0 USD` for exactly 0 and `< 0.0001 USD` for a
  positive amount that would round to zero. Visible change: the app's cost texts read `0.0400 USD` and `1.50 EUR`
  where they read `0.04 USD` and `1.5 EUR`, and `voiceover generate` prints its cost through it too (`about 0.0500 USD`, no raw float). The app's price text is chosen by `transcribePrice` (free before unknown), so a free remote provider without an estimate shows the free text, not "may charge you". Docs only: SPEC 5.9's example beats file says `onset-flux@2`, ADR 0029
  decision 10 says octave errors became more confident (12 of 12 synthetic, 4 of 5 CC0) and that octave and downbeat
  are the only reasons left for the learned spike (#689 stays open for the owner's go/no-go), and the research note
  has its final verdict at the top. No detector change. Left for later: `people tune` on
  real recordings (#700), the learned beat spike (#689), the `whisper-1` replacement (#702).
- Small fixes, wave 26 (slice SF7, parts of #451, #382, #689 and #702; no protocol change, `PROTOCOL_VERSION` stays):
  `notification-stack`'s fixed schedule (`onBeats` off or no usable grid) is held to the same room before the exit as
  its beat-placed one, through the one `stepTimes` formula (latest start minus `minGap` per later card, never before
  `startAt`; `stepTimes` takes a `holdFixed` flag only `notification-stack` sets), so six cards on the default 5 s
  clip stay before the exit and in order; default durations, a schedule that already fits, the fixed schedule of
  `work-cards` and `checklist` give the same times as before (ADR 0029 decision 8 amended). The beat path is the same
  except in degenerate cases: a step is never put before `latest`'s floor `start`, and a negative `latest` is ignored
  instead of clamping. Clips scaffolded earlier keep their template copy: scaffold again to get it.
  `DEFAULT_TRANSCRIPTION_PROVIDER` in `@frameshell/schema` is the one `whisper-cpp` provider id the daemon, the consent
  gate, the shoot service and the app read (the plugin keeps its own id); `APP_TRANSCRIPTION_PROVIDER` is an alias of
  it. The app's transcription ask says "charges nothing, but the audio still leaves this machine" for an estimate of
  exactly 0 instead of "0 USD" (a free remote provider with no estimate is a later wire change). The header of
  `main/voiceover.ts` is as it is now, and its `Confirmed`/`formatCost` re-export is gone (import them from
  `confirmation.ts`). The beats wire text for `detector` (model-facing description only) and the beats schema comment
  name `onset-flux@2`. The `openai` transcription provider says plainly when OpenAI no longer serves `whisper-1` (or
  the key cannot use it: 404 or 400 with `model_not_found`, or a 404 whose message says the model is gone): update the
  plugin or use `--provider whisper-cpp`;
  a plain 404 points at `FRAMESHELL_OPENAI_TRANSCRIPTION_BASE_URL`; nothing is retried, every text is scrubbed.
- Motion runtime 0.6.0 (ADR 0029 decision 8, ADR 0033, small fixes 6 of #451; no protocol change): `M.words()` lists the
  transcript words the timeline plays inside the clip, `{ at, end, text, id }` in composition seconds, as the page's
  `frameshellTiming.words` has them, or `[]` with no `words` timing or when `wordsProblem` is set (no nominal fallback,
  so a composition keeps its text as a prop). Nothing 0.5.0 exports changes: a clip keeps its frozen copy until
  `frameshell hyperframes update`, which now reports 0.6.0.
- Premiere XML export, slice 1 of #701 (ADR 0047; protocol 181): `frameshell export premiere` (MCP `export_premiere_xml`,
  method `export.premiereXml`) writes the timeline as a derived xmeml version 4 file, `exports/<timeline>.xml` by
  default, for Premiere Pro's File > Import. Export only, read-only, written by hand with no dependency. Carried: video and
  audio tracks (a hidden video track and a muted audio track disabled), media clips with source range and timeline
  position in whole frames, `speed` as a Time Remap filter, markers, dissolves between butted clips as Cross Dissolve
  (`edgeTransitions`, never recomputed), and the sound of video-track clips as linked audio clips. Generated and nested
  clips keep their slot and length as offline media. Program and subtitle tracks, dips and fades, transition shapes,
  transforms, keys, grades, finish, audio effects, sound fades and clip gain are named in `warnings`. Media paths are
  always absolute `file://localhost/` URLs, so the file is not portable. The pieces both editor hand-off writers share
  (what is left out, warning texts, clip placement, path encoding) moved to `export/handoff.ts`; the OTIO file is
  byte-identical. Not yet opened in Premiere Pro; the app menu came in slice 2. Closes the open point of #383.
- OpenTimelineIO export, slice 1 of #383 (ADR 0045, SPEC decision 50; protocol 179): `frameshell export otio` (MCP
  `export_otio`, method `export.otio`) writes the timeline as a derived `.otio` file, `exports/<timeline>.otio` by
  default, for editors that read it. Export only, read-only, never read back. Carried: video and audio tracks (a hidden
  video track and a muted audio track disabled), media clips as `Clip.2` from their source `in`, lasting their timeline length, with a
  `LinearTimeWarp` for `speed`, gaps, markers as `Marker.2`, every time a whole frame at the project rate. Generated
  and nested timeline clips keep their slot, name and timeline length as `Clip.2` with a `MissingReference.1` and a
  warning. Multicam program tracks, subtitle tracks, transitions, transforms and keys, grades, film finish, audio
  effects and (until slice 3) the sound of media clips on video tracks are not exported and are named in `warnings`. `target_url` is relative to the file, `--absolute-paths` writes
  `file://` URLs. No new dependency and no Python; dissolves and the app menu came in slice 2.
- OpenTimelineIO export, slice 2 of #383 (ADR 0045): a dissolve between two clips that end and start at the same frame
  is a `Transition.1` (`SMPTE_Dissolve`, centred on the cut, the half length `edgeTransitions` gives, in whole frames
  each side, so the handles of the files decide, as in a render). A wipe, push or iris dissolve is written as a plain one,
  its shape only in the metadata, with a warning; dips, fades and a dissolve with no handle or no clip before it stay
  warnings, named as such. File > Export OpenTimelineIO… in the app (video projects; it asks where to save, the daemon
  writes, a notice counts what the file leaves out). Gated real-library test `FRAMESHELL_TEST_OTIO=1 pnpm test
  packages/core/test/otio` (needs `pip install opentimelineio`).
- OpenTimelineIO export, slice 3 of #383 (ADR 0045; no protocol change, still 180): the sound of the media clips of
  each video track (still images have none) is mirrored on one extra `Audio` track per video track, after every real
  track (`<video track> sound`, `metadata.frameshell.mirrorOf`, clips linked to their picture by `clipId` and
  `linkedClipId`): same ranges, speed and `Transition.1` crossfades, a muted clip or track disabled there, a muted video
  track no longer warns. Clip `gain` stays metadata and now has one warning (also on audio-track clips); sound fades
  (`audio.fadeInMs`, `audio.fadeOutMs`) get one too. `tracks` counts the mirror tracks, `clips` only the pictures and
  real audio clips. The app notice names `frameshell export otio --out <file>.otio` and fixes "verla" for one thing in
  Spanish. The real-library test now also reads the mirror and has run against OpenTimelineIO 0.18.1; CI runs it on
  ubuntu shard 1 when OTIO files change.
- `frameshell people tune` (`people.tune`, MCP `people_tune`; protocol 178): a read-only tuning report for the voice
  and face suggestion thresholds (ADR 0020 decision 15). It replays matching on the people the owner confirmed (linked
  speakers with cached voice prints, face tracks a face anchor names): same-person and different-person score spreads,
  and for each `SPEAKER_MATCH` and `SPEAKER_MARGIN`, `FACE_CLUSTER_MATCH` and `FACE_PERSON_MATCH` and
  `FACE_PERSON_MARGIN` tried, correct and wrong suggestions, precision, recall, cluster purity and splits. Nothing is
  scanned, downloaded or changed, and no threshold changes. Results go in `docs/research/people-acceptance-run.md`.

- App confirmation for paid or remote transcription, slice 2 of #382 (ADR 0046 decision 10, epic #451; no protocol
  change): when `transcribe` refuses with `ConfirmationRequired`, the app asks in a native box that names the provider,
  the file and its length, says the audio is uploaded and the estimated cost, and sends `yes` with the token only after
  "Upload and transcribe". A changed file or price asks again; no consent is stored. It covers the project setup
  transcription and the Shoot speaker search, and the transcript view gains a Transcribe button on a not-transcribed
  asset when the project's provider is not whisper.cpp. The confirm loop of the voiceover cost dialog moved to one
  shared `runConfirmed` (`apps/desktop/src/main/confirmation.ts`), unchanged in behaviour.
- OpenAI transcription provider, first slice of #382 (ADR 0046, epic #451; protocol 180):
  `frameshell plugin install @frameshell/openai-transcription` adds the paid cloud provider `openai`
  (`whisper-1`, word timestamps as the service gives them, a note in `warnings`) for
  `frameshell transcribe <asset> --provider openai`. whisper.cpp stays the default. Every run is refused with
  `ConfirmationRequired` (the asset's audio is uploaded, its length, the estimated cost at $0.006 a minute from a
  price table with source and date) until `transcribe --yes [--confirmation token]`; the token fails as
  `ConfirmationStale` when the asset or cost changed. No consent is stored. Long audio is cut at pauses into
  10-minute pieces under the 25 MB upload limit. The key comes from `OPENAI_API_KEY` only and never reaches a
  project file, the history, progress or an error (texts scrubbed, a parity test with `openai-speech`). The plugin
  API gains optional `free`, `remote` and `estimate` on `TranscriptionProvider`; a provider with neither `estimate`
  nor `free: true` counts as paid, except `whisper-cpp` of any version (`@frameshell/whisper-cpp` 0.3.1 declares
  `free: true`). `transcribe.verify`, shoot takes, the voiceover misread check and captions, and `analyze` speech
  use only a local free provider: with any other they refuse (`TranscriptionFailed`) or skip. Wire: `transcribe`
  gains `yes` and `confirmation`. Tests run a stub HTTP server with a fake key, never the real API.
- `grade.analyze` and `grade.compare` on generated and nested clips, slice 11 of #384 (ADR 0031, epic #451;
  protocol 177): `grade compare` (MCP `grade_compare`) draws one frame of a generated clip or a nested timeline clip
  under candidate grades through the export frame path, as it did footage (a multicam shot is refused with reason
  `not-gradable`); `grade analyze` (MCP `grade_analyze`) measures a generated clip from its cached draft render, made
  when missing, and refuses one whose render has transparency (`has-alpha`) and a nested timeline (`nested`, pointing at
  the clips inside and at `grade compare`). Both results gain `kind` and a nullable `asset`. Owner decision
  2026-11-18.
- Words in the timing of generated clips, the final slice of #458 (ADR 0029 "Words in timing as built", epic #451; no
  protocol change, plugin API `apiVersion` stays "1"): a clip whose adapter's `timing()` returns `words` gets
  `RenderContext.timing.words`, the transcript words the timeline plays that start inside the clip (`{ at, end, text,
  id }`, composition seconds, `text` as corrected), read from the same placement as `word:` references. A stale
  transcript, or a timeline with no transcribed word, gives `words: []` and the stable code `wordsProblem`
  (`no-transcript`, `stale-transcript`; `RENDER_WORDS_PROBLEMS` words them), never a failed render. HyperFrames asks with
  `words` in the `frameshell-timing` meta tag, Remotion with `"words"` in `props.timing` (`src/frameshell-timing.ts`
  gains `FrameshellWord`, `words` and `wordsProblem`; a parity test holds it to `RenderTiming`). Only clips that ask
  read the transcripts and render again when one changes; every other key is unchanged.
- HyperFrames templates ask for beats by themselves: a clip whose props set `onBeats` to true gets the beat grid without
  the meta tag, and one with `onBeats` false or unset keeps its key, so it never renders again when the music moves.
  `notification-stack` (cards drop on beats) and `work-cards` (each card pulses on a beat) gain `onBeats`, with
  `checklist`; the three share one step schedule (`stepTimes`, nominal fallback to the steps).
- Still finals for look-dev, slice 7 of #482 (ADR 0035, epic #451; protocol 176): `frameshell frame --final [--yes]`
  and `frameshell clip compare --final [--yes]` (MCP `frame_capture` / `clip_compare` with `final`) draw a Blender clip
  shown at that frame from a Cycles final of that one frame instead of its EEVEE draft, unless its whole final is
  cached, so a look is confirmed on a final before a whole final. The host renders a copy of the clip narrowed to the
  frame (`in` = frame / fps, `duration` = 1 / fps), keyed apart from the draft and the whole final (`still` in the key),
  which the Blender adapter renders as one frame after a transparent head (slice 6), waited for and estimated as one
  frame; over 5 minutes in all (a look sheet adds its tiles up, each named in `look`) it fails with
  `ConfirmationRequired` until `yes`. A still that fails is `ClipRenderFailed`, never the draft; `warnings` say what
  each clip was drawn from. Stills are listed by no `clip.renders` and removed by `gc`. `review` stays on drafts (owner
  decision 2026-11-18). Plugin API: additive `finals.windowed` (`PLUGIN_API_VERSION` stays `"1"`), set by the Blender
  adapter; an adapter without it keeps its draft in a still, with a warning. Not verified with a real Blender (none on
  the machine that built it); the stub-Blender test runs on POSIX CI.
- Finish section and letterbox menu in the app, slice 4b of #500 (ADR 0043, epic #451; desktop only, no protocol
  change; closes #500): the clip inspector of a media or generated clip on a video track gains a Finish section after
  Colour, with a Vignette group (strength, radius, softness) and a Grain group (amount, size, seed), each with a
  switch that turns it on with the defaults or removes it and one Reset for both. A slider release is one `clip.set`
  of that number only, so a drag is one undo step; the grain note says footage only, never screen recordings, UI or
  text; while a format other than the primary is shown the section says the numbers are shared by every format. The
  preview's transport bar gains a letterbox menu beside the format switcher (no bars, 2.39, 2.35, 1.85, 4:3 or a
  typed aspect), one `letterbox.set` per choice, reading and writing the bars of the format shown. Image projects stay
  out of scope (recorded in ADR 0043). `parseAspect` moves to `@frameshell/schema/finish`, shared by the CLI's
  `letterbox set` and the menu, and a number field no longer sends its value twice when Enter is followed by leaving it.
- OpenAI speech provider, slice CS of #676 (ADR 0034 decision 24, epic #451; plugin only, no protocol change; closes
  #676): `frameshell plugin install @frameshell/openai-speech` adds the paid provider `openai` for
  `frameshell voiceover generate --provider openai` (default voice `alloy`, model `gpt-4o-mini-tts`, changed with
  `FRAMESHELL_OPENAI_SPEECH_MODEL`). The key is read from the `OPENAI_API_KEY` environment variable only, and never
  reaches a project file, the history, a progress message or an error (upstream error texts are scrubbed). The cost
  box and `ConfirmationRequired` show an estimate from a price table with its source and date (`src/prices.ts`),
  approximate for the token-billed default model. `SpeechProviderNotFound` for `openai` names the plugin. Tests run
  against a stub HTTP server; no real key or call.
- Remotion timing binding, slice RB of #458 (ADR 0029 decision 8, owner decision Q6, epic #451; plugin only, no protocol
  change): a `remotion` clip asks for the timeline's beats and markers with `props.timing` (`["beats", "markers"]`;
  unknown words are refused with the allowed ones) and its composition finds them in the reserved input prop
  `frameshellTiming` (`RenderTiming` as is: `beats`, `tempo`, `beatsProblem`, `markers`, composition seconds), in
  `selectComposition`, the render and the live page alike. Clips without the prop keep their render keys and input
  props; a clip that asks may not set `inputProps.frameshellTiming` itself (refused). `frameshell remotion new` also
  writes `src/frameshell-timing.ts` (types and `useFrameshellTiming()`) when missing. The plugin skill and ADR 0029
  ("Remotion binding as built") describe it. Word times in the timing and a shared `beatAt` stay for later.
- `title-3d` template, slice 3b of #473 (ADR 0042, epic #451; plugin only, no protocol change; closes #473):
  `frameshell hyperframes new title --template title-3d` extrudes a short title of Archivo Black letters
  (`THREE.TextGeometry`) in the `product-shot` studio, laid out in at most three lines that wrap and shrink to the
  format's width, arriving letter by letter on a spring stagger (`letters`), as one rise out of the flat text (`rise`)
  or dropping in (`drop`), with a glint, a slow turn and an optional headline. Props `text` (a line break is `\n`),
  `subtitle`, `depth`, `bevel`, `colors` (`single` or a `blend` into `color2`), `color`, `finish` (default `gloss`),
  `reveal`, `spin`, `ink`, `size`, `shadows`, `bg`, `backdrop`. The letters come from `frameshell-title.typeface.json`,
  copied next to the page (a new `ThreeTemplate.assets`, hashed with the composition and refreshed by
  `hyperframes update` like the bundles; `UpdateReport.typeface`): the Archivo Black outlines (SIL OFL 1.1, no Reserved
  Font Name) of printable Latin (ASCII, Latin-1, common punctuation, `€`), converted at build time by `pnpm gen:typeface`
  with opentype.js 2.0.0 (MIT), a devDependency used only by that script, never in the three.js bundle or the runtime
  dependencies, with a `--check` drift test. The title never passes 90 % of the frame width at any `size` (up to 1.4),
  and its height stays inside the frame and above the headline. A character the typeface lacks, a fourth line, a word
  too long for the width even at 40 %, a missing or broken typeface fail the render naming the cause. The 3D playbook gains "A 3D title"; the README lists both licences. The opt-in
  real-render test checks the first frame, alpha, `clip.verify` at tolerance 0, every reveal, a wrapped title, a colour
  blend and the failure messages.
- Voiceover captions in the display form, slice 6 of #470 (ADR 0034 decision 23, epic #451; protocol 175): `frameshell
  voiceover captions <script> [--lines] [--track] [--dry-run]` (MCP `voiceover_captions`) captions the placed takes with
  the line as written (digits, names as spelled), never the respelled or spelled-out words the voice read. Each take is
  transcribed by the project's transcription provider (the misread check's round trip) and the display words are lined
  up with the heard words by the transcript aligner: a number covers every word it was said as, a respelled name the
  heard words in its slot, a word the voice dropped is listed in `missing` and timed between its neighbours; digits the
  transcription wrote meet the spelled number. When the project cannot transcribe (untrusted, no plugin), or a line was
  heard as other words, the words are spread over the take's phrases by length, with a warning (a take whose transcript
  already holds heard words keeps that timing). The words become the take's transcript (ids and hand edits kept, edits
  of words not found again dropped with a warning; written outside the history, so `revert` leaves it and `transcribe`
  puts the heard words back), and one transaction gives a subtitle track that follows the voice track (made when absent) one hand-chunked phrase per phrase
  of the take, split at words within the style's limits; `captions set` re-chunks or marks a keyword afterwards. The
  shoot session's transcript writer and the new command share one builder (`transcriptFromWords`). `voiceover.place`'s
  `at` description now points to the TimeRef description, which includes word references.

- Built-in looks, slice 10 of #384 (ADR 0031 decision 8, epic #451; protocol 174; closes #384): six colour looks,
  `warm`, `cool`, `filmic`, `punchy`, `faded` and `mono`, as plain grade numbers (exposure, temperature, tint,
  contrast, saturation) in one table in the schema package: no `.cube` file is generated or bundled, so no licence
  is touched, and export and the preview needed no change. `frameshell grade looks` (MCP `grade_looks`) lists them
  with a summary and their numbers. `clip set --grade-look <name>` copies a look's numbers into the clip's own
  `grade`, like `--glass` copies the style: the clip keeps its copy if the table changes, and explicit `--grade-*`
  flags win over it. `grade compare --look warm` takes a built-in name as a look, and `--look
  mine:look=warm,saturation=1.1` (MCP `looks: [{ look: "warm", saturation: 1.1 }]`) starts one from it; an unknown
  name is refused naming the valid ones. The clip inspector's Colour group has a Look menu that sets the five
  numbers in one undoable step (English and Spanish).
- `review` measures a word behind the person, slice MX3 of #461 (ADR 0032, #457 follow-up, epic #451; protocol 173):
  on a timeline with a track `behind` a plate, `metrics.behind` lists each clip on it with the share of the word the
  person's matte covers at the first, middle and last frame of its time under the person (the word's render alpha
  against the matte frame export draws, both placed in the film through keys and the format's cover crop) and whether
  its box meets a face of the plate clip (a cached `people scan`). Under 15 % (it floats) or over 65 % (the person eats
  it), or over a face, is a craft warning of the new check `behind`, which names 30 to 55 % as the target; between the
  bands the entry carries a note only. The warning carries its `clip`, so a waiver of one word covers that word only.
  Review reads finished mattes and never queues one; a still or media word, an opaque render or a plate with no matte
  is `unplaced` with the reason. CLI `review` prints the entries; skill `critique.md` and `reels.md` teach them.
- Motion templates, slice TP5 of #466 (ADR 0033, epic #451; plugin only, no protocol change; closes #466):
  `frameshell hyperframes new <name> --template` takes two more. `select-resize` has a cursor press a card, so its
  selection ring, its handles (4 corner squares or 8 dots) and the click ripple start on the same frame; it then drags
  the bottom-right handle to a target size (`fromW`, `fromH`, `toW`, `toH` as fractions of the frame, kept inside it
  with the handles, the cursor and the badge), lets go, and a badge shows the final `W x H`. The card is written as
  layout on a 0.01 px grid, never a scale, and the cursor, its timing guard and the optional follow camera are the
  existing cursor kit. `lean-in` slides a headline or quote card in from a side with a heavy spring, tilts it away and
  back toward the viewer, then holds a slow lean (scale 1 to 1.06, rotation 1 to 2 degrees; 2D only, no matte). The
  ticking to-do and the word behind the person of the same ticket were already built (`checklist`, `big-word`). The
  `hyperframes` skill lists both.

- Word references as times, #458 slice 4 part 3 (ADR 0029, epic #451; protocol 172): every time argument that takes a
  TimeRef also takes `word:<text>[#n][+s|-s]`, the start of the nth time the timeline plays a word (`--from word:so
  --to word:so#2`, `--at word:over+0.2`), or a transcript word id (`word:w_000012`). Words match on their spoken tokens
  (case, accents and punctuation ignored, `20` meets "twenty", several words in a row for a phrase, compared token
  for token so `maybe` never meets "may be"; text that also reads as a word plus an offset is refused); words a cut
  removed do not count, and the same speech on two tracks counts once. The name is read on the timeline as the call
  sees it (a review-mode proposal's own timeline included) and the history records seconds, so a later cut never moves
  a recorded edit. A clip with a stale transcript refuses it naming `transcribe`; an unknown word lists the closest
  played words. A marker label starting with `word:` is now refused. `cleanup` and word references share one placement
  of transcript words on the timeline (`placeWords`). Not yet read by `requirements.json`.

- `music.pick`, the last slice of #485 (ADR 0037; protocol 171, no schema change): `frameshell music pick <track> [--keep] [--dry-run]`
  (MCP `music_pick`) keeps one of the candidate tracks `music candidates` placed. The chosen track (id or name, e.g.
  `Music 2`) is unmuted and renamed `Music`, and the other candidate tracks (audio tracks named `Music <n>` that hold only
  media clips) are removed with their clips; `--keep` mutes them and leaves them in place. A candidate with edits of its
  own (several clips, or a clip with speed, keys, effects, fades or transitions, or a subtitle track following it) is never
  removed: the result names it. Refused when the track is not a candidate or there is no other to pick between. One
  transaction `Music pick: <track>` (one proposal in review mode); nothing is fitted or ducked again, the result's `next`
  says `music fit` and `duck --level` follow. Skill updated.

- Cut seam strips and the per-clip kit of `review`, slice RP3 of #457, the last (epic #451; protocol 170):
  `--sheets cuts` (opt in, never a default) writes one row per cut, the whole frames 0.2 and 0.1 s before it, on it,
  and 0.1 and 0.2 s after (`cut 3 -0.1`; a cut within 0.2 s of the range's edge repeats the edge frame, so every cut
  keeps its row), up to 24 cuts thinned evenly with a warning naming how many were left out; a
  timeline's cuts are its clip edges, a file's the scene cuts `analyze` finds (found once per run, shared with the
  metrics). `--pop <time>` (seconds, a marker, `beat:N`; resolved in the daemon by the shared TimeRef resolver) writes
  the frame before and the frame at it side by side with their difference amplified 4 times. `--onion <clip>` blends
  up to 24 frames of the clip's span (of `--range` inside it) into one image: the median background, each moving part
  laid over at 25 %. `--speed <clip>` charts the clip's hero point speed per frame (a media clip: its keyed placement
  through `placementAt` and the cover crop, sub-pixel, no render; a generated clip: the centre and area of its render's
  alpha (alpha-weighted centroid and area, not its bounding box) at up to 90 frames; no render, a render that fails, no
  alpha or alpha on fewer than two frames skipped with the reason, never a failed run) and lists in `metrics.speed` the `linear`
  stretches (speed within 2.5 % over 6 frames and 20 % of the move) and dead `stop`s (under 0.25 px per frame for 4
  frames between two moving stretches), ESTIMATED, warnings only, thresholds as data in `review/thresholds.ts` (2.5 %,
  not 5 %: the middle of the `in-out` key ease varies by 4 %). With only the kit and no `--sheets`, a run writes the
  kit's sheets (and the metrics with `--speed`, the safe sheet with `--platform`). `--crop-at` crops `pop` and `onion`
  too; both `pop` frames take the crop of the frame at the pop. New sheet kinds and tile
  tags `pop`, `onion`, `speed`; `encodeRgbPng` joins `encodeGrayPng`. `onion`, `speed` with a file, a clip that is not
  on a video track or plays outside the range, and `pop` on the first frame or past the film are InvalidOperation.

- Motion templates, slice TP4 of #466 (ADR 0033, epic #451; plugin only, no protocol change): `frameshell hyperframes
  new <name> --template` takes four more. `orbit` has labels circle a logo or a word, from a seeded start phase, and
  slow to a stop on an evenly spaced ring that never depends on the seed. `locked-on` snaps four corner brackets onto a
  target box (`x`, `y`, `w`, `h` as fractions of the frame, kept inside it) with an overshoot, then a pulse and a small
  label. `spotlight` dims the frame except a soft pool of light, one layer of plain alpha with no blend mode, which
  moves to a second target and lights a label at each. `phone-fan` opens three phones from a stack like a hand of cards,
  one picture each, sized so the fan fits every format. The plain app screen and the phone bezel `device-frame` drew are
  now `paintSkeleton` and `dressPhone` in `ui-parts.ts`, shared with `phone-fan`. Fixes in `logo-sting` and
  `light-leak`: the light band now leaves with the exit on a clip under 1.55 s instead of being cut off, its
  geometry test checks the band outside the frame without leaning on its fade, and `light-leak` falls over at most
  0.6 of the clip, so its last rendered frame is clear on a clip of 0.2 s too. The `hyperframes` skill lists them.
- Beat helpers in the motion runtime, slice MH of #458 (ADR 0029 decision 8, ADR 0033, epic #451; plugin only, no
  protocol change): runtime 0.5.0 adds `beats`, `beatAt` (`{ index, beat, bar, phase }`), `beatTime`, `sinceBeat`,
  `springOnBeat`, `markers`, `hasBeats` and `frameshellTiming`. They read `window.frameshellTiming` (a composition that
  asked with `<meta name="frameshell-timing" content="beats markers">`) and are pure functions of `t`, so seeking stays
  exact; beats before the first and after the last of the clip continue at the nearest period. With no usable grid
  (no tag, `beatsProblem` set) they use a nominal `{ bpm, offset, meter }` the composition passes, or the clip's own
  seconds, so a composition looks the same without music. The `checklist` template takes an `onBeats` prop: its ticks
  land on the first beats at or after `tickStart` (the tag is added by hand, so a plain checklist never re-keys on the
  music). A clip keeps its frozen 0.4.0 runtime until `frameshell hyperframes update`, which now reports 0.5.0; no
  pixel of an existing clip changes. The plugin skill lists the helpers.
- The scene band shows a storyboard that has no transcript words, #662 (ADR 0015 amended, epic #451; protocol 169):
  every `span` of `script.outline` carries a `source`. A scene whose words a timeline does not place gets a `clips`
  span there, the first start to the last end of the clips linked to it (the box follows them when they move, and a
  pick selects them). A scene with no clip linked anywhere gets a `planned` span on `main` from the time range in its
  heading (`## Proof (bars 4-9, 0:06-0:18)`: clock readings win, bars and `bar:4-bar:10` go through the TimeRef
  resolver on the main timeline's tempo; a range that cannot be read is a warning). The band draws planned boxes with
  long dashes and the screen-reader list says "planned"; `frameshell script outline` prints where each scene is placed.
  Dragging a scene to move its clips is a later ticket.
- Batch closes #477 (ADR 0040 "Limits in v1" emptied, epic #451; protocol 168): a row whose data changed renders again
  without `--force`. Each manifest entry now stores a `hash` of the row's cells, the batch file's slots and the template
  timeline's content (not its revision); a `done` row whose hash differs is rendered and listed in the result's new
  `changed` (the CLI prints it), a manifest from before hashes counts as unchanged, and `force` is for what the hash
  does not see (a swapped file edited in place, `preset`, `quality`). A props slot naming a prop the clip's
  composition does not declare fails the row with InvalidOperation data `{ row, slot, reason: "unknown prop", prop,
  declared }`, in `--dry-run` too: the new optional plugin-API hook `ClipAdapter.declaredProps(clip)` names the
  top-level props a composition declares, HyperFrames answers from `data-composition-variables` of the entry (an object
  or an empty list declares nothing), and an adapter without the hook, or a composition without declarations, keeps
  accepting any prop. New method `batch.cancel { file, out? }` (CLI `batch cancel <file> [--out dir]`, MCP
  `batch_cancel`, replay-keyed like every mutating method): no further row is queued, the running row's render job is
  canceled, the entries not ended become `canceled` and the manifest's `state` `canceled` (new value; `failed` re-runs
  such rows); a Ctrl-C in `frameshell batch` asks the daemon, and the CLI also ends when another process cancels the
  manifest. The skill (`batch.md`) and `docs/mcp.md` list the `yes` param and `batch_cancel`, and a CLI test covers
  `batch --yes` (ConfirmationRequired, then the render with a stub final). Tests: `batch-service` (hash, cancel,
  unknown prop), `batch-method` (daemon cancel and declared props), `batch-cli`, hyperframes `declaredProps`.
- Audition dialog, slice AP of #463 (ADR 0038 "Audition page as built", epic #451; protocol 167): the person picks a
  sound by ear. In the Explorer, right-click two or more selected sound files (Audition N sounds…), a folder such as
  `assets/sound/`, or a `Music <rank>` track that `music candidates` made: each sound gets play/stop, a spectrogram,
  its loudness and true peak, and the kind and seed of a generated take; Match loudness plays them all at the quietest
  one's level, and Use this selects the file. Read-only: nothing on the timeline changes. English and Spanish.
- Daemon method `audio.inspect { assets, spectrogram? }` (MCP `audio_inspect`), read-only: per file the integrated
  loudness, true peak and loudness range from the per-asset loudness cache, the length, the `fssd` facts of a generated
  take (a sound shorter than one 400 ms gating block, which EBU R128 reads as silence, gets the loudness of that one
  block, flagged `shortSound`), and with `spectrogram: true` a 64-row log-frequency spectrogram of up to 400 columns in dB computed on the one
  FFT in a worker thread (kept in memory, not on disk: no new `gc` kind). Files with no sound are listed in `skipped`.
- Blender clips, slice 6 of #482 (ADR 0035, epic #451; plugin only, no protocol or plugin-API change): a render draws only
  the clip's window, frames `floor(in * fps)` to `in + duration`, instead of everything from the scene's first frame.
  `render.py` takes `startFrame` and names its files from 0; the encode pads the head with transparent frames (one
  `lavfi` input and `concat`, same flags and `-fflags +bitexact`; a clip with no head trim encodes exactly as before),
  so file time is still composition time. Progress, the written-frames check and the 5-minute finals estimate count the
  window, so a trimmed final is estimated on what it draws. Owner decision on #482: a head trim re-renders, so the range
  key marker is `range/<inMs>-<endMs>ms.json` (every Blender clip renders once more); `gc` recognises the old and new
  names. The opt-in real test has a case with `in` above 0; not run with a real Blender yet.
- `gc` cleans `.frameshell/blender/`, slice 5 of #482 (ADR 0035, epic #451, #509; no wire change, the entries are kind
  `clip`): the listing folders of `.blend` versions no clip has now, the length markers (`range/<ms>ms.json`) and
  version markers of lengths and Blenders no clip uses, each only if no current clip, in any timeline or format, names it
  as an input and nothing wrote it in the last minute; unknown names and symlinks stay (`finals.json` is not deleted, and
  is pruned of unused `.blend` rates since SF4, see Fixed). It is a new
  optional plugin-API hook, `ClipAdapter.gc(context)` with `AdapterGcContext { projectDir, inputs, dryRun,
  keepNewerThan, signal }`, so core never learns the plugin's layout: `ClipRenderer.gc` gathers the paths each adapter's
  `inputs()` returned while it keys every clip (the rule that keeps the clip renders), and skips the hooks with the
  same reasons when a clip has no key or a render or export job runs. `InputsContext` gets a `signal`, aborted when the
  daemon stops: the Blender that lists a `.blend`'s files (up to 5 minutes) is killed with it and no longer outlives the
  daemon.
- The opt-in real Blender test has a positive control for the driver trap: the same library's driver does write its file
  with auto-exec on and a frame evaluated, so "marker absent" under `-Y` means something. Not run with a real Blender
  yet.
- Motion templates, slice TP3 of #466 (ADR 0033, epic #451; plugin only, no protocol change): `frameshell hyperframes
  new <name> --template` takes four more. `logo-sting` is a short brand hit on its own background (the logo lands with a
  spring and a ring, a light band sweeps across, the name rises; a monogram stands in for a missing logo). `pip-card`
  is a still picture in a rounded corner card with an optional caption chip, over a talking head (image prop only: a
  live video in a corner stays the multicam picture-in-picture layout, owner decision 2026-11-16). `work-cards` shows
  task cards from a `title:status` list that come in staggered, pulse when they start and follow one shared progress,
  with no icons. `light-leak` is a seeded warm glow, a clip about a second long on a track above a cut, clear at its
  first frame and the last tenth of a second, `hue` and `intensity` props, no blend mode: an overlay, so the cut underneath keeps its
  length. Each pulls late cues in before the 0.3 s exit and lays out in all four formats. The hash of `seed` that
  `emphasis-marker` and `scene-background` each carried is one `SEED_HELPERS` in the kit, shared with `light-leak`.
  The `hyperframes` and Frameshell skills list them.
- `analyze` finds the faces for mouth sync itself, slice AL of #471 (ADR 0020 decision 16, epic #451; protocol 165): a
  reference file anywhere on disk no longer needs `people scan` first. When the project has no scan of the file's
  content, the run makes it with the same scanner as `people.scan` (the one `scanFileFaces` step) and caches it in
  `.frameshell/people/`, so `people scan` of a copy finds it again. On by default; the first run may download the face
  models. New `faces` param (`--no-faces`) skips the scan and still uses one already cached; a scan that cannot run
  (no model, no network, untrusted runtime) is a skipped `sync` with the reason and a warning, never a failed run.
  `analyze.diff` has no `faces`. `gc` leaves face scans alone while an `analyze` job runs (a scan of a file outside
  `assets/` is swept as unused afterwards; it is regenerable). The mouth is still picture motion in the face box: the
  5-point SFace landmarks have no mouth opening.
- `review` frames per beat and crops, slice RP2 of #457 (epic #451; protocol 164): `--sheets beats` (opt in, never a
  default) writes one frame per beat of the timeline's tempo grid, the one `tempo show` lists (`tempoGrid` through the
  daemon's grid loader), a quarter beat after each hit (the last beat takes the length of the one before), bar starts
  labelled `bar N` and the rest `beat N` like the `bar:N`/`beat:N` time references, up to 60 tiles thinned evenly with
  bar starts kept first; tile tag `beat`. No tempo, a LOW-confidence or unmeasured grid, or a `--file` writes no sheet
  and says why in `warnings`. `--crop-at x,y[,size]` (`cropAt` on the wire) crops every tile of the run but the safe
  sheet's around a point of the frame (size = share of the width, default 0.25, frame proportions kept) from the same
  captures, inside the picture letterbox bars leave; with `--clip id` the point is in that clip's own picture and
  follows its keyed position and scale, through the format's cover crop (ADR 0043 slice 4 as built). Each tile lists
  its `crop` in film pixels. `cropAt.clip` with a file, or naming no video clip, is InvalidOperation.
- Review mode: the proposal bar lists the `requirements.json` values a proposal sets, clears or waives
  (`Requirements: film.maxSeconds 30 → 20`), in English and Spanish. A `review` of a proposal whose requirements hold no
  valid file now says so in `warnings` and judges the film without them, instead of dropping them silently.
- The clip inspector's Colour section now shows for generated clips and nested timeline clips on video tracks, not only
  media clips (slice 9 of #384, ADR 0031, epic #451; no wire change). Same sliders, LUT and Reset, one `ui` `clip.set`
  per release; the LOG note stays on footage, and shots have no colour section. The reset tooltip no longer says "footage".
- The app finishes voiceover, slice VA of #470 (ADR 0034 decision 22, epic #451; protocol 163): "Generate voiceover…" on a
  voiceover script now opens a dialog with progress per line and a Stop button, then a report of every line (generated,
  already there, copied; heard as written, maybe the transcription, misread, with what the script said against what was
  heard) and the form of "Place voiceover…", which asks where to start (seconds, a marker, `beat:N`, `bar:N`, resolved by
  the daemon's TimeRef rules) and places the phrases on the main timeline in one transaction, with "replace" for takes
  already placed. "Place voiceover…" is also in the script's own menu. The misread check runs only when transcription is
  already on the machine, or after the person agrees to its download in the dialog; never a silent download. Stop is the
  new internal `voiceover.cancel`: it stops the generations of its own connection only (never an agent's run in
  front of it; a call still waiting its turn ends at once), the line being said is abandoned, the takes saved before it
  are kept and imported, and the stopped call fails with `SpeechFailed` (`data.canceled`); it answers `canceled: false`
  when it had nothing to stop and the dialog gives the button back. The dialog keeps keys and focus inside it, moves to
  the project window when its detached panel closes, and the progress bar is one fraction of the whole run. `FRAMESHELL_SPEECH_STAND_IN=slow` adds
  `stand-in-slow` for the e2e. The native "ready" and error boxes are gone (the dialog says it); the cost box stays.
- `frameshell voiceover generate --yes --confirmation <token>` binds a CLI confirmation to the ask the person saw: the
  `ConfirmationRequired` refusal prints the confirming command with its token and the `--lines`, `--provider`,
  `--voice` and `--no-verify` it was made with, and a script or price that changed
  meanwhile fails with `ConfirmationStale` instead of charging more than was confirmed.
- Requirements of `review` stay in frame and go through the config journal, sixth slice of #457 (epic #451; protocol
  162; `review.require`, `review.waive`, `clip.staysInFrame`, config document `requirements`): a clip requirement
  `staysInFrame` (`true` or `{ margin }`, a share of the frame kept clear on every side) fails when what the clip draws
  leaves the frame of the format reviewed: a generated clip's alpha (the boxes the safe-zone check already reads) or a
  footage clip's faces (a cached `people scan`), after the format's cover crop and inside letterbox bars; touching an
  edge is leaving it. The check names the `format` and the `spans` (timeline seconds) that leave, and is skipped with
  why for a clip with nothing placed (a render with no alpha, no face scan). `requirements.json` is a config document
  of ADR 0036 (keys `requirements:film.<field>`, `captions.minSize`, `fail`, `clip:<id>.<field>`,
  `waiver:<check>[:<clip>]`): `frameshell review require <path> <value> [--clip id]` and `frameshell review waive
  <check> <reason> [--clip id]` (`--remove`) change it one value at a time in the caller's transaction, so `history`
  lists them, `revert` and `tx abort` undo them and review mode holds them in the proposal; a `file.write` of the file
  and a hand edit are journaled like `style.json`'s, and `review` with `view: proposal` judges the proposal's version.
  Older files load unchanged; waivers stay in `requirements.json` keyed by clip id (no field on timeline clips). Not
  yet: requirement lines in the app's proposal bar, `staysInFrame` for clips inside a nested timeline (built in wave 28, see above).

- Blender clips, slice 4 of #482 (ADR 0035, epic #451; protocol 161): a scene at another frame rate than the project is
  time-remapped with seconds kept (project frame k shows scene frame `start + k × scene fps / project fps` through a
  subframe; no ratio is refused) instead of refused. Files a `.blend` loads from outside the project (owner decision
  2026-11-16) render, their content hashes are a key input with no path in it (`outside.json` beside `deps.json`), and
  every render of such a clip warns, naming them. Blender is found without `binaries.blender` where its installers put it
  (macOS `/Applications/Blender.app`, Windows `Program Files\Blender Foundation\Blender <x.y>` newest supported, Linux
  PATH and `/snap/bin`; PATH on every platform), by generic `UserInstall.standardPaths` data read by one lookup in
  `BinaryManager.locate`; an override still wins. `doctor` reports such an install as source `system` with `found`
  (`standard` or `path`). Not run with a real Blender: the opt-in real test now also checks the remap at a subframe, the
  outside-file warning and that a scripted driver of a linked library outside the project stays off under `-Y`.

- Loudness over the part of a file a clip plays, `duck --level style` and the level set again, slice MU2 of #485 (ADR
  0037, epic #451; protocol 160). `LoudnessStore` reads the seconds a clip plays (`in` to `out`, on whole frames) and
  caches them beside the whole-file reading in `.frameshell/loudness/` (`<hash>-l1-r<start ms>-<end ms>.json`, same `gc`
  kind; a part that spans the file or is under one 400 ms block is the whole-file reading, so nothing is measured
  twice). `music candidates --end` reads each file over the part its fit leaves playing, and `duck --level` reads each
  music clip, and each voice clip (a file cut into over 8 pieces is read whole), over its played part. `duck --level
  style` (`track.duck` `level: "style"`) takes the project's `sound.musicUnderVoice`; the number is what is kept in
  `audio.duck.level` and reported with `level.source`. `music fit`, `music shape` and `music grid` set the clip's static
  gain again from the stored `level` before they write the keys and run the duck again (a clip with gain keys of its own
  keeps its gain, with a warning).

- Documented limit of the export's loudness loop: it adds at most +3 dB (`MAX_TRIM_DB`), and when that cap binds the file
  ends under the target by more than 0.15 LU (a transient-heavy mix that is quiet before the limiter, at AAC 128 kbps,
  ceiling -4.9 dBTP). Kept on purpose (owner decision 2026-11-16); see SPEC §3.5 step 4 and ADR 0038 "Not done".

- Subject mattes follow colour edges and 4K plates get a full-size matte, slice MX1 of #461 (ADR 0032, epic #451;
  protocol 159): the guided filter fits the coarse alpha against the frame's three colour channels (He et al.'s colour
  guided filter), so an edge between two colours of the same brightness is found (error at a same-luma disc's edge 0.045
  against 0.145 with the gray guide). A source whose short side is above 1080 px also gets `<key>.full.mp4`, refined on
  the asset's own frames on the proxy's frame grid at its size (short side at most 2160), which `render`, `frame` and
  `cover` draw through; the preview keeps the proxy-size matte. `matte.prepare` returns it as `full` and
  `frameshell matte` prints it. `MATTE_VERSION` 2: older mattes are made again. Measured on an Apple M3 under heavy load:
  refinement 47 ms per 540p frame (gray guide 21 ms), the full-size pass 355 ms per 4K frame, about 2 minutes per minute
  of video for the matte and about 11 more for a 4K source's full-size one.

- More sound checks in `review`, slice RA1 of #457 (epic #451; protocol 158; `metrics.sound.music`, `edges`, `harsh`,
  craft checks `masking`, `edge-click`, `harsh`). On a timeline, still never mixed: `music` is the voice against the music
  alone per 0.5 s window where the voice speaks, judged by the style guide's `sound.musicUnderVoice` (`style.json`, 12 dB
  by default) less 3 dB, never under 0; the stretches under it are `masking` (the existing `voice-bed` keeps judging the
  voice against everything at 6 dB). `edges` lists clips starting with no fade inside sound their asset already plays
  before the in point, at -45 dBFS or more and 19 dB or more over the rest of the film's sound in the 10 ms before
  (`edge-click`; earshot's 9x click ratio); a clip played from its asset's start, picking up the same sound or a
  dissolve is no cut-in. On a `--file`, `harsh` measures the 2 to 6 kHz band of the decoded mix per 400 ms against that
  band in the loudest 400 ms (at least 20 dB under the whole mix there), and the stretches over 6 dB above it are `harsh`
  (earshot's rule, with the mix's loudest moment standing in for the music's). Thresholds are data in
  `review/thresholds.ts`; every finding is a warning unless `requirements.json` lists its check in `fail`. Not yet:
  masking per 1/3-octave band (the envelopes are broadband), a click in an exported file placed on a clip edge, and the
  ADR 0038 decision 5 lint rules over the whole timeline.
- Code templates, slice TP1 of #466 (ADR 0033, epic #451): `frameshell hyperframes new <name> --template code-typing`,
  `code-diff` or `code-morph` scaffold a code window. `code-typing` types a snippet key by key with the uneven rhythm of
  `typing-field`, a caret that blinks at rest, an indent that arrives with its Enter, waits after the lines named in
  `pauses` and a timing guard that types faster in a clip too short for it. `code-diff` shows two snippets as a unified
  diff: unchanged and removed lines come in, then each change is lit in turn (a removed line on a red wash with a strike
  through it, an added line sliding in on a green one). `code-morph` turns one snippet into another: tokens both have
  travel to their new place, the rest fade out or rise in. Props `code` / `before` / `after`, `language` (`js`,
  `python`, `shell`, `json`, `plain`), `highlight`, `title`, `numbers`, `card`, `accent`, `size`, `bg`, `backdrop`, plus
  timing props per template; the type shrinks until the longest line and every row fit in each format. A small built-in
  tokenizer colours keywords, strings, numbers, comments and calls (no highlighter dependency, no network); the face is
  the system monospace and the window colour and accent come from `style.json` (`colors.card`, `colors.accent`). The
  character width is measured on the rendering machine. The skill lists the three templates; the opt-in real-render test
  covers layout in the four formats, cold-versus-reseek frames, the typed text, the pauses, the diff turns and the morph
  end state.
- Wheel, roll, tab and freeze templates, slice TP2 of #466 (ADR 0033, epic #451): `slot-roll` spins a reel of words or
  numbers (`items`, one `|`-separated prop) past a highlighted band and lands on `target` (added to the reel when it is
  not in it; empty lands on the last), which flashes in the accent colour and pulses. `number-wheel` is an odometer:
  every digit is a column that rolls to its final digit (left columns first, the two lowest turn twice), ends on exactly
  the text `counter` would print (columns and separators left of the first digit of a shorter end fade out as they land)
  and holds; the slots are as wide as the widest digit, measured on the rendering machine
  (`1ch` is only the 0), and one line high, so nothing shifts while it rolls; count time 1.4 s by default (0.6 to 3).
  `tab-indicator` is a row of tabs with a pill or an underline that stretches between them: the edge it moves toward
  leaves first and the other follows, both springs retargeted at each time of `plan` (`2@1.2|4@2.4`: tab number or
  name). `freeze-cut` is the owner's 2026-11-16 decision: a template over a still image prop, not a freeze-frame
  operation on the timeline; the still drifts and sways, then on the beat it stops dead with a punch-in toward a focus
  point, a white flash and an optional label (make the still with an exported frame). Typed props with bounds and the
  per-format layout as in the other templates; every one pulls a late beat in so it lands before the 0.3 s exit. The
  `laps` of `slot-roll` is rounded to whole turns and its reel never has fewer than three items; the
  freeze sway stays inside the room the punch scale gains. The number format of `counter` moved to the kit (`NUMBER_FORMAT`, `GROUPING_VARIABLE`) so `number-wheel` shares it. The
  skill lists the four; the opt-in real-render test covers layout, cold-versus-reseek frames and alpha in the four
  formats, the digits shown at the start, mid-roll and the end, the band after a roll, the indicator edges before, in
  and after a move, and the flash, punch-in and hold of the freeze.
- Style suggestions from a reference analysis, slice of #471 (ADR 0028 slice 4, epic #451; protocol 157): `analyze`
  returns `suggestions` (also in `analysis.json`), values for `style.json` read from the film, each with `path`,
  `value`, `why`, `from` (the result fields) and its own label: `colors.bg` (the palette's largest colour, a quarter of
  the picture or more), `colors.ink` (most contrast against it, 4.5:1 or more), `colors.accent` (most saturated colour
  that is not grey), `motion.personality` (the personality whose standard move is nearest the median eased move, else
  energetic or calm from the pace of the cutting, a DECISION) and `sound.musicUnderVoice` (how far the voice sits over
  the music). Never applied by `analyze`. `style.apply` takes `analysis` (and `paths`) instead of `name`, CLI
  `frameshell style apply --from-analysis <analysis> [--only <path,...>]`: the picked suggestions merge value by value
  as one journaled change that `revert` undoes, held by review mode. `labels` gains `suggestions` (DECISION); `analyze`
  prints them. The analysis name pattern is one constant (`ANALYSIS_NAME_PATTERN`).
- `clip compare` and the Blender playbook, slice 3 of #482 (ADR 0035, epic #451): `frameshell clip compare <clip> --look
  [name:]key=value[,...] [--at s] [--out file.png] [--tile-width px] [--format id]` (daemon method `clip.compare`, MCP
  `clip_compare`) renders one frame of a generated clip under up to 11 variants next to the clip as it is, as one
  labelled PNG, through the export `frame` path and the sheet writer `grade.compare` and `review` share. A variant is
  props merged over the clip's own and/or another `source`, so one `.blend` with a scene per lighting setup is compared
  with `--look dusk:scene=Dusk`; each tile is drawn from its own render (a Blender clip: its draft, never a final) and
  the command prints the `clip set --props` that keeps it. Changes nothing. The `blender` skill grows from a stub into a
  playbook: which route (Blender, three.js, imported media), preparing a `.blend` (fps, length, camera, alpha,
  files inside the project, no add-ons or scripts), a look recipe, looks compared on one frame, draft to final with the
  confirmation, and a failure-and-fix table of the plugin's messages. Protocol 156.
- `logo-3d` template, slice 3 of #473 (ADR 0042, epic #451): `frameshell hyperframes new mark --template logo-3d
  [--component <svg of brand show>]` extrudes an SVG logo with three.js `SVGLoader` and `ExtrudeGeometry` in the
  `product-shot` studio, revealed by a rise (depth grows out of the flat logo), a swing or a drop, with a glint, a slow
  turn, a soft shadow on a wall behind it and an optional headline. Props `logo` (an SVG inside the composition; empty
  shows a built-in mark), `depth`, `bevel`, `colors` (one colour or the SVG's own fills), `color`, `finish`, `reveal`,
  `spin`, `title`, `size`, `shadows`, `backdrop`. Filled paths only (holes and even-odd fills work); a missing file, a
  raster or an SVG with nothing filled fails the render naming the file. The three.js bundle gains `SVGLoader`
  (`pnpm gen:three`, +29 KB), and the studio's finish presets and asset loader move into `three-kit.ts` for both 3D
  templates. The 3D playbook gains an "A 3D logo" section. `title-3d` is not built (blocked on the Archivo licence). The
  opt-in real-render test checks both fills, alpha, `clip.verify` at tolerance 0 and the three failure messages.
- Colour grade on generated clips and nested timeline clips, slice 8 of #384 (ADR 0031, epic #451; protocol 153):
  `clip set --grade-*` (`clip.set` `grade`, MCP `clip_set`) now takes adapter clips and nested timeline clips on video
  tracks too. A render is graded first in its part, before its alpha, as footage is (export `lut3d` right after it is
  read; the preview grades the decoded colour before the alpha plane masks it). A nested timeline clip's grade follows
  the own grade of every picture inside it, at any depth: flattening records the hosts' grades on each picture
  (`hostGrades`) and export and the preview fold the chain into one table (`gradeChainOf`, `gradeChainTable`), so it
  comes before that picture's vignette and grain; sound and shots are untouched. Plans of timelines without nested
  grades are unchanged. Tests: chain tables, flattening two levels deep, two goldens, the managed ffmpeg on a nested
  still and a VP9 alpha render, and the preview's tables against the ones export writes.
- Motion film playbook refreshed, slice of #453 (epic #451; no protocol change): `reference/motion-films.md` and its router
  row in `SKILL.md` now cover what landed since the first version: the brief written as `requirements.json` at the
  storyboard gate and `review` exiting 1 on it at the critique gate, `analyze` audio fields (`pace`, `pitch`,
  `voiceOverMusic`, `effects`, `sections`, `--no-speech`) as measured targets, a `grade analyze` / `grade compare` pass on
  supplied footage, `beat:N` / `bar:N` in every time argument, `voiceover place --tempo`, `music shape --drop --build`,
  the `beatsProblem` codes of generated clips that read beats and markers, and `batch` typed slots with `--review`. Links
  go to the reference pages instead of repeating them.
- Music fit follow-ups of #485 (ADR 0037 "Follow-ups as built", epic #451; protocol 152): `music shape --ending <time>
  --end-on-bar` (MCP `music_shape` `endOnBar`; result `endsAt`) stretches or shrinks the closing fade so it ends on the
  bar start of the grid nearest to `--ending + --fade`. `music grid` carries the hits stored by `music shape` with the
  shots that moved (result `shape`: the shaping, keys and builds, runs again in the same transaction before the duck;
  `--skip shape` leaves them). `music grid --trim head` (`trim: "head"`) moves a cut as a roll edit (tail before it and
  head after it trimmed to the beat, nothing ripples), and `--tracks all` (default; `video` keeps the old behaviour)
  also reads program-track shot changes (`kind: "program"`, always rolled, since the group clock keeps running) and
  entries of clips alone on upper video tracks (`kind: "entry"`, moved whole). Each cut of the result gains `kind`, and
  `out` is null for an entry.
- Per-row voiceover and CSV rows for batch, a slice of #477 (ADR 0040 and 0034 slice 4, epic #451; protocol 154): a batch
  slot written `voiceover` takes a voiceover script path per row (or `{ script, lines, at, tempo, start, gap, track,
  replace }`) and places the script's existing takes as phrase clips on the row's variant, in memory, with the planner
  and writer of `voiceover.place` (same spacing, anchors, tempo, fades, overlap rules), so a row per language gets its
  own voice without a second placement path. Batch still never generates: a line with no take fails the row naming it.
  A subtitle track that follows the voice track needs every take transcribed, and a voice that runs past the template
  adds a warning with the new length to the entry. The rows may be a CSV file next to the batch file (`"csv":
  "launch.csv"` instead of `rows`): header `id` and slot names (`price:number` types a column; otherwise the type of the
  template's value), comma, `;` or tab, quoted cells, an empty cell leaves the slot to the template, and every wrong cell
  is reported with its line and column. Tests: `batch-csv`, `batch-plan`, and a daemon test with the stand-in voice
  that places, renders and refuses rows. Skill `batch.md`, `docs/mcp.md` and `batch.json` updated.
- Blender finals, slice 2 of #482 (ADR 0035 as amended by ADR 0041 decision 11, epic #451; protocol 155): every `blender`
  clip keeps two renders. The draft (EEVEE, or Workbench) renders in the background for the preview and draft exports.
  The final (Cycles: 80 samples, adaptive threshold 0.02, OpenImageDenoise, fixed seed, 6 bounces, no caustics,
  persistent data, the first GPU backend Blender finds) is rendered only when a `render` with `quality: "final"` or no
  quality needs it, and the export waits for it. `clip.renders` shows it as `final` with `onDemand: true`, `waiting`
  until then; Chat about this does not hold its frame for it. `render
  --quality draft` adds a warning per clip exported from its draft. When the missing finals are estimated over 5 minutes
  in all, `render` fails with `ConfirmationRequired` (`data.finals` lists each clip's estimate, `data.seconds` the total)
  and queues nothing, until it is called again with `yes: true` (CLI `render --yes`, MCP `render` `yes`). `batch.render`
  asks the same over the finals of every chosen row before the first row queues (`yes`, CLI `batch --yes`; entries of
  `data.finals` name their `row`). Estimates are frames x megapixels x the per-frame rate that `.blend`'s last final
  took on this machine, its first frame (start-up, kernel compile) left out (`.frameshell/blender/finals.json`), else
  the project's last, else 5 s. `frame` and `review` use a cached final and otherwise the draft, with a warning;
  they never start a final. Plugin API (additive, `apiVersion` stays 1): `ClipAdapter.finals` with `estimate`, and
  `RenderContext.tier`; a final's key adds `final: true`, so draft keys are unchanged. Tests use the stand-in Blender and
  a `final-card` fixture adapter; the opt-in real test renders a Cycles final.

- Per-phrase tempo for voiceover, slice 5 of #470 (ADR 0034 decision 21, epic #451; protocol 151): `voiceover place
  --tempo hook-1.2=1.1,fix-1=0.9` (MCP `voiceover_place` `tempo`; keys as in `--at`) plays single phrases at 0.8 to 1.25
  times their speed as the phrase clip's `speed`, pitch kept in the preview (WSOLA) and the export (`atempo`) by the #499
  work, so no second time-stretch path. A phrase lasts `(out - in) / speed`; the pause the take has before the next
  phrase stays as long as it was, and the next line follows the line's real end. Every placed phrase reports `speed` and
  its effective `duration` (a dry run shows them first). A key that names no line or phrase, one given twice, or a tempo
  outside the range fails before anything is written. Tests place phrases of the stand-in voice at 0.8, 1.1 and 1.25 and
  check the clips, the pauses and the line ends.
- Motion blur of 3D compositions capped at 8 samples, and warnings for a blur that did not apply, slices of #473 and #501
  (ADR 0041, ADR 0042 decision 13, epic #451; protocol 150): a HyperFrames composition that draws with WebGL (it holds the
  three.js bundle `frameshell-three.js`, or a script makes a `WebGLRenderer` or `webgl` context) renders its blur with at
  most 8 samples per frame, since each sample is a full frame on the software renderer. Adapters get `RenderContext.warn`:
  the note is kept with the cached render and shown wherever that render is used. `frame` returns `warnings` (CLI prints
  `warning:` lines; MCP `frame_capture` has them in its facts), `review` adds them to its own `warnings`, once each, and
  export jobs show them as before. Where the producer refuses a blur (HDR content, shader transitions) and the sharp
  render stands in, `frame` and `review` now say so too, where only `clip.renders` `final.error` did.
- TimeRef in the last time arguments that took plain seconds, a slice of #458 (ADR 0029 slice 4, epic #451; protocol 149):
  `sound.place` and `sound.music` now read `beat:N` and `bar:N` too (they took seconds and markers only: the `cues[].at`,
  `typing.from`/`to`, `at`, `sections[].at` and `accents[]` times), and `captions.set` `from`/`to`, `multicam.direct`
  `from`/`to`, `multicam.reframe` `time` (the timeline second; `at` stays group seconds) and `ui.seek` `at` (read on the
  timeline the app shows) take a marker, `beat:N` or `bar:N` as well as seconds. All go through the one resolver, so the
  messages are those of `--snap-to`: a timeline with no tempo, a clip with no beats file yet or a LOW confidence grid is
  refused with the argument named (`sound.place: cues[1].at: ...`). The history records seconds. CLI `captions set`,
  `direct`, `multicam reframe --time` and `sound place|music` pass the text through. `track.duck` and `music.shape` curve
  times are computed by the daemon in seconds, not typed, and `multicam.paint` is on the group clock, so they stay numbers.
- Brand pictures in motion templates, the last slice of #467 (ADR 0044, epic #451; no protocol change):
  `frameshell hyperframes new <name> --template <t> --component [<prop>=]<path>` copies a picture `brand.json` lists
  (a captured logo, icon, screenshot or `section-*.png` crop, or a Figma frame) into the composition as
  `brand/<id>/<file>` and makes it the default of the template's image prop (`logo`, `screenshot`, `picture`,
  `before`/`after`, `label`). Fonts and files `brand.json` does not list are refused before anything is written. For a
  Figma frame the output also gives its place at the folder's one scale on this canvas; while `credits.json` has no
  licence for the source, it says so, since `frameshell credits` does not check files inside a composition. The
  Frameshell skill gains a brand page (`reference/brand.md`: capture, findings listed before use, credits, fonts,
  Figma, `--component`).

- Letterbox per format, slice 4 of #500 (ADR 0043 and ADR 0027 decision 14, epic #451; protocol 148): `letterbox set <aspect>
  --format 9x16` (and `letterbox clear --format`; daemon and MCP `letterbox.set` `format`) gives one format its own black
  bars, stored in the timeline's `formats`; a format without an entry still draws none, and export, `frame` and the
  preview of that format draw them like the primary's. `inspect.point` reports `picture`, the rectangle the bars leave, and
  `inBar` when the point lies in a bar (nothing is seen there), and the `safe` sheet of `review` gives `safeZones[].picture`
  and measures graphics and faces inside it, since the bars cover what lies in them. `timeline show` lists the bars per
  format. Inspector rows and a timeline control are still to come (#581).
- The swept high-pass build before a drop, slice 6 of #485 (ADR 0037, epic #451; protocol 147): audio effects take a new
  kind `highpassSweep { from, to, startHz?, endHz? }` (seconds of the file; cutoff 40 to 300 Hz by default, rising
  exponentially, out of the signal before `from` and from `to` on). It is baked with the rest of the chain, so the preview
  and the export play the same samples, deterministically (ffmpeg `highpass` moved by `asendcmd`). `frameshell music shape
  --drop <hit> --build 2` (also `--build-from`, `--build-to`; MCP `music_shape` `build`, `buildFrom`, `buildTo`) writes one
  per hit, on the file's clock and aimed at the hit through the clip's place and speed, in the same transaction (one
  `clip.set audioEffects`; marked `auto: "music"`, replaced by a re-run, removed by `--clear`, hand-set effects kept);
  `music fit` aims them at the hits again when it moves the clip. The inspector's Voice group shows a build's two cutoffs.
  A timeline with it is rejected by an older Frameshell (JSON Schema regenerated). Tests measure the low band before,
  during and after the build on a synthetic signal, in the bake and in an export.
- `grade.compare`, slice 7 of the colour grade (#384, ADR 0031, epic #451; protocol 146): pick a look by eye. One frame of
  a media clip (default its middle frame, or `at`) is rendered under up to 16 `looks` (each a whole `clip.set` `grade` plus
  an optional `name`; fields left out are neutral), next to a neutral baseline and the clip's own grade when it has one, and
  tiled into one labelled PNG (default `.frameshell/grade/compare-<clip>-<frame>.png`, tiles 160 to 960 px wide, default
  480). Every tile goes through the `frame` export path on a copy of the loaded timeline with the clip's grade swapped, so
  layers above, captions and the format are drawn as exported; the timeline is never changed. Each tile's `flags` are the
  `clip set` flags that give the clip that grade. A look's LUT outside the project, missing or not a 3D `.cube` is
  refused before rendering (`InvalidParams`). `frameshell grade compare <clip> --look warm:temperature=0.25,saturation=1.1
  [--look ...] [--at s] [--out file.png] [--tile-width px] [--format id]`; MCP `grade_compare` returns the sheet as an
  image. No built-in looks yet.
- `analyze` audio: sentences, pace, pitch, voice against music, effects and sections, last part of #471 (epic #451; protocol 144):
  the result and `analysis.json` of `frameshell analyze` gain `audio` (null for a film without sound; every value
  ESTIMATED in `labels`, read from the mix, never from separated stems). `audio.speech` is recognised by the project's own
  transcription provider and model (the daemon asks it for the film's sound, nothing is written to the project; the first
  run may download the model; no plugin, an untrusted project or a failure leaves `speech.status: "skipped"` with its
  `reason`, and a film over 10 minutes is skipped): each sentence (a full stop or a pause of 0.8 s ends one) has its
  `pace` in words per second, `pitch` (10th, 50th and 90th percentile of the voiced frames in Hz by the YIN method, and
  the `range` in semitones) and the voice against the music under it: `music` is the median level of the hops no word
  covers around the sentence (the gaps between its words), `voice` the mix over the words with that bed taken off as
  power, `voiceOverMusic` their difference in dB (null when no music plays under it or the music is as loud as the mix).
  `audio.effects` are sound hits (the `hit` detector of `events`, `soundHits`, taking a rise of 8 dB instead of the 12 dB of the `hit` events) that touch no word and, when the
  tempo is steady, no beat, each with its `overMusic` (the effect alone over the bed, from the rise as a power ratio) and
  `onBeat` counting those left out; null when the speech was skipped, since a word cannot be told from an effect.
  `audio.sections` are stretches where the level of the sound without the words steps by 4 dB or more (at least 4 s
  apart), snapped to a downbeat of a steady tempo with their `bars`, and the `speech` share they cover. The CLI prints
  `Speech`, `Effects` and `Sections` lines with a sentence and a section table; `--no-speech` (`speech: false`) skips the
  recognition, the slow part. New files in `packages/core/src/analyze/` (`audio.ts`, `speech.ts`, `pitch.ts`); the
  skill (`reference-video.md`), `docs/mcp.md` and SPEC say how to read them.
- Beats and markers for generated clips, ADR 0029 decision 8 (#458, epic #451): a generated clip can sync its motion to the
  music. An adapter says per clip which timing it reads (`ClipAdapter.timing`, `beats` and/or `markers`; plugin API
  stays "1") and gets `RenderContext.timing` (and `LiveContext.timing` for the live page): the beats of the timeline's
  grid with their `beat:N`/`bar:N` numbers and tempo, and the markers, that fall inside the clip, in composition seconds.
  No usable grid gives no beats and a `beatsProblem` code (`no-tempo`, `no-music-clip`, `no-beats`, `broken-beats`,
  `low-confidence`; worded by `RENDER_BEATS_PROBLEMS`), never a failed render; the key counts the code, not an error's
  words, so it holds while the reason does. Only clips that ask count it in their render key, so moving the music or a
  marker re-renders them and nothing else; existing keys are unchanged. A clip that asks inside a nested timeline is
  keyed through the timeline that shows it, in the background as in preview and export, so it renders once. An adapter
  whose `timing()` throws leaves the clip unavailable. HyperFrames compositions ask with
  `<meta name="frameshell-timing" content="beats markers">` and read `window.frameshellTiming`. No wire change.
- Batch slot defaults and a review column, slice 5 of #477 (ADR 0040, epic #451; protocol 145): a batch slot written
  `<clipId>.props` (no path) sets the prop named like the slot, so `"title": "c_8f2a1b.props"` is
  `c_8f2a1b.props.title` and a template's declared props become slot names without repeating them. `batch.render` takes
  `review` (CLI `frameshell batch --review`): each rendered file is reviewed (`ReviewService.run` on the file, metrics
  only, one at a time while the next row renders) and its manifest entry gets `review { state, verdict, warnings, failed,
  checks, run, error }`: `fail` when `requirements.json` fails, `warn` for craft warnings, else `pass`. The manifest says
  `running` until the last review ended, `gc` keeps clip renders until then, a failed render has no review and a review
  that cannot run (`error`) never fails the render. Rows skipped as done are reviewed when they have no finished review.
  The CLI prints each verdict under its file and exits 1 when a verdict is `fail`. Off by default (a review decodes the
  file). Old manifests without the field still read (`review` null). Skill `batch.md` says so.
- Clip grain, slice 3 of #500 (ADR 0043, epic #451; protocol 143): an optional `grain { amount?, size?, seed? }` on media
  and generated clips adds film grain to the clip's own picture (`{}` = amount 0.35, grains 1.5 project px wide, seed a
  hash of the clip id), after its grade and vignette and before scale, keys and transition shapes. A timeline frame
  always gets the same grain, in one segment or split ones, a `frame` capture or the cover frame: the pattern is a
  seeded ffmpeg `noise` plate of 64 frames, phased by the timeline frame, merged with `blend grainmerge` (alpha kept); a
  subject-matte copy keeps its plate clip's seed. `frameshell clip set --grain 0.3` (also `--grain-size`, `--grain-seed`,
  `--clear-grain`; daemon and MCP `clip.set` `grain`, merged, `null` clears; refused on nested timeline clips, skipped on
  multicam shots with a warning). The app's preview draws grain of the same strength in the grade and vignette WebGL2
  pass (statistically matched, not pixel for pixel). A `--loop` export with grain warns when its length is not a
  multiple of 64 frames. The skill says never on screen recordings, UI or text. Timelines without it export
  byte-identical plans. No inspector control yet.
- The sound review list of `review`, sixth slice of #457 (epic #451; protocol 141; `metrics.sound`, craft checks `voice-bed`,
  `sfx-repeat`, `machine-gun`, `chopped`, `ending`, `click`): the measurable parts of "the voice is always on top, no effect
  repeated more than twice, the music resolves on the final frame" and earshot's mechanical audio QA. On a timeline nothing is
  mixed: each heard clip is read from its asset's cached 10 ms envelope (the cut-snapping one) with its gain, gain keys and
  fades, and sorted by role: voice (a `Voiceover` track, a track a duck names in `under`, an asset with a transcript), music
  (a `Music` track, a music take, a ducked clip), effects (a generated take, an `SFX` track) and the rest. `sound.voice` is
  voice minus bed per 0.5 s window where the voice speaks, with the stretches under 6 dB (`voice-bed`); `repeats` lists
  effect files heard more than once (ticks and clicks left out: key runs rotate them), over twice is `sfx-repeat`;
  `machineGun` is one file 4 times or more in a row, each within 1 s of the last (earshot's rapid repeats; one take twice
  in a row at any distance stays `sound place`'s placement warning, ADR 0038 decision 5); `chopped` lists clips ending inside the film with their last 10 ms
  above -35 dB of their loudest (a dissolve or the same sound going on is no cut); `ending` is the music on the last frame
  against its loudest, above -35 dB a warning. On a `--file` (the decoded mix) `ending` is the RMS of the last 50 ms (above
  -45 dBFS) and where the loudest 400 ms are (after 85 % of the film), and `clicks` are bursts above 14 kHz over 9 times
  the RMS of their 20 ms with 80 % of that energy in 1 ms. Thresholds are data in `review/thresholds.ts`; every finding is a
  warning unless `requirements.json` lists its check in `fail`. The phone band against the mix was already measured on a file
  (third slice). Not yet (open in #457): masking per 1/3-octave band, harshness (2 to 6 kHz against the music's loudest), a
  click within 2 ms of a clip edge as a failure, `musicUnderVoice` from `style.json`, and the ADR 0038 decision 5 lint
  rules over the whole timeline (more than 2 sounds on a frame, gaps under the per-kind minimum, one take twice in a row).
- Grade analysis, slice 6 of #384 (ADR 0031, epic #451; protocol 140): `grade.analyze` measures a media clip's source
  picture with ffmpeg `signalstats` (one frame with `at`, or `samples` frames, default 8, over `from` to `to` or the whole
  clip; a still is one frame) and returns the levels (luma min, shadows, mean, highlights, max; saturation; warmth; tint),
  the clip's current grade and a bounded correction suggestion in the fields of `clip set --grade-*`: at most 1 stop of
  exposure (never pushing the highlights into clipping), 0.4 of temperature or tint, contrast 0.8 to 1.25, saturation
  0.85 to 1.2, nothing for a picture within the targets or without range. It reads only and applies nothing: each
  number comes with a reason and the `clip set` flags that apply it; a correction the clip already sets and the source does
  not need comes back neutral, so applying the flags replaces the clip's own correction (its LUT stays). `frameshell grade analyze <clip> [--at s | --from s
  --to s] [--samples n]` (also MCP `grade_analyze`); footage that looks like LOG or HDR gets a warning. Not yet:
  `grade.compare` (candidate looks on one frame) and looks generated by Frameshell.
- More sound effect kinds, slice 5 of #463 (ADR 0038, epic #451; protocol 139): `sound sfx` (and `sound place`, MCP
  `sound_sfx` / `sound_place`) make `glitch` (a stutter of short square or saw tones), `braaam` (a low brass blast on a
  root, detuned saws under a sweeping low-pass), `swell` (a quiet build that peaks near its end, `--length` 0.5 to 3 s),
  `bell` (a soft bell of inharmonic partials), `notify` (a ping near 2 kHz with a partial at 3.4 times its pitch) and
  `sting` (a chirp falling into a low hum, for a logo), three variants each, deterministic by seed. Placement defaults:
  glitch `click`, braaam and sting `knock`, swell `swell`, bell and notify `pop`; all but braaam and sting are
  secondary tier. The `sound` skill reference lists them with taste rules. Not yet: the CC0 set and the energetic music
  preset.
- Emphasis and reveal templates, part of #466 (ADR 0033, epic #451): `frameshell hyperframes new <name> --template
  emphasis-marker` draws a hand-drawn mark on a phrase of a sentence (`marker`: highlight, circle, underline,
  strike-through, box or bracket; `mark` names the phrase, `rough`, `weight` and `seed` shape the wobble), `before-after`
  sweeps a divider with a handle across a card and reveals the second picture, and `pull-back-reveal` opens tight on a
  detail of a screen and pulls the camera back to the whole window before a title rises. Every mark and move is a pure
  function of the time, so a seek paints the same pixels; a late start is pulled in so the move finishes before the
  exit. The `hyperframes` skill lists them with their props. Not yet: the rest of #466 (beat freeze cut,
  slot-machine roll, number wheel, code blocks, stretching tab indicator).
- Brand sections and substitute fonts, slice 4 of #467 (ADR 0044, epic #451; protocol 142):
  `frameshell brand capture <url> --sections "Pricing,Teams"` (daemon/MCP `sections`, up to 12 texts) also crops the
  part of the page around each text at 3x into `assets/brand/<id>/section-<text>.png`: the smallest element at least
  500 CSS px wide holding the text, a heading before a nav link, never the heading line alone, at most 2400 CSS px
  tall with the text inside; `brand.json`
  `sections` records each crop's box and element, or `not found`. A font family whose face may not be copied now names
  the closest open font from a curated, licence-checked table in `packages/schema/src/font-substitutes.ts` (50 families
  from google/fonts with their folder; metric-compatible stand-ins for Arial, Times New Roman, Courier New, Calibri,
  Cambria, Georgia; then category and width from the name, OS/2 or the CSS stack) as `substitute`, also named in the
  `style` suggestion and the CLI output. Icon fonts are now also told by their cmap (most characters in the Private Use
  Area), before the licence check, so an OFL icon font is never copied as a text face.
- 3D playbook, slice 4 of #473 (ADR 0042, epic #451): the `hyperframes` skill gains `3d-playbook.md`, a reference for
  3D product shots in three.js: which route to take (the `product-shot` template, a hand-written scene, Blender), the
  studio defaults (lights, environment, tone mapping, VSM shadows), the four finishes with their numbers, the glint,
  camera and modelling rules, the 6 s beat sheet, a failure and fix table, and how to bring a GLB from Blender
  (glTF Binary, no compression, inside the composition directory). The headless Chrome of `clip verify`,
  `inspect point` and `brand capture` now launches with `--enable-unsafe-swiftshader`, so WebGL works there without a
  GPU. Not yet: the `title-3d` and `logo-3d` templates (slice 3).
- Clip vignette, slice 2 of #500 (ADR 0043, epic #451; protocol 136): an optional `vignette { strength?, radius?, softness? }`
  on media and generated clips darkens the clip's own picture smoothly towards its edges (`{}` = strength 0.35, full at
  the corners, falloff 0.6 half-diagonals), after its colour grade and before scale, keys and transition shapes; in
  another format it darkens the part the format shows. `frameshell clip set --vignette 0.4` (also `--vignette-radius`,
  `--vignette-softness`, `--clear-vignette`; daemon and MCP `clip.set` `vignette`, merged, `null` clears; refused on nested
  timeline clips, skipped on multicam shots with a warning). Export multiplies each piece by a one-frame `geq` plate of
  `vignetteGain` (exactly its 8-bit levels, alpha kept); the app's preview draws the same formula in the grade's WebGL2
  pass. Timelines without it export byte-identical plans. No inspector control yet.
- Sharp and blurred renders of a clip with motion blur, slice 3 of #501 (ADR 0041 decision 11, epic #451; protocol 135):
  a generated clip with `motionBlur` keeps two cached renders. The sharp one (the key it had without blur) renders first
  and is what the live preview and `render --quality draft` use; the blurred one is queued after it in the background,
  the preview swaps it in when it is ready, and `render --quality final`, `render` without a quality and `frame` wait
  for it. `clip.renders` reports the blurred render in a new `final` field (state `waiting` while the sharp one is not
  ready yet), and the app follows its job. When the plugin refuses to blur a composition (HyperFrames: HDR content,
  shader transitions; plugin API `MOTION_BLUR_REFUSED`), exports use the sharp render and the render job gets a
  warning; `final.refused` says so and the refusal is not retried until the clip changes. Chat about this says
  `frame pending` while the blurred render is due. `gc` keeps both renders of every blurred clip.
- `analyze` cuts told apart: jump cuts and punch-ins (#471 slice 4, epic #451; protocol 137): the result and `analysis.json`
  of `frameshell analyze` gain `cuts`, every big change of the picture classified from the grey frame before and the frame
  after it (one more pass at 96 px on the long side): `cut` (a new scene), `jump` (the same framing with time skipped),
  `punch-in` / `punch-out` (the same shot scaled up or down, with its `scale`, searched from 1.08x to 2.5x and up to 4 %
  off centre) and `change` (no cut: a flash, a caption). Each has its `time`, `score`, `similarity`, `changed` and
  `opensShot`, false for the jump cuts and punches the scene score missed; `counts` and `jumpsPerMinute` sum them up
  (labelled ESTIMATED in `labels`; at most 300 are classified, with a warning). The CLI prints a `Cuts` line and lists the
  jump cuts and punches; the skill (`reference-video.md`), `docs/mcp.md` and SPEC say how to read them. New files in
  `packages/core/src/analyze/` (`framing.ts`, `cuts.ts`), after HyperFrames' `measure` (Apache-2.0, #478).
- Figma import and `brand show`, next slice of #467 (ADR 0044 decision 10, epic #451; protocol 138):
  `frameshell brand import-figma <dir>` (daemon `brand.importFigma`, MCP `brand_import_figma`) imports a folder of SVG
  frames exported from Figma into `assets/brand/<id>/` with no network. Each file is sanitised by the same allowlist as
  captured logos, now in Node (`brand/svg.ts`: a strict XML parse with no internal DTD subset and only the predefined
  entities, so an Illustrator DOCTYPE naming the SVG 1.1 DTD is kept; no script, `foreignObject`, `style` element,
  event handler, external `href`/`url()`, quoted URL in `image-set()`/`image()`/`cross-fade()`/`src()`, CSS escape;
  embedded rasters up to 10 MB of text); a file that is not well-formed, declares entities or states no size is
  skipped with a warning. The whole folder
  gets one scale (project canvas width / widest frame), each frame its centred position, recorded in `brand.json`
  (`imports`, published schema) with what the sanitiser removed; every frame gets a credits entry with no licence.
  `frameshell brand show` (daemon `brand.show`, MCP `brand_show`) prints the captures and imports of `brand.json` with
  their provenance. `brand.capture` now sanitises fetched SVG files with the same Node sanitiser instead of the page.
- Timeline letterbox, slice 1 of #500 (ADR 0043, epic #451; protocol 133): an optional `letterbox { aspect }` on the
  timeline paints black bars over the whole finished picture, above every video track and under the captions: top and
  bottom when the aspect is wider than the frame, at the sides when narrower. `frameshell letterbox set 2.39` (also
  `1.85`, `4:3`, `4/3`) and `letterbox clear` (daemon `letterbox.set`, MCP `letterbox_set`; journaled, revertible, a
  proposal in review mode); `timeline show` prints it. Export paints the bars with `drawbox` before burning the captions
  in every segment, the cover frame and `frame` captures (limited-range black converted back on full-range JPEG frames);
  the app's preview draws the same pixels (`letterboxBars`) above the live page and render slates, under the captions.
  Primary format only: other formats re-block without bars. Timelines without it export byte-identical plans.
- Clip render queue priority (#502, ADR 0035 decision 6, epic #451; protocol 132): the generated-clip queue still runs one
  render at a time, but a render somebody waits for (`clip.renders`, so the preview, `frame`, export and a format asked
  for) now starts before the background ones the daemon queues after an edit or a file change for timelines nobody is
  looking at, and a queued background render moves up when one of those asks for it. A background render still gets the
  next slot after four interactive ones in a row, so a long final is delayed, never starved; a running render is never
  interrupted. Jobs carry `priority` (`interactive` or `background`) and `position` (1 = next, null unless queued) in
  `job.list`, `status` and `job.progress`. New `job.cancel` (MCP `job_cancel`, CLI `frameshell job cancel <id>`) drops a
  queued clip render or stops a running one; the clip then shows `failed` (canceled) and is not rendered again until its
  inputs change, while an export renders it again. New `frameshell job list [--active]`. Left for later: reordering from
  `job list`, a second lane for renders over a duration threshold, and the app's view of what waits on what.
- Motion blur of generated clips, slices 1, 2, 4, 5 and 6 of #501 (ADR 0041, SPEC decision 46, epic #451; protocol 131):
  an optional clip field `motionBlur { shutter?, samples?, blend? }` (`{}` = 180° shutter centred on the frame, 8 samples,
  linear light) makes each frame of a generated clip's render the average of sub-frame pictures across the shutter. Set
  with `clip.set` `motionBlur` (merged, `null` clears, shared by every format) and `frameshell clip set --motion-blur`,
  `--motion-blur-shutter`, `--motion-blur-samples`, `--motion-blur-blend`, `--clear-motion-blur`. An adapter declares
  `ClipAdapter.motionBlur` and gets `RenderContext.motionBlur` with defaults filled in (plugin API stays "1"); clips of
  other adapters stay sharp and `clip.set` warns. The resolved settings join the clip render key only when present, so
  existing keys are unchanged. The HyperFrames adapter renders with the producer's sub-frame accumulation
  (`pageMotionBlur: "off"`), fixed samples, and names the clip when the producer refuses (HDR, shader transitions).
  Motion runtime 0.4.0 adds `cuts(seconds[])`, a time guard that keeps samples from crossing a cut inside a composition
  (the render declares its frame rate in `<meta name="frameshell-fps">`); `frameshell hyperframes update` brings it to
  existing compositions. Opt-in real tests: blur smears the fast spring, a blurred clip renders twice to identical
  frames, and a declared cut is never blurred across.
- Colour section of the clip inspector and LOG footage warning, second slice of #384 (ADR 0031, epic #451; protocol 130):
  a media clip on a video track shows Colour in the clip inspector: sliders for exposure, temperature, tint,
  contrast and saturation, a menu of the project's `.cube` LUTs with its mix, and Reset. A drag is one undoable step
  (`clip.set grade` with that number); English and Spanish. Footage that looks like LOG or HDR (colour tags of HDR or
  logarithmic curves or wide-gamut primaries, or a camera LOG word in the file name) gets a note there, and
  `clip set --grade-*` (and MCP `clip_set`) prints it as a warning; the grade is kept. `asset.list` probes carry
  `colorTransfer` and `colorPrimaries`; an asset ingested before the upgrade is judged by its name in the inspector
  until it is ingested again.
- Skill playbook for story-led animated shorts from the person's voice (#481, part of #453, epic #451): the new
  `skills/frameshell/reference/story-shorts.md` (pitch of five true stories, script budget, `sources.md`, the shot list
  as a contract with reads, camera reasons, beats in frames and acting lines, captions, platform rules, song-led films),
  routed from `SKILL.md` and `video-from-audio.md`. The motion-films playbook now starts intake with `brand capture` and
  describes the `product-shot` template for 3D shots.
- Grid moves, slice 5 of #485 (ADR 0037, epic #451; protocol 134): `frameshell music grid [--to beat|bar] [--max-shift s]
  [--skip g1,…] [--dry-run]` (MCP `music_grid`) moves picture cuts onto the timeline's beat grid (`tempo`; a LOW grid is
  refused). Each cut where two clips of a video track meet that is off its nearest beat (or bar start) by at most
  `--max-shift` (0.25 s) gets an id and lands exactly on the beat by a ripple trim of the clip before it, over the tracks
  with no clip across a cut, so the music, voice lines and backgrounds keep their timing and the shot's own sound is trimmed
  with it. Every other cut is put back where it was, so only the shots between change length. A move is blocked when the
  file has no more material, a clip would be empty or overlap, a multicam shot would be trimmed, a transcribed word
  would be cut or added, or a shot would slip against its own sound from the same file left on a track that keeps its
  timing (a J or L cut); `--dry-run` lists every cut with its status. Duck keys on the music are written again. One
  transaction `Music grid: …`.
- Brand capture from a URL, slice 3 of #467 (ADR 0044, epic #451; protocol 128): `frameshell brand capture <url>` (MCP
  `brand_capture`, job kind `brand`) opens a public `http`/`https` page in the managed headless Chrome, whose only way out
  is a daemon-local guarded proxy (public unicast addresses, ports 80/443, each host resolved once and dialed by the checked
  IP, every redirect hop re-checked; `--proxy-bypass-list=<-loopback>`, `--disable-quic`,
  `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`; at most 120 s and 150 MB). It saves logo candidates
  (sanitised SVG or the image), icons, the share image, `hero.png` and `page.png` under `assets/brand/<id>/`, copies a
  font into `assets/fonts/` only when the font file's own name table names OFL-1.1, Apache-2.0 or UFL (amends ADR 0028
  decision 7), and records colours with an accent, fonts by use, `:root` variables, headings, buttons and video URLs in a
  new root `brand.json` (published schema). Every saved file gets a credits entry with its source URL and no licence.
  `style.json` is never written: the result suggests `style set` calls. A page with almost no text and nothing to keep
  returns `ok: false`, `reason: little-text`. `file:`, `data:`, `chrome:` and every non-http(s) URL, URLs with
  credentials, other ports and private or loopback hosts are refused.
- Requirements and waivers of `review`, fifth slice of #457 (epic #451; protocol 127; `requirements.json`, `metrics.requirements`,
  `metrics.waived`, craft `severity`): a project's `requirements.json` (project root, written with `file.write`, validated on
  write, JSON Schema `requirements.json`) states what the film must be and `review` judges it on every run with metrics.
  `film`: `maxSeconds`, `minSeconds`, `maxStatic` (longest still stretch), `endCard.minSeconds` (the last picture holds still
  and is not blank) and, for a `--file`, `loudness` `target` LUFS (`tolerance` 1.5 LU) and `maxTruePeak`; `captions.minSize`
  (share of the short side, read from the subtitle tracks); per clip `appearsBy` (seconds or a marker, through the shared
  TimeRef resolver), `before` and `keepsMoving.maxStatic`. Each is a `pass`, `fail` or `skipped` (with why: a timeline has no
  loudness, a file has no clips, the range stops short of the end) in `metrics.requirements.checks`. Craft warnings stay `warn`
  unless the file lists their check in `fail`; a waiver (`check`, optional `clip`, `reason`) moves the warnings it covers out of
  `craft` into `metrics.waived` with its reason, so an accepted warning is reported, never dropped, and a waiver that covers
  nothing is listed with `matched: 0`. `requirements.failed` (failed checks plus craft warnings of severity `fail`) makes
  `frameshell review` exit 1. `ReviewMetrics` gains `waived` and `requirements`, craft warnings gain `severity`; the check list
  moved to `@frameshell/schema` (`CRAFT_CHECKS`). Not yet: `staysInFrame` and other pixel-level clip assertions, the sound
  review list, waivers kept on the clip in the timeline.
- 3D in generated clips, slices 1 and 2 of #473 (ADR 0042, epic #451): the `hyperframes` plugin template
  `product-shot` (`frameshell hyperframes new <name> --template product-shot`) paints a three.js scene on the motion
  runtime's clock: a product (a built-in rounded box with a label picture, or your GLB from the composition directory)
  in studio light arrives on a push-in, a glint sweeps across it, it turns slowly while the camera creeps and orbits,
  and a headline rises under it, laid out for 16:9, 1:1, 4:5 and 9:16; props `title`, `model`, `label`, `color`,
  `accent`, `ink`, `finish`, `spin`, `orbit`, `size`, `shadows`, `bg`, `backdrop`. The scaffold copies a pinned three.js
  0.187.0 bundle (MIT, notice in its header; `pnpm gen:three`) as `frameshell-three.js` beside the motion runtime, and
  `hyperframes update` refreshes it. Models and textures hold the render until they have loaded, and a missing one
  fails the render with its path. `hyperframes check` no longer blocks on the bundle's own code and flags
  `setAnimationLoop`, `THREE.Clock` / `getDelta` (errors) and `mixer.update` (warning) in scene code. Every
  HyperFrames render now uses the software WebGL renderer (SwiftShader) whatever `PRODUCER_BROWSER_GPU_MODE` says.
- Colour grade of media clips, export and preview (#384, ADR 0031, epic #451; protocol 129): a media clip on a video
  track takes `grade { exposure, temperature, tint, contrast, saturation, lut, lutMix }`: exposure in stops and white
  balance on light, then contrast and saturation, then a project `.cube` 3D LUT (Adobe Cube 1.0, up to 65 points,
  Rec.709 input) mixed in by `lutMix`. Both are baked into one 3D table (33 points, or the LUT's own size) that export
  applies with ffmpeg `lut3d=interp=trilinear` on the picture as decoded, before crop, scale, alpha and shape, and that
  the preview applies with a WebGL2 pass in the engine worker, sampling it the way `lut3d` does (8 taps, the result
  truncated to 8 bit): on a still the preview frame and `frameshell frame` agree to the level. Where WebGL2 is
  unavailable the preview draws graded clips ungraded and says so once (English and Spanish). `clip set
  --grade-exposure/--grade-temperature/--grade-tint/--grade-contrast/--grade-saturation/--grade-lut/--grade-lut-mix`
  set one number each (`--grade-lut none` removes the LUT), `--clear-grade` removes the grade; `clip.set` `grade`
  merges field by field and refuses a LUT path outside the project, MCP `clip_set` follows. A LUT that is missing,
  outside the project or not a 3D `.cube` fails the export naming the clip. Editing the `.cube` file updates the
  preview as it does export. Shots take none (skipped with a warning); timelines without grades export as before.

- Face framing per format and format renders in the preview, slice 5 of #469 (ADR 0027, epic #451; protocol 126):
  `clip reframe <clip> --format <id>` with a format of `format list` other than the primary (the default `9x16`
  too, once declared) writes the face-following framing into the clip's override there, so the clip, the primary and
  every other format keep theirs and each format can follow the face its own way; the result says where
  (`inFormat`). An aspect (`9:16`) still frames the clip itself. Its warning no longer suggests the
  `vertical-1080x1920` preset, refused in a 16:9 project since slice 1, but `format add`. In the app, the timeline
  marks a clip with an override in a declared format with a small frame in its corner, and its tooltip names the
  formats (English and Spanish); switching the preview to a format asks the daemon for that format's generated-clip
  renders (queued when missing), so generated clips show at the format's size with their props there, as export
  draws them.

- The 5 ms fade in of #485 (ADR 0037), now that sample-accurate audio fades exist (#585): `music fit`, `music shape`
  and `music candidates` give the music clip's start `audio.fadeInMs` 5, as one more step of the same transaction
  (`revert` undoes it with the fit; one proposal in review mode), so a track cut mid-waveform does not click. A fade
  in already on the clip (`audio.fadeInMs`, `fadeIn` or a dissolve) is kept; `music fit --skip fade` leaves it out; where
  a fit already lands, the fade is all it writes. `fade` joins the step ids of `music.fit` and `music.shape` (protocol 123).
- `analyze` curve, ink, mouth sync and labels, and `analyze diff` (#471 slice 3, epic #451; protocol 124): the result and
  `analysis.json` of `frameshell analyze` gain
  - `curve`: the change of the picture over time (`values` every `step` seconds, 0.1 or longer for a film over 2 minutes,
    a cut is a spike) and its `moves`, the steady stretches between the big changes, each with its start, duration, peak
    and the closest ease (`linear`, `in`, `out`, `inOut`, by the speed profile against the cubic eases) with its `fit`;
    the direction and overshoot of a move are not measured (the change has no sign);
  - `ink`, for the film and for every shot: the share of the 8 x 6 grid that gains detail over its quiet level in the
    shot (text and graphics coming and going), its `peak`, when and the `region` of cells;
  - `sync`: seconds the mouth of a talking face moves after the voice, by correlating the picture motion in the mouth area
    of the face box of the `people scan` cached for this exact file (found by content; scans keep boxes, not landmarks)
    with the loudness of the sound, within 0.5 s; skipped with a `reason` (no sound, no scan, no face for 3 s, no relation);
  - `labels`: MEASURED, ESTIMATED or DECISION for every value, by field path (a key covers what is inside it, the most
    specific wins; `labelOf` in the protocol). `frameshell analyze` prints the label before each line.
  New daemon method `analyze.diff` (job kind `analyze`, MCP `analyze_diff`) and `frameshell analyze diff <film> <reference>
  [--name n] [--lag s] [--max-lag s] [--every s] [--snapshots n]`: our film against a reference, lined up by activity-curve
  alignment (the lag within `--max-lag`, 3 s by default, or the one you give) and read at matched times: `energy` (mean and 95th
  percentile of the motion of each, their ratio, second-by-second windows), SSIM from ffmpeg's `ssim` every `--every` s
  (0.5), and a side-by-side sheet (ours left, `--snapshots` pairs, the lowest-SSIM moments among them) through the sheet code
  of `review`. A distance to read, not a pass or fail. Written to `.frameshell/analysis/<name>/` (`diff.json`, `diff.png`).
  New files in `packages/core/src/analyze/` (`curve.ts`, `ink.ts`, `lip.ts`, `lip-run.ts`, `align.ts`, `correlate.ts`,
  `activity.ts`, `diff.ts`), after HyperFrames' `measure` (Apache-2.0, #478). Skill page `reference-video.md` explains how to
  read them and how to report them.
- Zoom, slats and a pixel grid, slice 4 of #483 (ADR 0030, epic #451; protocol 125): `transition set --kind zoom|slats|grid`
  (MCP `transition_set`) with `--origin` for a zoom and `--count` (2 to 64) for slats and a grid. A zoom dives the
  outgoing clip into the centre of `--origin` (up to 4 times larger, by the larger side of the rectangle; default the
  middle half) while the incoming clip grows out of the same point; slats uncover the incoming clip in `--count` strips
  at once, each the `--direction` way (default 8, `left`); a grid shows it in square cells switching on in a fixed
  scattered order, `--count` across (default 12). All three play on every video track and inside nested clips like the
  other shapes, share `shapeAt` between export (a `scale` and `overlay` expression for a zoom, a `geq` alpha for slats
  and cells) and preview (a scaled draw, a canvas clip path), and are counted as kinds of their own by the variety
  warnings. The clip inspector's edge menu offers them (a count field for slats and a grid; English and Spanish) and the
  timeline marks them with their own signs. A timeline file with these kinds is rejected by older hosts; timelines
  without them export byte for byte as before.
- Shaped transitions on upper tracks and nested clips, slice 3 of #483 (ADR 0030, epic #451): `transition.set` with
  `kind` `wipe`, `push` or `iris` now plays on every video track with the edge, like a dissolve, instead of the bottom
  one only. On an upper track the shape cuts both clips: the outgoing one shows only where the incoming one does not
  (a wipe's or iris's inverse mask, a `geq` alpha step in export, a canvas clip path in the preview), and neither fades;
  a render's own alpha is kept. At an edge of a nested timeline clip the shape is no longer refused: the clip starting
  its window on its own track plays it, and its upper tracks follow the same shape over the half after the cut instead
  of fading in (their sound still fades in); a test checks that export and preview cut the same pictures at the same
  progress on every frame. In the app, the clip inspector's edge menu offers wipe, push and iris where clips meet on a
  video track, with a direction menu for wipe and push, and dip cut on the bottom video track (English and Spanish);
  the timeline marks a shaped dissolve with its kind's sign and a dip cut as a shaded strip over its clip's last
  frames. A hand-edited shape on an upper track, which played as a plain dissolve, now plays as its shape. Plans of
  timelines without shapes on upper tracks or nested clips are unchanged.
- Sample-accurate audio fades, #585 (ADR 0018 amendment, epic #451; protocol 121): a media clip's `audio` takes
  `fadeInMs` and `fadeOutMs`, an equal-power sound ramp from or to silence in milliseconds, not snapped to frames
  (`clip add`/`clip set --audio-fade-in ms --audio-fade-out ms`, daemon and MCP `audioFadeInMs`/`audioFadeOutMs`; 0
  removes one). At most half the clip, none at an edge a dissolve crossfades, multiplied with the frame fades. Export
  writes them as `afade` sample counts and the preview evaluates the same ramp per sample (`audioFadeGain`), checked
  against the real export mix. `voiceover place` now gives every phrase clip the 12 ms phrase fade at both ends. Older
  projects and export plans are unchanged.
- Music steps down before a hit, fourth slice of #485 (ADR 0037 decision 6, epic #451; daemon `music.shape`, CLI
  `music shape`, MCP `music_shape`, protocol 120): `frameshell music shape <clip> [--drop <time>]… [--ending <time>]
  [--lead s] [--depth dB] [--hold s] [--release s] [--fade s] [--clear] [--dry-run]` puts the music `--depth` dB (9) down
  by `--lead` s (0.4) before each hit of the picture instead of ducking after it, holds it `--hold` s (0.3) past the hit and
  brings it back over `--release` s (0.6); from `--ending` it fades out over `--fade` s (2.5, so `--ending bar:17` with a
  short fade stops on a bar line). Times are seconds, markers or `beat:N` / `bar:N`. The result is gain keys marked `auto:
  "music"`: a re-run replaces only those and never a hand key, `--clear` removes them, and a duck on the clip is written
  again after it (its stored parameters), so the voice still ducks the shaped music. `music fit` runs the shaping again
  when it moves the clip (the hits stay on the picture; `--skip shape` leaves the keys). The hits are kept in the clip's
  `audio.shape`. Schema: `auto` takes `music`, a duck key over a music key carries `baseAuto`, clips take `audio.shape`;
  older Frameshell versions reject such a timeline. The 5 ms entry fade waits for sample-accurate audio fades (#585);
  `duck --level` from the style's `sound.musicUnderVoice` is not done.
- Sound sync, loop seam, delivery check and safe-zone placement of `review`, fourth slice of #457 (epic #451, ADR 0039 slice 3;
  protocol 122; `metrics.sync`, `metrics.seam`, `metrics.delivery`, CLI `review --preset p --loop`, MCP `review` `preset`, `loop`):
  `metrics.sync` sets sounds against the picture events they belong to. For a timeline the sounds are the generated takes
  `sound.place` put on its audio tracks (exact to the frame), for a `--file` the hits found in its sound (the `analyze` hit
  detector); whooshes, risers and ticks are counted as `excluded`, since they do not land on an event by design. Each sound gets
  its offset to the nearest visual event within 0.12 s (sound minus picture): over 45 ms before it reads `early`, over 75 ms
  after it `late`, widened by half the picture sampling. Because a hit on every cut proves nothing, `near` (share of sounds with
  an event within 0.1 s) is set beside `chance`, the same share with the sounds moved by fixed offsets of 0.3 to 1.1 s, and
  `silentCuts` lists the cuts with no sound (sounds with verdict `none` are the other half). `metrics.seam` is the mean grey
  difference of the last frame and the first at 160 px (the measure of the render's loop check, `export/seam.ts`, now also giving its
  picture size; under 10 reads `continuous`, a hard cut 40 to 80, under 0.5 while the picture moves is a `duplicate`); `--loop`
  turns a duplicate or a jump into a `loop-seam` craft warning. `--file` with `--preset <id>` reads the file back with ffprobe against
  the export plan of `--timeline` (and `--format`) with that preset (`metrics.delivery`: width, height, frame rate, length within 2
  frames, video codec, audio, and loudness within 1.5 LU of the target; a difference is a `delivery` craft warning). The safe-zone sheet
  and `safeZones` now also flag graphics (a generated clip's alpha box at up to 12 frames of the clip, titles included; a render with
  no alpha is named in `warnings` and not measured) and faces (boxes of the cached `people scan`, placed through the clip's layer
  and the format's cover crop) that reach into a zone: `!graphic` and `!face` on the tile, `subject`, `clip` in the flags and a
  `safe-zone` craft warning. Thresholds are data in `review/thresholds.ts` with HyperFrames and earshot attribution (#478), and the
  warnings never fail a run. Not yet: assertions and per-clip waivers, the sound review list (voice over bed, repeated whooshes),
  multicam shots against zones, the mechanical audio QA of the third-pass comment.
- Voiceover, slice 4 of #470 (ADR 0034 decisions 19 and 20, epic #451; protocol 117): `frameshell voiceover place <script>`
  (daemon `voiceover.place`, MCP `voiceover_place`) puts the takes of a voiceover script on the timeline as phrase clips
  in one transaction: each take is cut at its silences, every phrase becomes a clip on the audio track `Voiceover`
  (made when absent) with the spacing the take has and a `scriptRef` to its scene. `--at line=time` anchors a line
  (`hook-1`) or one phrase (`hook-1.2`) on seconds, a marker (`hook+0.5`) or a beat or bar of the grid (`beat:9`,
  `bar:3`) through the shared TimeRef resolver; the rest follow by `--gap` (0.4 s). The voice never overlaps itself,
  `--dry-run` plans without writing, and clips already playing the takes fail the call unless `--replace` removes them
  first. `voiceover generate` now warns, naming the clips, when it replaces a take a clip plays. In the app, the
  Explorer's menu of a script has "Generate voiceover…": a paid provider asks first in a dialog with its estimated cost
  (or that it does not say), and only a confirm sends `yes` (English and Spanish). The e2e daemon takes
  `FRAMESHELL_SPEECH_STAND_IN=paid` for a stand-in provider that charges 0.01 USD a word.
- Captions and generated clips take the project style, third slice of #468 (ADR 0028, epic #451; `clip.live`
  `styleCss`, style `type.caption`, plugin API `styleTokens` / `RenderContext.styleCss`, protocol 115): a subtitle
  track that names no preset shows its text in `colors.ink` outlined in `colors.bg`, the keyword in `colors.keyword`
  (else the accent), the spoken word in `colors.highlight` (else the accent), at `type.caption` px, and neither mark
  under `calm`; a track that names a preset looks as before, and the track's own fields and the vertical-format scale
  still win. `fonts.captions` sets the caption face: a `.ttf` or `.otf` under `assets/fonts/`, whose family and line
  metrics are read from the file, so export, the preview and review safe zones place lines alike; a face that cannot
  be used falls back to Archivo Black and `render` warns. HyperFrames renders and live pages get the style as CSS
  variables (`--fs-color-accent`, `--fs-font-display`, `--fs-motion-standard`, ...) in a first stylesheet, with style
  font files inlined; the sheet's hash enters the render key only for adapters that take tokens and only with a
  `style.json`, so other renders keep their keys. The first run after the upgrade re-renders every HyperFrames clip of
  a project that has a `style.json`, and any later change to a colour, font, type size or motion value re-renders them
  all again. An invalid `style.json` blocks HyperFrames renders and exports of subtitled timelines until it is fixed.
- GIF preset, second slice of #474 (ADR 0039, ADR 0027 decision 13, epic #451; `render` with `preset: "gif"`, CLI `render --preset gif`,
  protocol 114): `render --preset gif` writes a silent GIF that loops forever. Each format is fitted inside 1200 x 1200
  (16:9 is 1200 x 675, 9:16 is 675 x 1200, never scaled up) through the new preset field `video.fit: "inside"`, which
  ADR 0027's aspect check honours. The frames render as lossless RGB temps, one palette (`palettegen stats_mode=diff`)
  covers the whole file, and `paletteuse` dithers with bayer scale 5 and diff rectangles; the frame rate is capped at
  30 (24 and 25 keep theirs) and the delays come out 4,4,5,4,4,4 hundredths of a second at 24 fps, pinned by a test that
  reads the file's blocks. More than 350 output frames is refused before anything is queued, with the count and the
  length that fits; a finished file over 15 MB adds a job warning with its size. A GIF has the loop rules without
  `--loop` (a cover frame is refused, the cycle and black-end warnings, the repeated last frame check) and ignores
  `--quality`. Export presets may now be silent (container `gif`, no `audio`): in the plugin contract `ExportPreset.audio`
  is optional. The skill documents the preset in `loops.md`.
- Motion film playbook in the agent skill, first slice of #453 (epic #451; skill only, no wire change): the new
  `skills/frameshell/reference/motion-films.md` walks an agent from a brief with no footage to a delivered film with the
  commands that exist today: a one-round intake kept in `style.json` `brand`, three storylines and a stop for the
  person's pick, assumptions with a free alternative beside every paid item, the style guide and banned looks through
  `style apply` and `style set`, a time budget in bars with launch beat shares, the beat grid (`tempo set`,
  `beats measure`), the storyboard as a script with scene markers at `bar:N` and a stop for an explicit OK, a board
  and an animatic, motion templates as shots on the bottom video track (where push and wipe play), cuts and
  transitions on bars, `sound place` and `music fit` on markers, formats and safe zones with `review`, the critique
  loop and finals with a contact sheet, loop check and poster. It answers the "Make my film" prompt of the Welcome screen.
- Hand edits of `formats` and `style.json` are config operations, rest of #496 (ADR 0036 slice 5, epic #451, no wire
  change): the daemon watches `frameshell.json` and `style.json` at the project root and diffs a change of formats or
  style values against the journal's last version (a head snapshot per document in `.frameshell/history/`). With review
  mode off it is journaled as a `file.edit` operation by `file`, so History lists it and `revert` undoes it; in review
  mode it waits in a proposal of `file` ("Edit style.json") and the document goes back until you accept or reject it,
  and while another proposal is open the edit is put back and its copy kept under `.frameshell/rejected/`. An edit made
  while no daemon ran is caught up when the project opens. `frame --format <id>` and `review --format <id>` with
  `view: proposal` capture a format only the open proposal adds. The proposal bar lists the style values a proposal
  changes (`Style: colors.accent #1A1A1A → #FF5A00`, en + es). New e2e of a config proposal in the app.
- Glass card template, second slice of #462 (ADR 0031 and 0033, epic #451; plugin only, no protocol change):
  `frameshell hyperframes new <name> --template glass-card` scaffolds a translucent card (hairline border at 38 %, light
  top edge, a skewed 220 px shine band that crosses in 0.9 s, 0.3 s after the entry, and again every `shineEvery`
  seconds when set) with a kicker, a title and text rising through masks on springs. The card paints only the look: the
  blur, saturation and dark scrim under it are the clip's backdrop, so the recipe is `clip add` then
  `clip set <clip> --glass` (`--backdrop-dim 0.72` over bright footage). Its fill stays above the backdrop's 3 % alpha
  threshold and its shadow is off by default, since the glass would cover a shadow too. Typed props (`label`, `title`,
  `body`, `tint`, `tintOpacity`, `shine`, `shineEvery`, `shadow`, `size`, `place`, `align`), per-format layout with
  `pick()`, empty or too long texts never break the picture. Listed in the plugin skill and the reels page.
- Iris and dip cut, slice 2 of #483 (ADR 0030, epic #451; protocol 113): `transition set --kind iris --origin
  x0,y0,x1,y1` opens the incoming clip in a circle growing from the centre of `origin` (fractions of the frame, default
  its centre) until it covers the frame, on the bottom video track; export masks the incoming piece with a `geq` circle,
  the preview with a Canvas 2D arc, and a subject of the outgoing plate (ADR 0032) shows outside the circle. `--kind
  dip-cut` makes the edge a hard cut and darkens the clip ending there by 40 % over its last 3 frames, written as two
  `opacity` keys on it (bottom video track only; an upper track is refused; sound is not touched); `transition remove`
  takes those keys away again, another kind set there replaces them, `clip trim` moves them to the clip's new end, a
  split or cut drops them from the left part, and the variety warnings count dip cuts as their own kind. The clip shape `origin` field
  is new: older Frameshell versions reject a timeline that carries an iris.
- UI demo template follow-ups, #549 of #451 (ADR 0033; plugin only, no protocol change): `cursor-click` and `app-window`
  take `camera: follow` (and `zoom`, 1.1 to 2.4): the frame zooms in with the cursor to the click and pulls back after
  the last beat, never showing the scene's edge. `app-window` takes `then: copy-paste` (and `keys`, Mac or Windows): an
  empty slot below the rows, a key chip showing the copy half a second after the click, a click on the slot that lights
  it on its own frame, then the paste, its chip and the copied row filling the slot on one frame. New template
  `comment-box`, the comment variant of `typing-field` (a card with an avatar types a comment over a few lines, a cursor
  presses the button, progress fills and a confirmation appears). Timing guard: a clip too short for the cursor's
  click, drop or release gives up the hesitation, then moves faster (up to 2.2 times), and a typed line is typed up to 9
  times faster with a shorter progress line, so the reaction shows before the exit; clips with room are unchanged.
  The kits write each function on one line to stay under the 300-line lint warning. New opt-in real-Chrome test
  `ui-demo-real.test.ts` checks, frame by frame, that each click and the beat it causes land on the same frame in every
  template and variant. The near-1 scale snap stays in the cursor kit (moving it into the runtime needs a version bump).
- Music beds made offline, third slice of #463 (ADR 0038, epic #451; daemon `sound.music`, CLI `sound music <preset>`,
  MCP `sound_music`, protocol 112): a seeded 16-step sequencer synthesizes a track with no network and no samples.
  Presets `synthwave` (118 BPM, Am F C G, saw chords, four on the floor), `lofi` (78 BPM, Dm9 G13 Cmaj7 Am7, electric
  piano, swung hats, vinyl) and `minimal` (110 BPM, FM mallet stabs, plucked bass, metallic hats); `--bpm`, `--meter`,
  `--chords`, `--seed`. Whole bars (`--bars`, `--length`, else to the end of the timeline) made of parts (`--sections
  kind[:bars][@time]`: intro, full, dark, build with a riser that ends 75 ms before the next part, gap, drop, outro; a
  part's `@time` starts it on the nearest bar, so the drop can land on a marker), `--accents` (a crash and a big kick on
  the nearest beat), and a final hit that rings 2.5 s; the bass ducks under the kick, a reverb from a synthetic impulse.
  The take, `assets/sound/music-<preset>-<key>.wav` (48 kHz 24-bit stereo), is brought to -14 LUFS with its sample peak
  at -1 dBFS by our own BS.1770 meter and limiter (ffmpeg reads the same loudness), and comes with its exact beat grid in
  `beats/` (`detector: exact`), so `beat:`/`bar:` times, `--snap-to beat` and `music fit` use it without measuring. It is
  placed in one transaction (`Music: …`, one proposal in review mode) on the audio track `Music` at `--at`, under the
  voice by the style's `musicUnderVoice`, and the timeline's tempo follows it when it had none; `--no-place` only writes
  it. Same arguments, same file; recorded as own work when the project keeps `credits.json`.
- Loudness cache, candidate tracks and `duck --level`, third slice of #485 (ADR 0037, epic #451; daemon
  `music.candidates` and `track.duck` `level`, CLI `music candidates` and `duck --level`, MCP `music_candidates`,
  protocol 110): every asset's EBU R128 loudness (integrated LUFS, range, true peak, ffmpeg `ebur128`) is measured once
  and cached by content under `.frameshell/loudness/` (swept by `gc`, kind `loudness`). `music candidates <asset> <asset>…
  [--end t] [--from t] [--loudness LUFS] [--dry-run]` puts 2 to 7 files on their own new audio tracks `Music 1..n`, all
  muted but the first, with the static gain that brings them to one loudness (`--loudness`, else the quietest file's own,
  so none is made louder); with `--end` each file's final hit is fitted onto it like `music fit` slides a clip and the
  candidates are ranked (files covering the picture first, then hit confidence). One transaction. `duck <track> --under
  <track> --level 12` first sets each clip's static gain so the music's loudness sits 12 dB under the voice's, then dips
  from that level (one transaction). `track.duck` now keeps what it was asked in `audio.duck` of each clip it ducks, and
  `music fit` runs the same duck again after it moves such a clip (clips ducked before keep getting the defaults); the
  result's `duck.parameters` says `stored` or `defaults`. Older Frameshell versions reject a timeline whose clips carry
  `audio.duck`.
- Determinism verify for motion clips, third slice of #465 (ADR 0033, epic #451; daemon `clip.verify`, CLI `clip verify`,
  MCP `clip_verify`, protocol 109): `frameshell clip verify <clip> [--probes n] [--tolerance 0-255]` loads the clip's live
  page in managed headless Chrome at the project resolution and captures `--probes` frames (default 12, 2 to 48) at
  `(i + 0.37) x duration / n` of the played part, each twice: cold (a fresh page seeks straight to the time) and after a
  reseek (one page shows an unrelated probe first). A channel (red, green, blue or alpha) that differs by more than
  `--tolerance` of 255 (default 2) fails the probe and the command exits 1, naming the worst probe time, the pixel and
  the page element that paints it (the cold picture's element where the reseek left the pixel empty). `distinct` counts
  different cold pictures, and a warning says when it is 1 (a clip that never moves, or a timeline not bound to the
  seek). It works for any adapter with a live preview, reads only (no render, no file written) and needs the plugin
  trusted. The headless page loader of `inspect.point` moved to `inspect/live-page.ts` so both use one.
- `metrics.json` of `review`, third slice of #457 (epic #451; `review` writes it without `--sheets` or with `--sheets metrics`,
  MCP `review` `sheets: ["metrics"]`, result `metrics`, protocol 108): numbers a sheet cannot tell, measured on the grey frames
  `review` already samples for the motion strips (a file up to 15 a second, a timeline at most 90) and, for a `--file`, on its
  decoded sound. Picture: the longest still stretch (change under 0.35 grey levels), the largest gap between visual events
  (peaks above the larger of 1 level and 2.5 times the median change, the ends of the range counted), near-blank pictures (luma
  standard deviation under 4) and whether frame 0, the thumbnail, is empty. Subtitle cues of a timeline on screen for less than
  their words take to read (0.4 s for one or two words, else 0.75 x (0.5 + 0.3 per word)). Loudness of a file by `ebur128`
  (integrated LUFS, range, true peak) and in the phone band (200 Hz to 6 kHz), through the same meter as `analyze`; a timeline
  has none (render a draft and review the file). `craft` lists warnings, never failures, with their thresholds from the
  launch-film checklist of the ticket: still over 3 s, empty frame 0, a blank picture, a short cue, a true peak above -1 dBTP,
  a phone band 6 LU under the mix and over 15 s with no sound. The critique loop of the skill reads them in place of a hand-made
  `ebur128` command. Sync of sounds to picture, the loop seam jump and the delivery check follow in the fourth slice;
  not yet: assertions and per-clip waivers.
- Voice section in the clip inspector, app slice of #464 (ADR 0031, epic #451; no wire change): a media clip shows its
  voice chain. The Voice switch writes the style's voice chain (high-pass, denoise, compressor) or bypasses it, and
  switching on again brings the bypassed chain back (kept in that window only; the saved clip has no bypass flag).
  Each effect is a row in processing order with its numbers (cutoff; floor and reduction; threshold, ratio, attack,
  release, makeup), a move-earlier and a remove button; a menu adds a missing effect and Voice preset puts the style's
  chain back. Every change is one undoable `clip.set` `audioEffects` by `ui`. Strings in English and Spanish.
- Batch variants from data rows, slices 1 and 2 of #477 (ADR 0040, epic #451; daemon `batch.render`, MCP
  `batch_render`, JSON Schema `batch.json`, protocol 106): `frameshell batch <file.batch.json> [--out dir] [--formats
  id,id] [--dry-run]` renders one template timeline (default `main`) once per row. `slots` name what a row sets:
  `<clipId>.props.<path>` (written over the clip's props and checked by its adapter, as `clip set` does) or
  `<clipId>.asset` (a media clip's file swapped, keeping its in, out and placement). Each row's timeline exists only in
  memory: nothing is written to `timelines/`, journaled or proposed. Every row × format is checked first, so a bad row
  fails the call with InvalidOperation naming its `row` and `slot` (props the adapter refuses, an unknown clip, a file
  shorter than the clip's out or without the stream its track plays, a voice file without the transcript a subtitle
  track follows, two rows writing the same output; slot names and props paths refuse `__proto__`, `prototype` and
  `constructor`). Then the rows render one at a time as ordinary `render` jobs into `exports/<batch name>/<row>.mp4`
  (`<row>-<format>.mp4` with formats from `frameshell.json`), and `manifest.json` there keeps each row × format's status,
  job, error and timings, rewritten on each job change. `gc` keeps clip renders while a batch runs. Batch never
  generates voiceover.
- Re-run batch rows and batch skill text, slices 3 and 4 of #477 (ADR 0040, epic #451; `batch.render` params `rows`,
  `failed`, `force`, result `skipped`, `preset` null when no row was chosen, MCP `batch_render`, protocol 119):
  `frameshell batch <file> --rows es,fr` (ids, or `en..fr` for the rows between two in file order) renders only those
  rows, `--failed` the rows `manifest.json` lists as not done (failed, canceled, or left `queued` or `running` by a
  daemon that stopped, which the manifest now shows as `canceled`), and both together the failed ones among the named.
  A chosen row whose renders are all `done` with the files in place is skipped, listed as `skipped`, unless `--force`.
  Only the chosen rows are checked and queued, so a bad row elsewhere does not block the re-run, and the other rows
  keep their manifest entries. `--failed` without the manifest of this batch file is refused. The skill gets
  `reference/batch.md`: when to batch and when not, the caution that episodes need an original story, voice and visuals
  each time (batch is for sizes, languages and product rows), the manifest and re-runs, and per-language voiceover rows
  (swap the take, transcribe it first, never paid generation from batch).
- Per-format overrides and editing in a format, fourth slice of #469 (ADR 0027, epic #451; `clip.set` `format`,
  `hidden`, `reset`, `clip.key` `format`, `track.set` `format`, `reset`, MCP `clip_set`, `clip_key`, `track_set`,
  protocol 116): where a format's automatic layout is wrong, a clip can be placed, keyed, hidden (its sound,
  transitions and captions stay) or given other generated-clip props and element adjustments in that format only,
  and a subtitle track another style. Stored as the clip's or track's `formats` map in the timeline file; timing and
  sound stay every format's and are refused there. CLI `frameshell clip set <clip> --format 9x16 --y 520`, `--hidden`/`--shown`, `--reset`,
  `clip key --format`, `track set --format`. One resolver (`formatTimeline`) feeds export, `frame`, clip renders,
  `gc` and the preview, so the primary format exports exactly as before. In the app, with the preview switched to
  another format, the handles move a clip there and the inspector edits that format, with "Hide in <format>" and "Use
  primary". Pick and element mode stay in the primary format.
- Loop-safe export, first slice of #474 (ADR 0039, epic #451; `render` `loop`, CLI `render --loop`, `JobInfo.warnings`,
  protocol 105): `render --loop` makes a file meant to repeat (title loops, banners). MP4 and MOV audio gets a 2 ms
  half-sine fade at its first and last sample after loudness (silent exports unchanged); `--loop` with `--cover-frame`
  is refused, because the cover replaces frame 0; `warnings` say when the output frame rate makes the cycle a fraction
  of a frame and when frame 0 or the last frame is black. Once the file is written the job compares frame 0 with the
  last frame at 160 px and, when they are the same picture while the file moves, adds a warning to the job (`warnings`
  of `job.list`, printed by the CLI after `Rendered`) naming the fix: end the last key one frame earlier or trim one
  frame. The timeline's length is never changed. Every job now carries `warnings` (empty when none).
- HyperFrames clips rendered at each format's size, third slice of #469 with the format half of #465 slice 4 (ADR 0027,
  ADR 0033, epic #451; daemon `clip.renders` `format`, MCP `clip_renders`, protocol 104): in a format of the project
  whose aspect differs from the composition's (`9x16` of a 16:9 project), the `hyperframes` adapter sets the copied
  composition root's `data-width`/`data-height` to the format's size before rendering, so the motion runtime's
  `stage()` and `pick()` lay a template out for that format instead of the page being letterboxed. Of the same aspect,
  the render keeps the composition's own size and export scales it, so primary renders are unchanged. Measured with
  `@hyperframes/producer` 0.9.30: a template scaffolded at 16:9 and rendered at 9:16 or 1:1 gives the frames of the
  same template scaffolded there. Background renders still cover only the primary format; `clip.renders` with
  `format` reports that format's renders and queues the missing ones (the preview's format switcher will ask this
  way). The cache key recipe and layout are unchanged.

- Format switcher in the preview, second slice of #469 (ADR 0027, epic #451): when `frameshell.json` declares two or
  more `formats`, the transport bar lists them and the preview shows the frame as that format exports it. It uses the
  rules export uses, now shared helpers in `packages/schema/src/formats.ts` (`formatOf`, `formatCrop`,
  `scaledCaptions`): untransformed footage and stills cover the frame around the centre, sources with alpha on upper
  tracks and transformed or keyed clips stay fitted, multicam shots keep their reframed tiles, and captions are 1.3x in
  vertical formats. Generated clips show their primary render, fitted, until renders per format reach the preview.
  Handles, Pick, element mode and live pages stay in the primary format. A parity test checks the preview against the
  export compiler in every format.
- Motion templates, third group of #466 (ADR 0033, part of #451): `frameshell hyperframes new <name> --template` also
  takes `terminal` (a command types out, then tasks spin and tick one by one), `chat-bubble` (a question, typing dots,
  then the reply), `notification-stack` (cards or chat bubbles drop in and push the older ones down; items are one
  `|`-separated prop of `Sender: message`), `device-frame` (browser or phone around a screenshot with a slow push, on its
  own background; a plain skeleton when there is no screenshot), `scene-background` (drifting orbs, a masked 120 px grid,
  vignette and grain on closed loops, for a track under other clips) and `prompt-bar` (the prompt types, then Run is
  pressed). No GSAP; each has typed props, takes colours and fonts from `style.json`, lays out per format with `pick()`,
  uses springs, and passes `hyperframes check --strict`. Typing and task timings speed up to fit a short clip. The
  real-Chrome test renders them in the four formats. Listed in the plugin skill.
- Voiceover, slice 3 of #470 (ADR 0034 decisions 17 and 18, epic #451; protocol 103): `voiceover generate` now splits each
  take into phrases and checks it for misreads. Every line reports its `phrases`: the take cut where it falls silent for
  60 ms or more (5 ms RMS, 38 dB under its peak, 20 ms lead and 30 ms tail kept) as ranges of the take in seconds, the
  cuts of phrase clips (`clip add --in from --out to`; `phraseFade` is the 12 ms fade #470 asks for, reported; placement does not apply it until sample-accurate fades, #585). With
  `verify` (the default; `--no-verify` skips it) each take is also transcribed by the project's transcription provider
  and compared with the line's spoken text by the shoot comparison, so spoken numbers and word normalization stay in one
  place: each line gets a `check` (`clean`, `doubtful` when the transcription may be to blame, `misread`) listing what was
  missing, changed or added, and the words heard inside each phrase. The check never fails the call and never blocks a
  paid take: in an untrusted project, without a transcription plugin or when the transcription fails, `verification`
  says it was skipped and why. Cached lines are checked too. The envelope builder of cut snapping takes an optional hop
  for the finer RMS.
- New video from an idea, wave 4 of #451 (#472; desktop only, no wire change): the Welcome screen has "New video from an
  idea..." next to "New from video, audio or image...". The form asks the name, the formats (any of 16:9, 9:16, 1:1 and
  4:5), a rough length and an optional web page, and makes an empty project in the videos folder (or the folder picked).
  The first format of that list sets the project's size and each other one is added with `format.add` through the daemon,
  so it is journaled like any format change (ADR 0027, 0036). The agent guide then keeps itself open with "Make my
  film": a prompt typed unsent at the agent's prompt that asks for three storylines (a different world, device and form
  each) with a recommendation, then the assumptions with a free alternative beside every paid item. It names no
  command, so it holds until the motion film playbook (#453) lands. Strings in English and Spanish.
- Words behind the head in the app (#461 slice 4, ADR 0032; no wire change): the header menu of a video track offers
  "Put behind the person on V1" for each lower video track that holds a media clip, and "Stop going behind the person"
  while it is behind one (one `track.set`, one undo step). A track behind a plate shows a person icon at the end of its
  header with the state of the plate's matte: the percentage while it is made, a `!` with the reason when it failed, plain
  once ready; until then the preview keeps showing the word in front. The skill's reels page gains the recipe for a
  big word behind the head: 30 to 55 % covered, never over the face, 1.5 to 4 s, no two-person shots, b-roll above the
  word's track. Strings in English and Spanish; an e2e with the stand-in matte.
- `analyze` events, look and rhythm (#471 slice 2, epic #451; protocol 111): the result and `analysis.json` of `frameshell analyze` gain
  - `look`, per shot and for the film: brightness, contrast, saturation and warmth (red minus blue), and an 8 x 6 grid of mean colours
    (the film's in the result, every shot's in `analysis.json`);
  - `rhythm`: the spread of the shot lengths (`shotLengthCv`), the share of still frames and the longest hold, the big changes of the
    picture (a cut, a flash or a jump of the layout: #457's visual event, a frame 4 times the median change of the half second around
    it, or 15 % of the grey range) with their count, per minute and the largest gap between them, and `bursts` of 3 or more within
    1.5 s, with constants the metrics of `review` (#457) are to share;
  - `events` in time order: `flash` (the picture jumps brighter or darker for at most 0.25 s), `appear` / `disappear` (part of the
    picture gains or loses detail while the rest holds, with its `region` on the 8 x 6 grid: where an element or a caption shows up),
    `hold` (no change for 0.5 s or more) and `hit` (a sudden rise of the sound, with its `offset` to a big change of the picture
    within 0.2 s, so a sound effect on a cut tells from music or speech).
  Measured in one extra pass over every frame at 64 px (a 30 s 720p film takes about 6 s in all), in new files of
  `packages/core/src/analyze/` (`look.ts`, `rhythm.ts`, `events.ts`, `picture.ts`), after HyperFrames' `measure` (Apache-2.0, #478).
  Events are hints, capped at 300 of a kind, and say so in the skill page `reference-video.md`, which now explains how to read the
  numbers. Where large text sits is read from `appear` regions, except over a subject that keeps moving (a talking head), where
  elements are not found; motion curves, sync, ink and diff against an original remain later slices of #471.
- Glass under generated clips, backdrop slice of #462 (ADR 0031, epic #451; protocol 102): a generated clip on an upper
  video track takes an optional `backdrop { blur, saturate?, dim? }` (blur = Gaussian sigma in project pixels). Export
  and the preview blur, saturate and dim the picture below the clip wherever the clip's alpha is above about 3 %, fading
  and wiping with the clip, then draw the clip; its render does not change. `frameshell clip set <clip> --glass` copies
  the new `style.json` `glass` numbers (default blur 46, saturate 1.45, dim 0.55) onto the clip; `--backdrop-blur`,
  `--backdrop-saturate`, `--backdrop-dim` set one number, `--clear-backdrop` removes it (daemon and MCP `clip.set`
  `backdrop`). `glass.cards` (default false) says whether the style uses glass cards at all: glass is never a default.
  The clip inspector has a Glass switch with Blur, Saturate and Dim fields. On the bottom picture track the backdrop is
  kept with a warning and not drawn. Timelines without backdrops export exactly as before. In the preview one glass
  card costs about 4 ms per frame at a 1920x1080 canvas on an Apple M3. Older Frameshell versions reject a timeline or
  `style.json` that carries the new fields.
- Fit music to the cut, second slice of #485 (ADR 0037, epic #451; daemon `music.fit`, CLI `music fit`, MCP `music_fit`,
  protocol 101): `music fit <clip> --end end-card` back-times a music clip (a media clip of an audio track) so the track's own
  final hit lands on the cut and it plays unspliced before it, and says where the music then starts. `--end` and
  `--from` are seconds or a marker (the shared TimeRef resolver). The hit is `--hit` (seconds of the file) or found on
  the track's energy, the last sharp jump in level near the end of the part the clip plays, with a confidence and the
  other strong hits; a hit under 0.5 is only suggested. By default the clip slides and keeps its speed (within half a
  frame); a track longer than the picture before the hit loses its intro (`in` moves later, never before `--from`,
  default 0), a shorter one starts late, and nothing is looped or spliced. `--exact` keeps the start and changes the
  speed to land the hit on `--end`, at most 1.7 % of the clip's speed, refusing beyond it with the ends that fit.
  `--dry-run` changes nothing and lists the steps. A clip with duck keys gets `duck` again in the same transaction
  (`--skip duck` leaves them), since duck keys sit on the clip's own clock. One transaction (`Music fit: …`, one
  proposal in review mode); only `start`, `in`, `speed` and gain keys are written, so older versions open the
  timeline. Measured on a synthetic drum track: the export's `atempo` plays the material about 21 ms early at a speed
  near 1 (the preview has no such shift) and softens a kick's attack from 3.1 to 5.7 ms; tape-style resampling shows
  neither (ADR 0037 has the numbers, measured on darwin-arm64 only; the 5 ms `fadeIn` is not written yet). A second fit
  that lands later brings back the intro an earlier fit dropped, as far as the file has it.

- `frameshell sound place <kind> (--at <t>[,<t>…] | --cuts <track> | --typing --from <t> --to <t>)` (#463 slice 2,
  ADR 0038; daemon `sound.place`, MCP `sound_place`, protocol 100) places generated sound effects in one transaction
  `Sound: …` (one proposal in review mode, `revert` undoes it whole): on times given as seconds or a marker through the
  shared TimeRef resolver (`hook`, `hook+0.5`), on every edit point of a track (or the numbered ones) and as a run of
  typing keys (tick or click, at most 10 a second, spaced for 87 ms or more, rotating takes). The take's `peakAt` lands
  on the time plus the offset of its role (click -11 ms, tap -60, knock -40, pop +30, whoosh +37; a riser ends 75 ms
  before), on whole frames, on the audio track `SFX` (made when absent; `SFX 2`, `SFX 3` where sounds overlap). Clip
  gain is `-sound.sfxUnderVoice` of `style.json` plus the tier (primary 0, secondary -4, texture -8 dB). Variants rotate
  so the same whoosh is not twice in a row. It warns, never refuses, about more than 2 sounds on one frame, ticks closer
  than 66 ms and pops closer than 114 ms, two typing keys closer than 87 ms once rounded to frames, and one take twice in a row; sounds that cannot be clips (nothing left after the
  timeline start) are listed in `skipped`.
- Safe-zone sheet of `review`, second slice of #457 (epic #451; `review --platform instagram|tiktok|shorts|youtube`,
  `--sheets safe`, MCP `review` `platform`, protocol 99): up to 36 frames chosen like the contact sheet with the
  platform's UI zones shaded red and outlined, drawn from the one table in `@frameshell/schema` (`safe-zones.ts`),
  scaled to the film's size. A frame where the captions of a subtitle track reach into a zone is marked
  `!subtitle` (box measured from the bundled face, the track's style and each cue's words), and `review.json`
  `safeZones` lists, per platform, the zones in the film's pixels and the captions that cross them by track and
  zone (how many cues, when, how many px deep), at the caption size export draws in that format
  (`captionScale`, 1.3 in a vertical non-primary format). `--platform` adds the sheet to the default ones; a vertical film
  whose `style.json` names platforms gets it without the flag. A file shows the zones without flags. Sheet labels
  are now also sized by the tile's width, so a narrow tile of a vertical film does not clip them (`review` and `analyze`). Titles, graphics
  and faces follow in the fourth slice.
- `beat:N` and `bar:N` as times, fourth slice of #458 (ADR 0029, epic #451; protocol 97): every time argument that takes
  a TimeRef (`--at`, `--from`/`--to`, `--start`/`--end` of `cut`, `clip add|move|trim|split|key`, `transition`, `marker`;
  the same arguments over MCP) now also takes a beat or a bar start of the timeline's grid, counting from 1, with the
  optional marker offset: `--at bar:8`, `--from bar:2 --to bar:6`, `--start beat:17-0.1`; `beat:2.5` is halfway between
  beats 2 and 3. They resolve in the daemon through the same grid as `--snap-to` (no second grid), so a measured grid is
  the music clip's beats file carried through the clip and a nominal one is built as far as the number reaches, and the
  history records seconds. They are refused with the same messages as `--snap-to`: no tempo, a music clip with no beats
  file yet, a LOW confidence grid, and a number past the last beat or bar of a measured grid. Word references
  (`"this#2"`) are still refused with a pointer.
- Style changes and user styles, second slice of #468 (ADR 0028, ADR 0036 slice 4, epic #451; daemon `style.set`,
  `style.apply`, `style.save`, `style.list`, `style.show` `view` and `from.status`, MCP `style_set`, `style_apply`,
  `style_save`, `style_list`, protocol 98): `frameshell style set <path> <value>` changes one value of `style.json`
  (JSON or text; `null` removes it) and keeps the rest of the file. `style save <name>` keeps the project's style as a
  user style in Frameshell's config folder (`styles/<name>.json`); `style apply <name>` copies one into a project value
  by value and lists what changed (`--replace` overwrites), recording where it came from so `style show` says when the
  user style changed since; `style apply premium` (any motion personality) sets the personality; `style list` lists
  them. Every change of `style.json`, by these commands or by `file.write`, is journaled: `history` lists it, `revert`
  undoes it (reverting the change that created the file removes it), and in review mode it waits in the agent's
  proposal like a timeline change instead of being refused.
- Beat grid on the timeline, third slice of #458 (ADR 0029, epic #451; daemon `tempo.set`, `tempo.show`, `timeline.show`
  `grid`, MCP `tempo_set`, `tempo_show`, event `beats.changed`, protocol 96): a timeline names the grid it follows in
  its optional `tempo`. `tempo set --clip <music clip>` carries the measured grid in the beats file of that clip's asset
  through the clip's start, `in` and speed, so moving, trimming or speeding up the music moves the grid; `tempo set
  --bpm 120 [--offset s] [--meter n]` is a nominal grid for blocking a film before music exists (each frame rounded once
  from the beat's index), also on a clip (`--clip c --bpm 120`, offset in the clip's source seconds). `tempo show` lists
  the grid on the timeline clock (bars and beats in seconds; why there is none when the music has no beats file), `tempo
  clear` removes it. The schema checks that `tempo.clip` is a media clip of a video or audio track; removing that clip
  clears the tempo with a warning and a revert brings both back; splitting it keeps the tempo on the left part. The app
  draws the grid, bars stronger than beats, both on the lanes and as ruler ticks (the level too dense to read at the
  current zoom is left out), and dragged clip edges snap to beats and bars (a clip edge, marker or the playhead in reach
  wins; a trimmed edge on a beat goes exactly there; a LOW confidence grid is drawn but never snapped to). `--snap-to
  beat|bar|marker` (daemon and MCP `snapTo`) on `clip add|move|trim|split|key`, `transition set|remove`, `marker add|set` and
  `cut` moves each time of the command to the nearest beat, bar start or marker (within 1 s) first and records the seconds; beat
  and bar are refused with no tempo, without a beats file, on a LOW confidence grid or for a time far outside the music. The daemon watches
  `beats/` (it may not exist yet): a beats file written, hand-edited, deleted or broken sends `beats.changed`, so a hand
  edit of `edits` (half or double time, a moved downbeat) changes the grid in the open app at once, and a broken file
  takes the grid away until it validates again. Older Frameshell versions reject a timeline that carries `tempo`.

- Subject layers in the preview (#461 slice 3, ADR 0032; protocol 95): a track `behind` a plate now shows behind the
  person in the app's preview too, as in export and `frame`. The preview reads the plate's proxy through its subject
  matte (the matte as the alpha of a second, software decoder; frame N of the matte is frame N of the proxy), on the
  frames export draws the subject (where a track behind the plate shows and no shown track between covers it), with
  the plate's push or wipe when the plate is the bottom track (an outgoing subject shows in the rest of a wipe). The
  internal daemon method `matte.status` reports each plate's matte and queues the missing ones as background `matte`
  jobs (shared with `matte.prepare`, never made twice); until a matte is ready the plate plays as it is, the word in
  front, with a note over the picture. A test checks that preview and export draw a subject on the same frames. On an
  Apple M3, 6 s of a 540p take with a word behind it played with 0 dropped and 0 starved frames and 3 decoders (plate,
  subject picture, matte). Plates with their own alpha (VP9 proxies) get no subject in the preview yet, only a note
  that export draws it.

- `frameshell analyze <video>` (#471 slice 1, epic #451, decided in #478; daemon `analyze` as a background job of kind `analyze`, MCP `analyze`, protocol 93):
  measure a reference video into `.frameshell/analysis/<name>/` (any file; a run of the same name replaces the folder; project
  files untouched). The shot table comes from ffmpeg's scene score on every frame (`--threshold`, default 0.3; hard cuts, a run of
  high scores within 3 frames is one cut) with cuts per minute and the average, median, shortest and longest shot; a contact sheet at
  2 frames a second with the cuts marked, a sheet and a JPEG of the middle frame of every shot, through the sampling and tiling
  of `review` (now `review/images.ts`, shared); the dominant colours of every shot and of the film; the loudness by EBU R128
  (LUFS, LU, dBTP); and the tempo and beats by the `beats` detector at 44.1 kHz when the sound has a steady beat (`analysis.json`
  holds the beat lists). Every time is a frame index / fps rounded down to the millisecond. MCP returns the sheets as images. New
  skill page `reference-video.md` (measured, estimated and decision labels; the grammar, never the content). Events, motion curves,
  text placement, look, sync and diff against an original are later slices of #471.
- `frameshell sound sfx <kind> [--variant n] [--seed n] [--pitch x] [--length s]` (#463 slice 1, ADR 0038; daemon
  `sound.sfx`, MCP `sound_sfx`, protocol 92) synthesizes a sound effect offline, with no network and no third-party
  samples: `click`, `tick`, `pop`, `whoosh` (stereo), `riser`, `thump`, `impact` and `shutter`, three variants each, a
  family `seed` for one timbre across a film and a seeded pitch (0.9 to 1.3) and level (within 1.5 dB) jitter. The same
  arguments always give the same file: `assets/sound/<kind>-<key>.wav`, 48 kHz 16-bit with the peak near -3 dBFS, imported
  like a voiceover take and carrying its cache key and `peakAt` (the instant that must land on the picture: the
  transient of a hit, the peak of a whoosh, the end of a riser) in a RIFF chunk. A take that is current is `cached`, and
  a file of that name made by hand is never overwritten. When the project already keeps a `credits.json`, the take is
  recorded there as `own` work. `sound` is a reserved built-in command group. Placing (`sound.place`, see above)
  and music come in later slices; the skill has a reference (`reference/sound.md`) with the role offsets and the placement
  taste.
- Motion templates, second group of #466 (ADR 0033, part of #451): `frameshell hyperframes new <name> --template`
  also takes `lower-third` (card with an accent bar, name and role), `logo-lockup` (logo, name, accent rule, tagline;
  beside the name on 16:9, stacked on 1:1, 4:5 and 9:16), `checklist` (items separated by `|` spring in, then tick one
  by one on `tickStart` and `tickGap`), `comparison` (the old option is crossed out, the chosen one springs in on an
  accent pill), `counter` (counts from `from` to `to`, up or down, in `countTime` seconds, tabular figures, optional
  glow while it climbs) and `big-word` (one huge word, letters rise through a mask, for a track with `behind` so it
  sits behind the person, ADR 0032). Each has typed props, takes colours and fonts from `style.json`, lays out
  per format with `pick()`, uses springs, and passes `hyperframes check --strict`; the ones that can work alone as
  well as over footage have `bg` and `backdrop` props. The real-Chrome test renders every template in the four
  formats (inside the frame, same frames cold and after a reseek). Listed in the plugin skill.
- Motion templates, UI demo group of #466 (ADR 0033, part of #451): `frameshell hyperframes new <name> --template` also
  takes `cursor-click` (a cursor arrives on an arc, hesitates, clicks a button; the confirmation springs in on the
  click's frame), `cursor-drag-drop` (a cursor carries a card into a drop zone that answers on the release),
  `cursor-marquee` (a selection rectangle over a grid of tiles, each lighting up as it is reached, a count on release),
  `cursor-text-select` (a cursor drags along a phrase of a paragraph, over line breaks too, the highlight following it,
  an action pill on release; word boxes are read from layout), `app-window` (a CRM, spreadsheet or inbox window: a
  cursor clicks a row, its highlight sweeps in and the rest dims on that frame; own solid background; `cursor` off
  clicks at `selectAt`) and `typing-field` (a prompt bar types with an uneven seeded rhythm and a blinking caret, a cursor
  presses Run, a progress line fills, a result appears). The cursor is a carrier: 4 to 7 % of the short side
  (`cursorSize`), outside the frame at the start so it never fades in, arcs with a 15 % bow and a tiny overshoot,
  optional `hesitate`, a click of 0.84 in 0.1 s and back in 0.22 s, and a drift after the last beat. Each has typed
  props, takes colours and fonts from `style.json`, lays out per format with `pick()` and passes
  `hyperframes check --strict`; the real-Chrome test renders all of them in the four formats. Scales within 0.6 % of 1
  are written as exactly 1 because Chrome kept an earlier raster for them (same time, a pixel off by seek order).
  Listed in the plugin skill.
- `frameshell review` (#457 slice a, epic #451; daemon `review`, MCP `review`, protocol 90): contact sheet, phone sheet
  (360 px tiles, 1 fps), fast-motion strips (the two fastest moments by difference of sampled grey frames, 12 consecutive frames
  each) and a loop seam sheet (last 6 and first 6 frames) of a timeline or of an exported file (`--file`), written to
  `.frameshell/review/<n>/` with a `review.json` manifest; the last 10 runs are kept and project files are never
  touched. The timeline contact sheet marks clip starts and ends, cuts, markers, subtitle cues and the deepest zoom of
  a keyed clip, each tile labelled with its time and why. Frames come from the `frame` path (timeline) or the managed
  ffmpeg (file); sampling and tiling live in one shared module for `analyze` (#471). MCP returns the sheets as
  images. The critique loop in the skill calls `review` instead of hand-built ffmpeg sheets. Metrics, safe-zone
  sheets and `--platform` are later slices.
- Times as names, first slice of #485 (ADR 0037, amends ADR 0029 decision 7; protocol 88): the time arguments
  `transition set|remove --at`, `clip key --at`, `clip split --at`, `cut --from/--to`, `clip move --start`,
  `clip trim --start/--end`, `clip add --start` and `marker add|set --at` (and the matching MCP and daemon params)
  take seconds or a marker id or label with an optional offset: `--at hook`, `--at hook+0.5`, `--from intro --to
  outro-1`. One shared resolver in core (`resolveTimeRefs`) turns the name into seconds in the daemon before the
  operation runs, against the timeline as it is then (a marker added earlier in the same transaction counts, and in
  review mode the proposal's timeline), so the history records seconds and a revert never depends on a marker staying
  put. A label is tried whole first (`end-card` is not `end` minus `card`); an unknown name fails and lists the
  markers. Plain decimals are seconds (`0x10` and `1e2` are not); a marker whose label is a plain number (`10`) is
  reached by its id, since `--at 10` means seconds. `beat:`, `bar:` and `word:` are reserved and refused until the
  beat grid and word references exist. `music fit` itself is a later slice.
- Beat grid, slice 2 of #458 (ADR 0029): `frameshell beats measure <asset> [--bpm n] [--reset-edits]` and `beats show
  <asset>` (daemon `beats.measure` and `beats.show`, MCP `beats_measure` and `beats_show`, protocol 87) measure the beats
  of a music file locally, with no download and no model, and write `beats/<name>.beats.json`: tempo, every beat in
  source seconds (each snapped to a measured hit within 8 ms), which beat starts a bar, the strong hits, a confidence and
  the largest gap to the hits (under 15 ms on clean click tracks). Calm music, which gets a double-time grid, is flagged
  LOW with the other tempi to try; a track decoded without a finished ingest is capped LOW too. `--bpm` says the tempo you
  expect so a 60 BPM song stays 60. Human corrections go in the file's `edits` (`tempo` double or half, `downbeat`,
  `offset`), are validated by `file.write` and kept when you measure again. It runs as a `beats` job in a worker thread
  (about 5 s for 3 minutes); the onset envelope is cached in `.frameshell/beats/` and swept by `gc`, which never touches
  `beats/`. The file's `detector` also admits `exact` for generated music that knows its beats. Nothing on a timeline
  reads a grid yet (the grid in the app, `tempo.clip` and `--snap-to` are slice 3). The FFT of multicam sync is now one
  shared module used by the detector too.
- SVG and font files in `assets/` are non-media assets (#520, split from #467). `.svg`, `.ttf`, `.otf`, `.woff` and `.woff2`
  were queued for media ingest and failed (fonts in `assets/fonts/` included); now ingest only hashes them: no probe,
  no proxy or other derived media, no ffmpeg, no failed job. `asset.list` (and `asset.changed`) report a new `kind`
  (`media`, `svg` or `font`) and `state` `ready` once hashed. `clip.add` and other edits that take a media asset
  refuse them with `not media` instead of an ffprobe error. Protocol 86.
- Words behind the head in export (#461 slice 2, ADR 0032): a video track can go `behind` a lower video track
  (`track.set` `behind`, `frameshell track set <track> --behind <plate>`, `--behind none` clears it; protocol 91).
  Export, `frame` and covers draw the plate's media clips again above that track through each asset's subject matte
  (`alphamerge`, on the same frames as the plate, with its transitions), so a big word or a logo sits between the
  background and the person. The person is drawn again only while the track behind shows a clip, and not while a
  shown track between the plate and it (a cutaway) does, with a warning. A `render` job makes missing mattes in a new
  `matte` step; `frame` makes those of the frame it captures first. Removing or moving the plate track, also by editing the timeline file, clears the flag in the same operation, with
  a warning (`timeline.changed` gains `warnings`). Track views
  (`timeline show`, `track list`) show `behind`. Not in the preview yet, nor in image projects; nested, generated and
  multicam plates are not lifted.
- Blender clips (#482, ADR 0035), first slice: the official `@frameshell/blender` plugin renders a frame range of a
  `.blend` in the project with your own Blender (4.5 LTS or any 5.x, never downloaded) to VP9 WebM with alpha, as a
  `blender` clip. `source` is the `.blend`; `props` take `scene`, `camera` and `quality` (`draft`: EEVEE or Workbench
  on a transparent film, the only one for now). The range is the clip's own `in` and duration from the scene's first
  frame; a scene at another frame rate than the project is refused with how to fix it. The key covers the `.blend`,
  the in-project files it links (listed by Blender once per file), the Blender version (an upgrade re-renders) and the
  length rendered. Blender runs as `blender -b --factory-startup -Y` with the plugin's own scripts only; progress comes
  from the script's per-frame reports and cancel kills it, launcher scripts included (the whole process group).
  Stamps are off and the encode is bitexact, so a rerun writes the same bytes. Run on Blender 5.2.3 LTS (macOS);
  4.5 LTS is supported but untested.
- `binaries.blender` names your Blender in `frameshell.json` or the global config. `frameshell doctor` lists it with
  its version (`not installed, set binaries.blender` when there is none), and reports a Blender outside the supported
  range as a problem; without an override, using it fails with how to set one instead of "no managed build".
- Plugin API: `ClipAdapter.inputs(clip, context?)` receives the project directory and `ensureBinary`, so an adapter can
  put a tool's version in its render key. Additive: the API version stays 1.
- Voiceover from text, slice 1 of #470 (ADR 0034, changes SPEC decision 10, adds decision 39): a `SpeechProvider`
  contract in the plugin API (`registerSpeechProvider`, manifest `contributes.speechProviders`; plugin API stays v1,
  but hosts before this release reject manifests that declare it) and `frameshell voiceover generate <script>
  [--lines] [--provider] [--voice] [--yes]` (daemon `voiceover.generate`, MCP `voiceover_generate`, protocol 85). A
  voiceover script is a script with `voiceover: true`, read with the shoot-script line rules; each line has a display
  form and a spoken form (respellings `{display|spoken}`, numbers spelled out in `language` `es`/`en`). Each line
  becomes `assets/voiceover/<script slug>/<line id>.wav`: cached by a key stored inside the WAV (unchanged lines are
  not said again, moved lines are copied, hand-made files are never overwritten), head and tail silence trimmed,
  imported together. A paid provider fails with `ConfirmationRequired` and its cost until called with `--yes`; a
  retried request with the same idempotency key never charges twice. No voice ships yet: a test-only stand-in
  (`FRAMESHELL_SPEECH_STAND_IN=1`) says words as tones. New error codes `SpeechProviderNotFound`, `SpeechFailed`,
  `ConfirmationRequired`; `plugin list` shows speech providers.
- Voiceover, slice 2 of #470 (ADR 0034): the machine-level `command` speech provider. Set `speech.command` in the global
  `config.json` (`run`: the TTS program and its arguments with `{voice}`, `{language}`, `{out}`; optional `voices`,
  `defaultVoice`, `version`, `timeoutSeconds`) and `frameshell voiceover generate --provider command` says each line
  with it: the text goes to stdin, the WAV comes from `{out}` or stdout. It is free, works in untrusted projects, and
  is read from the global config only: a `speech` key in `frameshell.json` is refused. A voice or language starting
  with `-` is never passed to the program. The global config now has one reader shared with binary overrides.
- Speech providers: a provider without `estimate()` counts as paid at an unknown cost (`ConfirmationRequired` with
  `cost: null`) unless it declares `free: true` on the contract. The stand-in and `command` declare it.
- Video subject matte, slice 1 of #461 (ADR 0032): `matte.prepare` (protocol 84), CLI `frameshell matte <asset>`
  and MCP `matte_prepare` compute which pixels of each frame of a video are the person in front, locally on CPU:
  MediaPipe's selfie segmenter (Apache-2.0, 0.46 MB, downloaded on first use; pinned in the binaries manifest) on
  every proxy frame, smoothed forward and backward in time and refined by a guided filter. The whole asset is matted
  once per content into `.frameshell/cache/mattes/` (a grayscale H.264 video, frame N = proxy frame N), as a
  background job of kind `matte` with an ETA, and swept by `gc`. Nothing on a timeline uses it yet: the `behind`
  track flag, export and preview come in the next slices. Spike numbers and licences in
  `docs/research/video-subject-matte.md`.
- Audio effects on media clips (#464, ADR 0031 slice 1): optional `audio.effects`, a list applied in order of
  `highpass { frequency }`, `denoise { floor, reduction }` and `compressor { threshold, ratio, attack, release,
  makeup }`; omitted numbers take the voice chain's. `frameshell clip set <clip> --voice` writes the voice chain as
  explicit entries (high-pass 85 Hz; denoise -30 dB / 8 dB; compressor -20 dB, 2.5:1, 8 ms, 140 ms, +2 dB),
  `--audio-effects '<json>'` sets a list, `--clear-audio-effects` removes it; `clip.set` takes `audioEffects`
  (`null` clears; shots are skipped with a warning). Each asset is baked once per chain with the managed ffmpeg into
  `.frameshell/audio-fx/` (mono s16 on the sidecar clock, `afftdn` latency compensated) as a background `audio-fx`
  job; export mixes the bake (render step `audio-fx`) and the preview plays it in place of the dry sidecar once it
  is ready. `gc` sweeps bakes no clip plays. Energy snapping and transcription keep the dry sound. Protocol 83: job
  kind and step `audio-fx`, `gc` kind and area `audio-fx`, internal method `audio.bakes`. Timelines without effects
  are unchanged.
- Shaped transitions, first slice (ADR 0030, #483): `transition set --kind wipe|push [--direction left|right|up|down]`
  (`transition.set` `kind` and `direction`, protocol 82) puts a wipe or a push on a cut of the bottom video track.
  It is stored as the incoming clip's `dissolve` plus an optional `shape: { kind, direction }`; sound still
  crossfades equal-power. `shapeAt` (`packages/schema/src/transitions.ts`) gives the geometry to export (`overlay`
  offsets for a push, a `geq` alpha step for a wipe) and to the preview (Canvas 2D clip paths). With no spare source
  around the cut a shaped transition holds the outgoing clip's last frame or the incoming clip's first instead of
  dipping through black. `transition.set` now warns when the bottom track has three transitions of one kind in a row
  or more than a third hard cuts (jump cuts inside one take do not count). Shapes play on the first shown picture
  track only, so not over a multicam program track; other video tracks and edges of nested clips refuse them for now.
  The skill's transitions reference gains a table of kinds by cause and the variety rules.
- Timeline markers (#458, slice 1 of ADR 0029): named points on the timeline clock, `markers: [{ id, at, label,
  color? }]` in the timeline file, labels unique ignoring case. Operations `marker.add`, `marker.set`,
  `marker.remove` (journaled, revertible, idempotent) and `marker.list`; `timeline.show` lists them; CLI
  `frameshell marker add --at s --label l [--color c] | set | remove | list`, MCP tools from the registry
  (protocol 81). A `cut` of every track moves markers after it with the material and removes those inside the
  range (with a warning, a marker on the cut's first frame stays); ripple inserts and trims move them too, and a
  ripple trim removes markers inside the material it cuts away. A cut or ripple of only some tracks leaves markers
  where they are. Labels never look like an id (`m_1a2b3c`); a hand edit with a duplicate id or label, an id-shaped
  label or an off-grid time is rejected into `.frameshell/rejected/`. Review mode counts marker ids as touched. In the
  app, markers show on a lane under the ruler, the ruler's right-click menu adds, renames and deletes them, and
  dragged clip edges snap to them. A timeline with `markers` is refused by older Frameshell versions.
- Project style guide, slice 1 of #468 (ADR 0028): an optional `style.json` at the project root holds brand fields,
  colours (hex), fonts (family, file under `assets/fonts/`, weight, tracking), type sizes (px at a 1080 short side),
  a motion personality (`playful`, `premium`, `corporate`, `energetic`, `calm`) with field-by-field overrides, sound
  levels under the voice with ducking and voice-chain defaults (the loudness target stays `export.loudness`),
  platforms, notes, rules and a banned list. `resolveStyle` (`packages/schema`) gives every value with its source
  (`file`, `personality`, `default`); safe zones per platform live once in `packages/schema/src/safe-zones.ts`
  (Instagram Reels measured, the others from guides). New daemon method `style.show` (protocol 80), CLI
  `frameshell style show [--json]`, MCP `style_show`; `file.write` refuses an invalid `style.json`; JSON Schema
  `style.json`. The agent skill documents the file. Nothing renders from it yet.
- Asset provenance and credits ledger (#484, part of #451; ADR 0026): optional `credits.json` at the project root
  records source URL, licence, author, title and content hash of third-party assets. `frameshell import` takes
  `--source-url`, `--licence`, `--author`, `--title` and `--credit` (`asset.import` params, protocol 78);
  `frameshell credits set <asset>` (`credits.set`) completes an entry. `frameshell credits` (`credits.check`) judges
  every asset the timelines place, exits 1 when any is unverified (no entry, no licence, a licence that needs credit
  without an author, changed content, missing file) and prints the credit text for the video description. `render`
  warns about placed assets without verified provenance once the ledger holds an entry. Agent skill:
  `reference/credits.md`.
- `frameshell hyperframes check [<composition>] [--strict]` (`@frameshell/hyperframes` 0.5.0, #479, part of #451):
  lints HyperFrames compositions in the daemon with `@hyperframes/lint` (`lintProject`, `shouldBlockRender`; a pure
  library, no network, no telemetry) plus four GSAP seek-safety rules the linter lacks (`gsap_scrolltrigger`,
  `gsap_delay_chain`, `gsap_callback_not_seek_safe`, `gsap_overwrite_reads_state`); inlined GSAP builds are skipped.
  The other #479 seek rules are the linter's own: `non_deterministic_code` (random), `gsap_infinite_repeat`,
  `gsap_repeated_fromto_without_baseline`, `gsap_relative_value_second_writer`, `gsap_function_value_hazard`. Without
  an argument it checks every `compositions/hyperframes/<name>/index.html`; an argument is a name, a directory or an
  HTML entry. `--json` carries each finding's `file`, `line`, `column`, `rule`, `severity`, `message` and `fix`;
  errors exit 1, warnings only under `--strict`. The plugin skill now tells the agent to run it after every
  composition edit and before waiting for a render, and carries the authoring and GSAP seek-safety rules, citing
  HyperFrames (Apache-2.0). Frameshell never depends on the `hyperframes` CLI (#478).
- Plugin commands can report failure without throwing: `CommandResult` takes `failed: true`, `plugin.run` results
  carry `failed` (protocol 77), and the CLI exits 1 after printing the command's output or `--json` data.
- Reframe a single clip to vertical following the face (#459, part of #451): `clip.reframe` (protocol 75), CLI
  `frameshell clip reframe <clip> [--format 9x16] [--person <id|name> | --anchor 0-1]`, MCP `clip_reframe`. It scales
  the picture to cover the frame and writes `x`/`y` keys (ease in-out on a move, static when the face holds) so the face
  sits centered, 30 % from the top, never showing outside the picture. Faces come from YuNet on the clip's own stretch
  of its file (the multicam face keys, now with a sampling `range`), or from a person's cached `people scan` track.
  One transaction (`Reframe <file>`), one proposal in review mode; keys stay editable with `clip key` and in the
  inspector. Rotation metadata and the proxy GOP of 15 were already honoured and are pinned by tests.
- Duck music under speech as editable gain keys (#456, part of #451): `frameshell duck <track> --under <track>…`
  (`track.duck`, MCP `track_duck`, protocol 74) listens to the sound of the `--under` tracks and writes `gain` keys
  on the clips of an audio track that dip while someone speaks. Defaults: 7 dB deep (`--depth`), complete as the voice
  starts (`--attack` 40 ms), gone 450 ms after it ends (`--release`), speech above -38 dBFS (`--threshold`),
  stretches closer than 0.6 s merged (`--gap`). The keys are the clip's level minus the dip, with keys at the clip's
  start and end, and carry the new key field `auto: "duck"`: running it again replaces them and keeps keys set by hand
  (a hand key where someone speaks is dipped as well, its level kept in the new key field `base`).
  Preview and export play them like any gain key. History shows it as "Duck music under speech".
- Cover image and a finished frame 0 (#476, part of #451): `frameshell cover [--text word] [--at s] [--color #rrggbb]`
  (daemon `cover`, MCP `cover`, protocol 72) writes a cover image: a frame with one big word over it (upper-case,
  centered, outlined, in the bundled subtitle face, as large as the width allows), rendered by the export compiler like
  `frame`. `--text` alone picks the frame where the word is first spoken in the transcripts; `--at` picks it; neither
  uses the first whole picture (past the first clip's fade in, never the black frame). It is checked readable at 180 px wide (capitals at least 12 px tall, sized from the face's
  own metrics, `export/font-metrics.ts`) and warns when the word is too long. `render --cover-frame [--cover-text]
  [--cover-at] [--cover-color]` (`render` param `cover`) makes frame 0, the thumbnail platforms show, that same
  composition as a one-frame segment of its own; the other frames and the length are unchanged. Every render now
  warns when frame 0, or the chosen cover frame, is black (a gap before the first picture, a fade). The cover uses the
  `big-keyword` subtitle look until the project style guide (#468) holds one; review's frame-0 check (#457) can
  read the same warning.
- Hardware encoder probe and quality tiers (#475, part of #451). Frameshell test-encodes 0.2 s of colour with each H.264
  candidate (VideoToolbox, NVENC, then x264) and uses the first that works, because `ffmpeg -encoders` lists encoders
  that fail on the machine. The answer is cached per ffmpeg build in `encoders.json` in the data dir
  (`packages/core/src/encoders/`). `render` takes `quality` (`draft` or `final`; protocol 71, CLI `--quality`): a draft
  is at most 30 fps at x264 CRF 22 veryfast (NVENC p5, VideoToolbox bitrate from frame size), a final is CRF 16 slow
  (NVENC p6 cq 17, VideoToolbox 0.25 bits per pixel, about 62 Mb/s at 4K30) with bt709 tags, faststart and AAC 320k.
  Without `quality` a render is the preset as written. The `render` result names the `encoder`. `doctor` reports the
  encoder in use, a speed class (fast, medium, slow) with the proxy and draft sizes it suits, and the disk a master
  intermediate takes per minute; `doctor --reprobe` tests the encoders again. The codec list's hardware test encode
  is now the same 0.2 s test.
- Agent skill: a playbook for short-form reels from a talking-head take (#452), `skills/frameshell/reference/reels.md`.
  It covers a one-round intake, the vertical canvas and −14 LUFS loudness, passes (words, cut, captions, graphics
  plan, zooms, sound), 9:16 safe zones, notes as rules for the whole video, and checks before handing over.
- Agent skill: a critique loop for reels and generated videos (#454), `skills/frameshell/reference/critique.md`:
  contact, phone and loudness checks on the export, a fresh critic that describes before judging, a scoring rubric
  with automatic caps or pairwise comparison, scoped fix notes, a round log and when to stop.
- `frameshell cleanup` (and the MCP tool `cleanup`, daemon method `cleanup`, protocol 73; #455, part of #451): proposes
  and makes the cuts that remove dead air and false starts of a talking head. Pauses: a gap between two kept words
  longer than `--pauses` (default 0.4 s) that the audio energy shows quiet, cut inside the quiet leaving `--breath`
  (0.1 s) on each side, on the frame grid. `--retakes`: a phrase of 1 to 6 words said again (spelling variants and a
  cut-off last word match, same speaker) cuts the earlier attempt and keeps the last. `--dry-run --json` lists every
  candidate with its range, the words removed, reason and confidence (`--min-confidence`, `--skip <id>` for the ones
  a person rejected). Applying is one transaction labelled `Cleanup: …`, one proposal in review mode; cut words show
  struck through in the transcript view. Words come from the transcripts of the unmuted media clips and the sound of
  multicam program tracks, placed by the clip that plays most of each word; a cut is made only where transcribed
  speech covers it. Export and preview already fade the audio 2 ms at every cut (SPEC §3.4), so splices made in
  quiet audio do not click.
- Captions with chosen keywords, hand chunking and soft entries (#460, part of #451): `frameshell captions set <track>
  --text "No need to | open any | *editor*"` (MCP `captions_set`, daemon `captions.set`) chunks the words a subtitle
  track shows into cues by hand and marks one keyword per phrase. The text is matched to transcript words by position
  (a lost or repeated word fails, naming the first difference) and stored as word ids in the track's `phrases`, so cuts
  and transcript corrections keep it. A chunk lasts until the next cue starts, at most 0.35 s after its last word and
  never under 0.4 s. Style: `entry` (`none`, `chars`, `words`, `line`: 0.4 s, ease out, slight blur, no bounce, the
  keyword settling from `keywordScale`), `keywordColor` (null for none); `gaps` hide cues over a time range
  (`track set --gap 12-15.5`). Preview and ASS export share the cue, timing and easing rules (`SUBTITLE_ENTRY`);
  `PROTOCOL_VERSION` 76, timeline JSON Schema regenerated. Left for later: a keyword font, UI controls in the subtitle
  inspector, a one-word-per-cut preset.
- Formats of a project, export path (#469, ADR 0027): one edit delivered at several sizes. `frameshell.json` takes
  `formats` (primary first, equal to `resolution`); built-in `16x9`, `1x1`, `4x5`, `9x16`, or a custom id and size.
  `frameshell format list|add|remove` (MCP `format_list`, `format_add`, `format_remove`) edits them, journaled in
  `.frameshell/history/project.config.jsonl`, each change returning the call that undoes it (`revert` of its `op` id
  is refused and names that call). While review mode is on, only the person in the app may change formats: agents get
  ProposalState `forbidden`.
  `frameshell render --formats 16x9,9x16` writes one file per format (`<file>-<format>.mp4`) from the same edit:
  untransformed footage covers the frame (cropped around the centre; a source with alpha on an upper track, such as a
  title or lower third, is fitted whole, never cropped), generated clips render at the format's size,
  vertical captions are 1.3x larger; the primary format exports exactly as before. `frameshell frame --format 9x16`
  (wire `projectFormat`) captures a frame in a format. `gc` keeps the clip renders of every declared format.
  Protocol 79.
- Motion runtime, slice 1 of #465 (ADR 0033, part of #451): spring math in `@frameshell/schema` (`spring`,
  `springStep`, `settle`, `track`, `ease`, `stagger`, `durationFromDistance`; presets snappy, default, heavy,
  playful; role eases), closed form and free of clocks and random sources. The private `@frameshell/motion` package
  adds `bind(compositionId, paint)`, which drives a paint function from the HyperFrames clock through a seek-only
  `window.__timelines` entry (with `hf-seek` as fallback), and `write`, which sets only a 2D `transform` and
  `opacity` so element adjustments still apply. `pnpm gen:motion` bundles it into `@frameshell/hyperframes`
  (`motion-runtime.ts`); compositions do not use it until templates land (slice 2). Spike:
  `docs/research/motion-runtime.md`.
- Motion templates, slice 2 of #465 and first set of #466 (ADR 0033): `frameshell hyperframes new <name> --template
  <kinetic-headline|end-card>` scaffolds a composition painted by the motion runtime, with `frameshell-motion.js`
  copied next to it (frozen per clip). The kinetic headline (words rise through a mask, keyword in the accent colour,
  transparent over footage) and the end card (logo, name, call to action, address on a solid background, never
  static) declare typed props (number with min and max, colour, image path, enum), lay out per format with
  `pick(wide, square, tall)` (16:9, 1:1, 4:5, 9:16) and take colours, fonts and brand texts from `style.json` as the
  defaults when it exists. `frameshell hyperframes update [<composition>] [--dry-run] [--force]` refreshes older
  frozen runtime copies on request. Runtime 0.2.0 adds `pick`, `stage`, `props` (props clamped and typed) and
  registers `window.__timelines` where the HyperFrames linter looks for it, so `hyperframes check` passes. The skill
  gains the motion-composition authoring rules. No GSAP in templates. `@frameshell/hyperframes` 0.5.0 gains the
  `hyperframes update` command.

### Changed

- Docs and website for a non-developer start (no code change): the README now walks through download, open or start a
  project, Connect your AI (Claude Desktop or the ChatGPT desktop app), then talking to it, with plugins as optional
  extras from the Plugins view; the terminal, `frameshell init`, the CLI on PATH, plugin install commands and the
  coding agents moved to a "For developers" section. The website's home steps no longer start in the terminal, and its
  "Connect your agent" page (English and Spanish) leads with Claude Desktop and the ChatGPT desktop app, adds the
  ChatGPT desktop app with its honest notes, then lists the developer tools; the Connect your AI steps say they need a
  version newer than 0.18 and keep the 0.18 "Connect Claude Desktop" path. `docs/SPEC.md` gains as-built lines for
  the Plugins view, Connect your AI and the folded terminal; no decision changes.
- Desktop app: the terminal starts folded in a new project, an optional extra. A slim strip at the right edge shows the
  prompt mark and the word Terminal; one click (or View > Terminal, Cmd/Ctrl+\) opens it at its kept width. No shell
  starts and the agent guide does not load until the terminal is first shown; after that it stays mounted, so folding it
  never stops a shell or an agent. Chat about this and a film idea open it when they need it. A project that already
  saved its layout keeps the terminal as it was.

- A new project made from video or audio asks before downloading transcription (no protocol change,
  `PROTOCOL_VERSION` stays): when the transcription tool or its model is still to be downloaded, a native box states the
  size, says it runs on this machine and nothing is uploaded, and offers "Download and transcribe" (default) or "Skip
  transcription". Skipping, or closing the box, makes the project as usual without a transcript and installs nothing;
  the setup status says it was skipped and that the agent can transcribe later (for audio: that the project has only the
  audio, without background or subtitles). With nothing to download the setup runs as before, with no question; the
  cloud-provider ask is unchanged. Strings en + es; pure decision `chooseDownload` in
  `apps/desktop/src/main/transcription-download.ts`.
- Agent docs split (DOC1, epic #451; docs and tooling only, no protocol change): the root `CLAUDE.md`, loaded on every
  turn, shrinks from about 15k to about 2.6k tokens. It keeps a short doc map that routes each area to a nested
  `CLAUDE.md`, a "Shared truths" table (concepts with one owner file shared by export, preview, engine or CLI, with
  their parity tests) and the rules that span packages. Area detail moves to 25 nested files under `packages/*/src/`,
  `packages/core/test/`, `apps/desktop/` and `plugins/`, none in a directory that ships to users. New
  `scripts/claude-md-check.mjs` (with a test) refuses a `CLAUDE.md` in a shipped directory and a backticked repo path
  that does not exist; CI's scope job runs it on every change. With `--split <rev>` it also checks that every token and
  rule clause of an older root file survives in some `CLAUDE.md`. `scripts/test-scope.mjs` runs no tests for a
  `CLAUDE.md` change at any depth.
- Docs: `docs/SPEC.md` status lines match what shipped, DOC2 of epic #451 (no decision changed, no wire change): the
  header says alpha with the last-edited date instead of "draft v0.1", decision 38 names `clip verify` (ADR 0033) and
  the style token sheet in generated clips (ADR 0028) as built, decisions 4, 32 and 36 and the style paragraph of §5.8 mark
  per-format overrides and style in captions and fonts as built, and the roadmap marks Remotion, live preview, OpenAI
  transcription, OTIO and Premiere XML as shipped with their ADRs, leaving Deepgram, ElevenLabs Scribe, the effects/LUT
  and UI panel extension points and the plugin index website open.
- Small fixes, wave 28 (SF9, epic #451): the app's editor hand-off kinds (OpenTimelineIO, Premiere XML) are one table in
  `apps/desktop/src/shared/handoff.ts` (command, menu item id, extension, daemon method, CLI name) that the File menu,
  save dialog, IPC check, notice and its CLI hint read, instead of the same two-way branch in five places. No visible
  change. CLAUDE.md doc map: one row per area, no path lost.
- Beat detector `onset-flux@2` (#689, ADR 0029; DSP only, same envelope cache, beats file and protocol): hits of a
  low kick are placed on its first cycle, not a later louder one (median bias on generated music 12.7 → 0.8 ms); the
  period is searched within 1 % by the comb and refitted over the whole audio as the match tolerance narrows, so a
  straight grid no longer walks 100-300 ms off over a minute; a 3:2 or 4:3 tempo whose beats carry clearly more hit
  energy replaces a dotted-quarter misread (not when `bpm` states the tempo: that one only moves by octaves); confidence now weighs how many matched hits sit within 15 ms instead of
  the saturated periodicity term, and stays LOW when a 3:2 rival is close. Measured on the #689 corpus
  (`docs/research/beats-real-music.md`): 32 of 34 right-tempo synthetic tracks within p95 15 ms (was 7 of 28), no
  CC0 track with a tempo that is not one octave off (was 3 of 17). One octave off is still not told apart. Existing
  beats files keep `onset-flux@1` and their grid until measured again (`frameshell beats measure`); nothing migrates.
- `export.otio` (`frameshell export otio`, MCP `export_otio`) refuses an image project with `InvalidOperation`: it has
  stills as layers and no cut to hand to an editor (ADR 0045). The warning about dissolves and fades is split: dips
  and fades stay left out, dissolves between butted clips are exported.
- The Remotion adapter warns (`RenderContext.warn`) when a clip asks for `words` and the project's own
  `src/frameshell-timing.ts` predates them, and `frameshell remotion new` says so too; the file is never changed.
- `scripts/test-scope.mjs` runs no tests for anything under `spikes/`.
- Small fixes, wave 24 (slice SF5, part of #451; no protocol change, plugin API `apiVersion` stays "1"):
  `RENDER_TIMING_KINDS` in `@frameshell/plugin-api` is the one list of timing kinds the host reads (`clipTiming`); the
  `hyperframes` and `remotion` adapters keep a type-only copy, since an installed plugin carries no plugin-api
  (ADR 0021), and a test in each holds it equal to the list. `work-cards` and `notification-stack` with `onBeats` on
  hold beat-placed starts to the room before the exit on a short clip (order kept, held 0.08 s apart at the end);
  with `onBeats` off, with no usable grid, or on a clip long enough, the times and the render keys are unchanged. `checklist` is left as it
  is: its ticks follow `tickStart` and `tickGap` with no room pulled in, so there is none to clamp to. Clips
  scaffolded earlier keep their copy of the template (`hyperframes update` refreshes only the runtime files, never a
  composition's HTML); scaffold again with `hyperframes new --template` to get the clamp. `grade.analyze` on a
  nested timeline clip lists the first eight media and generated clips inside it (all of them in the error's
  `data.inside`), still naming `grade.compare`; a nested file that is missing, empty or unreadable gives the old
  message.
- Docs: the timing bullet of SPEC §6.5 and `motion-films.md` read as one sentence each, and the `hyperframes` skill says
  `onBeats` is asked only from the clip's own props (never a `<meta>`, a template default or a nested clip's host).
- `analyze` of a file over an hour (only the first hour's picture is read) now takes its rhythm's shot-length CV
  from the shots as far as they were read (`shotLengthsRead` in `analyze/shots.ts`, the one rule `review` uses too),
  so the CV of a truncated file shifts to the one `review --file` reports; the shots table still lists the whole film.
  Files under an hour are unchanged.

- `review` measures motion on the scale of `analyze`, slice RR of #457 (epic #451, #471; owner decision 2026-11-17;
  protocol 166): a `--file` is read on every frame with `analyze`'s reader (grey frames 64 px on the long side) instead
  of up to 15 samples a second at 320 px, and its shots are found the way `analyze` finds them (ffmpeg scene scores at
  0.3). A timeline stays sampled through `frame` (at most 90 samples, now 64 px too) and every threshold applies per
  sample interval; `metrics.picture.sampled` says so. Still pictures, visual events and bursts use `analyze/rhythm.ts`
  only (`STILL_LEVEL`, `bigChanges`, `stillRuns`, `bursts`); review's own `STILL_ENERGY`, `EVENT_FLOOR` and
  `EVENT_MEDIAN_FACTOR` are gone. New `metrics.rhythm` (`label`, `shotLengthCv`, `stillShare`, `bursts`): on a file
  MEASURED and the numbers `analyze` reports for it, on a timeline ESTIMATED from its samples and clip cuts; the CLI
  prints it on one line. **Verdicts shift:** a picture is still under 0.5 grey levels of change (was 0.35, on a different
  picture size), so slow drifts and noisy holds now count as still; a hold lasts to the end of its last frame (`n`
  frames = `n / fps`, one frame longer than before), so `static` warnings, `film.maxStatic`, `clip.keepsMoving` and a
  waiver's `to` read up to a frame longer, and a hold of exactly 3 s at 30 fps is now 3 s, not 2.967; a file's holds
  shorter than 1/15 s and changes between two old samples are now seen; visual events are big changes (4 times the
  median within 0.5 s and at least 1 level, 15 % of the grey range, or a file's scene cut) instead of peaks over 2.5 times the
  film's median, so `events`, `largestGap` and the sync of a file change; near-blank (`blank`, `frame-0`) reads the
  64 px picture, where thin detail on a flat frame weighs less. Every motion reading (`analyze`'s picture,
  `analyze.diff`'s activity, a reviewed file and a reviewed timeline's samples) now takes one grey, the rounded Rec. 709
  luma of RGB frames (`greyOf`), instead of ffmpeg's Y plane for `analyze.diff` and `review`: a change of colour alone
  (a hue turn, a grade ramp) now moves the picture there too, so their still stretches shrink and their alignment can
  shift on coloured footage. A file over an hour is measured on its first hour, with a warning, and its gap and shots
  stop there. The MCP server's instructions list the current sheets (with `beats` and `cropAt`) and the rhythm metrics.
- The preview draws a person lifted in front of a word from the frame the plate track already decoded, slice MX2 of
  #461 (ADR 0032, epic #451): a subject span that shows the same source frame of the same proxy as a span of the plate
  decodes only its matte, so a word behind the head runs one decoder fewer per plate layer (2 instead of 3 for one
  clip, 4 instead of 6 for a dissolve or wipe of the plate under the word). Grade, shape, matte and opacity stay per
  layer, as export applies them. Any span that does not line up keeps its own decoder. A preview layer now closes a
  decoder no clip ahead of the playhead needs, instead of keeping it open and idle.
- A tool's install folders outside its supported range are a fallback, not the answer (`findUserInstall`, Blender on
  Windows): an old `Blender 3.6` folder in `Program Files` no longer hides a supported `blender` on PATH; the later
  rules look first, and only when they find nothing is the newest folder outside the range taken, so `doctor` still says
  "out of range" and never "not installed".
- Raw frame reads (`readRawFrames`: subject mattes, face detection, people scans, `review`, `analyze`) copy each pipe
  chunk once into its frame instead of joining chunks as they come, which copied a 4K RGB frame hundreds of times.
- The `blender` clip's `quality` prop is gone (owner decision on #501): props are `scene` and `camera`, and a `quality`
  prop is refused with how to choose draft or final at export.

- `brand import-figma` sanitises the folder in a worker thread (#467): a synthetic 13 MB frame took 4.7 s on a loaded
  host, long enough to stall every other daemon call.
- Internal: the daemon method registry is split into one module per area under `packages/protocol/src/methods/`
  and merged into `methods` with a declared `MethodRegistry` type (#517), so its emitted declaration no longer grows
  with every schema (TypeScript TS7056 limit). Wire, `PROTOCOL_VERSION`, method names, params, results, MCP tools and
  CLI unchanged.
- Export holds true peak under -1 dBTP in the delivered file (#519, epic #451): after the second `loudnorm` pass the
  mix goes up to 4x the export's sample rate, through `alimiter` at -1.5 dBFS (sample peaks there are true peaks) and
  back, before the cut to length, the loop fades and the encode. `loudnorm` alone let sharp synthesized transients
  through at -0.8 dBTP after the AAC encode; the half dB of headroom covers what the encoder adds. Only the final mux
  step changes: golden plans differ in that filter chain, nothing on the wire.
- Export loudness after the true-peak limiter lands within 0.15 LU of the target, and the limiter's ceiling follows the
  codec (last slice of #463, ADR 0038, epic #451; no wire change). The limiter of #519 took up to 0.6 LU (more on
  hostile transients) off the integrated loudness: when it can engage (the true peak plus the gain to the target, which
  is what `loudnorm` applies in linear mode, not its `target_offset`, reaches the ceiling) the export now measures the
  limited mix again with `loudnorm` in analysis mode, adds the missing
  difference as `volume` before the limiter (once two measurements show how much of a dB the limiter lets through,
  the step divides by that), and measures once more, at most three measurements and ±3 dB, keeping the
  closest; a mix the limiter cannot touch costs nothing extra. The ceiling is no longer -1.5 dBFS for every codec but
  `TRUE_PEAK_CEILINGS` (`export/true-peak.ts`): -1.2 dBTP for PCM, -1.8 for Opus from 64 kbps, -2.3 for AAC from
  160 kbps, -4.9 below, each from the overshoot ffmpeg's encoders add to hot transients (the data and its source are in
  the file). `RenderPlan.audio.truePeak` carries it, `muxStep` takes the trim, `limitedAnalysis` is the new step;
  golden plans differ in the limiter's `limit` and the plan's `audio.truePeak`. Real-ffmpeg tests export a transient
  fixture (and a quiet one, at -33 LUFS, but for AAC 128 kbps) as AAC 320 and 128 kbps, Opus and PCM: each ends under -1 dBTP and within
  0.15 LU of -17. The re-measures report progress inside the mux step.
- Docs of the sound features, last slice of #463 (ADR 0038 "as built" for the slices after the first, SPEC decision 43,
  GLOSSARY terms music take, section and true-peak ceiling, CLAUDE.md rows): #463 is done but for the CC0 set, the
  audition page and the energetic music preset, which the owner postponed.
- Preview playback tests count two kinds of dropped frames (#567, ADR 0001 amendment): the engine reports, per play,
  the frames it passed over that a display tick wanted but were not decoded, or that followed a tick of its own longer
  than a frame (starved), and those no tick wanted while it was idle (cadence: the host gave it no tick in time), with
  the longest and 95th-percentile tick times. The playback e2e tests and the ADR 0001 harness fail on starved drops
  only, still none allowed; cadence drops are listed in the annotations. Frame lists are posted capped at 50 per kind.
- Motion film playbook uses the commands that landed after it (#453; skill only): `sound music` or `music candidates`
  for the bed, `music fit --end bar:N`, `duck --level`, `analyze` numbers as storyboard targets, `clip verify` per shot,
  `review` metrics in the critique loop, iris and dip-cut, `glass-card` with `clip set --glass`, `render --loop` and `batch`.

- `beat:N` and `bar:N` count from the song, not the clip (#550, part of #458, ADR 0029; protocol 107): `beat:1` is the
  music file's first measured beat and `bar:1` its first downbeat, so trimming the head of the music clip no longer
  renumbers them (`bar:8` stays the same musical bar). Past the measured part a number continues at the grid's period
  instead of being refused (a result before 0 still is), and `tempo.show` reports `beatBase` and `barBase`, the entries
  of the file before the first one the clip shows. With a pickup `bar:N` is not `beat:(meter*(N-1)+1)`; ADR, CLI help
  and skill say so. `marker add`/`marker set` now refuse a label shaped like `beat:8` or `bar:2` (any case), so
  a marker cannot shadow a grid reference (projects that stored such a label still load, and the grid wins over it). `music fit --end` and `--from` take `bar:16` and `beat:N` too: they go
  through the same asynchronous resolver as every other time.
- The preview's 9:16 toggle is gone (#469 slice 2, ADR 0027): its fixed 1080x1920 frame is replaced by the format
  switcher, which shows only the formats a project declares. A landscape project without `formats` has no 9:16 view any
  more; `frameshell format add 9x16` gives it one.
- Review mode holds format changes (#496 slice 2, ADR 0036, protocol 94): while review mode is on, an agent's
  `format add`, `format remove`, `revert` of a format change and `tx abort` of one that reached the file wait in the
  transaction's proposal like timeline changes, instead of being refused. A transaction mixing clips and formats is
  one proposal, accepted or rejected whole. The person's change of another format rebases the proposal; a change of
  the same format makes it stale (`conflicts`: `format:<id>`). Accepting journals the format operations, marked with
  the proposal, before the timeline ones. `format list` shows the author its proposal's version (`--json`: `view`,
  `proposal`). A `frameshell.json` write that changes `formats` is journaled as a `file.write` config operation that
  `revert` undoes; in review mode its formats change waits in the proposal and the other keys are written at once.
  An agent's `style.json` write is refused while review mode is on, until `style set` exists. The app's proposal bar
  lists the formats a proposal adds or removes (`Formats: + 9x16 (1080x1920)`), and the History list refreshes when a
  proposal opens or closes. Wire: `format.add`/`format.remove` results gain `proposal`; `format.list` takes `view`;
  proposals (`proposal.status`, `status`, `proposal.changed`), `proposal.diff` and `proposal.accept` gain `config`;
  decisions gain `config`.
- Format changes are history (#496 slice 1, ADR 0036, SPEC decision 41, protocol 89): `format add` and
  `format remove` join your transaction, `frameshell history` lists them in every timeline's history (marked
  `project config`, touched `format:<id>`), and `frameshell revert <op|tx>` and `tx abort` undo them, with the clips
  of a mixed transaction. A later change of the same format conflicts like a clip; a hand edit of `formats` in
  `frameshell.json` refuses the revert like a hand edit of a timeline. `revert` no longer refuses format changes
  (InvalidOperation reason `format change` is gone). `.frameshell/history/project.config.jsonl` lines are keyed
  operations now (`doc`, `patch`, `tx`, hash chain); older lines are read as they are. While review mode is on, an
  agent still cannot change or revert formats. Wire: `format.add`/`format.remove` results carry `tx`, `history`
  operations `doc`, `revert` and `tx.abort` results `config`. The History panel marks such transactions `project`.
  A transaction that changed several timelines reverts one `--timeline` at a time, its format changes with the
  first; naming a timeline it never changed fails with HistoryNotFound naming the ones it did (`data.timelines`).
- `clip set --voice` (#464, ADR 0031) writes the voice chain of the project's `style.json` (`sound.voice`, ADR 0028)
  instead of fixed numbers: style seconds become milliseconds, each number is held to the effect's range, and a
  noise reduction of 0 leaves `denoise` out. Without a `style.json`, or with a style that does not set `sound.voice`,
  the chain is the same as before. The style's default high-pass is now 85 Hz (was 80), the voice chain's.
- Agent skill: the reels playbook and the critique loop use the commands of this release: `style show` at intake,
  `clip reframe`, `format add` and `render --formats`, `clip set --voice`, `cleanup`, markers for the graphics plan,
  `push`/`wipe` transitions, `duck`, `render --quality draft|final`, `--cover-frame` and `cover`.
- `@frameshell/hyperframes` 0.5.0 renders with `@hyperframes/core` and `@hyperframes/producer` 0.9.30 (was 0.8.92).
  The 0.9 breaking changes touch only distributed rendering (Lambda, Cloud Run), which the plugin does not use.
  Clip render caches are keyed by plugin version, so existing `hyperframes` clips render again once.
- `@frameshell/remotion` 0.5.0 carries the beat and marker timing binding (`props.timing`). Clip render caches are
  keyed by plugin version, so existing `remotion` clips render again once.
- The format owns the frame (ADR 0027): an export preset given to `render` or `frame` whose aspect differs from the
  format rendered is refused (`render --preset vertical-1080x1920` in a 16:9 project now asks to add and render the
  `9x16` format). A vertical project rendered without a preset now exports at its own size, not a letterboxed
  1920x1080. Likewise an `export.defaultPreset` of another aspect than the project only gives codec, bitrate and
  loudness: a 16:9 project with `defaultPreset: vertical-1080x1920` exports at 1920x1080, no longer letterboxed into
  1080x1920, and the render's `warnings` say so.
- Edits of `frameshell.json` by the daemon (plugin pins, transcription choice, formats) run one at a time per project,
  so two at once no longer lose one of them.
- Timeline files: a clip's `shape` without a `dissolve`, or on an audio track, is rejected. Files without `shape`
  are unchanged and export byte for byte as before; hosts older than this release reject files that carry `shape`.

### Fixed

- Removing a managed download (`binaries.remove`) reports only the bytes it really freed (a file the system would not
  delete is not counted), refuses with `files-open` on Windows only (elsewhere a denied rename says the data directory
  is not writable), checks again for a concurrent download right before moving the directory, and sweeps every
  `.removing-*` leftover in `binaries/` and `models/` on each removal, not only those of the same name.
- Closing a terminal tab whose shell had already exited, with the exit event not yet delivered, no longer calls
  `pty.kill()` on it (it throws or logs on Windows); the close waits for the exit event instead (small fixes 6 of #451).
- Generated clips: a pass over a timeline (`clip.renders`, `ensure`, `finals`, `check`, `gc`, the background refresh)
  reads the transcript once for all the clips that ask for `words`, instead of once per clip; a transcript changed
  between two calls still re-keys, and render keys are unchanged.
- Review switch (ADR 0019, test hardening #515, #516, #533): the "Review agent changes before applying" checkbox keeps
  the click until the review state agrees with it (or the call fails), instead of jumping back when the daemon's reply
  arrives before its event; this was the cause of the flaky checkbox in the review and config-proposal e2e specs.
- ADR 0001 harness counts frames dropped at cuts from the engine's draws, slice PB of #573 (epic #451; e2e harness
  only, no src or wire change): `analyze` took the dropped frames at a cut from the page's rAF probes, so a main
  thread that read a frame late counted as a drop although the engine had drawn it. New `cutEdgeDrops` in
  `e2e/draw-log.ts` takes the undrawn run at the end of the segment before a cut and at the start of the one after,
  and classifies it with the same `classifyDrops` as interior drops. Threshold 1 now fails on stray frames or starved
  drops at cuts; cadence drops are reported in its detail (ADR 0001 amendment #567, owner decision 2026-11-18). The
  stray frames, freeze and A/V numbers still come from the probes. The full 30 min re-measure stays with the owner.
- Small fixes, slice SF4 of #451 (no wire change): (1) the preview sizes a clip's grain cells from the clip's unkeyed
  placement, as export does (ADR 0043 "Units"), so a zoom key no longer changes the grain size from frame to frame in
  the preview only. (2) `gc` prunes `.frameshell/blender/finals.json` of the `.blend` files no clip uses (the file stays,
  with its `last` rate; a file written in the last minute is left; reported as one `gc` entry with the bytes saved;
  ADR 0035). (3) The Remotion `useFrameshellTiming()` hook falls back to `getInputProps().frameshellTiming` when a
  composition's `calculateMetadata` returned props without it; projects that already have `src/frameshell-timing.ts`
  keep their copy (never overwritten) and can add the fallback by hand. Not in this slice: the `ui.seek` view while a
  proposal is open (needs the app to report which view it shows: a wire change), `music.fit` bar-ending re-snap, held
  edge frames in `frame` stills.
- Small fixes, slice SF2 of #451 (no wire change): the `ui.seek` description and the batch `VariantContext.resolve`
  TSDoc named only markers, beats and bars; they now point to the `TimeRef` forms, `word:` included. `review --pop`
  with a number is taken as seconds straight, with no stub timeline; a marker, beat or word still resolves against the
  timeline. The plugin API TSDoc of `ClipAdapter.gc` states the real contract of the host's `gc`: one call per clip
  type, which inputs it gets, and when it is not called. Not changed: the stale temp-root sweep for e2e (the unit-test
  side, PR #640, is on main; the e2e side is done in slice SF3) and `grade.analyze`/`grade.compare` for generated clips
  (they need a clip render and a nullable `asset` in the result, a wire change).

- Small fixes, slice SF3 of #451 (no wire change): the e2e run root `fse-*` that a killed run left in the system temp
  dir is swept at the next start when it is older than a day, by the same helper as the unit tests' `fsv-*` dirs
  (`scripts/stale-temp-dirs.mjs`, one sweep with a unit test), before `TMPDIR` moves so a parallel run's young root
  stays. `review` of words behind the person now measures only inside the range reviewed (a word that plays outside it
  is not listed, one that straddles an end is sampled in its part inside), and one word whose alpha or matte cannot be
  read (an ffmpeg exit) is an `unplaced` entry and a `behind:` warning instead of failing the whole review. When the
  samples of a word fall on both sides of the 15 to 65 % bands, the entry keeps the verdict of the farthest sample and
  its message says part of the word floats and part is eaten. `readyMatte` (review) and `matte.status` read one
  `matteLookup`, so both judge the ingest the same way (texts and states unchanged). `sound.place` and `sound.music`
  write through the `inOneTransaction` helper that `voiceover.place` uses, so a stale-revision refusal now carries the
  helper's generic text.

- Small fixes, slice SF of #471 (epic #451, parts of #470 and #482; no wire change): a `voiceover.generate` call now
  stops when its connection closes (Ctrl+C in the CLI, a dropped MCP connection, the app quitting), through the same
  stop as `voiceover.cancel` (takes finished before stay written, other clients' calls untouched, a waiting client no
  longer sits behind a run nobody listens to; ADR 0034 as built; the skill no longer says a dropped connection keeps
  the run going). The confirming command a paid refusal prints quotes its words for the shell (single quotes, `'\''`
  in sh and `''` in PowerShell on Windows) and is left out for a word with a line break, instead of double quotes
  that expanded `$` and a backtick (on Windows also a leading `@`, a PowerShell splat, is quoted and a `"` leaves the
  command out). The `voiceover.generate` description now says a closed connection stops the call. `docs/binaries.md` says a Blender folder outside the supported range is taken on
  Windows only when nothing else is found, `blender.exe` on PATH included, as the code does.
  `InputsContext.signal` of the plugin API is typed optional, as its doc already said (`PLUGIN_API_VERSION` stays
  `"1"`).
- Skill: reference handling by type, closes #471. `reference-video.md` opens with "What kind of reference": a frame
  (what to take and what not, ESTIMATED by eye, `grade analyze` on a still for the levels), a video (the existing
  steps) or a library (`brand capture` / `brand import-figma`, `style show`, `style set`, then one or two videos).
  `motion-films.md` and `reels.md` link to it.
- `clip compare --look a:scene=2024` (#482) keeps `scene` and `camera` values as text, so a scene named `2024` or a
  camera named `001` is found; `null` still drops the key. The `clip.compare` description now names `ClipRenderFailed`
  for a variant whose render fails (it said InvalidOperation) and says variant renders stay cached only until `gc`.
- The Blender playbook quotes `doctor`'s real lines for a Blender that is missing or out of range.
- Test runs no longer fill the system temp dir: vitest gives each test file its own `TMPDIR` (`fsv-*`, removed after the
  file and swept again at the end of the run, stale ones after a day) and warns about temp dirs that still escaped it;
  Playwright e2e runs under one temp root removed at teardown. Before, every run left hundreds of `frameshell-*` and
  `fs-*` dirs behind (94 GB over many parallel runs).
- The Voice switch of the clip inspector no longer deletes the builds `music shape` wrote (#485, ADR 0037): the switch,
  "Voice preset" and Voice off replace only the voice effects and keep every `highpassSweep` build in place, and the
  switch reads "on" only while the clip has a non-build effect. `isBuild` moved to `@frameshell/schema`.
- Motion compositions paint each time the same whatever was painted before (#501, epic #451): motion runtime 0.3.0
  writes `x` and `y` on a 1/32 px grid and `rotate` on a 0.02° grid, because Chrome does not repaint a transform change
  under about 1/80 px and kept the older pose, so slow motion (a spring settling) rendered by frame differed from the
  same frames painted alone (8/255). Each seek also changes the document element's filter between `opacity(1)` and
  `brightness(1)` (no pixel changes), so Chrome rasters the whole page again instead of only the rectangles it thinks
  changed. With both, the sub-frame samples of a motion-blurred render (HyperFrames producer, fixed 8 samples) match
  each time painted on a fresh page in 240 of 240, and repeated blurred renders are byte-identical, as PNG and as WebM
  (before: up to 4/255 in PNG and 92/255 after VP9). New clips get 0.3.0; an existing clip keeps its frozen copy until
  `frameshell hyperframes update`. Numbers in `docs/research/motion-blur.md`.
- Leaving the preview's full screen no longer depends on a fixed 1.5 s wait (#533): macOS drops a request to leave
  while it animates into full screen, and a slow machine took longer, so Escape did nothing. The window now reports
  when it settled (`enter-full-screen`, `panels.fullScreenSettled` in the app's API) and the leave waits for that.
- A batch render no longer counts as running once its last job ended (#533): `batch.render` of the same `out` straight
  after waited for the manifest to say `done` used to fail with "A batch is already rendering" when the run had not
  yet been dropped, and `gc` kept clip renders until then. The run is finished as soon as every row ended; a new
  render waits for the manifest write of the one before, so it reads the final manifest.
- The preview keeps the pitch of a clip at speed ≠ 1, like export (#499, epic #451): its program audio stretches a
  sped-up clip's sound with WSOLA (2048-sample Hann frames, the window of export `atempo` at 48 kHz, each moved by up
  to 512 samples to line up with the one before) instead of resampling it, so a 1.25x clip no longer sounds higher in
  the app than in the file. Reads of one clip carry the alignment over from one to the next during a play; speed 1 is
  sample-for-sample unchanged. A test plays tones at 0.75x, 1.25x and 2x through the preview and the real export mix:
  the same pitch within 2 Hz, the sound on time within one 128-sample block, sample-accurate fades the same (also at
  2x and 0.75x: the fades ramp over program samples after the stretch). Export is unchanged: `atempo` stays with no
  pre-roll (ADR 0037), since it is on time for continuous sound and early only on a hit right after digital silence (up
  to about 21 ms, a known limit); `music fit --exact` warns about that case.
- Voiceover cost dialog (#586, ADR 0034 decision 20; protocol 118): the paid run is bound to what the person saw.
  `voiceover.generate`'s `ConfirmationRequired` carries a `confirmation` token (provider, voice, lines to say and their
  cost), the app sends it back with `yes`, and a paid run whose lines or cost changed since (the script was edited while
  the dialog was open) fails with the new `ConfirmationStale` and generates nothing; the app then asks again with the
  new cost. `yes` alone (CLI, agents) still confirms any cost. The Explorer offers "Generate voiceover…" only on scripts
  with `voiceover: true` in their frontmatter.
- Preview: in a short window the clip inspector takes at most half the panel and scrolls, instead of squeezing the
  picture, and its handles, to nothing (#581).
- Preview: after a timeline change (such as a subject matte turning ready, ADR 0032) the preview no longer reports
  the previous picture as the new one's frame while the engine still decodes it (#551).
- Desktop: a detached panel window closed within a moment of being moved, resized or leaving full screen keeps that
  placement for the next time it opens (#533).
- CLI: `import --wait`, `render --wait` and other job followers no longer print a step twice when the job list the
  daemon answers is older than the events already read (#533).
- Windows: an atomic write (`writeTextAtomic`) whose target a reader keeps opening tries the rename again every
  25 ms at most instead of every 200 ms, so it reaches the moment no handle is open within the same 3 s (#533).

## [0.18.0] - 2026-11-07

### Added

- Tooltips on icon buttons and terse controls in every panel (#409): one in-app tooltip (`components/Tooltip.tsx`)
  shows what a control does and its shortcut (⌘ on macOS, Ctrl elsewhere) after a short hover or at once on keyboard
  focus; Escape, a press or scrolling hide it. It works in detached panel windows. Controls mark it with `data-tip`
  and `data-tip-key` instead of the native `title`; new tips on angle tiles, review Before/After/Accept/Reject,
  History revert, People pick buttons, tab close buttons, teleprompter Hold and Start shoot, and panel show/hide
  controls now name their shortcut.

- Shoot view: right-click a take in the scene's take list to Discard take (danger item) or Restore take
  (`shoot.discard`, then the cut is assembled again). Part of #414.
- Mute and hide a track (#414): timeline tracks take optional `muted: true` (video, audio and program tracks: no
  sound, whatever the clips' own audio) and `hidden: true` (video and program tracks: no picture, the tracks below
  show through, the sound still plays). Set with `track.set` `muted`/`hidden` (protocol 69), CLI
  `frameshell track set <track> --muted|--unmuted --hidden|--shown`, or Mute track / Hide track in the timeline's
  track header menu; the header marks the state and a hidden track's clips are drawn faded. Export, preview,
  `inspect.point`, `people ranges --onscreen` and the word checks read it through `withTrackMutes` and `showsPicture`
  (`composite.ts`), nested timelines included. Existing files stay valid.

- Calls in the Shoot view (part of #394, ADR 0024 decision 8). After a session that recorded system audio, the view
  offers "After the call": split the call window into its tiles, find who speaks in the system audio
  (`transcribe.speakers`, transcribing it first when needed) and link the speakers in People. `multicam.gallery`
  takes `group` and `mic` (CLI `multicam gallery --into <group> --mic <id>|none`) to add the tiles to an existing
  group at its window angle's offset, keeping its shots (tiles added already are refused); the result's `track`
  and `clip` may then be null (protocol 70). `people.suggest` has a new kind `script`: a transcript speaker, or a whole transcript without
  speakers, that says 80% or more of its words in one `**Name:**`'s lines of a shoot script is that person (or a new
  one with that name); a mixed transcript without speakers gets a hint to run `transcribe --speakers`.

### Changed

- `speaker` deviations of shoot takes name the person `people.json` links to a transcript speaker before the
  speaker's own name in the transcript, and each transcript of a session take counts its own whole-transcript
  link (before, the first sound file's link was given to the words of every file). Cached comparisons are redone.
- One `shortcutLabel` helper (`renderer/src/shortcuts.ts`) writes shortcuts per platform for menus and tooltips;
  the panel show/hide keys live there too (#409).
- One `mediaSrc` helper (`preview/media-src.ts`, worker-safe) builds media URLs for the engine worker, the Angles
  viewer and the People panel (#385).

### Fixed

- Shoot view in a project without a transcription provider (#411): it says so before Start and installs
  `@frameshell/whisper-cpp` in one click, showing the download size. Takes cut meanwhile show why they failed and
  are transcribed once a plugin is installed. `shoot.status` reports `transcription` (protocol 68), and
  `frameshell shoot status` prints it.
- A shoot session whose End could not place every chosen take on the program track (#440): two shots on the same
  program track were refused as overlapping when 3-decimal rounding of `start`, `in` and `out` put one shot's end a
  millisecond past the next one's start, so the later takes were silently left out. Shots may now meet within 2 ms.
- Flaky desktop e2e: `transitions-ui` waits for the history journal before reading the keyframe entries (#379).

## [0.17.0] - 2026-11-03

### Added

- "Ask agent" is now **Chat about this** ("Hablar de esto" in Spanish; #434, ADR 0025), Cmd/Ctrl+L unchanged, and every right-click menu over something selectable has it: now also track headers, multicam turn lanes, Explorer folders and editor tabs, each after selecting what was clicked. **Copy reference** sits under it in every such menu and puts the same `[frameshell]` lines on the clipboard. A track picked by its header is referenced as `[frameshell] track v1 · video "Camera"`.
- Pick the transcription model, including your own model file (#427, protocol v67). `frameshell model add <id> <file> [--dtw preset]` registers a local model file on this machine under an id (daemon `model.add`, MCP `model_add`), kept in `models.json` in the config dir with its SHA-256: no checksum of ours, registering is the consent. Only formats that cannot run code are accepted: whisper.cpp ggml, gguf and ONNX; pickle checkpoints (`.nemo`, `.pt`, `.ckpt`) fail with the new error `UnsupportedModelFormat`. A project names only the id (`transcription.model`), never a path, so it stays portable: `frameshell model use <id|default>` (daemon `transcription.set`) writes it, `frameshell model default <id|none>` (`model.default`) sets this machine's model for projects that name none, `frameshell model list` (`model.list`) shows the provider's models with size and download state, the registered files and what the project uses, and `frameshell model remove <id>` forgets a registration (the file stays). An id this machine does not know fails with the new error `ModelNotRegistered`, naming it and how to register it, never falling back to another model. Transcripts made with a registered file record `modelHash`; `transcribe` reports it and warns (new `warnings`) when the file changed since it was registered. whisper.cpp runs registered ggml files with their `--dtw` alignment preset, or without DTW (coarser word starts, said in progress and in `warnings`). The desktop transcript view gets a model picker: the provider's models with their size, registered files, and "Custom file…" to register one.
- `@frameshell/whisper-cpp` 0.3.0: runs model files registered with `frameshell model add` (#427); needed before projects can use them.
- Plugin API: `TranscribeContext.userModel(id, formats)` resolves a model file the user registered, so every provider gets the same mechanism; providers may list their pinned `models`, `defaultModel` and `userModels` support, and return `notes` with a result. All additive (API version stays 1).
- Connect Claude Code (ADR 0025, #430): a button in the agent guide and `frameshell setup claude-code [--status | --remove]` add Frameshell's MCP server (`~/.claude.json`) and a `UserPromptSubmit` hook (`frameshell ask --take --target claude --hook`) to Claude Code's user settings, so what you send with "Chat about this" arrives with your next message. Only Frameshell's entries change, with a backup; the hook starts no daemon and never fails a prompt. `ask --take` gained `--hook`.
- Right-click menu in the Explorer (#415, protocol v66). A file offers Chat about this, Open, Reveal in Finder (Show in File Explorer on Windows), Copy path and Move to Trash; a folder offers the last three. Move to Trash asks first, naming the timeline clips that use the file and saying they show as missing, then moves it to the system Trash (Recycle Bin), where it can be put back. `frameshell.json`, `.frameshell/` and the main timeline are refused. New app-only daemon method `file.uses` lists what in the project's timelines names a file or folder. Context menus gain separators and items drawn in the danger color.
- Right-click menu on timeline clips (#416): Split at playhead, Trim start / end to playhead, Reveal the clip's file in Finder (media, nested timeline or composition), Delete and Ripple delete, each with its key shown and disabled where the key would do nothing. It acts on the right-clicked clip, or on the whole selection when the clip is in it.
- Right-click menu on track headers (#417): Rename track (typed in place; an empty name clears it), Add subtitles of that track, Add video or audio track, and Delete track (naming how many clips go with it; undo brings them back). Right-click on empty lane space adds a video, audio or subtitle track.
- Right-click menu on recent projects in the welcome screen (#418): Open, Reveal in Finder, and Remove from Recent (the folder stays on disk).
- Right-click menus on tabs (#419). Editor tabs: Close, Close others, Close all (each unsaved file still asks), Reveal in Finder and Copy path. Terminal tabs: Rename terminal (typed in place; an empty name brings back the shell or agent name), Open in its own window or Dock back, New terminal, Close terminal.
- Chat about this reaches agents outside the app's terminals (ADR 0025 decisions 3-5, #429, protocol v67). Each `frameshell mcp` registers its MCP client with the daemon as an agent target of its project on `initialize` (Claude Code sends `claude-code`, shown as Claude Code; its target id is `claude`, like its app terminals) and leaves when it exits; several sessions of one client on one project share one target. The app sends references there instead of typing them: with one target the menu item sends at once, with several a submenu names them (app terminals running an agent as "Terminal 2 (codex)", outside agents as "Claude Code · project"), and Cmd/Ctrl+L goes to the one used last. With no agent anywhere it still types into the last focused terminal, and with no terminal it copies the reference to the clipboard. The status bar says "Sent to Claude Code, waiting for it to read", then "Claude Code read it", and how many references each agent has not read. Agents read their inbox with the MCP tools `inbox_take` / `inbox_wait`, or `frameshell ask --take [--target id]` (prints and removes them; prints nothing when none waits or the app is closed, and never starts the daemon, so a prompt hook can run it) and `frameshell ask --wait [--as name] [--timeout s]` (shows the terminal in the menu and blocks until something comes; exit 6 when nothing did). References live in daemon memory only, until read. New daemon methods `target.register`, `target.unregister`, `target.list`, `inbox.put` (app and plumbing only), `inbox.take`, `inbox.wait`, notification `target.changed`. The skill says when to take references.
- Right-click menus in History, People and Layers (#420). A History entry is selected (its changes show on the timeline) and offers Chat about this, Revert and Show / Hide operations; an operation offers Chat about this and Revert. A person offers Rename and Remove; a layer offers Rename, Move up, Move down and Delete layer.
- The terminal panel can be closed and reopened like any panel (#432, ADR 0025 decision 8): View > Terminal joins Mod+\ and the header and rail buttons. Closing keeps the shells running and the choice is remembered per project. While it is closed, the status bar lists the connected agents and clicking it reopens the panel (the list is fed by the agent-target registry, #429).
- History names agents that run outside the app's terminals (ADR 0025 decision 6, #431). The MCP server journals its operations as `agent:<label>:<session>` using the client name from `initialize` (Claude Code is `claude`), and the CLI run in any terminal uses the agent among its parent processes (`claude`, `codex`, …). Both share one table with the app terminals' detection (`agentCommands` in `@frameshell/protocol`, including `FRAMESHELL_AGENT_COMMANDS`). `FRAMESHELL_AGENT` still overrides; empty means no agent.
- Claude Code channels, opt-in (ADR 0025 decision 4, #433; a Claude Code research preview). `frameshell mcp --channel` (or `FRAMESHELL_CHANNEL=1`) declares the `claude/channel` capability and pushes each reference sent from the app as a `notifications/claude/channel` event, so Claude Code reacts without a message; started with `claude --dangerously-load-development-channels server:frameshell`. A pushed reference is taken from the inbox, so it counts as read and is never delivered twice. Off by default; without it nothing changes. See `docs/mcp.md` and the cross-session messaging research note `docs/research/claude-code-channels-messaging.md`.

## [0.16.0] - 2026-10-29

### Added

- The teleprompter follows your voice (ADR 0024 decisions 5 and 6, #393). With the Shoot view open, live recognition listens to the microphone (mixed with system audio) and the teleprompter moves with what you say: never more than the word being said, a skipped sentence struck through once the next one is clearly heard, a restart taken back, coughs and unrelated speech ignored, and a `[FREE: …]` slot held until you pause. Keys still correct it, Space holds it, and the Follow voice switch turns it off. Live words only move the teleprompter: nothing is written to the project. It runs a resident `whisper-server` (new managed package, same pinned whisper.cpp commit as `whisper-cli`; Frameshell builds for macOS Metal and Linux Vulkan on release `whisper-server-1.9.4-fs1`, upstream's CPU archives elsewhere) with the `small-q5_1` model, or `base-q5_1` where a speed check finds the machine too slow; the choice is kept in `<dataDir>/shoot/live-model.json`. Nothing is downloaded until you agree in the Shoot view (~195 MB on a Mac); where it cannot run, the view says so and the teleprompter is moved by keys.
- The project's copy of the agent skill (`.claude/skills/frameshell/`) stays current (#396, protocol v64). When a project opens, a copy holding only versions Frameshell shipped is updated to this version (new pages such as `shoot-scripts.md` reach existing projects); files added to the folder stay. An edited copy is left alone, and `frameshell status` and `doctor` say so (`skill` in their results). `frameshell skill update [--force]` (daemon `skill.update`, MCP `skill_update`) updates on purpose, `--force` also over edits, and writes the skill again where it was deleted. `pnpm gen:skill` records each version's SHA-256 in `packages/core/src/skills/shipped.json`, seeded from every release tag.
- Takes in a shoot session (ADR 0023 decision 4, ADR 0024 decisions 1 and 4, #391, protocol v63). While the Shoot view records, T starts a take at the current scene (again: record it again) and C cuts it; each take is a range of the one continuous session, kept in `shoots/<script>.json` with its session, range and sound files (`session`). Seconds after C, a `shoot` job cuts that range of the microphone (and system audio) to 16 kHz PCM, transcribes it with the project's model and compares it with the shoot script. The view picks the shoot script, lists its scenes with their state, shows the current scene's chosen take as tracked changes against the script lines (missing words struck, other words inserted), accepts one deviation or the whole take, picks the take in the cut, and moves to the next scene; while it is open, each analyzed take is assembled. When the session ends, the takes' words become the transcripts of `mic.m4a` / `system.m4a`, the session becomes one multicam group on the shoot's timeline, and its chosen takes become shots of the group's program track (`shoot.assemble` reports `waiting` for them while the session records). `clip.add` adds `shot` clips to a program track (`in`/`out` on the group clock, `shot` and `angles` optional); shots carry `take`. `shoot.status` takes report `session` and the new state `transcribing`. New app-only daemon methods `shoot.session.cut` and `shoot.session.end`.
- Teleprompter (ADR 0024, #392): a new sidebar view that moves to its own window (Shoot view: "Open teleprompter"), for a second screen or a prompter under the camera. It shows a shoot script of the project (a picker when there are several) from the shoot's next scene, or any scene picked. The word being said stays on a focus line in the middle, the next words right after it, and the text glides up under it as you read, never jumping; the current sentence stays whole on screen, the part already said dimmed and the current word highlighted. Each line starts with its speaker. Cues show small or not at all (Cues toggle); a `[FREE: …]` slot always shows its note. ←/→ move by word, ↑/↓ by line, Space holds it. Font size and mirroring (for beam-splitter prompters) are remembered per viewer.
- Record a shoot in the app (ADR 0024, #390, protocol v62). A new sidebar view, Shoot (Rodaje in Spanish), lists cameras, microphones, screens and windows (Frameshell's own list with thumbnails, never the system picker) and system audio, each with a live preview or level meter; it warns when system audio stays silent for 10 s. A microphone is the only required source. Start shoot records every picked source without stopping, one file each under `assets/shoot/<session>/` (`camera.mp4`, `screen.mp4`, `mic.m4a`, `system.m4a`; H.264 and AAC in MP4, WebM VP9 and Opus where MP4 is not offered), screens at most 1440 px on the shorter side. End shoot ingests the files and makes the session one multicam group on the main timeline: camera and screen as angles (the screen marked as one), mic and system audio as mics, in sync from the recorders' start times. While recording the preview plays no sound and Frameshell's windows hide from screen captures (macOS and Windows; on Linux the view says they may show and suggests recording a window). A session cut short by a crash, a reload or a force quit is repaired (remuxed with the managed ffmpeg) and finished the next time the project opens. System audio needs macOS 14.2 or later; on Linux and older macOS the view says so and a loopback input can be picked as the microphone. Signed macOS builds ask for camera, microphone and system audio with Frameshell's own wording.
- `multicam.create` takes known `offsets` (one per file, cameras then mics) instead of matching sound: one camera is then enough (its first shot is `solo`) and no file needs sound. `screens` marks cameras that are screen shares.
- First cut of a shoot (ADR 0023, #389, protocol v61): `frameshell shoot assemble <script> [<scene>…]` (daemon `shoot.assemble`, MCP `shoot_assemble`) writes the shoot's timeline (`timelines/<script slug>.json`, created when missing): per scene, in script order, the chosen take from its first to its last line with restarts and pauses over 1.5 s cut out, 0.15 s handles and edges snapped into pauses (`--no-snap` keeps them exact). Clips carry their scene (`scriptRef`) and their take (new optional clip field `take`, also a `clip.add` argument). Running it again replaces only scenes whose take changed, in place, moving what follows; clips anyone else placed stay. One transaction per run, undone with `revert`, held in review mode. `shoot.status` cues now have `time`, their second in the assembled timeline.
- Takes of a shoot script (ADR 0023, #388, protocol v60): `frameshell shoot add <script> <asset>` links a recorded file as a take; once the file has a transcript it is compared word by word against the script (numbers as said, the last complete attempt of each line counts). Every difference is a deviation: missing, changed (also close spellings), added, moved, restart, pause over 1.5 s, wrong speaker, scene length off by more than 25%, `[FREE: …]` slot under 5 s; `maybeTranscription` marks the ones the transcription may have caused. `frameshell shoot status` shows each scene's state (none, deviations, done), its chosen take (the newest covering it unless picked), every take's deviations and the next scene; `shoot accept`, `shoot choose` and `shoot discard` record decisions, each with its inverse (`--undo`, `default`, `--restore`). Decisions live in `shoots/<script slug>.json` (JSON Schema `shoot.json`), comparisons are cached in `.frameshell/shoot/` and swept by `gc`. MCP tools `shoot_*`, notification `shoot.changed`, skill section "Takes".
- Shoot scripts (ADR 0023, #387, protocol v59): a script in `scripts/` with `shoot: true` says line by line what each person says on camera. `frameshell script check <file>` (daemon `script.check`, MCP `script_check`) returns its scenes with expected lengths from heading timings `(0:05–0:40)`, each line with its speaker (`**Name:**`, held until the next), spoken words and cues (`[LABEL: …]`, never spoken; `[FREE: …]` for unscripted speech), the speakers matched to `people.json`, and whether the person's original (`source`, `source_hash`) changed since. Problems are warnings, never failures. New skill page `shoot-scripts.md`: the format, mapping other tools' marks, and the rule that the original is never written. In a shoot script the heading timing is left out of the scene's title and anchor.
- People in the app, the rest of ADR 0020 decision 11 (#374, protocol v58):
  - The transcript view's speaker-label menu has "Link to person…" (type a name: an existing person, or a new one added on the spot) and, for a linked speaker, "Unlink from <name>".
  - The People panel shows each person's seconds speaking and on screen in the main timeline, and a play button beside each linked voice (and each suggestion naming a voice) that plays up to 8 s of that speaker's longest stretch from the preview audio; nothing is written.
  - `ui_select` takes `person: { id, what? }` (id or exact name; `speaks` or `onscreen`): the app selects that person's spans and words as a click in the People panel does. An unknown person fails with `InvalidOperation` before the app is asked.

### Changed

- The teleprompter centers its text, so a short line sits in the middle of the panel where the eyes already are.
- The People panel no longer downloads the voice model (CAM++ and ONNX Runtime Web, ~60 MB) on its own when it opens: it shows the size and a "Find voice matches (downloads ~60 MB once)" button, then the download's progress. With the model installed it matches voices as before. `people.suggest` takes `download` (default true, so the CLI and agents are unchanged); with `download: false` voices that need the missing model are left out and `voiceDownload.bytes` says what it would fetch.

### Fixed

- A take cut right before End shoot (C, or End cutting the open take) is now analyzed (protocol v65). Its `shoot` job could start reading `<file>.part` just as End renamed it to the finished file, failed with "No such file or directory", and the take stayed `no-transcript` with no transcript written for the session. The job now reads the finished file when the `.part` is gone, and `shoot.session.end` runs again, on the finished files, every take of the session left without words (a failed job, or one lost to a daemon restart before crash recovery), so the session's transcripts hold every take. A failed take's `problem` in `shoot status` says why, and `shoot.changed` reports `failed`.
- T and C say what they did. While a shoot records, the teleprompter shows a strip above the text: "Recording · press T to start a take of <scene>", then a red dot with "Take N · <scene>" and its running time and "C to cut", then "Take N cut · analyzing…" and the result ("no differences", or how many to review in the Shoot view), or why the take failed or was not kept. The strip keeps one height and flips with Mirror. The Shoot view shows the same, larger, announces each result as it arrives (also for the take End cuts), and before Start says what T and C do.
- The teleprompter's voice recognition comes back by itself. After 10 minutes without audio the recognizer stops; coming back to the Shoot view left it off while Follow voice stayed on, and the teleprompter did not move with no sign why. Following now starts it again (never downloading anything), and next to the Follow voice switch the teleprompter says in words whether it is listening, starting, off (with a Turn on button), not installed or unavailable. While a shoot records, the Shoot view says Frameshell's windows, the teleprompter included, are hidden from screen recordings and screenshots by other apps (macOS and Windows). T and C keep taking and cutting takes while a source select holds focus.
- The teleprompter has a Back to start button that moves to the first word of the script.
- The teleprompter no longer leaves a `[FREE: …]` slot during a thinking pause (found in a real-voice run). The slot ends after a pause of 2.5 s (was 1.2 s), and only once you have spoken in it for at least 4 s. The Shoot view's voice recognition button now leads with the action ("Download voice recognition (~195 MB, once)") and says under it what it is for.
- Shoot view on macOS (#406): "Choose screen or window…" lists windows on other desktops and in full screen too (a call in a full-screen browser was missing), and picking one records it. They show "Other desktop" instead of a thumbnail; minimized or hidden windows appear the same way and record nothing until shown again. The list comes from `CGWindowListCopyWindowInfo` through `osascript`, still never the system picker.
- People (#374): face clustering runs in a worker thread, so a long recording no longer blocks the daemon, and the model of a set of cached scans is kept between `people suggest` calls (same clusters and suggestion ids). Confirming suggestions is all or nothing: people and links are checked together and `people.json` is written once, so a link that fails leaves it as it was.
- Speaker diarization (`transcribe --speakers`) gave words to the wrong person on most recordings (#359): sherpa-onnx's native ONNX Runtime computes CAM++ voice embeddings that jump with the segment length, so its voice clusters were close to random. sherpa-onnx now only finds the speech segments; each segment is embedded with CAM++ on ONNX Runtime Web (as voice prints are) and the segments are grouped into voices by Frameshell. On synthetic conversations of 2 to 6 voices the diarization error rate fell from 56% to 4% (47% to 4% with `--people`); details in `docs/research/diarization-embeddings.md`. The first run now also installs ONNX Runtime Web (33 MB) when people or face tools have not already done so, and diarizing takes about a third longer. Re-run `transcribe --speakers` on transcripts diarized before: ids and names carry over where voices match, and corrections in `edits` still win.

## [0.15.0] - 2026-10-23

### Added

- People in the project (ADR 0020, SPEC decision 27, protocol v57). Everything is optional: without `people.json` nothing changes, nothing is downloaded, no job runs and no transcript is touched.
  - Model: optional `people.json` at the project root (Zod model, JSON Schema `people.json`, SPEC §5.7): people with an id (`p_` + 6 hex, hand-written ids accepted) and a name unique ignoring case, linked to transcript speakers (`{ transcript, speaker? }`, no `speaker` = the whole transcript), multicam angles (`{ timeline, group, angle }`) and face anchors (`{ asset, at, x, y }`), each with an optional `by`, plus `dismissed` suggestion ids. A speaker, angle or anchor belongs to one person. Links whose target is gone are reported `missing` with the reason and never deleted. Names and references only: no voice or face prints in the file.
  - Commands: `frameshell people list|add|rename|remove|link|unlink|scan|suggest|confirm|ranges` (MCP `people_*`, daemon `people.*`, event `people.changed`). Linking a transcript speaker and renaming its person write the name into that transcript's `speakers` (human `edits` kept). People changes are not timeline operations: not in `history`, not held by review mode; an agent's link or confirmation records its author in `by`. Agent skill `reference/people.md`.
  - Face scan: `people scan [<asset>…]` (`force` to redo) is a background job of kind `people`: per video, 2 frames per second, YuNet faces with their five landmarks on a 512 px copy, each face of at least 32 px aligned and embedded with SFace (128 numbers), detections joined into face tracks. Cached per file content and model ids in `.frameshell/people/` (regenerable, `gc` sweeps it, kind `people`). New managed model `sface-2021dec` (38.7 MB, Apache-2.0, OpenCV zoo commit `26cc381e4d25`, `docs/binaries.md`), downloaded only by the first scan.
  - Suggestions, never assignments: `people suggest` returns `sg_…` ids with a score, a reason and `hints`; `people confirm` links (`--person` names who a suggestion naming nobody is; a new name adds them) or `--reject` dismisses for good. Kinds: `speaker` (a speaker linked to nobody sounds like a person's linked speakers: CAM++ voice prints of each speaker's 20 longest stretches alone, sherpa-onnx's fbank ported to TypeScript, ONNX Runtime Web in a worker, cached in `.frameshell/people/voices/`, computed only when some person has a linked speaker; thresholds 0.7 and margin 0.1 until tuned on real recordings), `face-speaker` (in one video, the one face on screen for 60% of a speaker's time), `face` (a face cluster nobody has, on screen 10 s or more: who it looks like, or "Who is this?"), `angle` (a multicam angle linked to nobody: the person named like it or a new one with its name, with its mic's voice and the face most on its screen, linked by one confirmation). Faces are clustered across videos (average linkage on cosine of track means, cut at 0.45) and come only from cached scans.
  - Ranges: `people ranges <person> [--on-screen] [--timeline id]` gives merged timeline spans (pauses under 0.5 s bridged) where a person speaks (their speakers' words placed through clips with cuts, speed and nested timelines; their angles' turns inside the program track's shots) or is on screen (shots showing their angles; their face samples ±0.25 s through the video clips that show them). Occlusion by upper tracks is not subtracted.
  - Subtitles: a subtitle track's `style.speakerNames` (default false; `track.add`, `track.set`) starts the first cue of each speaker turn with the transcript's speaker name ("Juan: …") and never lets a cue span two speakers. Export (ASS) and preview share `subtitleCues`; off, output is unchanged. The subtitle inspector has a "Speaker names" checkbox.
  - Desktop: a **People** sidebar view, detachable, left out of image projects. Suggestions on top (a face shows the proxy frame cropped to it, nothing stored; an angle suggestion names the angle, what else it links and a prefilled name for a new person), "Scan faces" with the job's progress, then each person with their voices, angles and faces, `missing` marks, "Confirmed by agent" from `by`, rename, remove, unlink and a picker to link a voice or angle. Picking a person selects their words in the transcript view and their spans on the timeline (Speaks / On screen); Ask agent quotes `[frameshell] person p_3fa2c1 "Juan" · speaks · 14 spans, 03:20 total` and `ui_state` reports `person` with its spans. Cmd/Ctrl+Z in the panel undoes the last people change, an agent's included (one step). Renaming a linked speaker in the transcript view renames the person. English and Spanish.
- Photo segmentation (ADR 0022, SPEC decision 28; #360, #361, #362, #363): point at a part inside a photo of an image project and cut it out as a layer.
  - Model: MobileSAM (Apache-2.0, `Acly/MobileSAM`, two ONNX files, 44.7 MB), pinned by Hugging Face revision and SHA-256 (`docs/binaries.md` "Photo segmentation"), run single-threaded in a daemon worker on the existing ONNX Runtime Web pin. Downloaded only by the first segmentation in an image project, never at startup or in a video project. Each photo is encoded once; its embedding is cached in memory by content hash (last 8). The worker's models are freed after 5 minutes without a request. Internal daemon method `segment.prepare { cwd, asset }`, image projects only.
  - Segment a point: `inspect.point` takes `segment` (CLI `frameshell inspect … --segment`, MCP `inspect_point`). On a still photo the point maps through the clip's placement into the photo's pixels; three masks (part of a part, a part, the whole) are written as 8-bit grayscale PNGs `.frameshell/context/m_<frame>_<x>_<y>_<k>.png` and listed in `segment` smallest first with `bbox`, `frameBox`, `area`, `score`, `chosen`; elsewhere `segmentUnavailable` says why. `gc` and the open sweep remove masks after 7 days. A point's `[frameshell] point` line gains `segment <png> bbox …` for the chosen mask.
  - Cut out: `image.cutout { clip, mask }` (CLI `frameshell image cutout <clip> --mask <png>`, MCP `image_cutout`) writes the photo with the mask as alpha, cropped to the mask's box, to a new `assets/<photo>-cutout-<n>.png` (the photo is never changed) and adds it on a new track right above the photo's, placed over the same pixels. Track and clip are one transaction "Cut out <photo>" (the caller's open one, else its own, also for a client without a terminal session): one revert or undo removes the layer and keeps the PNG. In review mode an agent's cut-out is one proposal; the PNG is written at once. Keyframes and fades of the photo are not copied (a warning says so). The mask must be an 8-bit grayscale PNG of the photo's size inside the project.
  - App: in an image project, turning Pick on prepares the photos ("Preparing photos…", with the download percent the first time); a click on a photo outlines the chosen mask, ↑ / ↓ step its size, and the preview's context menu offers "Cut out as layer". English and Spanish.
  - End-to-end tests: `FRAMESHELL_SEGMENT_STAND_IN=1` makes `frameshelld` answer with nested squares instead of MobileSAM; results then name the model `stand-in`.
  - Protocol v56.
- Drag to edit composition elements (ADR 0021, #331-#335, protocol v55). Everything is optional: a clip without `elements` is unchanged, in the file, its render key and its render.
  - Model: adapter clips take `elements`, CSS selector to `{ x?, y?, scale? }` (a move in composition CSS px, a uniform scale about the element's centre); the composition file stays untouched. `clip.set` merges it per selector (`null` removes one, `null` for the field clears all); CLI `clip set --elements '<json>'` / `--clear-elements`. Refused when the clip's plugin does not declare support, and for a selector holding `<`, an unescaped `{ } ;` or `/*`, starting with `@`, or leaving a quote or bracket open. With review mode on, an agent's change is a proposal; a drag in the app applies at once.
  - Render: `elementStyles` (`@frameshell/schema`) makes one sheet of `translate` and `scale` rules with `!important`, which add to the composition's own animation. The render cache key includes `elements` only when present. Plugin API (additive, `apiVersion` stays `"1"`): `ClipAdapter.elementStyles`, `RenderContext.elementCss`. HyperFrames inserts the sheet last in the copied entry's `<head>`; Remotion serves a hard-linked copy of the bundle whose `index.html` carries it, removed after the render (also when it fails).
  - Live pages: `clip.live` returns `elementCss`, and the app's bridge owns one `<style data-frameshell-elements>` that it swaps without a reload, answering how many elements each selector matches. Adapters need nothing for live. The bridge also answers `probeMovable` and `probeSelector`: the element an adjustment moves and its `unit` (page px per composition px), so a composition sized unlike the project drags 1:1.
  - Desktop: in the paused preview of a trusted project, double-click a generated clip to enter element mode. Hovering outlines the element under the pointer; a press selects it (an inline element moves its nearest block ancestor; ↑/↓ select the parent or back); its body drags it and its corners scale it about its centre. Escape, playing or selecting another clip goes back to the whole clip. A drop saves one `clip.set` by `ui` ("Move element", "Scale element"), one undo step. While dragging, a topmost clip shows its live page with the new sheet in place of its render until the new render or live page is ready; a covered clip moves only the outline. The clip inspector lists the adjustments with a reset each and Reset all, marks selectors that match nothing at the shown frame, and marks fragile ones (no `id`, `:nth-child`) with an Ask agent button that asks for an `id`. English and Spanish.
- `@frameshell/hyperframes` 0.4.0 and `@frameshell/remotion` 0.4.0 apply element adjustments at render (`elementStyles`). The new versions are part of the render cache key, so their clips render once more.

### Fixed

- Review mode no longer lets two agent changes past review (#328, ADR 0019). A new timeline file, or one written over an unreadable file, by `file.write` (anyone but the app) or created on disk, now waits in a proposal instead of landing in `timelines/`: it is not a timeline until the person accepts it, and reject discards it (one created on disk while another proposal is open is rejected with reason `proposal-pending`, `current` null, and removed). `tx abort` of operations applied before review mode was turned on no longer undoes them at once: the undo waits as a ready proposal labelled `Abort "<label>"`, named in the new `proposal` field of the `tx.abort` result; with another proposal open it fails with `ProposalPending` and the transaction stays open. With review mode off nothing changes. Protocol v54.

## [0.14.0] - 2026-10-23

### Added

- Reframe keys from faces (ADR 0016, #277): `frameshell multicam faces <group> [<angle>…] [--replace]` (MCP `multicam_faces`) looks at 2 frames per second of each angle that is not a screen, follows the largest face inside its crop and writes `reframe` keys only where it moves, so a `vertical-1080x1920` export of 16:9 cameras keeps each person in frame. It runs as a background job (kind `faces`, step `faces`) with detection in a worker thread, so the daemon stays responsive and the run finishes if the caller disconnects. One `multicam.reframe` operation per angle in one transaction (one revert undoes the run); angles that already have keys are kept unless `--replace`; the person corrects keys as before. Runs only when asked, locally on CPU: the YuNet face detector (MIT, OpenCV model zoo) on ONNX Runtime Web (MIT, WebAssembly, one pin for every platform), about 33 MB downloaded from the builders on first use and listed by `doctor` (`docs/binaries.md`). `multicam.reframe` takes `keys` to replace every key at once. Protocol v52.
- Transitions and keyframes (ADR 0018). Everything is optional: a timeline without them is unchanged, in the file, the export plan and the preview.
  - Model (schema version 1, optional fields): video and audio clips take `dissolve`, `fadeIn` and `fadeOut` (seconds) and `keys`, one sorted list per property (`x`, `y`, `scale`, `opacity`, `gain`; audio tracks only `gain`), on the clip's own clock, eased `linear`, `in`, `out` or `in-out`. The file stores what was asked; `edgeTransitions` in `@frameshell/schema` (also the `@frameshell/schema/transitions` subpath) gives what plays: whole frames, a dissolve centered on the cut and cut to the source both clips have past it and to half of each clip, a dip through black when there is no spare source, a fade in when nothing is butted. Export, preview, timeline marks and engine warnings all read it, and share the evaluators `placementAt`, `gainAt`, `fadeWeight` and `dissolveWeights` (`composite.ts`).
  - Operations (protocol v51): `transition.set` (`{ at, kind?, duration?, tracks? }`: with only `at` it dissolves the clip edge there on every video and audio track, 0.5 s; `kind: "fade"` dips through black, its two halves summing to `duration` in whole frames; a clip start or end with nothing butted fades in or out; multicam program tracks are skipped with a warning), `transition.remove` and `clip.key` (`{ clip, prop, time, value?, ease?, remove?, clear? }`: a key at a timeline second, `value` defaulting to what plays there). CLI `frameshell transition set|remove --at s`, `frameshell clip key <clip> --prop p --at s`; MCP `transition_set`, `transition_remove`, `clip_key`; all undoable. `clip.split` and `cut` give the left part the dissolve and fade in, the right part the fade out, the new cut none; both keep the keys. A transition that plays shorter or differently than asked adds a `warnings` entry. Agent skill: `reference/transitions.md`.
  - Export: dissolves draw the incoming clip from its handle over the outgoing clip's tail (opaque on the bottom track, `1 - w` above); fades go to black on the bottom track and to transparent above; generated clips hold their first or last rendered frame for handles. Keyed position and scale use `overlay` and `scale` expressions, keyed opacity a per-frame alpha through `sendcmd`. Sound crossfades and fades are equal-power (`afade` `qsin`); gain keys use `volume` per 64 samples.
  - Desktop preview: a dissolve's incoming clip plays on a second layer of its track (one more decoder, only on tracks with a dissolve) while the outgoing clip plays on into its handle, with the same weights as export; each sound sample gets its clip's gain keys and equal-power fades and crossfades. Hit-testing and live pages follow the animated placement.
  - Desktop timeline and inspector: a clip edge with a transition shows a mark at its effective length (a crossed band for a dissolve, a shaded wedge for a fade), keys show as diamonds. Right-click on a clip edge: Add dissolve, Add fade, Remove transition. The clip inspector has a Start and End transition (none, dissolve, fade, length) and, per property, a diamond that adds or removes a keyframe at the playhead, with its ease; a keyed property shows its value at the playhead and an edit keys it there. Each edit is one labelled `ui` step; the History panel names `transition.set`, `transition.remove` and `clip.key`. Image projects show none of it. English and Spanish.
- Review mode and proposals (ADR 0019, protocol v53). Optional and off by default: with it off, timeline files, journals and behaviour stay as before.
  - The switch: "Review agent changes before applying", per project, in the app's History view and File menu. It is stored per user in `<configDir>/review.json`, outside the project, and only the app can set it (internal `review.set`): there is no CLI command or MCP tool. A moved or cloned project starts with it off.
  - Proposals: while it is on, every timeline change not made in the app (agents, the CLI, MCP clients, plugins, direct file edits) waits as one **proposal** per transaction in `.frameshell/proposals/<tx>.json` instead of touching the file, and survives a daemon restart. It is building while its transaction is open and ready once it closes. One at a time: other changes, a new `tx begin` in that project (`tx.begin` takes an optional `cwd`, which the CLI and MCP pass; without it a proposal in any open project refuses it), and the author's own changes once it is ready fail with `ProposalPending`, which says to run `proposal wait`. The author's `timeline.show`, `track.list`, `frame` and `inspect.point` show the proposal (`view: "current" | "proposal"`), everyone else's the file; `render` always exports the file.
  - Decisions: the person accepts (the operations are journaled under their author, marked `proposal: <tx>`, on every timeline or none) or rejects (nothing is journaled), only in the app: internal `proposal.accept` and `proposal.reject` are refused for any other caller. The person's own edits rebase the proposal, or make it stale when they touch the same clips, tracks or groups (the keys `revert` uses). A direct edit of a timeline file becomes a ready proposal and the file is restored; one arriving while another proposal is open is rejected with reason `proposal-pending`. Outcomes go to `.frameshell/proposals/decisions.jsonl`; `status`, `history` (`proposals`) and `tx.commit` report them; event `proposal.changed`; `gc` sweeps closed proposals after 7 days.
  - Agents: `proposal.status`, `proposal.wait` (`accepted`, `rejected`, `stale`, `aborted`, or `pending` after `timeout`) and `proposal.diff` (per timeline, in `history.diff` shape). CLI `frameshell proposal status`, `proposal wait [--timeout s]` (exit 0 accepted or none, 3 rejected, 4 stale, 5 aborted, 6 still pending) and `proposal diff [--tx id]`; `status` prints a review mode line while it is on. MCP `proposal_status`, `proposal_wait`, `proposal_diff` only (`docs/mcp.md`). The agent skill has a Review mode section.
  - Desktop: while a proposal exists, a bar in every window of the project (detached panels, editor and terminal windows too) names it (label, the agent's own label, operations). Building shows "claude is working…"; ready offers Accept and Reject; a proposal made stale by the person's edits says which clips both changed until dismissed. A Before / After toggle, shared by the window and its detached panels, switches the preview and the timeline between the file and the proposal, with the History diff marks of what the proposal changes; it starts on After when a proposal becomes ready. Editing while on After applies to the file and returns the view to Before. Ask agent frames read the file. English and Spanish.

### Fixed

- Transitions and keys through nested timelines (ADR 0018 decision 9, #310), the same in export and preview from one implementation in `composite.ts`. A nested clip's `keys` compose with its clips' placement and gain at each time (offsets and scale compose, opacity multiplies, gain adds), as do the keys of a clip inside a nested clip with a transform; flattened clips record the nested clips they play in (`nestingOf`), plain data that `placementAt` and `gainAt` fold. A nested clip's `fadeIn` and `fadeOut` fade every layer and sound it plays; its `dissolve` dissolves on its own track and fades its extra layers and sound in. A clip cut by the nested window drops its own transitions at the cut. Handles at a window edge are the nested timeline's seconds outside it, and timeline marks size a dissolve beside a nested clip by its timeline's duration. Export also keeps keys on generated clips, and refuses multicam shots under a nested clip with picture keys as it does under a transform. Projects without these keep their export plans and preview unchanged.

## [0.12.1] - 2026-10-22

### Changed

- Desktop: an image project has no transcript view (#289). Mod+Shift+T does nothing there, the editor's tab strip has no Transcript button, and transcript files in the explorer open as JSON. View > Transcript and File > New Image from Frame are disabled while an image project's window is focused.

## [0.12.0] - 2026-10-21

### Added

- Image projects (ADR 0017): `"kind": "image"` in `frameshell.json` makes a project of one still picture, its main timeline's first frame, with video tracks as layers. The desktop app starts one from dropped or chosen pictures (welcome screen, Open with), sized like the first; each picture becomes a layer at its own pixel size. Pictures dropped on the project add layers. The UI hides time: a Layers panel in the timeline's place (select, rename, move up or down, delete, Ask agent, undo), the preview shows the picture's size instead of a timecode, keeps the Pick tool and adds **Export image** (PNG, JPEG or WebP). In an image project `clip.add` gives a still or a generated clip one frame without `duration`. `frameshell init --kind image`; agent skill `reference/image-projects.md`.
- Desktop: File > New Image from Frame (Cmd/Ctrl+Shift+S, or right-click the preview) makes an image project from the frame at the playhead, beside the video's project, at a size picked in a dialog (YouTube thumbnail 1280x720, the video's size, square or vertical), with the frame covering the picture as its layer, and opens it in a new window. The video project does not change.
- `frame` writes JPEG and WebP besides PNG: `format`, else the extension of `out`; `quality` 1-100, default 92 (`frameshell frame --format --quality`, MCP `frame_capture`). `track.set` takes `index` to move a track in the stack (`frameshell track set --index`). Protocol v50: also `project.init` `kind`.
- `progress` notifications carry an optional stable `stage` code (`hash`, `extract-audio`, `binary`, `binary-download`, `binary-fallback`, `model`, `model-download`, `model-load`, `gpu-compile`, `gpu-compiled`, `gpu-retry`, `transcribe`, `retranscribe`, `diarize`) and `values` (model, size in MB, device, seconds…) beside the English `message`, so a UI can word the step in its own language; unknown codes fall back to `message`. Transcription providers set them through `context.progress({ message, stage, values })` (`@frameshell/plugin-api`). Protocol v49.

### Changed

- Desktop: the status bar's setup lines during a new project's first transcription (preparing whisper.cpp, downloading the model, loading it, compiling Metal shaders, transcribing) are Spanish in the Spanish UI (#222). English reads as before.
- `@frameshell/whisper-cpp` 0.2.0 sets the stage codes of its progress steps, so new projects install it and show its setup lines in the UI language.

### Fixed

- Sound of a multicam program track nested inside an audio track now plays at exact samples in export and preview, like a program track's own sound (ADR 0016): mics of one room no longer drift up to half a frame apart there, and a sound running on across a shot change stays one item without an edge fade. It ends where a later clip of the host track starts, which keeps its own start. Flattening marks those clips (`isProgramSound` in `composite.ts`); no file, wire or protocol change.

## [0.11.0] - 2026-10-19

### Added

- Correcting who speaks by hand (ADR 0016 decision 3, protocol v48): a group may hold `painted` turns, stretches of the group clock marked as spoken or silent for one angle, set by the new operation `multicam.paint` (`frameshell multicam paint <group> [<angle>] --from s --to s (--speaking [--alone] | --silent | --measured)`, MCP `multicam_paint`, journaled and undoable). They replace the measured turns of their angle for `multicam turns` and `direct`, so re-directing keeps them. Desktop: a toggle on the program track's head opens one turn lane per angle under the shots (measured and painted turns; painted ones framed, silenced ones hatched) that can be painted by dragging (Shift keeps the other angles, Alt marks silent, right-click goes back to measured); the transcript view sets the speaker of any selection of words (picked in the transcript, the timeline or a subtitle cue) from a toolbar picker, also a new speaker, and renames a speaker by double-clicking its name; the angle panel of the shot inspector picks an angle's transcript speaker.

- Multicam from a gallery-view call recording (ADR 0016 decision 1): `frameshell multicam gallery <asset> [--name <tile>…] [--at s]` (MCP `multicam_gallery`) finds the tile grid of a Zoom, Meet or Teams gallery on frames sampled across the whole file (gutter detection with managed ffmpeg, nothing new to download) and adds one angle per tile, each a crop of the same file, with the call's sound played once through one group mic. Every tile reports a confidence; a layout change mid-call (someone joins, a screen share) is reported with its time, and `--at` picks another stretch's layout (a time past the end of the recording is refused). Fix a tile with `multicam angle --crop-*`; diarization (`transcribe --speakers`) tells the tiles' voices apart. The multicam viewer now shows each angle's crop. Protocol version 47.
- Speaker diarization (ADR 0016 decision 3): `frameshell transcribe --speakers <asset> [--people n]` (MCP `transcribe_speakers`) finds who says each word of a transcript, locally on CPU with sherpa-onnx (Apache-2.0) and two models (MIT, Apache-2.0), about 60 MB downloaded from the builders on first use (`docs/binaries.md`). Transcript words get an optional `speaker` and the transcript a `speakers` list (SPEC §5.4); a voice keeps its id and name across runs, speaker corrections in `edits` always win, and re-transcribing keeps the speakers. `multicam turns` and `direct` take the turns of angles that share one file or a diarized mic, or name a transcript speaker with `multicam angle --speaker s1`, from those speakers' words (`speakers` in the result). Desktop: the transcript view names each paragraph's speaker and its context menu says who says the marked words, saved as a transcript edit. Protocol v46: method `transcribe.speakers`, `multicam.angle` `speaker`, `multicam.turns` `speakers`.
- Reframing multicam shots for 9:16 (ADR 0016, v0.11): an angle may hold `reframe` keys (`{ at, x, y }`: a group second and the point of its picture to center on), kept in the group, not per shot. Wherever a tile cuts the angle's picture to its aspect (a solo or each stacked two-up tile of a `vertical-1080x1920` export of 16:9 cameras, grid tiles, a `pip` inset), the cut centers on that point, moving in a straight line between keys and staying inside the angle's crop; screens are never cut, and a 16:9 export of 16:9 cameras is unchanged. `frameshell multicam reframe <group> <angle> (--time s | --at s) [--x f] [--y f] [--remove]` or `--clear` (MCP `multicam_reframe`) sets, replaces or removes keys, in timeline or group seconds. Export moves the crop frame by frame with the same formula as the preview. Desktop: a **9:16** toggle in the preview's transport bar shows the frame as the vertical preset cuts it, and the shot inspector sets each cut angle's point at the playhead (X, Y, remove key, center). Face detection is not included. Protocol v45: method `multicam.reframe`.
- Camera sets with separate mics (ADR 0016, v0.11): a multicam group may hold `mics`, sound files synced apart from any picture, and an angle's sound is its own file's (as before), a mic's, or none (`mic`: a mic id or `null`; a wide camera has none, one mic may serve several angles and plays once). `frameshell multicam create` takes `--mic-file`, `--mic-name` and `--sound` and syncs every file by audio against all the others, not only the first: each file is placed by its best match with a file already placed, the first file with sound is the reference, and the report names the file each one matched. `multicam mic <group> <mic> [--offset s] [--gain dB] [--muted]` fixes a mic, `multicam angle --mic <id>|camera|none` picks an angle's sound. Export, the preview, cut snapping, transcript checks, `multicam turns` and `direct` use the mics (turns are measured from an angle's mic with the mic's offset and gain); the desktop disables gain and mute on angles heard through a mic. Existing timeline files stay valid (optional fields, schema version 1). Protocol v44: `multicam.create` takes `mics` and `soundOf` and reports `kind` and `against` per file, new method `multicam.mic`, `multicam.angle` takes `mic`.
- Screen and picture-in-picture shots (ADR 0016): shot layouts `screen` (one angle whole, never cropped, black bars where aspects differ) and `pip` (a screen angle with a second angle as an inset, `corner` configurable, default bottom-right), in export, the preview, `shot set --layout screen|pip [--corner c]` and the shot inspector. An angle can be marked a screen share (`multicam angle --screen`, a checkbox in the angle rows). `direct` measures marked angles for motion (frame difference, 4 samples a second) and, by the new `screen` rules of `director.json` (`motion`, `hold`, `threshold`, `pip`, `corner`), shows the screen while it moves: `screen` while nobody speaks, `pip` with the speaker when the shot there was a solo or two-up, else `screen`; screen angles never count as speakers, and their sound does not mask people's turns. Black bars of a contained screen are opaque black, also over lower video tracks. Protocol v43: `multicam.angle` `screen`, `shot.set` `corner`, `multicam.direct` `motion`.
- Desktop: the multicam viewer, a new **Angles** sidebar view that can move to its own window (ADR 0012, 0016): every angle of the program track's group in a grid at the playhead (a muted low-res proxy per angle, one decoder each, only while the view is shown), the angles of the current shot outlined and the speaking ones marked from `multicam.turns`. Click an angle to cut to it, as its number key does; Shift+click adds it to the shot. A mouse click leaves the focus where it was, so Space still plays; an angle whose ingest failed or has no picture says so instead of "Preparing"; the speaking marks follow the group the tiles show.
- Agent skill: a multicam playbook (`reference/multicam.md`) for conversations with one file per person (ADR 0016): create the group and check the sync confidence, cut silences from the speaking turns, pick a director template, run `direct`, review the low-confidence shots with the transcript and never overwrite the human's shots.
- `frameshell direct <group> [--template interview|podcast-calm|panel-dynamic] [--rules <file>] [--from s --to s] [--replace-human]` (and the `multicam_direct` MCP tool) turns a multicam group's speaking turns into shots by rules, in one undoable operation (ADR 0016): shortest and longest solo (a cutaway to the listener or a wide), two-up on quick exchanges and on two people talking at once, wide on silence and laughter, cut lead (J-cut) and weight per angle. Rules come from a template with `director.json` at the project root (JSON Schema `director.json`) on top. Deterministic: the same turns and rules give the same shots. Each shot gets a `confidence` and a `reason`, and the result lists the ones below 0.5 to review. The program track keeps what plays where (gaps and cuts stay); shots a person chose in the app, and pieces cut out of them, are kept unless `--replace-human` (an agent's `shot set` hands a shot back to the director). The History panel names each run. Protocol v42: method `multicam.direct`.
- Desktop: keys 1-9 cut to that angle of the multicam group at the playhead (ADR 0016): the shot under it is split there and the new part set to solo of angle N in group order; Shift+N adds the angle to the shot (two-up, grid). They work while playing, in detached windows too (not in text fields), and the presses of one playback are one undo step. Cutting is `cutToAngle` in `timeline/angle-cut.ts`, for the multicam viewer to reuse. Number keys on the keypad count only with NumLock on (with it off they keep moving the playhead), and a take stays one undo step however far apart its presses are. `timeline.edit` takes `burstGap` and the app a `timeline.settle` call (desktop IPC only, no protocol change). A press the daemon refuses leaves no split behind: the split and the `shot.set` are one edit call, and `timeline.edit` undoes what a refused call applied even inside a gesture burst; a `clip` arg of `$created` right after a `clip.split` stands for the clip it created (#268).
- Correcting multicam shots by hand (ADR 0016): `frameshell shot set <shot> [--layout solo|two-up|grid] [--angles a,b]` changes a shot's layout and angles, and `frameshell multicam angle <group> <angle>` an angle's name, crop and sound (MCP `shot_set`, `multicam_angle`), each one undoable step; `shot set` also clears the director's confidence and reason. Desktop: the program track paints each shot in its angles' colours (two-up and grid striped) and flags doubtful director's shots; the shot inspector changes layout and angles and shows the director's confidence and reason; the group's angles (name, sync, crop, gain, mute) open from the shot or the program track head. Protocol v41: methods `shot.set`, `multicam.angle`.

- `frameshell multicam create <asset>… [--name <angle>…]` (and the `multicam_create` MCP tool) makes a multicam group from one file per person (ADR 0016): it measures each file's offset against the first by audio cross-correlation of the cached energy envelopes (within one frame on files that share a sound), shifts them so the earliest starts at 0, and adds the group, a program track and one `grid` shot over the whole length in one undoable step. It reports each file's confidence; a file with no shared sound, or no sound at all (the first file needs some), is left with the first file's start and a warning says so. `multicam offset <group> <angle> <seconds>` fixes one angle by hand. Protocol v39: methods `multicam.create`, `multicam.offset`.
- `frameshell multicam turns <group>` (and the `multicam_turns` MCP tool) lists who speaks when: each angle's speaking turns on the group clock, from that angle's own mic energy (the cached envelopes cut snapping uses). Hysteresis and a minimum length keep coughs and breaths out, a voice bleeding into another person's mic is not their turn, and people talking at once keep overlapping turns. Read-only. Protocol v40: method `multicam.turns`. A pause is not bridged while another angle speaks in it, each angle's `audio.gain` counts when mics are compared, and ffmpeg failures are errors, not per-angle warnings.
- Export renders multicam program tracks (ADR 0016): each `solo`, `two-up` or `grid` shot puts its angles' pictures in their tiles (`composite.ts`, the same layout the preview will use), an angle's picture starts when its recording starts, and every angle's sound, with its gain, plays under every shot. Program tracks stack by track order like video tracks, also inside a nested timeline (a video track listed after its program track stays above the shots); `render`, `frame` and `transcribe --verify` work on them. A program track nested under a video clip that has a transform is refused with `ExportUnsupported` naming the clip and, for a clip in a nested timeline, that timeline (`--timeline <id>` in the suggested fix).
- Desktop: a new project can start from an audio file (`wav`, `mp3`, `m4a`, `aac`, `flac`, `ogg`, `opus`), from **New from video…**, a drop on the welcome screen or Open with (ADR 0015). The confirmation offers a 16:9 (default) or 9:16 frame; the audio goes on its own audio track in one undoable step, and is transcribed. Frameshell is also offered in Open with for audio, never as its default player.
- Protocol v36: `project.init` takes `resolution`, the frame size for a project whose `like` file has no picture.
- Desktop: a project made from audio gets a picture once its transcript exists: a plain background image with the project title in `assets/` over the audio, and a subtitle track following the audio (default preset), in one undoable step (ADR 0015). A project that already has clips on a video track is left alone; swap the image with **Replace image…** in the clip inspector (one undoable step), or the subtitle preset as usual.
- Desktop: **Replace image…** in the clip inspector shows a chosen image file in a media clip on a video track, keeping its track, start and length, as one undoable `ui` step.
- Scripts: a scene can name the transcript words it covers with `<!-- words: talk.words.json w_000010..w_000042 -->` (transcript file optional while one transcript holds the ids) right under its `##` heading (ADR 0015). `frameshell script outline --json` (and the `script.outline` MCP resource) then returns each scene's `wordRange` and `span`, the timeline seconds its words occupy per timeline, through clips cut inside the range; unknown ids, ambiguous bare ranges and reversed ranges are warnings. Protocol v37.
- Timeline model for multicam (ADR 0016, SPEC §5.3): `groups` of synced angles (asset, offset, crop, gain) and `program` tracks of `shot` clips (`solo`, `two-up`, `grid`) on the group clock; every angle's sound plays under every shot. `cut`, `clip trim`/`split`/`move`/`remove` and undo work on shots, and cut snapping listens to the angles. `composite.ts` lays shots out at any frame aspect, for export and preview. Adding shots and exporting program tracks are not supported yet: `clip.add` answers the new `Unsupported` error, export `ExportUnsupported`. Existing timeline files stay valid (schema version 1). Protocol v38: `timeline.patch` carries `groups`, `timeline.show` and `track.list` report program tracks.
- Desktop: the preview plays multicam program tracks (ADR 0016): each shot shows its angles laid out as export lays them out (`composite.ts`), one decoder per visible angle, and every angle's sound plays under every shot without a fade at shot changes. An angle that stays on screen across a layout change keeps decoding. Shots of a nested timeline clip that is moved, scaled or faded show a placeholder instead of drawing in the wrong place; their sound still plays. An angle still ingesting or missing shows its slate in its own tile only. Pick outlines the tile under the pointer, and a region over several tiles names the shot once.
- Desktop: the timeline shows a band under the ruler with one span per script scene that names transcript words (ADR 0015), labelled with its heading; scenes with no clip linked by `scriptRef` are drawn hollow. It follows the script, the transcript and the timeline live. A click on a span selects its time range, and Ask agent on it writes `[frameshell] scene <script>#<slug> "<title>" · <time range> · clips …`.

### Changed

- The CLI refuses a flag given twice (exit 2) where it takes one value; before, the last one won. `multicam create` and `multicam gallery` take `--name` (and `--mic-file`, `--mic-name`, `--sound`) once per file.
- `multicam`, `shot` and `direct` are built-in commands and `shot` is a core clip type, so a plugin can no longer use those names for its command or clip type.
- Desktop: the welcome button is now **New from video or audio…**.
- Agent skill: new reference page for videos made from audio (the three levels, edit the audio first, scene plan with word ranges, human review, clips with `scriptRef`; ADR 0015).
- `cut` now warns, in its result `warnings` and in the CLI output, for every generated clip (`hyperframes`, `remotion`…) it trims or splits, naming the clip id, type and `scriptRef` (ADR 0015). The cut still applies; the skill says to edit the audio before building visuals.

### Fixed

- Turn lanes: an angle marked as a screen share no longer reports speaking stretches painted before it became a screen, and the English tooltip says Alt marks that person silent.
- Export places a multicam program's sound at exact samples, like the preview (ADR 0016): each angle's or mic's file starts at `round(seconds * 48 kHz)` of its offset instead of a frame-rounded start, so mics of one room no longer drift up to half a frame apart (`soundSamples` in `composite.ts`, shared by both). A sound that runs on across a shot change is one mix item, without the edge fade at the shot change, as in the preview. Where hand-edited shots overlap, the later shot's sound wins from its start in export and preview alike. Sound of a program track nested inside an audio track still lands on frames (follow-up).

## [0.8.1] - 2026-10-17

Fixes **Connect Claude Desktop** on macOS: Claude Desktop now works on the project open in the app. Installing it is enough: an existing connection keeps working, restart Claude Desktop once. No protocol change; the official plugins are unchanged.

### Fixed

- Desktop: Claude Desktop, connected with **Connect Claude Desktop**, now reaches the app's daemon on macOS and Linux, so its tools act on the project open in the app. MCP clients start servers without `TMPDIR`, which the default daemon socket path depends on, so `frameshell mcp` started a second daemon that showed no window. The app's `frameshell` command now uses the app's socket when its caller sets no `FRAMESHELL_SOCKET`.

## [0.8.0] - 2026-10-16

Frameshell for people who never used a terminal. This release ships the 0.7 and 0.8 milestones together. Start from a video: **New from video…**, a drop, or **Open with** / **Edit with Frameshell** make a project beside it, in the video's format, with the video on the timeline and its speech transcribed. The app speaks Spanish. An agent guide above the terminal starts or installs Claude Code, Codex, Gemini CLI, OpenCode or Pi and suggests what to ask; **Connect Claude Desktop** links Claude's chat app, whose MCP server follows the app window in use. The app checks for updates, and **Help > Copy Diagnostics** helps report a problem. Plugin installs no longer need Node.js. Protocol v35: the app stops a 0.6 daemon left running and starts its own, and the app's `frameshell` command updates with it; a CLI from another install must be updated to talk to this daemon. The official plugins are unchanged.

### Added

- Desktop: **New from video…** on the welcome screen (#182, ADR 0013). Choose one or more videos and the project is made in a folder beside the first one, named after it (`interview.mp4` becomes `interview/`), with the videos imported into `assets/`; no terminal needed. The name and the place can be changed before creating. The originals stay where they are: the project gets a clone where the disk supports it (no extra space), and when it does not and the videos pass 2 GB, the app asks whether to keep a copy or use them in place. Choosing a video that already has its project there opens that project; a folder of that name holding something else gets `interview (2)`.
- Desktop: drop videos from Finder or Explorer on the welcome screen to start a project from them, and drop videos, audio or images on a project window to import them into `assets/` (#183). The status bar names what was imported and what was not media. Drops on a terminal are left to the terminal.
- Desktop: Frameshell is offered in **Open with** for videos (`mp4`, `mov`, `m4v`, `mkv`, `webm`) in Finder, Explorer and Linux file managers, without becoming their default player (#184). Opening a video shows its new project for confirmation; a video that already has its project, or a project folder, opens it. A second launch hands its files to the running app instead of starting another one.
- Windows: the installer has an option, checked by default, to add **Edit with Frameshell** to the right-click menu of videos (#185). Updates keep the choice; uninstalling removes the entry. Several videos edited at once make one project. On Windows 11 the entry is under "Show more options".
- Core: `frameshell init` and the app's new projects also write `AGENTS.md` and `GEMINI.md`, which point Codex, OpenCode, Pi and Gemini CLI at the Frameshell skill, and `.claude/settings.json`, which lets Claude Code run `frameshell` commands and MCP tools without asking while deleting files still asks (#186). Files already there are kept; `--no-skill` writes none of them.
- Core, CLI, desktop: a warning when a project is inside a folder a cloud service syncs: iCloud Drive (including a synced Desktop or Documents), Dropbox, OneDrive, Google Drive, Box (#187). Its `.frameshell/` (proxies, renders, history, often several GB) would sync too, and syncing can corrupt the history. `frameshell status` prints it, `status` reports it as `synced` (protocol v33), and the app shows it above the workspace until "Don't show again for this project".
- Desktop: a project made from videos can be transcribed right away (#188). "Transcribe what is said", checked by default in the confirmation, installs the official `@frameshell/whisper-cpp` plugin and transcribes each video in the background, with the language detected. The status bar shows each step and the first-run download (engine and model, about 600 MB); if a step fails it says what to do, with the reason in its tooltip.
- Desktop, core: a project made from videos takes the first video's format, its size (portrait phones too), frame rate and sample rate, and opens with the videos on its timeline, one after another, as one undoable step (#197). `project.init` takes `like`: a media file whose format the project gets (protocol v34).
- Desktop: the app speaks Spanish (#189). It follows the system language, and **View > Language** switches between the system language, English and Español without a restart (the windows reload; terminals keep running). The choice is saved in `language.json` in the config directory. Menus, dialogs, the welcome screen, every panel, inspector and status line are translated; the CLI, the agent skill, daemon error messages and "Ask agent" references stay in English, since agents read them.
- MCP, core, desktop: an MCP server started outside any project, as Claude Desktop runs one for every project, acts on the project open in the app window the user focused last (#192, ADR 0014). Switching windows switches the project; each result names it in a `Project: <dir>` line, and resources follow. With no window open, tools say to open a project in Frameshell or pass `cwd`. A server started inside a project keeps that project, and an explicit `cwd` always wins. The daemon answers with the internal `ui.active`, and the app reports which window has focus with `ui.publish` (protocol v35), so a window playing in the background does not take over.
- Desktop: an agent guide above the terminals answers "how do I talk to an agent" (#190). It lists Claude Code, Codex, Gemini CLI, OpenCode and Pi: the ones installed (found on the login shell's PATH and the usual install folders) get **Start**, which runs that agent in the terminal; the others get **Install**, which types the official install command into the terminal for you to run. Pi is marked as running commands without asking. With an agent running, suggestions ("Remove the silences", "Add subtitles"…) are typed at its prompt without sending. It links to the install guide on frameshell.dev and can be hidden.
- Desktop: **Connect Claude Desktop** in the agent guide (#191, macOS and Windows) adds a `frameshell` server to Claude Desktop's `claude_desktop_config.json`, running the app's `frameshell` command with `mcp` (through `cmd /c` on Windows, where Claude Desktop cannot start a `.cmd` file), after showing the entry. Only that key changes, the file is backed up to `claude_desktop_config.json.frameshell-backup`, and Claude Desktop then works on the project open in the app (ADR 0014). **Disconnect** removes the entry.
- Desktop: terminals running Pi (`pi`, also launched as `node …/pi`) are labelled as an agent like Claude Code or Codex: `agent:pi:<session>` authorship and the Ask agent target (#195). `pi` is a short name; `FRAMESHELL_AGENT_COMMANDS=pi=` turns it off if another program uses it.
- Desktop: update check (#193). Installed release builds look for a newer published release on GitHub at start and daily. On macOS and from the AppImage the update downloads in the background and a banner offers **Restart to Update**; on Windows and with the `.deb`, a banner links to the download. **Check for Updates…** and **Check for Updates Automatically** are in the app menu (macOS) or the Help menu; the opt-out is kept in `updates.json` in the config directory. The first start of a new version stops an idle daemon of the old version, so the app does not keep talking to old code. Releases now also carry `latest-mac.yml`, `latest-linux.yml` and macOS zips.
- Desktop: **Help > Copy Diagnostics** copies the app, system, Electron and Node versions, the daemon version, the `frameshell doctor` result and a summary of the focused window's project (counts only, paths under home as `~/`, no file contents, no environment) to the clipboard, then offers **Report a Problem**, which opens the new bug report form (`.github/ISSUE_TEMPLATE/bug.yml`). **Help > Report a Problem…** opens the form directly (#194). Nothing is sent anywhere by the app.

### Changed

- Core: files imported into `assets/` by copy are read-only, so an agent or a tool cannot overwrite the project's footage by mistake (#186). Linked imports (`--link`) keep the original's permissions. Replacing an asset means deleting it and writing the new file, which the daemon ingests as before.

### Fixed

- Desktop: plugin installs work on machines without Node.js (#204). The app ships npm 11.21.0 in its resources and the daemon runs it with the app's own Node; dependencies' install scripts get a `node` command that does the same. Before, `frameshell plugin install` from the installed app needed a system npm, so transcription could not be set up without Node. The app is about 18 MB larger.
- Core: rotated videos, as phones record portrait video, are reported at the size they play: `asset.list` and the export used the stored landscape size while ffmpeg decodes them upright (#207). Assets ingested before keep the old size until re-ingested.

## [0.6.0] - 2026-10-12

Detachable panels (ADR 0012): any panel moves to its own window and back, for a second monitor, sharing the playhead, the selection and the keys with the project window. Terminals keep running through the move, "Ask agent" finds the terminal running the agent in any window, the preview goes full screen with `F`, and Cmd/Ctrl+Shift+Enter maximizes a panel in place. No protocol change: the CLI and the daemon of 0.5.0 work with this app. The official plugins are unchanged.

### Added

- Desktop: the preview moves to its own window and back (#165, ADR 0012), for a second monitor. The button in its header opens it; "Dock preview back", closing the window, or "Bring back" in the slot it left returns it. The window is drawn by the project window, so it shares the playhead, the selection and the keys (Space, arrows, `I`, Cmd/Ctrl+L, undo) with it, and keeps playing at full rate while the project window is minimized. The project opens with the preview detached again, where it was: placement is saved globally (`panel-windows.json` in the config directory), per set of connected displays, and a window whose display is gone opens on the primary one.
- Desktop: `F` shows the preview full screen, in the project window or a detached one; the transport shows while the pointer is over it, and Escape leaves.
- Desktop: each terminal tab moves to its own window and back (#166, ADR 0012), for an agent on a second monitor. The button in the terminal header opens the active tab's window; "Dock terminal back", closing the window, or "Bring back" returns it. The shell keeps running through the move and the screen comes along: main keeps each terminal's recent output (about 10,000 lines, at most 4 MiB) and replays it into the view that shows it next. Closing a project still ends its terminals, so it reopens with them docked.
- Desktop: the timeline, the editor and each sidebar view (Explorer, History, Plugins) move to their own window and back too (#167, ADR 0012), each with the button in its header. The editor moves with every open file: unsaved edits, undo history and the caret come along. Like the preview, they open detached again with the project.
- Desktop: Cmd/Ctrl+Shift+Enter maximizes the panel holding the focus (else the one last clicked) inside the project window; the same keys restore the others. Hidden panels stay mounted: terminals keep running.
- Desktop: "Ask agent" types into the last focused terminal running an agent, in any window of the project, else the last focused terminal, and flashes its tab. A terminal window behind others is not raised.

### Changed

- Desktop: a terminal's shell no longer ends when its view goes away, only when its tab is closed or its project window closes.

## [0.5.0] - 2026-10-12

Pick and inspect (ADR 0011): point at a pixel of the preview and the agent gets the clip and the HTML or React element there; the agent can ask the same itself with `frameshell inspect` / MCP `inspect_point`. `@frameshell/hyperframes` and `@frameshell/remotion` 0.3.0. A plugin's version is part of the clip render cache key, so existing `hyperframes` and `remotion` clips render once more after the update.

### Changed

- Desktop: "Select region" is now the Pick tool (`I`): a drag still selects a region; a click picks a point. Plain clicks on the paused preview select the picture seen at that pixel, so transparent parts of an overlay let the click through.
- `PROTOCOL_VERSION` 32 (from 29): the app, the CLI and the daemon must be of this release.

### Added

- `frameshell inspect --at <s> (--point x,y | --px X,Y) [--json]`, MCP `inspect_point` and daemon `inspect.point` (#164, ADR 0011): what a point of the frame shows, with the app closed. The clips under it come from the export placement, topmost first, and the target is the one seen there. In a generated clip, the DOM element painting that pixel comes from its live page, loaded in managed headless Chrome (DevTools protocol over a pipe, no new dependency) and probed with the app's Pick script, adapter facts and `generated` included. Elements need a trusted project; footage counts as painting its whole box. Agent skill updated.
- `ui_select` takes `points` (`{ at, x, y }`): the daemon inspects each one and the app shows them as the agent's picks, outlined, with the playhead at the first, so the agent can show the user what it understood. `ui_state` reports picked `points` (clip and element at each). `PROTOCOL_VERSION` 32.

- Plugin API: `frameshellLive` in a live page's `head` may define `describe(element)`, returning facts about a picked element the DOM does not hold: `source` (the file it comes from) and `components` (the components rendering it, outermost first). The app adds them to the pick under the element's `adapter` (#163, ADR 0011). Additive: `apiVersion` stays `1`.
- `@frameshell/hyperframes`: `describe` names the file a picked element comes from, its `data-composition-src` sub-composition or the composition itself, project-relative.
- `@frameshell/remotion`: `describe` names the React components rendering a picked element, outermost first (at most 8, innermost kept), from React's fiber on the DOM node.
- Desktop: a picked element whose id, classes and text all occur nowhere in its source file is marked `generated` (created by a script: GSAP, bindings). Its point line says `(created by a script)`, `in <file>` when the file is not the clip's source, and `react A > B` for Remotion components. Agent and adapter skills updated.

- Desktop: the Pick tool (#162, ADR 0011) replaces "Select region" (transport button, or `I`; it pauses). Hovering outlines what the pointer is on, as a browser inspector does: in a generated clip, the composition element painting that pixel (its live page probed in an invisible frame, also when the render is ready), else the clip's picture; ↑/↓ move the outline to the element's parent and back. A click picks that point, Shift+click adds more (each keeps its time), a drag selects a region as before and now also finds up to 10 elements inside it. Escape clears the pick, then leaves the tool. Transparent parts of a page let the pick through to the layer below. In an untrusted project, or for a clip without live preview, Pick names the clip and says why it has no element.
- Ask agent: one `[frameshell] point` line per picked point, naming the clip seen there with its source, the element (short selector and text) and the layers under it, a frame capture per time, and a details file (`.frameshell/context/e_<frame>_<n>.json`: full selector, tag, classes, text, box in project pixels, computed styles, HTML snippet, data attributes, ancestors, layers). A region with elements gets a details file too. Agent skill updated.
- Live page bridge: element probes (`probe`, `probeRect`), answered after the pending seek. The probe script is shared as `@frameshell/protocol/probe`.
- Daemon method `context.write` (app only, no CLI command or MCP tool): writes an Ask agent details file under `.frameshell/context/`. `PROTOCOL_VERSION` 31.

- Desktop: a click on the paused preview selects the clip the user sees at that pixel (#161, ADR 0011). Transparent parts of an overlay let the click through to the picture below: the preview engine reports each picture's alpha at the point (render and proxy alpha planes, still images), and a layer fainter than 5 % there (alpha × opacity) does not count. A generated clip whose render is not ready yet can be clicked and moved too: it covers the project frame, as its render will. A click on the selected clip's handles without dragging picks again, so a layer above it can be selected.
- Ask agent: a preview region's line names the clips whose picture meets it, topmost first (`clips c_0100, c_0002`). While a generated clip's render is queued, rendering or failed, the line says `frame pending` and is typed at once instead of waiting for the frame capture. Agent skill updated.
- `ui_state` (MCP) and daemon `ui.state`: `selection.region`, the rectangle drawn on the preview with its time and the clips under it. `PROTOCOL_VERSION` 30.
- `gc`, and the sweep when the daemon opens a project, delete Ask agent captures in `.frameshell/context/` older than 7 days (kind `context`).

## [0.4.0] - 2026-10-11

`@frameshell/hyperframes` and `@frameshell/remotion` 0.2.0. A plugin's version is part of the clip render cache key, so existing `hyperframes` and `remotion` clips render once more after the update.

### Added

- `frameshell doctor` says which `frameshell` the shell's PATH runs and whether it is the CLI running now (#142): the link and its target, the Frameshell app it belongs to and that app's version (read inside `app.asar` too, so an npm or source CLI can tell), a note when they differ, when the app it points at is gone, or when there is none, with the File menu item that installs it. Notes never change the exit code. `--json` adds `command`. The CLI does this, not the daemon: only the CLI sees the caller's PATH.
- File → Install 'frameshell' Command in PATH (and Uninstall) puts the app's `frameshell` CLI on the system PATH, so any terminal and MCP client can run it (#139). macOS links `/usr/local/bin/frameshell` (native admin prompt only when the directory is not writable), Linux links `~/.local/bin/frameshell`, Windows adds the shim directory to the user PATH. The link targets the shim the app rewrites on every start, so it follows app updates. It never replaces a regular file, and asks before replacing a `frameshell` command another install owns; uninstall removes only a command of this app. Refused for an AppImage and for a macOS app running from its disk image or a translocated path, whose locations change between runs.
- CLI: `--ripple-track <track>` (repeatable) for `clip add` and `clip trim`, only with `--ripple`: the ripple moves later clips on the clip's own track plus the named ones instead of every video and audio track, as `rippleTracks` already allowed through the daemon and MCP (#131). Agent skill updated.
- Plugin API: optional `ClipAdapter.livePreview(clip, context)` returning a `LivePage` (`root`, `entry`, `head`): a page that plays the clip's composition, which the preview will show while the clip's render is not ready (ADR 0010). Additive: `apiVersion` stays `1`.
- Daemon method `clip.live` (app only, no CLI command or MCP tool): a generated clip's live page and its current render key. Error code `LiveUnavailable` (-32039) when the clip's adapter is missing, untrusted, has no live preview or fails; `OutsideProject` when the page leaves the project. `PROTOCOL_VERSION` 29.
- `@frameshell/hyperframes`: live preview of `hyperframes` clips (ADR 0010). The live page is the composition directory as it is, with the clip's props as composition variables (set only when there are some, as for a render) and the HyperFrames runtime from `@hyperframes/core`, now a direct dependency at the producer's pin (0.8.92). Seeks use the runtime's render-accurate `renderSeek`; page media stays muted, since renders carry no audio.
- Desktop: live preview of generated clips (ADR 0010). While a clip's render is queued or rendering, and the clip is the topmost picture at the playhead, the preview plays its adapter's live page in a sandboxed frame (opaque origin, no preload) over the program canvas, placed and faded like the render, and seeked to the playhead: exactly while paused, best effort while playing. A "Live, rendering 40%" label replaces the slate. A new render key (composition or props changed) reloads the page; once the render is ready the engine plays it again. Pages load from a new `frameshell-live://` scheme that serves only the page's root, with the adapter's `head` and a seek bridge inserted into the entry. Clips under another picture, or whose adapter has no live preview, keep the slate.
- `@frameshell/remotion`: live preview of `remotion` clips (ADR 0010). The live page is the clip's current bundle, put in composition mode with the composition a render would use (same input and resolved props, project fps and length, same size and scale), driven frame by frame the way `@remotion/renderer` drives it, through Remotion's internal page globals (`remotion_setBundleMode`, `remotion_setFrame`, `remotion_renderReady`). A bundle without them fails live preview with a message naming them; renders are unaffected. The page runs in Remotion's rendering environment (no sound), with a transparent body as in a render and in-memory `localStorage`/`sessionStorage`, since a sandboxed frame has none. Props are serialized as the renderer serializes them, so `Date` props stay dates. `<OffthreadVideo>` frames, which a render gets from Remotion's frame server, are decoded in the page from the same file (alpha kept with `transparent`); a remote video source must allow CORS.

### Changed

- Unpackaged (dev) builds write their CLI shim to `<userData>/bin-dev` instead of `<userData>/bin`, so running a dev build no longer repoints the installed app's `frameshell` command.
- History panel: an aborted transaction (`tx abort`, or a desktop edit refused part-way, whose own last operation undoes the rest) shows dimmed, marked "aborted", without Revert buttons, since it changed nothing (#133). `history --since` is unchanged.

### Fixed

- Linux `.deb`: `/usr/bin/frameshell` linked to the app binary, so `frameshell status` in a terminal started the app instead of running the CLI (#143). The package now installs a script that runs the bundled CLI as Node, the same command the app's per-user shim runs, so `frameshell` works right after install, before the app is first started, and `frameshell doctor` recognizes it. Removing the package removes it. File → Install 'frameshell' Command in PATH says it is already installed instead of adding a second link in `~/.local/bin`. The release workflow installs the built `.deb`, runs the command and removes the package.
- `@frameshell/hyperframes`: compositions from `frameshell hyperframes new` rendered 45 s slower than needed. They animate with CSS and register no GSAP timeline, so the producer waited its full player-ready timeout for `window.__timelines[id]` before capturing (an 8 s clip at 1440p: about 60 s, now 15 s). The scaffold's root now carries `data-no-timeline`, and the agent skill tells authors of CSS-only compositions to add it. Compositions scaffolded before keep the wait until the attribute is added.
- `frameshell --version` of the CLI bundled in the desktop app printed `0.0.0`, the unversioned CLI package's version. It now prints the app's version.

## [0.3.0] - 2026-10-10

### Added

- `@frameshell/remotion` 0.1.0, the official Remotion clip adapter (#135, ADR 0009). A `remotion` clip names the entry of a Remotion project (`source`, relative to the Frameshell project; the Remotion project may sit next to it) and a composition (`props: { composition, inputProps? }`). Compositions may import code from outside the project, such as the user's web app: the adapter bundles the entry with webpack into `.frameshell/remotion/<entry>/<content hash>/` and reports that bundle as the clip's cache input, so an edit anywhere in the bundled code re-renders, and re-bundles only when a file webpack read (or probed and missed) changed. Renders use the Remotion project's own `@remotion/bundler` and `@remotion/renderer` (the plugin depends on no Remotion package; the user's version and licence apply), the managed headless Chrome, the project's fps (same length in seconds) and resolution (a same-aspect composition is rendered at its size and scaled), VP9 WebM with alpha and multithreaded libvpx (8 s at 1440p: 13.4 s instead of 66 s with Remotion's defaults). `frameshell remotion new <name> [--duration s]` adds a composition, creating `compositions/remotion/` (pinned Remotion 4.0.527) on first use. Agent skill `remotion`. Composition audio is dropped: clip renders are video only. The Remotion project's `remotion.config.ts` applies as with Remotion's CLI (webpack/bundler override, so Tailwind via `@remotion/tailwind-v4`, and OpenGL renderer; output settings ignored), read with the project's own `@remotion/cli` internals; editing it re-renders.
- Plugin API: `PluginApi.refreshRenders()`, callable after `activate`, asks the host to re-check the render keys of the project's generated clips. The Remotion adapter calls it when a watched file outside the project changes, since the project watcher never sees those. Additive: `apiVersion` stays `1`.

### Changed

- The clip render watcher ignores `node_modules` at any depth, not only at the project root, so installing a composition's packages (`compositions/remotion/node_modules`) no longer floods render refreshes.

## [0.2.0] - 2026-10-09

### Fixed

- The Release workflow's `npm plugins` job failed when a plugin version was already on npm: npm 11 refuses `npm publish --dry-run` over a published version. `plugins-npm.mjs dry-run` now dry-runs only versions npm lacks; a published one still gets the tarball checks.
- The daemon the desktop app starts held the app's stdout and stderr on Windows (#112): a child spawned from Electron's main process inherits every inheritable handle, and Electron leaves its stdio inheritable, so whoever read the app's output (Playwright: about 3 s per `app.close()`) saw it open until the daemon idled out. The app now starts each daemon from a short-lived Electron utility process (`daemon-spawner`), which hands the daemon none of the app's handles and exits once the daemon listens; startup errors are still relayed from the daemon's stderr. The CLI and MCP server spawn as before. `connectOrStartDaemon` takes a `launch` option (`DaemonLauncher`); `spawnDetachedDaemon` and `defaultDaemonEntry` are exported from `@frameshell/cli`. New e2e `daemon-stdio` spec: the app's stdout closes with the app while its daemon keeps running.
- HyperFrames clips without `props` lost their composition's variable defaults (#116). The producer already merges `props` over the declared defaults (`{}` keeps them all), but HyperFrames reads `data-composition-variables` only as an array of `{id, type, label, default}` and silently ignores anything else, and `frameshell hyperframes new` and the `hyperframes` skill taught an object (`{"title":"Title"}`). The scaffold and skill now use the array form, and a render whose composition declares an object fails with the equivalent array to paste instead of rendering without its defaults. The clip cache key recipe is unchanged (no `CACHE_LAYOUT_VERSION` bump): the pixels for given files and props are the same as before; fixing a composition to the array form changes its content and so its key. A render cached for an object-form composition before this fix is still reused, without the error, until that composition is edited.
- Whisper could swallow a repeated phrase into one very long word, losing its words from the transcript and subtitles (#117). `transcribe` now checks every word longer than 1.5 s: when its audio energy shows speech after its first second, that span is re-transcribed alone and the words found replace it (ids follow the usual re-transcription rules). Long words close together share one window, so words spoken in the gap between them are recovered too; window words that repeat a neighbour (the previous word's tail, the next word heard before its onset) are dropped, so no word appears twice. A long word filled with silence is left alone: that is a pause, still safe to cut. A long word with speech inside that the window cannot split is written with `speechInside: true` (new optional transcript field), listed in the `transcribe` result's new `speechInside` (next to `recoveredWords`), printed as a warning by the CLI, and underlined in the transcript view. The skill's "silence hidden in a word" rule now forbids cutting inside such a word, and says shorter long words (under 1.5 s) are not checked. Protocol version 26.
- Words recovered from a long word came back lower case and without punctuation (#123): whisper decoded the window alone, with no text before it, so the #117 retake read "incluido aquella semana otra vez el cierre…" and subtitles showed one run-on sentence. Each window is now prompted with the 40 words before the long word (never the long word itself, which whisper would then skip as already said): on the #28 recording it reads "incluido. Aquella semana, otra vez. El cierre de mes ya está sumado. La obra en marcha". Plugin API: `TranscribeOptions` gains optional `prompt` (decoding context, never part of the result; providers without such a feature ignore it); `@frameshell/whisper-cpp` passes it as `--prompt`.
- `transcribe --verify` reported fully audible words as `lost` (#115): whisper sometimes skips a phrase in a long pass that it hears in a short one, and any word missing near a cut counted as lost, even one whole inside its clip. A word missing at a cut is now re-transcribed in a window of export audio (5 s each side, nearby words share one window) before it is reported. Heard there: confirmed. Still missing: `lost` only when the cut falls inside it (`clipped: true`); a word whole inside its clip goes to `uncertain` as `unheard`. The skill now says `clip trim --ripple` fixes only `lost`, never an `uncertain` word.
- Media assets with alpha played opaque in the preview while export kept their alpha (#90): every proxy was H.264, which has no alpha plane. Ingest now detects alpha (VP9/VP8 `alpha_mode=1`, decoded with libvpx so the alpha survives, or an alpha pixel format such as ProRes 4444 or QuickTime Animation) and builds a VP9 WebM proxy with its alpha plane instead (`alphaProxyArgs`, same CFR grid, scale, BT.709 tags and GOP 15 as the H.264 proxy, no audio: the preview plays the PCM sidecar). The preview indexes it from its head and Cues and reads it by byte ranges like MP4 proxies (`openWebmProxy`, `readWebmProxy` in `preview/webm.ts`), then decodes colour and alpha with the clip-render path (ADR 0002). Opaque assets keep the H.264 proxy. `RECIPE_VERSION` 3: existing proxies are rebuilt once. E2e frame compare against `frameshell frame` (`alpha-media.spec.ts`).
- Fresh clones could not start the desktop app (#114): Electron 44 downloads its binary on first `require("electron")` instead of at install, and `electron-vite preview`/`dev` never require it, so `pnpm --filter @frameshell/desktop start` failed with `Electron uninstall` (e2e passed because Playwright requires it). The desktop postinstall now requires it once.

- CI stability, three real bugs (#109). **Windows edits could fail with `EPERM` on rename**: Windows refuses to replace a file another handle has open (the daemon's own reads, a client, an antivirus scan), so an atomic write of `timelines/main.json` failed when a read overlapped it. Every rename-based writer (`writeTextAtomic`, ingest outputs, exports, frames, transcription audio, binary installs, desktop layouts) now goes through `renameRetrying`, which retries `EPERM`/`EACCES`/`EBUSY` with backoff for up to 3 s on Windows only; each atomic write also has its own temp file, so concurrent writes of one path (a panel drag saving the layout) each land whole instead of failing with `ENOENT`/`EEXIST`. **`frameshell import --wait` could hang forever** (the Linux `import-cli` timeout): a job finishing while the daemon wrote a `job.list` reply sent its `done` event before that reply, and the follower then took the older "running" snapshot as the latest; it no longer moves a job back to an earlier state (reproduced in-process: 60 of 300 cached re-imports hung before, 0 after). **The desktop app could hang on quit on Windows** (the `launch.spec` timeout plus "error not part of any test"): node-pty kills a shell that has not printed yet only once it prints, and an app closed within that moment reached exit first and hung with the pseudoconsole open; the app now quits only once closed windows' shells have exited (bounded at 5 s).

- Desktop start-up on a loaded machine (flaky `subtitles` and `layers` e2e specs under load, #103). The window loaded its page only after the `--project` open, so a cold daemon kept it blank; it now loads at once and shows the boot screen while the open runs, and every project IPC call (files, media, timeline, history, terminals, layout) waits for that open instead of failing with "No project is open in this window". The app's daemon link now waits up to 60 s for a spawned daemon to listen (the CLI keeps 10 s): under synthetic load a cold daemon took 29 s, so the app showed the welcome screen with an error, and its retry started a second daemon competing for the same CPU. E2e harness: `launch` resolves once the startup open settled (60 s bound, apart from assertion timeouts), and closes the app when its window setup fails instead of leaking it into the next spec; `runInTerminal` types only once the shell drew its prompt (a login shell still starting reordered typed keys, seen once in `timeline.spec.ts`).
- Preview could drop video frames when a proxy read came back late (#105, ADR 0001 thresholds 1 and 3). A layer's decoder read the next 30 proxy pictures only when it needed the first of them, with 12 decoded frames (0.4 s) kept ahead. So any `frameshell-media://` range read slower than that starved the picture, inside segments and at cuts, where the new clip's first read and its pre-roll decode shared the same 0.4 s. The engine worker now reads encoded pictures up to 90 ahead of the decoder (about 3 s, `preview/read-ahead.ts`), across cuts. With every 4th proxy read delayed by 600 ms (quick measurement, quiet machine), frames the engine never drew went from 168 to 0 and frames dropped at cuts from 44 to 0. Busy-loop CPU load alone (12 or 32 loops) dropped no frame before or after the change. A full 200-cut run on a quiet machine passes all six thresholds (0 of 28,445 interior drops).
- Preview audio could play late for a whole playback, and the ADR 0001 audio threshold failed now and then on the same code ("deviating samples": 551 in one full run, 98 % in another). At start-up under load (reproduced with a second app starting at the same time), Chromium renders quanta of the AudioContext without calling the worklets' `process()`, while `currentFrame` still advances. The program mixer and the probe recorder counted `process()` calls from the first `currentFrame`, so they fell behind the context clock for good: by 1,408 and 7,296 frames (up to 152 ms) in measured runs. The program audio played that much after the picture, and its last samples were cut at the end. The recorder fell behind with the mixer, so the harness saw only the cut tail, unless it started after the skip (then almost every sample deviated). Both worklets now take each quantum's frame from the new `QuantumClock`: their own count, but never behind `currentFrame`. A stale `currentFrame` still never repeats a block. The recorder ends a block at any hole, so the harness sees quanta the graph skipped during playback.
- Connecting could fail after 10 s with "frameshelld did not start listening" when the daemon the client had just spawned stopped on its idle timeout before the client's next poll (flaky Windows `daemon-client` test, about 40% of CI runs, #97). The client took every exit 0 for a lost start race and kept polling an empty socket. It now wakes on the exit, spawns the daemon again when nobody listens (at most 3 daemons per connect), and polls at most every 100 ms instead of 250 ms. Also: a terminal's agent was missed for good when the desktop app looked at a Node CLI (`claude`, `codex`) before it set its process title (flaky macOS `terminals` test); a foreground found not to be an agent is now looked at again for 5 s.
- CLI calls could fail with "frameshelld closed the connection" (or `EPIPE`) when they reached the daemon as its idle timeout stopped it (flaky `snap-cli` and `timeline-cli` tests, #79): the stopping daemon resets connections still in its accept backlog, unanswered. `connectToDaemon` now rejects a drop before the handshake reply with code `ECONNRESET`, which `isDaemonUnavailable` accepts, so `connectOrStartDaemon` (CLI, MCP server, desktop app) starts a fresh daemon and retries. The handshake is idempotent.
- `frameshell import --wait` could print ingest steps twice (an extra `starting`, `hash` pair, #79): the daemon sent a project's first `job.progress` and `asset.changed` events only after an async `realpath`, so a `job.list` reply could overtake them. The event key is now resolved synchronously (memoized per project): each event is written in the same tick as its change, before any reply that shows the change.
- Status and journal robustness (#76, SPEC §6.2, §6.4). `status` (and `status --json`) now reads refused direct edits back from disk (`.frameshell/rejected/` plus details in `.frameshell/rejected.jsonl`), so they survive daemon restarts until the kept file is deleted; a kept file with no recorded details is listed with reason `unknown`. `status` also lists open explicit transactions (label, author, session, operations, timelines, age), with a hint to end one left by a closed shell via `FRAMESHELL_SESSION=<session> frameshell tx commit|abort`. `file.write` of a timeline is journaled as the caller's operation (`ui` for the desktop editor) instead of `file`; edits the watcher finds stay `file`. Each journal now keeps a head snapshot (`.frameshell/history/<timeline>.head.json`): when a project opens, a timeline edited while no daemon ran is journaled as a `file` operation on top of it, so `revert` works across it (content breaking a timeline rule is rejected and kept, as for live edits). Protocol v17.
- Desktop explorer on macOS could miss a file change made right after a project opened (about 1 in 50 opens under load; flaky test #53). libuv rebuilds its shared FSEvents stream asynchronously after each new directory watch, so the watcher reported ready before the OS delivered events. Opening a project now waits until a probe folder in the OS temp dir, watched after the project folders, gets an event (best effort, 5 s cap; immediate on Linux and Windows).

### Changed

- Generated clips are composited in the preview engine, and nested ones play (#98, SPEC §3.4, §6.5, ADR 0001, ADR 0002). The engine worker now demuxes cached VP9-alpha clip renders (`preview/webm.ts`, alpha plane from BlockAdditions, BT.601 limited range when untagged, as export's ffmpeg reads them) and decodes them with WebCodecs like proxies, the alpha plane in a second software decoder, then draws them on their track's layer with the other layers: a generated clip under media on a higher track is hidden in the preview exactly as in export (e2e frame compare against `frameshell frame`). The page `<video>` layers over the canvas are gone; only render slates (state and live progress) stay above the picture. `clip.renders` now reports generated clips inside nested timelines too, by flattened id `<nested clip>/<clip>` on the root track (flattened like export), so they play instead of showing "Waiting to render". Protocol v25.
- One user-directory resolver, `resolveAppDirs()` (now in `@frameshell/protocol`), for the binary manager, the plugin trust store and the desktop app. Data (binaries, downloads, caches, desktop app data under `<dataDir>/desktop`) and config (global `config.json`, `trust.json`) follow OS conventions; overrides are `FRAMESHELL_DATA_DIR` and `FRAMESHELL_CONFIG_DIR` only (`FRAMESHELL_APP_DATA`, `FRAMESHELL_USER_DATA_DIR` and `resolveAppDataDir` removed). Linux trust decisions stored in the data dir by earlier builds are still found and move to the config dir on the next decision. `startDaemon` takes `dirs` instead of `appDataDir`. New "Real binaries" CI workflow downloads and runs every pinned ffmpeg/ffprobe build (weekly, on dispatch, and on PRs touching the binary manager); the opt-in real-download test now encodes and probes H.264 and VP9-with-alpha clips.
- Transcript view (#118). **Restoring no longer opens gaps on other tracks**: a restore used to ripple every video and audio track, so restoring a voice-only cut left black on the footage track and silence on the music track. It now moves only the restored clip's track and the tracks whose later clips it can move without pulling them away from a clip they touch; the others keep their timing and the status line names them, so the user can check their sync. New optional `rippleTracks` on `clip.trim` and `clip.add` (with `ripple: true`; the clip's own track always moves; default every video and audio track, as before). Protocol v26. **Whole passages in one step**: a ↺ button before each cut passage of two or more words, a "Restore N cut words" toolbar button for the struck words a drag spans, and "Restore cut passage" in a struck word's context menu bring the words back as one edit per run, one transaction, one undo step. **Word corrections**: double-click a word, F2 on one selected word, or "Edit text…" in the context menu edits its text in place; it is saved as the transcript's `edits` entry (subtitles and `transcribe --verify` read it), and clearing it goes back to the transcribed text. **Easier to find**: View > Transcript (Cmd/Ctrl+Shift+T) and a "Transcript" button in the timeline header open the view.

### Added

- Cleanup of unused derived media (#52): new `frameshell gc [--dry-run] [--json]` and daemon method `gc` (MCP tool `gc`). It deletes regenerable files under `.frameshell/` that nothing uses any more: proxies, PCM sidecars, manifests, waveforms, thumbnails, energy envelopes and transcription WAVs (`.frameshell/cache/audio/`) of content no file has now (deleted or replaced assets, an older recipe, another fps), keyed by the media index (files whose content is not known yet are hashed first; index entries of vanished files are dropped); clip renders no generated clip of any timeline keys (nested ones included); and temps of interrupted jobs, export verifies and long-word re-transcriptions (`.frameshell/cache/transcribe/`) older than an hour. Alpha proxies (`.webm`) count as proxies. It never touches `assets/`, project files, history or rejected edits; keeps a key whose ingest is building or whose clip render is pending; leaves the clip cache alone while a clip render or export runs, or when a clip cannot be keyed (plugin missing or untrusted, invalid timeline), transcription WAVs and verify temps while a transcription or verify of the project runs, and job temps while any job of the project runs (`skipped` says why). Opening a project also sweeps unused derived media older than 7 days, without hashing and only when every file's content is known. Protocol v26.
- Official plugins publish to npm (#54, SPEC §8.3), so `frameshell plugin install @frameshell/whisper-cpp` and `@frameshell/hyperframes` work outside the repo once the `@frameshell` npm org exists and each package has the Release workflow as its npm trusted publisher (no npm token or secret). Publishing a reviewed draft release (`release: published`) runs the new `npm plugins` job of the Release workflow: `scripts/plugins-npm.mjs publish` packs each plugin with `pnpm pack` and publishes, with npm trusted publishing (OIDC) and provenance, every version npm lacks (prereleases to the `next` dist-tag); nothing is published from a tag alone. Each plugin keeps its own semver version, equal in `package.json` and `frameshell-plugin.json`. Both packages gained `publishConfig` (`access: public`, `provenance: true`), `repository` with `directory`, `homepage`, `bugs`, `keywords` and a README. `plugins-npm.mjs verify` (part of `pnpm test`) checks those fields; `dry-run` packs, checks each tarball's contents and runs `npm publish --dry-run`, on every pull request (`ci.yml`, Linux) and every Release run. Setup and checklist: `docs/release.md`, "npm plugins".
- `frameshell plugin install` accepts a local tarball made by `npm pack`/`pnpm pack` (#54): `./name-1.0.0.tgz`, `file:<path>` or a `file://` URL, relative to the caller's directory. It pins `file:<path>#sha256=<digest>`, always project-relative: a tarball from outside the project is copied to `vendor/<file>` first, never over a copy with other content: a rebuild with the same file name goes to `vendor/<stem>-<digest>.tgz` (ADR 0008). Installing a tarball replaces the pin of its package, read from its `package.json` before npm runs, even when the pinned file is gone or changed (#125); a `.tgz` that is not an npm package is refused before npm runs, installs through npm and, like every install, trusts the resulting plugin list. Every later install from the pins checks the digest first: a tarball whose bytes changed (a pull, a swap) is never installed, the plugin reports the mismatch, so trust always covers the code that runs. Directories and remote tarball URLs stay refused (`InvalidPluginSpec`, now naming `npm pack`), as does a missing file. The official plugins install this way before they are on npm (`docs/release.md`, "Without npm"). `plugin.install` description and the agent skill updated.
- Agent context in the app (#120). App terminals now find the ffmpeg, ffprobe and whisper-cli the daemon runs: each installed one (managed download under `<dataDir>/binaries`, or a `binaries` override from `frameshell.json` or the global config) has its path in `FRAMESHELL_FFMPEG`, `FRAMESHELL_FFPROBE`, `FRAMESHELL_WHISPER_CLI`. Managed downloads also get their directory on `PATH` after the CLI shim; overrides never touch `PATH`, so they cannot reorder it or shadow the user's commands. Located when the terminal opens, never downloaded. New `@frameshell/core/binaries` export (the binary manager). The `frameshell` skill gains "In the app: what the human sees": struck words in the transcript view and how to open it, the timeline after a cut, the History panel, and those terminal tools.
- Timeline UI editing (#119, SPEC §6.2, §10). **Labelled history**: every timeline panel, inspector and transcript edit is now one `ui` transaction with a label (`Move clip`, `Ripple trim clip`, `Split 3 clips`), so `history --since` reads as what the human did; a gesture burst shares one, so a held or repeated `,`/`.` nudge of the same clips is one entry (`Nudge clip`) and one undo step instead of one per press. The burst's transaction stays open up to 1.5 s after its last press and closes before any other edit, undo, redo, History revert or editor save (`TimelineEditor.alone`). Renderer API `timeline.edit` takes `{ label, burst }`. Rapid nudges now build on presses still in flight, so a held key moves a frame per press instead of repeating the first target. **Edit menu Undo and Redo** (Cmd/Ctrl+Z, Cmd+Shift+Z or Ctrl+Y) undo the timeline wherever focus is, except in text fields, which keep their own undo; the keys work anywhere too, not only with the timeline focused. **Ripple trim**: the new toolbar toggle (R) makes edge drags `clip.trim` with `ripple`, so later clips follow and no gap is left; Shift when pressing an edge inverts it for that drag (Shift+click on an edge still toggles the selection). A ripple head trim's ghost keeps the clip's left edge, as the daemon does, and the tooltip shows the source-in change. **Multi-select moves**: dragging one of several selected clips moves them all by the same shift, each on its own track, as one step (`Move 2 clips`), with a ghost per clip; a drop where any of them would overlap sends nothing and says so. Cmd/Ctrl+A on the lanes selects every clip. **All-or-nothing edit calls**: when the daemon refuses one edit of a multi-edit call (a group move, a split of several clips), main now undoes the call's earlier edits (`tx.abort`) instead of keeping them; undo skips the aborted entry. Quitting waits up to 500 ms for an open nudge burst to commit before closing the daemon connection.
- Agent skills (#26, SPEC §8.2, §11). New `frameshell` agent skill in `skills/frameshell/`: project model, work loop with transactions, resuming from the human's edits (`history --since`), transcript-driven editing (snapped cuts, retakes, subtitles, export, `transcribe --verify`), every CLI command, CLI or MCP, frame capture to check visual results, `[frameshell]` selection lines and `ui_state`/`ui_*`. `frameshell init` installs it into `.claude/skills/frameshell/` (asked on a terminal, installed otherwise; `--no-skill` or `project.init` `agentSkill: false` leave it out; an existing one is kept); it is bundled into `@frameshell/core` by `pnpm gen:skill`, and a test fails when the bundle drifts. `frameshell plugin install` links each skill a plugin ships into `.claude/skills/<name>` (relative link, a junction on Windows), `plugin remove` and a trust denial unlink them, a fresh plugin load relinks them, and entries the user owns are never touched; `plugin.install` returns `skills` and `warnings`, `plugin.remove` returns `skills` (protocol v25). A test fails when a skill names a CLI command, flag, MCP tool, resource or error code that does not exist, or when the core skill misses a command (`cliCommands()`, `RESOURCE_TEMPLATES`). Built-in commands now reject flags they do not take instead of ignoring them. Opt-in eval `evals/agent-skill/case-b.mjs`: a fresh `claude -p` session with only the skill must complete Case B on a fixture recording.
- Desktop "Ask agent" (#49, SPEC decision 21, §10): Cmd/Ctrl+L or the new context menu types a `[frameshell] …` reference of the selection at the active terminal's prompt, unsent (plain text, bracketed paste when the program asks for it; control characters stripped), one line per item: transcript words as subtitle lines (timeline times, clip, word ids), clips, a History pick, a timeline time range (drag over empty lane space), explorer files (click an asset, Cmd/Ctrl-click or right-click any file), the script scene under the caret, and a preview region. The preview's region tool draws a rectangle; its reference carries normalized coordinates, the timeline time and a frame capture rendered by the daemon's `frame` method into `.frameshell/context/f_<frame>.png`. All kinds live in the one selection store. Ctrl+L inside a terminal stays clear-screen on Linux and Windows.
- Agent-labelled terminals, and word clicks seek during playback (#89, SPEC §6.2, §10). The desktop app watches each terminal's foreground process (`ps`, once a second; macOS and Linux) and, when it is an agent CLI (Claude Code, Codex, Gemini CLI, Aider, OpenCode and others, matched by program or script name; `FRAMESHELL_AGENT_COMMANDS=name=label,…` adds, relabels or with `name=` removes commands), names the tab after it and tags the terminal's session in the daemon with the new internal registry method `session.tag` (the `DaemonLink` tags again after a reconnect: tags last as long as the connection that set them). Operations of a tagged session are journaled as `agent:<label>:<session>`, and the History panel shows them as `agent: <label>` with the session; they still group into the session's transactions, so `tx commit` from the same shell works after the agent quits. `FRAMESHELL_AGENT=<label>` names the agent for the CLI and `frameshell mcp` (new handshake param `agent`; empty = not an agent, overriding detection), also on Windows, where there is no detection. `status` reports the caller's `agent`. Clicking a transcript word while the preview plays now seeks the playhead to it and plays on; selecting a script heading or History row still never moves a playing playhead. Protocol v21.
- MCP UI state and navigation (#33, SPEC §7b): new registry methods, so MCP tools, `ui_state`, `ui_seek`, `ui_play`, `ui_pause`, `ui_select`, `ui_open_file` and `ui_show_tx_diff`. `ui_state` reports the app's playhead, play state, selection (clips, transcript words, time range, History entry marked), editor tabs and the timeline seconds visible, or `{ connected: false }` without the app; a selection made in the app reaches it within 200 ms. Navigation is brokered by the daemon (`UiBroker`) to the window that last reported, answered with the window's new state; new error codes `UiNotConnected` (-32036) and `UiCommandFailed` (-32037), internal methods `ui.publish`, `ui.reply`, `ui.detach` and notification `ui.command`. The shared selection store gains origin `agent`, a whole-selection `select` (words given by id are read from their transcript files, as the transcript view selects them); a paused playhead moved off screen now scrolls the timeline to it; the status bar briefly says what the agent did. MCP tool names are snake case (`ui.openFile` → `ui_open_file`). Protocol v22.
- Subtitle tracks (#22, SPEC §3.4, §3.5, §5.3). A subtitle track shows the transcript words whose midpoint a clip of its followed video or audio track keeps, mapped through the clip's start and speed to timeline frames, with the transcript's `edits` applied; it copies no words, so a cut removes its words with no extra edit. One pure definition in `@frameshell/schema/subtitles` (words, cues, presets, layout) drives both sides. Style presets: `big-keyword` (default: up to three large upper-case words, the word being spoken highlighted in yellow, low in the frame) and `plain` (sentence-length lines, no highlight); `position` top, center or bottom. Export burns them with libass: the compiler writes one ASS script laid out like the preview, with event edges on the exact frames ffmpeg's truncated millisecond clock shows (goldens updated), shifted to timeline time per segment and in `frame` captures, and the bundled face Archivo Black (OFL-1.1, npm `@expo-google-fonts/archivo-black`) copied into the work dir so every OS draws the same glyphs; a followed asset with sound but no transcript is named in `warnings`. The preview draws the same cues on a canvas over the picture, synced to the shared playhead, with the same face; an e2e test compares preview and `frameshell frame` pixels and the highlighted word's place frame by frame. New registry method `track.set` (also an MCP tool) changes a track's `name`, and a subtitle track's `follows` and `style` field by field; `track.add` takes `style`; `timeline.show` and `track.list` report it. CLI: `track add … --preset --position`, `track set <track> [--name | --clear-name] [--follows] [--preset] [--position]`. Desktop: subtitle lanes show their cues; clicking a cue selects its words (the shared selection store gains a `track`), clicking a lane head selects the track; the inspector under the preview sets its followed track, preset and position; a timeline button adds a subtitle track following the selected clip's (or the first transcribed) track. Each is one undoable `ui` operation (`track.add`, `track.set` join the app's allowed edit ops). The transcript files feed is now one shared store. Protocol v23.
- HyperFrames clips and the clip render cache (#24, SPEC §3.4, §3.5, §6.5, §8, ADR 0002). New official plugin `@frameshell/hyperframes` (`plugins/hyperframes`): clip type `hyperframes` whose `source` is a composition's HTML entry and whose `props` are composition variables; it renders in-process with `@hyperframes/producer` 0.8.92 to VP9 WebM with alpha, using the managed ffmpeg, ffprobe and headless Chrome; every file of the composition directory is a cache input; a `source` that is absolute or resolves outside the project (through `..` or a symlink) fails the render instead of listing or copying outside files. `frameshell hyperframes new <name> [--duration s]` scaffolds a transparent composition at the project resolution; the plugin ships a `hyperframes` agent skill. The daemon renders every generated clip in the background into `.frameshell/cache/clips/<key>.webm`, keyed by plugin name and version, clip `source` and `props`, the content of the adapter's declared inputs, and project fps and resolution (moving or trimming never re-renders); timeline changes and file edits under the project (a watcher) re-render only affected clips, on a dedicated one-at-a-time `clip` job queue whose progress arrives as `job.progress`. New registry method `clip.renders` (MCP tool `clip_renders`) reports each clip's state (`ready`, `queued`, `rendering`, `failed` with the adapter's error, `unavailable` with the fix) and cached file; new error code `ClipRenderFailed` (-32038); job kind `clip`, steps `render` and `clips`. Export and frame capture composite a generated clip's render like footage, on its track's layer with its `transform` and alpha (libvpx decode); a render job waits for pending clip renders first (step `clips`). The plugin API's `RenderContext` gains `signal`, `ensureBinary` and `progress`. The binary manager pins Chrome for Testing 154.0.8037.57 `chrome-headless-shell` (macOS arm64/x64, Linux x64, Windows x64; installed on first render, whole directory) and extracts zip archives itself on Linux. The desktop preview plays cached renders in page layers over the engine's canvas (so above media of higher tracks), placed with `layerRect` and slaved to the shared playhead, with a slate and live render progress while one is pending; `frameshell-media://` also serves `.frameshell/cache/clips/`. Protocol v24.
- Multi-clip timeline edits are one undo step, and edit requests are idempotent (#82). A command that changes several selected clips (split, trim, nudge, delete, ripple delete) is one `ui` transaction labelled like `Split 3 clips`, so Cmd/Ctrl+Z undoes all of it; the header says `… of 3 clips saved as one step`. The first edit the daemon refuses stops the rest; what applied stays as one step. New `tx.begin` param `autoCommitAfter` (seconds): the daemon commits the transaction itself once its author is quiet that long, also across daemon restarts, so an app that crashes mid-batch (15 s) never leaves a `ui` transaction absorbing later edits; the app's timeline editor also commits any `ui` transaction left open before its first edit or undo after a start or a lost commit, since each `ui` operation joining it would push that countdown back. Registry methods that change a project or daemon state are flagged `mutating` and accept `params.idempotencyKey` (split off by the new `parseRequest`, kept out of MCP tool schemas; `RequestOptions.idempotencyKey` on the client): the daemon remembers recent keys per author for 10 minutes and answers a replay with the first result, waiting for it when still running, instead of applying twice; a failed request's key is forgotten, and a key reused for another request is refused with InvalidParams. The desktop `DaemonLink` sends a fresh key with every mutating call and reuses it on its retry after a transport failure. Renderer API `timeline.edit` now takes a command's edits. Protocol v18.
- History panel (#18, SPEC §6.2, §10): the desktop sidebar's History view lists the main timeline's transactions newest first, by author (you, a terminal session `cli:<session>`, a direct file edit, a plugin), with label (or what its operations did), operation count and time, live on each daemon `timeline.changed`. Selecting a transaction or one of its operations selects it in the shared selection store (new origin `history`): the clips it left are selected and revealed, and the timeline marks what it did (removed clips as dashed ghosts where they were, added, moved and otherwise changed clips framed, each with a glyph tag; a header legend counts them and clears them). Revert undoes a transaction or a single operation of any author as a `ui` revert; a refusal lists the later operations to revert first. New registry method `history.diff` (also an MCP tool) reports each clip a transaction or operation added, removed, moved or changed, with its track, start and end right before and after it; new error code `HistoryUnavailable` (-32035) when the file changed outside the journal since then. Protocol v19.
- Transcript view in the desktop app (#21, SPEC §10): a Transcript editor tab (button after the last tab, or open a `transcripts/*.words.json` from the explorer; "Open JSON" opens the file itself) shows the words of every asset the main timeline plays, in source order, with a timecode per paragraph. The word under the shared playhead is underlined as it plays. Words no clip keeps (midpoint rule of `transcribe --verify`) are struck through, and clicking one restores it as one `ui` operation, undoable from the timeline: the clip before it grows over it, or the clip after it grows back, when no other cut word lies between; otherwise just the word's range is inserted after the clip before it. Edges are requested mid-gap and snapped to audio energy (ADR 0003) only inside that gap (between the word and its neighbours, never over source another clip plays), so a restore in continuous speech, whose gaps are shorter than a pause, still brings back that word and only it; the view checks the new revision keeps the word and undoes the edit otherwise. Clicking or dragging over words selects them in the shared selection store (new `words` and `range` kinds, origin `transcript`, re-placed or pruned on every revision); the timeline tints the range and the playhead jumps to it. A notice flags transcripts whose asset changed since. Daemon: `clip.trim` and `clip.add` take `ripple: true` (the inverse of `cut`: later clips on every video and audio track move by the length added), and `clip.add` takes `snap`/`snapWindow` for media in/out; both take `snapBounds` (`{ in?: { min, max }, out?: { min, max } }`, source seconds) to fence where a snapped edge may land; CLI `--ripple` on `clip trim`/`clip add`, `--snap` on `clip add`; protocol v20. The app may now send `clip.add`.
- Overlays and audio tracks (#17, SPEC §3.4, §3.5, §5.3): every video track is a layer, bottom first, placed by its clips' `transform` (fitted like the base, scaled about the center, offset in project pixels, opacity) with one shared definition, `layerRect` in `@frameshell/schema/composite`. Export stops refusing extra video tracks: the compiler overlays upper tracks and transformed base clips (scaled to their rect, opacity as alpha, padded with transparent frames so they line up frame by frame, VP9 decoded with libvpx per ADR 0002) and mixes the sound of every track (new golden `overlay-plan.json`); `frame` captures the composited frame. Nested timelines are flattened before compiling and in the preview (`flattenTimeline`: nested tracks become the host clip's slot and layers above it, transform and gain composed, ids `<nested clip>/<clip>`); an unreadable nested file is refused by name. The preview worker runs one decoder per layer and composites them on the audio clock (a frame shows only once every layer has its picture); still images (PNG with alpha, JPEG, …) draw from `assets/`, now served by `frameshell-media://` for image types only; every track's sound still mixes in the one AudioWorklet (ADR 0001). A click on the picture selects the topmost layer's clip (selection origin `preview`); the selected clip gets move and scale handles; a clip inspector under the preview sets X, Y, scale, opacity, gain and mute (type, arrow keys, or drag the label). Each change is one undoable `clip.set` by `ui` (`clip.set` joins the app's allowed edit ops). Audio clip waveforms scale with gain and flatten when muted; clip labels list gain, mute and transform. The proxy recipe now tags BT.709 limited range (`RECIPE_VERSION` 2: proxies rebuild once) so the browser shows the colors export renders; an e2e test compares a preview frame with `frameshell frame` for an overlay composition. `ExportSource.video` carries `width`/`height`; `RenderInput` and `FrameInput` take the project `resolution`. Not covered yet: alpha of VP9 media assets in the preview (their H.264 proxy is opaque; export keeps it), and group opacity of a nested timeline (opacity multiplies per layer).
- Preview player for media clips (#15, SPEC §3.4, ADR 0001): the desktop preview plays the main timeline's first video track from CFR proxies and the sound of every unmuted media clip (all tracks, clip gain applied) from PCM sidecars, with the same frame and sample timing as export v1. A Worker decodes with WebCodecs `VideoDecoder` from the keyframe before each in-point (pre-roll dropped, about 12 frames decoded ahead) and draws to an `OffscreenCanvas` on the audio clock. One `AudioWorklet` mixes the program with its own sample counter and 2 ms edge fades; the worker feeds it directly. Proxies and sidecars are read through the new `frameshell-media://` protocol (byte ranges, CORS for workers, only `.frameshell/proxies/` of the window's project, one unguessable base URL per project: `ProjectView.mediaUrl`) and demuxed with mp4box.js. One playhead store (`preview/transport.ts`) is shared by the preview and the timeline panel. Clicking or dragging on the ruler scrubs, the lanes follow the playhead while playing, and selecting a clip from a script heading moves the playhead to it. Transport bar and keys: Space plays and pauses, arrows step a frame (Shift: a second), Home and End jump to the ends. Timeline changes during playback re-decode and re-mix only from the first frame and sample that changed, so playback never restarts. Generated, nested-timeline and still-image clips, and clips whose proxy is still being built, show a placeholder. Without an audio device, playback runs silently on the wall clock and says so. Measured on the real app with the spike's 200-cut fixture, it passes all six ADR 0001 thresholds: opt-in Playwright spec `preview-thresholds.spec.ts` (`FRAMESHELL_PREVIEW_MEASURE=1`), with results in `docs/research/preview-playback-measurements.md`. The e2e suite now generates barcode media with the managed ffmpeg, and CI caches it for the e2e and packaged-app jobs. e2e boxes are polled until laid out (`laidOutBox`). `@frameshell/core` exports the proxy recipe (`proxyArgs`, `sidecarArgs`, `PROXY_GOP`, `RECIPE_VERSION`, `SIDECAR_SAMPLE_RATE`).
- Asset and job events replace polling (#69): new daemon notifications `asset.changed` `{ project, path, asset }` (the asset exactly as `asset.list` reports it, sent when its ingest starts, finishes or fails; `asset: null` when the file leaves `assets/`) and `job.progress` `{ project, job }` (the `job.list` snapshot on queue, start, each step, progress at most every 200 ms per job, and done/failed/canceled), declared in the notification registry and subscribable with `events.subscribe`; protocol v16. `JobQueue.watch` reports job changes in order. The desktop timeline no longer polls `asset.list` every 2 s: it reads assets once, then applies `asset.changed` (re-reading after a daemon reconnect), so waveforms and thumbnails appear as soon as ingest finishes, also for files dropped into `assets/` with no timeline change. `frameshell import --wait` and `frameshell render` follow `job.progress` instead of polling `job.list`, so every ingest step shows. `@frameshell/core` exports `MediaStore` and `RECIPE_VERSION`. E2E tests wait for elements to be laid out before reading their box.
- Timeline editing in the desktop app (#16, SPEC §10). Drag a clip to move it, onto another track of the same kind too. Drag an edge to trim. A ghost follows the drag, drawn in the danger color when the daemon would refuse it, and only the release sends an operation. Edges snap to other clips' edges and the playhead: `N` or the magnet button toggles snapping, and holding Alt/Option inverts it for one drag. Keys:
  - `S` or Cmd/Ctrl+K splits at the playhead.
  - `[` / `]` trim the head or tail to the playhead.
  - `,` / `.` nudge by a frame (Shift: 10 frames).
  - Delete removes a clip. Shift+Delete ripple deletes it: an exact `cut` of its range on its own track.
  - Arrows, Home and End move the playhead. Clicking the ruler scrubs it.
  - Cmd/Ctrl+Z undoes and Cmd/Ctrl+Shift+Z (Ctrl+Y) redoes.

  Every edit is one daemon operation (`clip.move`, `clip.trim`, `clip.split`, `clip.remove`, `cut`) by author `ui`, saved and journaled at once. Trims keep the CLI's energy snapping, except an edge placed on another clip's edge, which goes exactly. The header says when an edge snapped into a pause or found none, and shows the daemon's message when an edit is refused. Undo and redo `revert` the latest `ui` transaction replayed from the journal, so they never touch the agent's operations. New renderer API: `timeline.edit/undo/redo`. The playhead is a shared store (`playhead.ts`), and the preview shows its timecode. Scene headings now scroll the timeline again when clicked twice, and pruning a selection never moves the view. `isScriptPath` is exported from `@frameshell/schema`.
- Project default snap window (#68): `frameshell.json` takes `editing.snapWindow` (seconds, 0.5 to 10, SPEC §5.2) as the search half-width for snapping `cut` and `clip trim` edges into audio pauses; an operation's `snapWindow` / `--snap-window` still overrides it, and without either the ADR 0003 default of 0.5 s applies. The daemon re-reads it on every operation. Values below 0.5 or above 10 make the project file invalid with a message naming the value, the range and the fix (`editing.snapWindow: snap window 0.2 s is below the 0.5 s minimum ...`); JSON Schema regenerated. Each entry in `snaps` now carries the `window` searched, and the CLI's unclean-snap note names it. Protocol v11.
- Durable transactions and automatic session ids (#67, SPEC §6.2): an open explicit transaction (`tx begin`) is stored under `<dataDir>/transactions/` (one file per daemon socket, removed when nothing is open) and survives a daemon restart with its label, grouping, operation count and touched timelines; each timeline is recorded before the operation runs, so a crash never hides it from `tx abort`. `tx abort` is all or nothing across timelines: every touched timeline is locked and checked first, and on any conflict nothing is undone and one `RevertConflict` lists every conflicting timeline (`data.timelines: { root, timeline, conflicts, hint }[]`; `data.conflicts` flattens them); timelines where the transaction's only operation failed are skipped. The CLI without `FRAMESHELL_SESSION` (or with it empty) sends a session generated from its parent shell, `sh-<pid>-<hash of pid and start time>` (`sh-<pid>` on Windows), so calls from one shell group automatically and `tx begin` works outside app terminals; documented in `frameshell --help`. Protocol v12.
- Direct file edits and conflict handling (#11, SPEC §6.4): the daemon watches `timelines/*.json` of every open project and compares each change with the last version it wrote or accepted, so its own atomic writes never count as edits. An edit carrying the current `revision` is schema-validated, diffed against that version and journaled as one `timeline.patch` operation by author `file` (with its inverse, so `revert` undoes it and names it as a conflict), the revision is bumped and `timeline.changed` is sent. A stale `revision` (lower or raised by hand) or invalid content (not JSON, schema error with the failing path, or a timeline rule such as overlapping clips) is rejected: the daemon's version is restored byte for byte, the incoming file is kept at `.frameshell/rejected/<timestamp>-<timeline>.json`, the new notification `timeline.rejected` `{ project, timeline, reason, message, preserved, revision, current, at }` is sent, and `status` lists it under `rejections` (the CLI prints them). An edit the watcher has not reported yet is taken in before the next operation on that file. `file.write` of a timeline takes the same path, but refuses instead of preserving: new error code `StaleRevision` (-32034), rule violations with the engine's error. The desktop timeline panel follows the daemon only (its own file-watcher refresh is gone) and shows a dismissible notice when an edit is rejected. Protocol v14.
- `frameshell transcribe --verify <export> [--timeline id] [--json]` and daemon method `transcribe.verify` (#23, SPEC §3.5 step 6): re-transcribe an exported file with the project's provider and compare it with the source transcript words the timeline keeps (each unmuted media clip's words whose midpoint lies inside its `in`/`out`, mapped to timeline seconds by `start` and `speed`). `lost` lists every word at a cut (within 0.5 source seconds of a clip edge where speech was removed, or crossing it) of which nothing was heard, with timeline position, clip, track, source span, the cut edge and a confidence; the CLI exits 1 when any. `uncertain` holds what is unconfirmed but not a cut loss: a missing phrase that repeats its neighbour (whisper can collapse repeats, ADR 0003), a word at a cut heard as other text, a word missing away from cuts. `confidence` is the run's agreement with the sources away from cuts. Clips without a transcript, or with a stale one, are listed in `unchecked`; an export whose length differs from the timeline gets a warning. The alignment (`alignWords`) is a time-banded token-level weighted LCS on the shared timeline clock that tolerates case, punctuation, accents, onset jitter up to 2 s, split or merged words, close spellings and inserted words. Nothing is written but a temporary WAV. Protocol v15.
- MCP server (#32, SPEC §7b): `frameshell mcp` serves MCP on stdio as one more daemon client, starting the daemon when needed; register with `claude mcp add frameshell -- frameshell mcp` (docs/mcp.md). New package `@frameshell/mcp` (official `@modelcontextprotocol/sdk`). Every public method of the Zod registry becomes a tool at startup (`clip.add` → `clip_add`), with the registry's model-facing description and its params as input schema; `cwd` is optional and defaults to the server's directory. Results are compact JSON; mutating tools return `revision` and `operation.tx` (inverse patches omitted); daemon errors come back as `isError` tool results `<ErrorCode>: <message>` with `data`. `frame_capture` (the `frame` method) returns the composited frame as a PNG image fitted to 1280x1280, `frames_strip` a contact sheet of 2 to 16 evenly spaced frames. Resources `frameshell://status`, `timelines/{id}`, `timelines/{id}/history`, `transcripts/{file}` (`scripts/{file}/outline`, one per `scripts/**/*.md`, from `script.outline`), in the compact `--json` form; subscribed timeline and history resources are notified on the daemon's `timeline.changed`, new timelines and transcripts send `list_changed`. Operations are attributed to `FRAMESHELL_SESSION`, else to a session id per server run. Contract test: a scripted MCP client drives the built `frameshell mcp` through init, plugin install, import, clip add, transcribe (fake provider plugin), cut in a transaction, frame capture, contact sheet and revert. No wire change.
- Live timeline view (#14): the desktop timeline panel draws the project's `main` timeline from the daemon on a canvas: tracks top layer first (V2, V1, A1, S1 numbered from the bottom layer), clips named after what they play with their length, media / nested timeline / plugin-rendered clips told apart, clips with an unknown length (missing nested timeline) flagged, thumbnails on video clips and waveforms on audio clips once ingest produced them, a ruler with timecodes and a static playhead. Zoom with Ctrl/Cmd + wheel, pinch, `+`/`-`/`0` or the ruler corner buttons; native horizontal and vertical scroll; hover shows clip details; a hidden clip list mirrors the canvas for screen readers. Only visible clips are painted (binary search per track): 500 clips paint in well under a millisecond. CLI edits show up without reload (about 20 ms from file write to screen in the e2e test; budget 200 ms), direct edits of the timeline file too. Daemon event subscriptions: methods `events.subscribe` / `events.unsubscribe` (registry entries, internal) and notification `timeline.changed` `{ project, timeline, revision, author, changes }`, sent after each applied operation, `revert` and transaction abort included, to connections subscribed on that project; protocol v10. `DaemonConnection.on(event, listener)` (payloads validated against the registry) and `DaemonConnection.closed`. The app's `DaemonLink.subscribe` renews subscriptions after a lost connection, restarting the daemon if needed, and tells listeners to resync.
- Export v1 (SPEC §3.5): `frameshell render [--preset p] [--out file] [--timeline id]` and daemon method `render` export a timeline as a background job on the shared job queue (`job.list` shows kind `render`, steps `video`/`mux`, progress and `output`); the CLI waits and prints progress. A pure compiler (`compileRender`, golden-file tests) turns the timeline into a render plan and ffmpeg arguments: the first video track in segments encoded in parallel from the original assets (frame-exact source picking on the proxy clock, speed, black gaps, letterboxing, every VP9 input decoded with `libvpx-vp9` per ADR 0002) and joined with the concat demuxer; the sound of every video and audio track mixed in one continuous pass (sample-exact `atrim`, `atempo`, gain, a 2 ms fade at every cut, `amix`) into a lossless intermediate, then two-pass `loudnorm` to the target (preset `loudness`, else `export.loudness`, else -17 LUFS) and muxed. Built-in presets `youtube-1080p`, `youtube-1440p`, `vertical-1080x1920` as data; plugin presets (#19) resolve too and `export.presets` now lists built-ins with `plugin: null`. `frameshell frame --at <s> --out <png>` and daemon method `frame` capture one composited frame with the same compiler (single-frame plan for MCP `frame_capture`). Default output `exports/<timeline>-<preset>.<container>`, written atomically. Timelines with clips on a second video track, nested timelines or adapter clips fail with `ExportUnsupported` (overlays and adapters come later); subtitle tracks and transforms are skipped with a warning. Error codes `PresetNotFound` (-32028), `ExportUnsupported` (-32029); protocol v7. Tests: golden plans; a 200-cut export with no sample step above a tone's own slope at any cut or segment join; integrated loudness within 1 LU of the target; frame-exact video across segment joins; CLI smoke render on all three OSes.
- History and transactions (SPEC §6.2, ADR 0004): every timeline operation is appended to `.frameshell/history/<timeline>.jsonl` (one JSON line per operation: `{ id, op, args, inverse, author, tx, txLabel, revisionBefore, revision, at, hashBefore, hash }`, append-only; `hashBefore`/`hash` are sha256 content hashes of the timeline before and after) after the file is written. Authors: `ui` (desktop app), `cli:<session>` (`FRAMESHELL_SESSION`), `cli` (terminal without session), `file`, `plugin:<name>`. Operations from one terminal session are grouped into one transaction until 10 s pass without one (`FRAMESHELL_TX_IDLE_MS` / `startDaemon({ txIdleGapMs })`); other authors get one transaction per operation. `frameshell tx begin "<label>" | commit | abort` groups explicitly (needs a session); abort undoes the transaction. `frameshell history [--since <tx>] [--json]` lists operations grouped by transaction, and with `--since` only what came after the agent's last transaction. `frameshell revert <tx|op>` applies the stored inverses newest first as one new `revert` operation (reverting a revert redoes); it is refused with `RevertConflict`, naming each later operation, when later operations left different values on tracks or clips the target changed (a later change that was itself reverted cancels out), or when the file changed outside the journal after the target: the file content differs from the last entry's hash, or the hash chain has a gap (a `file.write` save that kept the revision, an unjournaled edit followed by more operations, or a lost journal append), since replaying inverses over an unrecorded edit would drop it. Every mutation result now carries the operation `id` and its `tx`, and the CLI prints both after the revision. New daemon methods `tx.begin`, `tx.commit`, `tx.abort`, `history`, `revert`; error codes `TransactionState` (-32030), `HistoryNotFound` (-32031), `RevertConflict` (-32032); protocol v8.
- Cut boundaries snap to audio energy (#12, ADR 0003): `cut` and `clip trim` move every edge that has media audio under it into the interior of the nearest pause (at least 200 ms below speech level - 40 dB) within ±0.5 s, then onto the frame grid, so a cut never lands inside a word. With no pause in reach the edge goes to the quietest frame and is reported unclean. On by default for media clips with audio (muted, video-only and generated clips keep exact edges); `--no-snap` / `snap: false` cuts exactly, `--snap-window <s>` / `snapWindow` widens the search (0.5 to 10 s). Results list each snapped edge in `snaps` (`field`, `clip`, `requested`, `applied`, `clean`); the CLI prints them. Envelopes (10 ms RMS) come from the PCM sidecar, or from the asset decoded by ffmpeg when ingest has not finished, and are cached per content hash under `.frameshell/energy/`. Protocol v9.
- Script outline and scene links (SPEC §5.5, decision 14): `frameshell script outline <file> [--json]` and daemon method `script.outline` parse a Markdown script into scenes (level-2 `##` headings outside fenced code; GitHub-style unicode slugs, repeated headings get `-1`, `-2`…), optional YAML frontmatter (`title`, `target_duration` as `60`/`"90s"`/`"1:30"`/`"1m30s"`, `aspect`), each scene's `scriptRef` value, word count and the clips of every timeline linked to it, the clips linked to the whole script (`clips`: a `scriptRef` without `#anchor`, SPEC §5.5), plus `unresolved` refs to anchors that no longer exist. Bad frontmatter and duplicate headings are warnings, never failures. `clip add|set --script-ref` checks the ref (`scripts/x.md#scene` for a scene, `scripts/x.md` for the whole script, which must be a `scripts/**/*.md` file and is only stat'ed) and still stores it when the script or scene is missing, returning a warning that lists the scenes there are; a ref path that is absolute or has a `..` segment fails with `InvalidOperation` and is not stored. The check runs before the edit is queued, never fails the edit and never blocks the timeline: a script that is a symlink leaving the project, a directory, a FIFO or device, over 1 MiB or unreadable is not read, only warned about; every timeline operation result now carries `warnings`. Parser `parseScript` in `@frameshell/schema` (adds the `yaml` dependency). Desktop: clips on the canvas timeline (#14) are selectable (click; Shift/Cmd/Ctrl-click toggles; Esc or a click on empty lane clears) and drawn with an accent frame when selected (clips a new revision removes leave the selection; opening another project clears it; a click never scrolls the lanes), through the renderer's one selection store (`apps/desktop/src/renderer/src/selection.ts`) that #16, #33 and #49 extend. The script editor flags each scene in the gutter (filled: has clips, ring: none; a square on line 1 when clips link the whole script), highlights the scene of the selected clip (every line for a whole-script clip), and selects a scene's clips on the canvas when its heading is clicked, scrolling the first into view. The timeline panel and the editor share one live feed of the timeline. New error code `ScriptNotFound` (-32033); protocol v13.
- Timeline operations (SPEC §5.3, §6.1, ADR 0004): `frameshell track add|remove|list`, `clip add|move|trim|split|remove|set`, `cut [track…] --from --to` (ripple across tracks) and `timeline show [--json]` (compact dump for agents), all with `--timeline <id>`. The daemon validates each operation, snaps times to the project frame grid (3 decimals), enforces timeline rules (no overlapping clips on a track, in/out inside the source duration from the media probe, clips at least one frame, track kind accepts the clip type, adapter props checked by the adapter), bumps `revision`, writes the file atomically and prints the new revision. Every applied operation returns `{ op, args, inverse, author, tx, revisionBefore }`; the inverse is a `timeline.patch` computed by diffing, applied by the same engine. Errors name what failed, the valid range and a fix. A nested timeline file that goes missing, invalid or cyclic does not lock its parent: `timeline show` and `track list` still answer, with `end`/`duration` null and a `problems` list naming the clip, its track and the fix; edits that need the clip's length fail with `NestedTimelineUnavailable` saying the same, and edits that do not (removing the clip or its track, cuts before it, moves that provably keep clear of it) work. Media is probed on demand, so edits never wait for proxies. Full timeline Zod model and regenerated `timeline.json` JSON Schema: video/audio/subtitle tracks, media/timeline/adapter clips, transform, audio gain/mute, speed, `follows`, `scriptRef`. New daemon methods `timeline.show`, `track.*`, `clip.*`, `cut`; error codes `TimelineNotFound`, `TrackNotFound`, `ClipNotFound`, `InvalidOperation`, `NestedTimelineUnavailable`; protocol v6. Plugin API: `ClipAdapter.propsSchema` (any Standard Schema validator). `cut` and `clip.trim` route edges through an edit-point seam for energy snapping (#12).
- Media import (SPEC §6.3, ADR 0001): `frameshell import <file…> [--link] [--wait]` copies or hard-links files into `assets/`, and a watcher picks up files dropped there. A daemon job queue then probes each asset and builds a CFR proxy (H.264 at project fps, GOP 15, no B-frames, faststart, short side at most 540 px; VFR sources resampled with A/V sync kept), a mono s16le 48 kHz PCM sidecar, a waveform and thumbnails under `.frameshell/`. Outputs are cached by content hash, so unchanged or renamed assets are not re-encoded. Jobs belong to the daemon: they keep running after the client disconnects, and the daemon does not idle out while any runs. Progress shows in `status`; new daemon methods `asset.import`, `asset.list` and `job.list`, error code `AssetNotFound`; protocol v4. Tests generate tiny synthetic media, a VFR clip included, with the managed ffmpeg (cached in CI).
- Transcription (SPEC §5.4, ADR 0003): `frameshell transcribe <asset> [--provider] [--model] [--language] [--json]` and daemon method `transcribe` write `transcripts/<asset>.words.json` (new `transcript.json` schema) with asset SHA-256, provider, model and stable word ids; re-transcribing keeps ids and human `edits` of words found again, and `nextWordId` makes sure a dropped id never names another word. A transcript is never overwritten for another asset: a same-name sibling (`interview.mp4` / `interview.wav`) gets `transcripts/<asset with extension>.words.json`, and `TranscriptNameTaken` is returned when both names are taken. Audio comes from the media store: the asset's PCM sidecar (resampled to 16 kHz) when an ingest of its current content is complete, else the asset itself through the same clock filter, so word times match the sidecar and CFR proxy either way; transcription never triggers or waits for ingest. Progress streams as `progress` notifications (CLI prints them on stderr). Official plugin `@frameshell/whisper-cpp` (`plugins/whisper-cpp`): whisper.cpp with `-dtw large.v3.turbo -nfa -ml 1 -sow -ojf`, word start = DTW onset, word end from audio energy, default model `large-v3-turbo-q5_0`, announces the cold Metal shader compile (15-21 s measured on an M3). The binary manager pins prebuilt whisper.cpp 1.9.4 with GPU first and CPU fallback: Frameshell's Metal build on macOS; upstream's CUDA 12.4 build on Windows x64 when an NVIDIA driver answers; Frameshell's Vulkan build on Linux when a Vulkan driver answers; upstream CPU builds otherwise. Frameshell builds are reproducible CI builds of the pinned tag, published on the GitHub release `whisper-cpp-1.9.4-fs1` (workflow `whisper-cpp-release.yml`, which refuses bytes that differ from the pins). It also pins the three large-v3-turbo models and reports install progress. Pins can list candidates probed on the machine; a GPU build that does not start is recorded and the next candidate installs. The provider reruns on CPU (`-ng`) when a GPU run fails. `doctor` lists whisper-cli without requiring it and reports each build's accelerator. `file.write` validates transcripts. Plugin API: providers receive a WAV and host services (`ensureBinary`, `ensureModel`, `progress`) and return `{ model, words }`. Error codes `TranscriptionProviderNotFound` (-32020), `TranscriptionFailed` (-32021), `TranscriptNameTaken` (-32022); protocol v5.
- Release pipeline (`.github/workflows/release.yml`, electron-builder): a `v*` tag builds macOS DMGs (arm64, x64), a Linux AppImage and `.deb`, and an unsigned Windows beta installer, smoke-tests each packaged app with the Playwright suite, and attaches them with `SHA256SUMS.txt` to a draft GitHub release. macOS builds are signed and notarized when the signing secrets exist; without them they are unsigned and the job summary says so; partial secrets fail the job. The CLI and daemon ship inside the app bundle, so `frameshell` works in the integrated terminal. Manual runs and packaging PRs build without publishing. Secrets and release steps: `docs/release.md`.
- ffmpeg mirror: every pinned ffmpeg archive now lists a fallback URL on the GitHub release `ffmpeg-mirror-2026-09-29` of this repository. `.github/workflows/binaries-mirror.yml` publishes that release from `main` with the pinned bytes, `SHA256SUMS.txt`, the FFmpeg source and build scripts at the exact revisions, a written offer for the full corresponding source, and the GPL-3.0 text. The release workflow refuses to draft an app release while the mirror is missing or does not match the manifest. Details: `docs/binaries.md`.
- Desktop app (`apps/desktop`, Electron + electron-vite + React): opens a project folder, auto-starts or reconnects to `frameshelld`, and lays out explorer/history/plugins, preview and editor tabs, timeline and a full-height terminal panel (SPEC §10). Explorer updates live from a file watcher. Markdown and JSON open in Monaco, with the project JSON Schemas; saves go through the daemon. Terminals are real login shells (node-pty + xterm.js) with `FRAMESHELL_SOCKET`, `FRAMESHELL_PROJECT`, `FRAMESHELL_SESSION` and a bundled `frameshell` on `PATH`. Panels resize and collapse; layout is saved per project. Playwright smoke test of the built app in CI.
- Daemon method `file.write`: atomic text-file writes inside a project, schema-checked for `frameshell.json` and timelines. Confinement checks real paths: symlinks cannot escape the project and `.frameshell/` is refused in any letter case. Error code `OutsideProject`.
- `status` reports `caller` (client and terminal session). The CLI sends `FRAMESHELL_SESSION` in the handshake, so calls from an app terminal are attributed to it. Protocol bumped to v3.
- pnpm workspaces monorepo (`packages/schema`, `protocol`, `core`, `cli`), TypeScript strict, Vitest, ESLint.
- `@frameshell/schema`: Zod models for `frameshell.json` and timeline files (`schemaVersion` 1) with generated JSON Schema (`pnpm gen:json-schema`).
- `frameshelld` daemon: JSON-RPC 2.0 over a unix socket (macOS/Linux) or named pipe (Windows), protocol-version handshake with a clear mismatch error, idle-timeout shutdown and stale socket cleanup.
- `frameshell init [dir] [--name]` scaffolds the project layout; `frameshell status [--json]` auto-starts the daemon and reports the enclosing project.
- GitHub Actions CI on macOS, Linux and Windows.
- Product and architecture specification (`docs/SPEC.md`).
- Project-level agent skills and `CLAUDE.md` router.
- README, contributing guide with DCO sign-off, and this changelog.
- Plugin system (SPEC §8): `frameshell-plugin.json` manifest schema with plugin API version check, public `@frameshell/plugin-api` types, and a daemon plugin host. `frameshell plugin install|remove|list` installs from `github:user/repo`, `git+<url>` or npm into `.frameshell/plugins` (regenerable) and pins the commit or exact version in `frameshell.json`. Projects that declare plugins load them only after the user trusts them (`--trust` or a prompt; decisions stored per user and re-asked when the plugin list changes). Plugin commands run as `frameshell <plugin> <command>`; plugins also contribute export presets. New daemon methods `project.trust`, `plugin.*` and `export.presets`.
- `@frameshell/protocol`: Zod method registry declaring every daemon method once (params, result, model-facing description). The daemon rejects invalid params with `InvalidParams` naming each field, and `methodJsonSchemas()` exports per-method JSON Schema for MCP tool generation. Daemon startup errors (bad `FRAMESHELL_IDLE_TIMEOUT_MS`, a non-socket file or an over-long unix socket path) now reach the CLI instead of a generic 10 s timeout.
- Managed native binaries and `frameshell doctor [--install] [--json]`: the daemon downloads pinned GPL static ffmpeg/ffprobe builds (x264, libvpx VP9 encode and decode) for macOS arm64/x64, Linux x64/arm64 and Windows x64 on first use, verifies SHA-256 and installs atomically under the app data dir. `binaries` in `frameshell.json` or the global `config.json` points at system binaries instead. `doctor` reports sources, versions and encoders/decoders (x264, libvpx, VideoToolbox, NVENC, VAAPI, hardware ones test-encoded). New `doctor` daemon method and binary error codes; protocol version 2. Sources and licences: `docs/binaries.md`.

[Unreleased]: https://github.com/ThomasPraun/frameshell/compare/v0.19.0...HEAD
[0.19.0]: https://github.com/ThomasPraun/frameshell/releases/tag/v0.19.0
[0.18.0]: https://github.com/ThomasPraun/frameshell/releases/tag/v0.18.0
[0.17.0]: https://github.com/ThomasPraun/frameshell/releases/tag/v0.17.0
[0.16.0]: https://github.com/ThomasPraun/frameshell/releases/tag/v0.16.0
[0.15.0]: https://github.com/ThomasPraun/frameshell/releases/tag/v0.15.0
[0.14.0]: https://github.com/ThomasPraun/frameshell/releases/tag/v0.14.0
[0.12.1]: https://github.com/ThomasPraun/frameshell/releases/tag/v0.12.1
[0.12.0]: https://github.com/ThomasPraun/frameshell/releases/tag/v0.12.0
[0.11.0]: https://github.com/ThomasPraun/frameshell/releases/tag/v0.11.0
[0.8.1]: https://github.com/ThomasPraun/frameshell/releases/tag/v0.8.1
[0.8.0]: https://github.com/ThomasPraun/frameshell/releases/tag/v0.8.0
[0.6.0]: https://github.com/ThomasPraun/frameshell/releases/tag/v0.6.0
[0.5.0]: https://github.com/ThomasPraun/frameshell/releases/tag/v0.5.0
[0.4.0]: https://github.com/ThomasPraun/frameshell/releases/tag/v0.4.0
[0.3.0]: https://github.com/ThomasPraun/frameshell/releases/tag/v0.3.0
[0.2.0]: https://github.com/ThomasPraun/frameshell/releases/tag/v0.2.0
