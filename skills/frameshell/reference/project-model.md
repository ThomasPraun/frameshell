# Project model

A Frameshell project is a directory with `frameshell.json` at its root. Every file is JSON validated against a published schema (`$schema` in each file) or Markdown.

```
frameshell.json          project config
timelines/main.json      the exported sequence (others: nested timelines)
assets/                  footage, images, audio, fonts, generated media
transcripts/*.words.json word-level transcript per asset
scripts/*.md             Markdown scripts
compositions/            HyperFrames HTML compositions, the Remotion project (compositions/remotion/)
exports/                 render output
.frameshell/             daemon state, regenerable, gitignored (history, proxies, caches, rejected edits)
```

## `frameshell.json`

`fps`, `resolution` (`width`, `height`), `sampleRate`, `main` (the main timeline file), `plugins` (package → pinned spec), and optional `transcription` (`provider`, `model`, `language`), `export` (`defaultPreset`, `loudness`), `editing.snapWindow` (seconds), `binaries` (paths overriding the managed ffmpeg/whisper builds). Edit it with your file tools; the daemon re-reads it.

## Timeline

`timelines/<id>.json`: `id`, `revision` (bumped by every change), `tracks` in stacking order (first video track = bottom layer).

- **Track:** `id` (`t_…`), `kind` (`video`, `audio`, `program`, `subtitles`), `name`, `clips`. A subtitle track has no clips: it `follows` a video or audio track and carries `style` (`preset`, `position`).
- **Clip:** `id` (`c_…`), `type`, `start` (timeline seconds).
  - `media`: `asset`, `in`/`out` (source seconds), `speed`; length `(out - in) / speed`.
  - `timeline`: `source` is another timeline file, embedded as one clip.
  - adapter types such as `hyperframes` or `remotion`: `source`, `duration`, `props`.
  - optional on any of these: `audio` (`gain` dB, `muted`), `transform` (`x`, `y` in project pixels, `scale`, `opacity` 0-1), `scriptRef` (`scripts/x.md#scene`).
- **Multicam:** `groups` holds multicam groups: `id`, `angles` (`id`, `name`, `asset`, `offset` = group second where the asset's 0 plays, optional `crop` fractions per side, `audio`, `speaker` = transcript speaker whose words are its turns on a shared mic). A `program` track names one `group` and holds `shot` clips: `shot` (`solo` 1 angle, `two-up` 2, `grid` 2+), `angles` (ids of that group), `in`/`out` on the group clock, optional `confidence`/`reason`. Shots switch pictures only: every angle's sound plays under every shot. `multicam create` makes a group with its program track and a first `grid` shot from one file per person, synced by audio (see cli.md). `direct` fills the program track with shots by the rules of `director.json` (`template`, `minShot`, `maxShot`, `cutLead`, `twoShot`, `wide`, `cutaway`, `weights`; see cli.md). `shot set` changes a shot's layout and angles, `multicam angle` an angle's name, crop, sound and speaker, `multicam offset` its sync. `cut`, `clip trim`/`split`/`move`/`remove` work on shots, the desktop preview plays them, and export renders them; adding more shots is not supported yet. A program track nested under a transformed video clip is refused by export with `ExportUnsupported` and shows a placeholder in the preview.
- Times snap to the project frame grid (`1/fps`), stored with 3 decimals. Duration is derived, never stored.

## Transcript

`transcripts/<asset minus extension>.words.json` (extension kept when two assets share a base name; the file's `asset` field names its asset):

- `words`: `{ id: "w_000001", text, start, end, confidence }`, source seconds of that asset. An id always names the same word, across re-transcriptions. `speechInside: true`: the span hides more speech than the word; never cut inside it.
- `edits`: human corrections keyed by word id, `{ "w_000002": { "text": "a todos" } }`, or who says it, `{ "w_000002": { "speaker": "s2" } }`. Subtitles and verify show the edited text. Correct a word by adding to `edits`; leave `words` as the engine wrote them.
- `speakers` (after `transcribe --speakers`): `[{ id: "s1", name: "Ana" }]`; each word then has a `speaker` id. Rename a person by changing `name`, never the `id`.
- `assetHash`: the transcript is stale when the asset changes; re-run `transcribe`.

## Scripts

Plain Markdown; optional frontmatter `title`, `target_duration`, `aspect`. Each `## ` heading is a scene whose slug is the anchor in a clip's `scriptRef`. `frameshell script outline <file>` lists scenes, their refs and the clips linked to each; empty scenes still need footage. A scene may name its transcript words with `<!-- words: talk.words.json w_000010..w_000042 -->` right under the heading (word ids repeat across transcripts, so name the file; the bare `w_000010..w_000042` works only when one transcript holds both ids); the outline then gives `wordRange` and `span` (timeline seconds those words occupy, per timeline), so you can place its clips on the words. Clips do not follow their words when audio is cut: re-read the outline after cutting. Unknown ids, an ambiguous bare range or a reversed range come back as `warnings`.

## Direct timeline edits

Editing `timelines/*.json` by hand is allowed, as a last resort for a change no command expresses. The daemon accepts the edit only when the file's `revision` equals its current one and the result is valid, and journals it as author `file`. Otherwise it restores its version and keeps yours under `.frameshell/rejected/`; `frameshell status` lists why. Read the file right before editing and keep `revision` as read.
