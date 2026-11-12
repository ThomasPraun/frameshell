# Transcript-driven editing

Cutting a recording by its words: remove silences and retakes, add subtitles, export, and prove no word was lost. Commands assume the session rule of [SKILL.md](../SKILL.md) (same `FRAMESHELL_SESSION` on every call).

## Steps

1. **Import.** `frameshell import <file…> --wait` copies the footage into `assets/` and blocks until its proxy, audio sidecar and waveform exist (exit 1 if one failed). `--link` avoids copying a large file (the source must stay). Done = every file shows `done`.
2. **Place it.** `frameshell track add video --name Camera --json`, then `frameshell clip add <track> assets/<file> --json` (whole asset at the track's end). Audio-only material goes on `track add audio`.
3. **Transcribe.** `frameshell transcribe assets/<file> --language <code> --json` writes `transcripts/<file minus extension>.words.json`; the output names the file. Needs a transcription plugin: when it fails with `TranscriptionProviderNotFound`, run the install command its message gives. The first run downloads the engine and a 574 MB model (minutes, once). The model is the project's `transcription.model`, else this machine's default, else the provider's; see *Choosing the model*.
4. **Find what to remove.** For silences and retakes start with `frameshell cleanup --retakes --dry-run --json` (see *Cleanup*): it lists the cuts with their words, reason and confidence. Anything else (intro chatter, off-topic passages): see *Choosing cuts*, and write the ranges down in timeline seconds before cutting anything.
5. **Cut** inside one transaction, **last range first**: a cut shifts everything after it left, so cutting from the end keeps the earlier ranges valid.
   ```sh
   frameshell tx begin "remove silences"
   frameshell cut --from 41.2 --to 43.0 --json
   frameshell cut --from 12.4 --to 13.1 --json
   frameshell tx commit
   ```
   Each edge **snaps** into the nearest audio pause within ±0.5 s (`editing.snapWindow` in `frameshell.json`, or `--snap-window 0.5-10`) so no word is clipped. Read `snaps` in the output: `clean: false` means no pause was in reach and speech may be clipped there; check that range, widen `--snap-window`, or move the edge. `--no-snap` cuts at exact times; keep it for material with no speech.
   A cut of every track carries markers along (`marker list`): those after it move with the material, those inside the range are removed and `warnings` names them; `revert` brings them back. A marker exactly on the cut's first frame stays. A cut of only some tracks (`cut <track>…`) leaves markers where they are. A `--ripple` trim that shortens a clip treats the removed material the same way.
   A cut that trims or splits a generated clip (`hyperframes`, `remotion`…) still applies and adds a `warnings` entry naming the clip id, type and `scriptRef`. Edit the audio first, then build visuals; after a late cut, re-place those clips against their script scene.
6. **Look.** `frameshell timeline show` to confirm the clip count and duration; `frame --at <s>` at a few cut points when the picture matters (a jump in framing, a slide change).
7. **Export.** `frameshell render --preset youtube-1440p --json` (presets: `youtube-1080p`, `youtube-1440p`, `vertical-1080x1920`; default `export.defaultPreset`). The command waits for the render job and prints the output path (`exports/<timeline>-<preset>.mp4` unless `--out`). A vertical or square cut of the same edit: `frameshell format add 9x16`, then `frameshell render --formats 16x9,9x16` (one file per format; the preset's aspect must match each format, so leave `--preset` out).
8. **Verify.** `frameshell transcribe --verify exports/<file>.mp4 --json` re-transcribes the export and lists in `lost` every kept word cut off at a clip edge (`clipped: true`, not heard even in a re-check of the audio around it), with its timeline position `at`, `clip` and `cut`. Fix each: extend the edge over the word with `frameshell clip trim <clip> --out <s> --ripple` (tail) or `--in <s> --ripple` (head), render, verify again. `uncertain` lists words to check by ear (`repeat`: whisper may have collapsed a retake; `garbled`; `unheard`: a recognition miss, the audio is there). Never trim for an `uncertain` word: a trim fixes only a cut that falls inside a word. `unchecked` names clips whose asset has no current transcript. The report is the whole check: it writes no transcript, so there is nothing to transcribe or clean up afterwards.

Done = `lost` is empty, every `uncertain` word reviewed, and the user has the export path and the transaction ids.

## Choosing the model

`frameshell model list --json` shows the models the provider ships (size, downloaded), model files registered on this machine, this machine's defaults (`defaults`) and what `transcribe` uses in this project (`project.effective`).

- A user's own model file (a fine-tuned Whisper for their language) is registered once per machine by id: `frameshell model add <id> <file> --dtw <preset>`. whisper.cpp reads ggml files; `--dtw` names the alignment preset of the model it was trained from (`small`, `large.v3`, …) and keeps word starts precise; without it word starts come from token times and `transcribe` warns. Only register a file the user named. Pickle checkpoints (`.nemo`, `.pt`, `.ckpt`) fail with `UnsupportedModelFormat`: ask for the model's ggml or ONNX export.
- `frameshell model use <id>` writes the project's `transcription.model` (`default` removes it); `frameshell model default <id> --provider whisper-cpp` sets this machine's default for projects that name none. `frameshell model remove <id>` forgets a registration, never the file.
- The project names only the id, so it stays portable: on a machine where that id is not registered, `transcribe` fails with `ModelNotRegistered` and says how to register it. Never switch to another model on your own; ask the user for the file.
- A transcript made with a registered model records its `modelHash`. `transcribe` warns (`warnings`) when the file changed since it was registered.

## Cleanup

`frameshell cleanup` finds the dead air and false starts and cuts them; the edges come from the audio (whisper stretches words over silences), the words only say where to look.

```sh
frameshell cleanup --retakes --dry-run --json      # candidates, nothing changed
frameshell cleanup --retakes --skip r2 --json      # the same plan, without r2: one transaction
```

- **Show the table first.** Each candidate: `id` (`p1` pause, `r1` retake), `start`/`end` (timeline seconds), `words` removed, `reason`, `confidence` (0 to 1), `clean` (false: an edge found no pause and may clip speech). Ask the person which to drop, then run again with the same flags and `--skip` for those: the plan is made again from the timeline as it is, so ids match only while it has not changed.
- **Pauses:** gaps between kept words over `--pauses` seconds (default 0.4) that the audio confirms quiet, cut leaving `--breath` seconds (default 0.1) on each side. A pause after a punchline or a laugh is content: look at the gaps whose `reason` follows a joke before accepting them. `--no-pauses --retakes` looks only for false starts.
- **Retakes:** `--retakes` cuts the earlier attempt of a phrase said again and keeps the last. One repeated word ("very, very") is weak (low confidence, below `--min-confidence 0.5` unless a stop separates the attempts): `skipped` lists what was left. Check a retake by ear when it is a list or an emphasis.
- Only speech covered by transcripts is cut; `warnings` names clips left alone (no transcript, an older transcript than the file, no audio). Transcribe first.
- The result is a normal transcript edit: cut words show struck through in the transcript view and one click restores them; `frameshell revert <tx>` undoes the run. With review mode on it waits as one proposal.
- Run `transcribe --verify` after exporting, as for any cut.

## Choosing cuts

By hand: what `cleanup` does not cover (intro and outro chatter, passages the person names, silence hidden inside a long word) or when its candidates need other edges.

Transcript words carry `id`, `text`, `start`, `end` in source seconds (see [project-model.md](project-model.md#transcript)). Word `start` lags real speech by ~140 ms; `end` comes from audio energy. Neither is a safe cut point by itself: cut in the pause between words and let snapping place the edge.

- **Silence:** a gap between one word's `end` and the next word's `start` longer than the user wants (default: 0.7 s). Cut from `end + 0.1` to `start - 0.2` so a little air stays on both sides.
- **Silence hidden in a word:** a word lasting far longer than its text needs (over ~0.8 s for a short word, ~1.2 s for a long one) usually swallowed the pause after it: whisper sometimes stretches `end` up to the next onset. Cut from `start + 0.6` to the next word's `start - 0.5` (onsets can lag speech that much), and let snapping find the pause. **Never when the word has `speechInside: true`** (also listed in `transcribe`'s `speechInside`): it hides speech the transcript lacks, such as a swallowed retake. Cutting inside it deletes real words; ask the user to check it by ear in the app before cutting there. `transcribe` already re-transcribes such words alone and splices in the words it finds (`recoveredWords`), so a flag means that failed. Only words over 1.5 s are checked: no flag on a shorter long word proves nothing, so look at its energy or listen before cutting inside it.
- Map every range to timeline time with the clip's `start`, `in` and `speed` before cutting. After cutting, read `snaps`: an edge with `clean: false` found no pause and may clip speech; `frameshell revert <op>` and cut a narrower range. `transcribe --verify` is the final check.
- **Retake:** the same phrase said twice or more in a row, often after a pause or a false start ("so the, so the key idea…"). Keep the last complete take unless the user says otherwise; cut from the start of the first take to the start of the kept one. whisper can drop a repeated phrase from the text entirely, so also inspect long pauses followed by a restart of the same sentence.
- **Intro/outro chatter:** material before the first sentence of content and after the last one.

## Subtitles

A subtitle track copies no words: it shows the transcript words inside each clip of the track it follows, so cuts update it automatically.

```sh
frameshell track add subtitles --follows <video track> --preset big-keyword --position bottom --json
```

`--preset big-keyword` (few large words, the spoken one highlighted) or `plain`; `--position top|center|bottom`; change later with `frameshell track set <track> --preset … --position …`. Export burns them in, identical to the preview. Fix a misheard word in the transcript's `edits` (keyed by word id), not in the track.

### Chosen keywords, chunking and soft entries

The automatic grouping reads well for talk; short-form reels read better with your own chunks and one emphasised word per phrase. Write the phrases, do not edit the transcript:

```sh
frameshell captions set <subtitle track> --from 12 --to 18 --text "No need to | open any | *editor*
Just ask | and it *edits*"
```

- One phrase per line; `|` ends a cue (a chunk); the phrase's one keyword goes between asterisks; `[chars]`, `[words]`, `[line]` or `[none]` at the start of a line sets that phrase's entry. `--file <path>` reads the same text from a project file.
- The text must cover **every word the track shows between `--from` and `--to`**, in order, matched by position: a lost or repeated word fails and the error names the first difference. Words that only differ in spelling (digits, case, punctuation) warn. The result lists the cues it made (keyword starred); check them, then look at frames with `frame` or `inspect`.
- Phrases are stored as transcript word ids, so cuts and transcript corrections keep them (a removed word just leaves its chunk). Words no phrase holds keep the automatic grouping. Phrases that share a word with new ones are replaced; `--replace` first drops all of the track's phrases (alone, it clears them). One transaction: `revert` undoes it.
- Timing is fixed: a chunk lasts until the next cue starts, at most 0.35 s after its last word, never under 0.4 s. Chunk by energy: 2-3 words for high energy, 3-5 for conversation, 4-6 for calm; break at pauses.
- Style (`track set`): `--entry chars|words|line` fades the text in over 0.4 s (ease out, slight blur, no bounce; `words` shows each word as it is spoken); `--keyword-color #rrggbb` (`none` for no colour; default the accent) and `--keyword-scale 1.12` (the keyword settles from that size while it enters). One keyword per phrase, approved by the person before the final render; calm styles use `--keyword-color none`.
- `--gap 12-15.5` hides every cue that overlaps the range, for when a graphic already says it; `--clear-gaps` removes them.
- Preview and export draw the same cues; during the 0.4 s entry the keyword's scale is only approximate in the preview.

## Speed and sound

- `frameshell clip set <clip> --speed 1.1`: faster delivery; the clip's end moves, later clips do not (cut or move to close gaps).
- `frameshell clip set <clip> --gain=-6` (negative values need `=`), `--muted`.
- `frameshell clip set <clip> --voice`: the voice chain for phone or laptop recordings (high-pass, light denoise, gentle compression; the numbers of `style.json` `sound.voice` when the project sets them), written into the clip as explicit `audio.effects` you can edit; `--audio-effects '<json>'` sets your own list, `--clear-audio-effects` removes it. The sound is baked in the background: export waits for it, the preview plays the dry sound until it is ready. Cut snapping and transcription keep using the dry sound.
- Loudness is normalized at export: the preset's `loudness` (built-in presets set none), else `export.loudness` in `frameshell.json`, else -17 LUFS.
