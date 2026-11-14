# Project model

A Frameshell project is a directory with `frameshell.json` at its root. Every file is JSON validated against a published schema (`$schema` in each file) or Markdown.

```
frameshell.json          project config
timelines/main.json      the exported sequence (others: nested timelines)
assets/                  footage, images, audio, fonts, generated media
transcripts/*.words.json word-level transcript per asset
beats/*.beats.json       optional: beat grid of a music asset (see Beat grid)
credits.json            optional: source, licence and author of third-party assets (see credits.md)
scripts/*.md             Markdown scripts
compositions/            HyperFrames HTML compositions, the Remotion project (compositions/remotion/)
style.json               optional style guide: colours, fonts, type, motion, sound, platforms, rules
exports/                 render output
.frameshell/             daemon state, regenerable, gitignored (history, proxies, caches, rejected edits)
```

## `frameshell.json`

`fps`, `resolution` (`width`, `height`), `sampleRate`, `main` (the main timeline file), `plugins` (package → pinned spec), and optional `kind` (`image` for an image project, see [image-projects.md](image-projects.md); absent = video), `transcription` (`provider`, `model`, `language`; `model` is an id, never a path: a model file is registered per machine with `frameshell model add`), `export` (`defaultPreset`, `loudness`), `formats` (delivery formats `{ id, width, height }`, primary first and equal to `resolution`; change them with `frameshell format add` and `frameshell format remove`, absent = one format; a write of the file that changes them is journaled like those commands and waits in your proposal in review mode), `editing.snapWindow` (seconds), `binaries` (paths overriding the managed ffmpeg/whisper builds). Edit it with your file tools; the daemon re-reads it.

## Timeline

`timelines/<id>.json`: `id`, `revision` (bumped by every change), `tracks` in stacking order (first video track = bottom layer).

- **Track:** `id` (`t_…`), `kind` (`video`, `audio`, `program`, `subtitles`), `name`, `clips`, optional `muted: true` (no sound from the whole track; not on subtitle tracks) and `hidden: true` (video and program tracks: no picture, the tracks below show through, its sound still plays); set both with `track set`. A video track may say `behind: "<plate track>"`, a video track listed before it: its pictures sit behind the person in front on that plate (while it shows a clip and no shown track between them does, export and the preview draw the plate's media clips again above it through their subject mattes); set it with `track set --behind`. A subtitle track has no clips: it `follows` a video or audio track and carries `style` (`preset`, `position`, `speakerNames`, `entry`, `keywordColor`, `keywordScale`), optional `phrases` (hand-chunked captions as transcript word ids, written by `captions set`) and `gaps` (`{ from, to }` ranges with no cue).
- **Clip:** `id` (`c_…`), `type`, `start` (timeline seconds).
  - `media`: `asset`, `in`/`out` (source seconds), `speed`; length `(out - in) / speed`; optional `audio.effects`: audio effects applied in order (`{ "kind": "highpass", "frequency": 85 }`, `{ "kind": "denoise", "floor": -30, "reduction": 8 }`, `{ "kind": "compressor", "threshold": -20, "ratio": 2.5, "attack": 8, "release": 140, "makeup": 2 }`; omitted numbers take these). Set with `clip set --voice` or `--audio-effects`; baked into `.frameshell/audio-fx/`. Optional `grade` (video tracks): `{ exposure, temperature, tint, contrast, saturation, lut, lutMix }`: exposure in stops, white balance -1 to 1 (temperature cool to warm, tint green to magenta), contrast and saturation factors (1 = unchanged), then `lut`, a project `.cube` 3D LUT (up to 65 points, Rec.709 input) at `lutMix` (0-1, default 1). Correct first, then style. Export and the preview apply the same table. Set with `clip set --grade-*`.
  - `timeline`: `source` is another timeline file, embedded as one clip.
  - adapter types such as `hyperframes` or `remotion`: `source`, `duration`, `props`, optional `elements`: `{ "<css selector>": { x, y, scale } }` moves and scales elements inside the composition (composition CSS px, scale about the centre) without touching its file. Set with `clip set --elements`; a plugin must support it. An agent rewriting the composition anyway may move a value into the code and clear its entry. Optional `backdrop`: glass under the clip, `{ blur, saturate?, dim? }` (blur = Gaussian sigma in project px; saturate 1 = unchanged; dim 0-1 = dark scrim). Export and the preview blur, saturate and dim the picture below the clip wherever its alpha is above about 3 %, then draw the clip; the render does not change. Upper video tracks only (on the bottom track nothing is below). Set with `clip set --glass` or `--backdrop-blur`, `--backdrop-saturate`, `--backdrop-dim`.
  - optional on any of these: `audio` (`gain` dB, `muted`), `transform` (`x`, `y` in project pixels, `scale`, `opacity` 0-1), `scriptRef` (`scripts/x.md#scene`).
  - optional on video-track clips: `formats` (by format id: `transform`, picture `keys`, `hidden: true`, and for generated clips `props`, `elements`): how the clip shows in that format instead of as in the primary (`clip set --format`, `clip key --format`). A subtitle track's `formats` holds `style` per format (`track set --format`). Ignored in the primary format and for formats `frameshell.json` no longer lists.
- **Tempo:** optional `tempo`: the beat grid the timeline follows, `{ clip }` or `{ bpm, offset?, meter?, clip? }`; see [Beat grid](#beat-grid).
- **Markers:** optional `markers`: `{ id: "m_…", at, label, color? }`, `at` in timeline seconds on the frame grid, labels unique ignoring case and never shaped like an id (`m_…`) or a grid reference (`beat:8`, `bar:2`), `color` one of `red`, `orange`, `yellow`, `green`, `blue`, `purple`. Edit them with `marker add|set|remove` (journaled, revertible); a hand edit that breaks any of these (or repeats an id) is rejected into `.frameshell/rejected/`; markers are kept sorted by `at`.
- **Multicam:** `groups` holds multicam groups: `id`, `angles` (`id`, `name`, `asset`, `offset` = group second where the asset's 0 plays, optional `crop` fractions per side, optional `reframe` keys `{at, x, y}` (group second, point to center a cut tile on as fractions of the picture; for 9:16 exports of 16:9 cameras), `audio`, optional `mic`, `screen: true` for a screen share, optional `speaker` = transcript speaker of its sound whose words are its turns when people share a file or mic), optional `mics` (`id`, `name`, `asset`, `offset`, `audio`: separate sound files), optional `painted` (`angle`, `start`, `end` on the group clock, `speaking`: who speaks as a person painted it, replacing the measured turns of that angle; `multicam paint`). An angle's `mic` is a mic id (its sound comes from that mic, level on the mic), `null` (no sound) or absent (its own file's sound). A `program` track names one `group` and holds `shot` clips: `shot` (`solo` 1 angle, `two-up` 2, `grid` 2+, `screen` 1 angle whole with bars, `pip` 2: the screen then a person as an inset), `angles` (ids of that group), `in`/`out` on the group clock, optional `corner` (`pip` only), `confidence`/`reason`. Shots switch pictures only: every sound of the group (own files of angles without `mic`, each mic once) plays under every shot. `multicam create` makes a group with its program track and a first `grid` shot from one file per person, synced by audio (see cli.md). `multicam gallery` makes a group whose angles are all one call recording at offset 0, each with the `crop` of its tile, and whose sound is one mic (`call`) that every angle takes. `direct` fills the program track with shots by the rules of `director.json` (`template`, `minShot`, `maxShot`, `cutLead`, `twoShot`, `wide`, `cutaway`, `screen`, `weights`; see cli.md). `shot set` changes a shot's layout and angles, `multicam angle` an angle's name, crop, sound, mic, screen mark and speaker, `multicam paint` who speaks by hand, `multicam reframe` its reframe keys, `multicam offset` its sync, `multicam mic` a mic's sync and level. `cut`, `clip trim`/`split`/`move`/`remove` work on shots, the desktop preview plays them, and export renders them; `shoot assemble` adds shots (with `take` and `scriptRef`) for takes recorded in the app, otherwise adding shots is not supported in the CLI. A program track nested under a transformed video clip is refused by export with `ExportUnsupported` and shows a placeholder in the preview.
- Times snap to the project frame grid (`1/fps`), stored with 3 decimals. Duration is derived, never stored.

## Transcript

`transcripts/<asset minus extension>.words.json` (extension kept when two assets share a base name; the file's `asset` field names its asset):

- `words`: `{ id: "w_000001", text, start, end, confidence }`, source seconds of that asset. An id always names the same word, across re-transcriptions. `speechInside: true`: the span hides more speech than the word; never cut inside it.
- `edits`: human corrections keyed by word id, `{ "w_000002": { "text": "a todos" } }`, or who says it, `{ "w_000002": { "speaker": "s2" } }`. Subtitles and verify show the edited text. Correct a word by adding to `edits`; leave `words` as the engine wrote them.
- `speakers` (after `transcribe --speakers`): `[{ id: "s1", name: "Ana" }]`; each word then has a `speaker` id. Rename a person by changing `name`, never the `id`.
- `assetHash`: the transcript is stale when the asset changes; re-run `transcribe`.
- `provider`, `model` (id), and `modelHash` (`sha256:<hex>`) when the model was a file registered on the machine that transcribed it.

## Beat grid

`beats/<asset minus extension>.beats.json` (extension kept when two assets share a base name), written by `frameshell beats measure <asset>` or, for generated music, by the generator with `"detector": "exact"`. Times are source seconds of the music file. Versioned with the project; `gc` never touches it.

- `bpm`, `meter` (beats per bar, 4), `downbeat` (index in `beats` of the first beat that starts a bar), `beats` (increasing, each snapped to a measured hit within 8 ms), `onsets` (strong hits), `confidence` (0..1), `residualMs` (largest gap between the grid and the hits it matched; under 15 on a clean track), `sampleRate` (16000 = decoded without a finished ingest, confidence capped at 0.45).
- **LOW confidence** (under 0.5, `low: true`): calm or sparse music gets a double-time grid, a bar can start half a bar off, a tracker lags an attack by tens of ms. Tell the person, offer the tempi in `alternatives` (best supported first), and do not cut to the grid until they pick one. A person or you vouch for it by setting `edits`.
- `edits` (validated by `file.write`): `tempo` `"double"` (a beat halfway between each pair) or `"half"` (every other beat), `downbeat` (index among the effective beats of the first bar start), `offset` (seconds added to every beat). `beats show` applies them; `beats measure` keeps them unless `--reset-edits`. Correct a grid by adding to `edits`; leave `beats` as measured.
- A grid before music exists is just arithmetic: beat `i` is at frame `round(fps · 60 · i / bpm + offset · fps)`, computed from `i` and rounded once. Never add a rounded beat length, it drifts 2 frames in 32 beats at 128 BPM and 30 fps.
- `assetHash`: stale when the asset changes (`beats show` says `current: false`).

### The timeline's tempo

A timeline names the grid it follows in its optional `tempo` (set with `tempo set`, journaled and revertible; the file's `beats` stay in the music's own seconds):

- `{ "clip": "c_…" }`: the beats file of that media clip's asset, carried to the timeline through the clip's `start`, `in` and `speed` (a beat inside `[in, out)` lands at `start + (beat - in) / speed`, on the frame grid). Moving, trimming or speeding up the music moves the grid; `edits` of the beats file apply. A clip with no beats file has no grid yet (`tempo show` says so).
- `{ "bpm": 120, "offset": 0.5, "meter": 4 }`: a nominal grid on the timeline clock, to block a film in bars before music exists. With `"clip"` too, it rides on that clip and `offset` is in the clip's source seconds.
- `tempo.clip` must name a media clip of a video or audio track; a direct edit that drops the clip but keeps `tempo` is rejected. The app draws the grid on the timeline (bars stronger than beats) and drags snap to it; a hand edit of the beats file updates it live. `--snap-to beat|bar|marker` does the same for a command's times. **Never snap on a LOW grid.**

## Scripts

Plain Markdown; optional frontmatter `title`, `target_duration`, `aspect`. Each `## ` heading is a scene whose slug is the anchor in a clip's `scriptRef`. `frameshell script outline <file>` lists scenes, their refs and the clips linked to each; empty scenes still need footage. A scene may name its transcript words with `<!-- words: talk.words.json w_000010..w_000042 -->` right under the heading (word ids repeat across transcripts, so name the file; the bare `w_000010..w_000042` works only when one transcript holds both ids); the outline then gives `wordRange` and `span` (timeline seconds those words occupy, per timeline), so you can place its clips on the words. Clips do not follow their words when audio is cut: re-read the outline after cutting. Unknown ids, an ambiguous bare range or a reversed range come back as `warnings`.

A script with `shoot: true` in its frontmatter is a shoot script: lines, `**Name:**` speakers and `[LABEL: …]` cues, checked with `frameshell script check <file>`. Format: [shoot-scripts.md](shoot-scripts.md).

## Style

`style.json` (optional) is the project's style guide: every look and sound decision as a number, so you never improvise "make it nice". Keep the person's style here, not in a Markdown notes file. `frameshell style show` (MCP `style_show`) prints it resolved, each value with its source. Captions and generated clips take it automatically (below); for everything else read it and use its values when you write cards, compositions and mixes.

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
- `type`: `hero`, `card`, `minReadable`, `margin` in px on a frame whose short side is 1080 (defaults 200, 110, 28, 120); `caption`: caption font size, same unit (default null: the preset's).
- **Captions take the style as their base**: a subtitle track that names no `preset` shows its text in `colors.ink` outlined in `colors.bg`, the keyword in `colors.keyword` (else `colors.accent`), the spoken word in `colors.highlight` (else the accent), at `type.caption`, with no keyword or spoken-word colour when `motion.highlight` is false (`calm`). A track that names a preset (`--preset plain`) takes every value of that preset instead, and the track's own `--position`, `--keyword-color` and the 1.3x of vertical formats win over both. The caption face is `fonts.captions` whatever the preset: a `.ttf` or `.otf` file under `assets/fonts/` (its family and line metrics are read from the file, so preview, export and review safe zones place lines the same way), or `Archivo Black`, the bundled face. A family without a file, or a missing or WOFF file, falls back to Archivo Black, and `render` warns.
- **Generated clips get the style as CSS variables**: a HyperFrames page's render and live preview carry a first stylesheet with `:root` variables, all named `fs-…`: `var(--fs-color-<role>)` for each colour set, `var(--fs-font-<role>)` as a family stack plus `-weight` and `-tracking`, `var(--fs-type-hero)` and `-card`, `-min-readable`, `-margin`, `-caption` in px on a 1080 short side, `var(--fs-motion-quick)` and `-standard`, `-slow`, `-stagger` in s, `var(--fs-motion-ease)` and `-overshoot`, `-exit`, `-spring-response`, `-spring-damping`, `-highlight` (1 or 0), `-personality`, and an `@font-face` per font file of the style. Write compositions with `var(--fs-color-accent, #ff5a1f)` (always with a fallback) so a rebrand is one `style set`. Changing a value in the sheet re-renders HyperFrames clips; brand text, rules and sound do not. Templates (`hyperframes new --template`) still copy the colours in when scaffolded.
- `motion.personality` picks the motion values: `playful` (0.15-0.3 s, bouncy), `premium` (0.35-0.8 s, no overshoot), `corporate` (0.2-0.4 s, at most 3 %; the default), `energetic` (0.1-0.25 s, up to 30 %), `calm` (premium's timing, no overshoot, no keyword highlight). Override single values: `duration` (`quick`, `standard`, `slow`), `ease` (cubic-bezier as 4 numbers), `overshoot` (fraction), `spring` (`response` s, `damping` ζ), `stagger`, `exit` (fraction of the entrance), `highlight`. **Times are seconds, never milliseconds.**
- `sound`: `musicUnderVoice`, `sfxUnderVoice` (dB under the voice), `duck` (`depth` dB, `attack`, `release` s), `voice` chain defaults. The loudness target is `export.loudness` in `frameshell.json`, not here.
- `glass`: `cards` (true: cards over the picture are glass in this style; default false), `blur`, `saturate`, `dim` (defaults 46, 1.45, 0.55; dim up to 0.72 over bright footage): the numbers `clip set --glass` copies onto a generated card. Glass cards everywhere read as an AI default: use glass only when `glass.cards` is true or the person asks for it.
- `platforms` (`instagram-reels`, `tiktok`, `youtube-shorts`, `youtube`): `style show` adds each one's safe zone (pixels its app covers; `measured` false = from guides). Keep text and faces out of them.
- `notes`, `rules`, `banned`: lists in the person's words. When the person rejects something in a critique ("no emojis"), add it to `banned` and never do it again.
- Change it with `frameshell style set <path> <value>` (MCP `style_set`): the path names one value as `style show` prints it (`colors.accent`, `motion.duration.quick`, `fonts.display`, `banned`); the value is JSON or plain text (`style set banned '["emoji in captions"]'`, `style set colors.accent '#ff5a1f'`); `null` removes it so the personality's or default value applies again. Put negative numbers after `--`: `style set sound.voice.compressor.threshold -- -18`. Every change is journaled (`frameshell revert <op>` undoes it) and, in review mode, waits in your proposal like a timeline change. Change it only with the person's agreement.
- User styles are the person's saved styles on this machine: `frameshell style list`; `frameshell style apply <name>` copies one in value by value and lists what changed (`--replace` makes the file exactly that style); `style apply premium` (any personality) sets only `motion.personality`. `frameshell style save <name>` keeps the project's style for other projects (`--force` overwrites). A project never follows a user style afterwards: when `style show` says it changed since, ask before applying it again.
- A `file_write` of `style.json` is journaled too and refuses an invalid file; prefer `style set`, which keeps the rest of the file.

## Direct timeline edits

Editing `timelines/*.json` by hand is allowed, as a last resort for a change no command expresses. The daemon accepts the edit only when the file's `revision` equals its current one and the result is valid, and journals it as author `file`. Otherwise it restores its version and keeps yours under `.frameshell/rejected/`; `frameshell status` lists why. Read the file right before editing and keep `revision` as read.
