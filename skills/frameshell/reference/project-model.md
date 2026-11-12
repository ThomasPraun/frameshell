# Project model

A Frameshell project is a directory with `frameshell.json` at its root. Every file is JSON validated against a published schema (`$schema` in each file) or Markdown.

```
frameshell.json          project config
timelines/main.json      the exported sequence (others: nested timelines)
assets/                  footage, images, audio, fonts, generated media
transcripts/*.words.json word-level transcript per asset
credits.json            optional: source, licence and author of third-party assets (see credits.md)
scripts/*.md             Markdown scripts
compositions/            HyperFrames HTML compositions, the Remotion project (compositions/remotion/)
style.json               optional style guide: colours, fonts, type, motion, sound, platforms, rules
exports/                 render output
.frameshell/             daemon state, regenerable, gitignored (history, proxies, caches, rejected edits)
```

## `frameshell.json`

`fps`, `resolution` (`width`, `height`), `sampleRate`, `main` (the main timeline file), `plugins` (package → pinned spec), and optional `kind` (`image` for an image project, see [image-projects.md](image-projects.md); absent = video), `transcription` (`provider`, `model`, `language`; `model` is an id, never a path: a model file is registered per machine with `frameshell model add`), `export` (`defaultPreset`, `loudness`), `formats` (delivery formats `{ id, width, height }`, primary first and equal to `resolution`; change them with `frameshell format add` and `frameshell format remove`, absent = one format), `editing.snapWindow` (seconds), `binaries` (paths overriding the managed ffmpeg/whisper builds). Edit it with your file tools; the daemon re-reads it.

## Timeline

`timelines/<id>.json`: `id`, `revision` (bumped by every change), `tracks` in stacking order (first video track = bottom layer).

- **Track:** `id` (`t_…`), `kind` (`video`, `audio`, `program`, `subtitles`), `name`, `clips`, optional `muted: true` (no sound from the whole track; not on subtitle tracks) and `hidden: true` (video and program tracks: no picture, the tracks below show through, its sound still plays); set both with `track set`. A video track may say `behind: "<plate track>"`, a video track listed before it: its pictures sit behind the person in front on that plate (export draws the plate's media clips again above it through their subject mattes); set it with `track set --behind`. A subtitle track has no clips: it `follows` a video or audio track and carries `style` (`preset`, `position`, `speakerNames`, `entry`, `keywordColor`, `keywordScale`), optional `phrases` (hand-chunked captions as transcript word ids, written by `captions set`) and `gaps` (`{ from, to }` ranges with no cue).
- **Clip:** `id` (`c_…`), `type`, `start` (timeline seconds).
  - `media`: `asset`, `in`/`out` (source seconds), `speed`; length `(out - in) / speed`; optional `audio.effects`: audio effects applied in order (`{ "kind": "highpass", "frequency": 85 }`, `{ "kind": "denoise", "floor": -30, "reduction": 8 }`, `{ "kind": "compressor", "threshold": -20, "ratio": 2.5, "attack": 8, "release": 140, "makeup": 2 }`; omitted numbers take these). Set with `clip set --voice` or `--audio-effects`; baked into `.frameshell/audio-fx/`.
  - `timeline`: `source` is another timeline file, embedded as one clip.
  - adapter types such as `hyperframes` or `remotion`: `source`, `duration`, `props`, optional `elements`: `{ "<css selector>": { x, y, scale } }` moves and scales elements inside the composition (composition CSS px, scale about the centre) without touching its file. Set with `clip set --elements`; a plugin must support it. An agent rewriting the composition anyway may move a value into the code and clear its entry.
  - optional on any of these: `audio` (`gain` dB, `muted`), `transform` (`x`, `y` in project pixels, `scale`, `opacity` 0-1), `scriptRef` (`scripts/x.md#scene`).
- **Markers:** optional `markers`: `{ id: "m_…", at, label, color? }`, `at` in timeline seconds on the frame grid, labels unique ignoring case and never shaped like an id (`m_…`), `color` one of `red`, `orange`, `yellow`, `green`, `blue`, `purple`. Edit them with `marker add|set|remove` (journaled, revertible); a hand edit that breaks any of these (or repeats an id) is rejected into `.frameshell/rejected/`; markers are kept sorted by `at`.
- **Multicam:** `groups` holds multicam groups: `id`, `angles` (`id`, `name`, `asset`, `offset` = group second where the asset's 0 plays, optional `crop` fractions per side, optional `reframe` keys `{at, x, y}` (group second, point to center a cut tile on as fractions of the picture; for 9:16 exports of 16:9 cameras), `audio`, optional `mic`, `screen: true` for a screen share, optional `speaker` = transcript speaker of its sound whose words are its turns when people share a file or mic), optional `mics` (`id`, `name`, `asset`, `offset`, `audio`: separate sound files), optional `painted` (`angle`, `start`, `end` on the group clock, `speaking`: who speaks as a person painted it, replacing the measured turns of that angle; `multicam paint`). An angle's `mic` is a mic id (its sound comes from that mic, level on the mic), `null` (no sound) or absent (its own file's sound). A `program` track names one `group` and holds `shot` clips: `shot` (`solo` 1 angle, `two-up` 2, `grid` 2+, `screen` 1 angle whole with bars, `pip` 2: the screen then a person as an inset), `angles` (ids of that group), `in`/`out` on the group clock, optional `corner` (`pip` only), `confidence`/`reason`. Shots switch pictures only: every sound of the group (own files of angles without `mic`, each mic once) plays under every shot. `multicam create` makes a group with its program track and a first `grid` shot from one file per person, synced by audio (see cli.md). `multicam gallery` makes a group whose angles are all one call recording at offset 0, each with the `crop` of its tile, and whose sound is one mic (`call`) that every angle takes. `direct` fills the program track with shots by the rules of `director.json` (`template`, `minShot`, `maxShot`, `cutLead`, `twoShot`, `wide`, `cutaway`, `screen`, `weights`; see cli.md). `shot set` changes a shot's layout and angles, `multicam angle` an angle's name, crop, sound, mic, screen mark and speaker, `multicam paint` who speaks by hand, `multicam reframe` its reframe keys, `multicam offset` its sync, `multicam mic` a mic's sync and level. `cut`, `clip trim`/`split`/`move`/`remove` work on shots, the desktop preview plays them, and export renders them; `shoot assemble` adds shots (with `take` and `scriptRef`) for takes recorded in the app, otherwise adding shots is not supported in the CLI. A program track nested under a transformed video clip is refused by export with `ExportUnsupported` and shows a placeholder in the preview.
- Times snap to the project frame grid (`1/fps`), stored with 3 decimals. Duration is derived, never stored.

## Transcript

`transcripts/<asset minus extension>.words.json` (extension kept when two assets share a base name; the file's `asset` field names its asset):

- `words`: `{ id: "w_000001", text, start, end, confidence }`, source seconds of that asset. An id always names the same word, across re-transcriptions. `speechInside: true`: the span hides more speech than the word; never cut inside it.
- `edits`: human corrections keyed by word id, `{ "w_000002": { "text": "a todos" } }`, or who says it, `{ "w_000002": { "speaker": "s2" } }`. Subtitles and verify show the edited text. Correct a word by adding to `edits`; leave `words` as the engine wrote them.
- `speakers` (after `transcribe --speakers`): `[{ id: "s1", name: "Ana" }]`; each word then has a `speaker` id. Rename a person by changing `name`, never the `id`.
- `assetHash`: the transcript is stale when the asset changes; re-run `transcribe`.
- `provider`, `model` (id), and `modelHash` (`sha256:<hex>`) when the model was a file registered on the machine that transcribed it.

## Scripts

Plain Markdown; optional frontmatter `title`, `target_duration`, `aspect`. Each `## ` heading is a scene whose slug is the anchor in a clip's `scriptRef`. `frameshell script outline <file>` lists scenes, their refs and the clips linked to each; empty scenes still need footage. A scene may name its transcript words with `<!-- words: talk.words.json w_000010..w_000042 -->` right under the heading (word ids repeat across transcripts, so name the file; the bare `w_000010..w_000042` works only when one transcript holds both ids); the outline then gives `wordRange` and `span` (timeline seconds those words occupy, per timeline), so you can place its clips on the words. Clips do not follow their words when audio is cut: re-read the outline after cutting. Unknown ids, an ambiguous bare range or a reversed range come back as `warnings`.

A script with `shoot: true` in its frontmatter is a shoot script: lines, `**Name:**` speakers and `[LABEL: …]` cues, checked with `frameshell script check <file>`. Format: [shoot-scripts.md](shoot-scripts.md).

## Style

`style.json` (optional) is the project's style guide: every look and sound decision as a number, so you never improvise "make it nice". Keep the person's style here, not in a Markdown notes file. `frameshell style show` (MCP `style_show`) prints it resolved, each value with its source. Nothing renders from it yet: read it and use its values when you write captions, cards, compositions and mixes.

```json
{
  "$schema": "https://frameshell.dev/schema/v1/style.json",
  "schemaVersion": 1,
  "brand": { "product": "Acme", "hook": "Stop editing by hand.", "cta": "?", "mustShow": ["logo at the end"] },
  "colors": { "bg": "#0b0b0f", "ink": "#f5f5f0", "accent": "#ff5a1f" },
  "fonts": { "display": { "family": "Archivo Black" }, "ui": { "family": "Inter", "file": "assets/fonts/Inter.ttf", "weight": 500 } },
  "motion": { "personality": "premium", "duration": { "quick": 0.3 } },
  "sound": { "musicUnderVoice": 14 },
  "platforms": ["instagram-reels"],
  "rules": ["sentence case", "accent on the key word only"],
  "banned": ["emoji in captions"]
}
```

- Every section is optional; unknown keys are refused. `brand`: `product`, `url`, `promise`, `hook`, `cta`, `audience`, `reference`, `mustShow`, `mustAvoid`; `?` marks a field to ask the person about. `colors`: `bg`, `ink`, `ink2`, `accent`, `card`, `keyword`, `highlight` as `#rrggbb`. `fonts`: `display`, `ui`, `captions`, `keyword`, each `{ family, file?, weight?, tracking? }` (`file` under `assets/fonts/`; tracking in em). Frameshell never downloads fonts: import the file and record its credit.
- `type`: `hero`, `card`, `minReadable`, `margin` in px on a frame whose short side is 1080 (defaults 200, 110, 28, 120).
- `motion.personality` picks the motion values: `playful` (0.15-0.3 s, bouncy), `premium` (0.35-0.8 s, no overshoot), `corporate` (0.2-0.4 s, at most 3 %; the default), `energetic` (0.1-0.25 s, up to 30 %), `calm` (premium's timing, no overshoot, no keyword highlight). Override single values: `duration` (`quick`, `standard`, `slow`), `ease` (cubic-bezier as 4 numbers), `overshoot` (fraction), `spring` (`response` s, `damping` ζ), `stagger`, `exit` (fraction of the entrance), `highlight`. **Times are seconds, never milliseconds.**
- `sound`: `musicUnderVoice`, `sfxUnderVoice` (dB under the voice), `duck` (`depth` dB, `attack`, `release` s), `voice` chain defaults. The loudness target is `export.loudness` in `frameshell.json`, not here.
- `platforms` (`instagram-reels`, `tiktok`, `youtube-shorts`, `youtube`): `style show` adds each one's safe zone (pixels its app covers; `measured` false = from guides). Keep text and faces out of them.
- `notes`, `rules`, `banned`: lists in the person's words. When the person rejects something in a critique ("no emojis"), add it to `banned` and never do it again.
- Write it with your file tools or the MCP `file_write`; `file_write` refuses an invalid file and `style show` names the bad field. Change it only with the person's agreement, and not while review mode is on (`frameshell proposal status`): style edits are not proposals yet.

## Direct timeline edits

Editing `timelines/*.json` by hand is allowed, as a last resort for a change no command expresses. The daemon accepts the edit only when the file's `revision` equals its current one and the result is valid, and journals it as author `file`. Otherwise it restores its version and keeps yours under `.frameshell/rejected/`; `frameshell status` lists why. Read the file right before editing and keep `revision` as read.
