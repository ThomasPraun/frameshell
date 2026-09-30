# Transcript-driven editing

Cutting a recording by its words: remove silences and retakes, add subtitles, export, and prove no word was lost. Commands assume the session rule of [SKILL.md](../SKILL.md) (same `FRAMESHELL_SESSION` on every call).

## Steps

1. **Import.** `frameshell import <file…> --wait` copies the footage into `assets/` and blocks until its proxy, audio sidecar and waveform exist (exit 1 if one failed). `--link` avoids copying a large file (the source must stay). Done = every file shows `done`.
2. **Place it.** `frameshell track add video --name Camera --json`, then `frameshell clip add <track> assets/<file> --json` (whole asset at the track's end). Audio-only material goes on `track add audio`.
3. **Transcribe.** `frameshell transcribe assets/<file> --language <code> --json` writes `transcripts/<file minus extension>.words.json`; the output names the file. Needs a transcription plugin: when it fails with `TranscriptionProviderNotFound`, run the install command its message gives. The first run downloads the engine and a 574 MB model (minutes, once).
4. **Find what to remove** (see *Choosing cuts*). Write the ranges down in timeline seconds before cutting anything.
5. **Cut** inside one transaction, **last range first**: a cut shifts everything after it left, so cutting from the end keeps the earlier ranges valid.
   ```sh
   frameshell tx begin "remove silences"
   frameshell cut --from 41.2 --to 43.0 --json
   frameshell cut --from 12.4 --to 13.1 --json
   frameshell tx commit
   ```
   Each edge **snaps** into the nearest audio pause within ±0.5 s (`editing.snapWindow` in `frameshell.json`, or `--snap-window 0.5-10`) so no word is clipped. Read `snaps` in the output: `clean: false` means no pause was in reach and speech may be clipped there; check that range, widen `--snap-window`, or move the edge. `--no-snap` cuts at exact times; keep it for material with no speech.
6. **Look.** `frameshell timeline show` to confirm the clip count and duration; `frame --at <s>` at a few cut points when the picture matters (a jump in framing, a slide change).
7. **Export.** `frameshell render --preset youtube-1440p --json` (presets: `youtube-1080p`, `youtube-1440p`, `vertical-1080x1920`; default `export.defaultPreset`). The command waits for the render job and prints the output path (`exports/<timeline>-<preset>.mp4` unless `--out`).
8. **Verify.** `frameshell transcribe --verify exports/<file>.mp4 --json` re-transcribes the export and lists in `lost` every kept word cut off at a clip edge, with its timeline position `at`, `clip` and `cut`. Fix each: extend the edge over the word with `frameshell clip trim <clip> --out <s> --ripple` (tail) or `--in <s> --ripple` (head), render, verify again. `uncertain` lists words to check by ear (`repeat`: whisper may have collapsed a retake; `garbled`; `unheard`). `unchecked` names clips whose asset has no current transcript.

Done = `lost` is empty, every `uncertain` word reviewed, and the user has the export path and the transaction ids.

## Choosing cuts

Transcript words carry `id`, `text`, `start`, `end` in source seconds (see [project-model.md](project-model.md#transcript)). Word `start` lags real speech by ~140 ms; `end` comes from audio energy. Neither is a safe cut point by itself: cut in the pause between words and let snapping place the edge.

- **Silence:** a gap between one word's `end` and the next word's `start` longer than the user wants (default: 0.7 s). Cut from `end + 0.1` to `start - 0.2` so a little air stays on both sides. Map to timeline time with the clip's `start`, `in` and `speed` before cutting.
- **Retake:** the same phrase said twice or more in a row, often after a pause or a false start ("so the, so the key idea…"). Keep the last complete take unless the user says otherwise; cut from the start of the first take to the start of the kept one. whisper can drop a repeated phrase from the text entirely, so also inspect long pauses followed by a restart of the same sentence.
- **Intro/outro chatter:** material before the first sentence of content and after the last one.

## Subtitles

A subtitle track copies no words: it shows the transcript words inside each clip of the track it follows, so cuts update it automatically.

```sh
frameshell track add subtitles --follows <video track> --preset big-keyword --position bottom --json
```

`--preset big-keyword` (few large words, the spoken one highlighted) or `plain`; `--position top|center|bottom`; change later with `frameshell track set <track> --preset … --position …`. Export burns them in, identical to the preview. Fix a misheard word in the transcript's `edits` (keyed by word id), not in the track.

## Speed and sound

- `frameshell clip set <clip> --speed 1.1`: faster delivery; the clip's end moves, later clips do not (cut or move to close gaps).
- `frameshell clip set <clip> --gain=-6` (negative values need `=`), `--muted`.
- Loudness is normalized at export: the preset's `loudness` (built-in presets set none), else `export.loudness` in `frameshell.json`, else -17 LUFS.
