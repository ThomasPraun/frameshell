# Spike: whisper.cpp word timing in Spanish (PROTOTYPE, throwaway)

Answers ticket #4: which whisper model/quantization Frameshell defaults to, how word
timestamps are obtained, and whether cuts must snap to audio energy valleys (ticket #12).
Decision: [`docs/adr/0003-transcription-engine-and-timestamps.md`](../../docs/adr/0003-transcription-engine-and-timestamps.md).
Measured numbers: [`results/summary.md`](results/summary.md) (generated, committed).

Self-contained package. Not part of any pnpm workspace. Everything heavy (whisper.cpp
clone and build, models, media, raw outputs, Python venv) lives in gitignored folders.

## Reproduce

Requirements: macOS on Apple Silicon, `cmake`, `clang`, `uv`, `node` 22, `curl`. Nothing is
installed system-wide; ffmpeg comes from the `ffmpeg-static` npm package.

```sh
npm install && npm run setup && npm run fixture   # ~4 GB download: whisper.cpp, 3 ggml models, CT2 model, audio
npm run transcribe && npm run analyze              # ~45 min on an M3 (faster-whisper float32 is most of it)
```

`npm run transcribe -- <filter>` reruns only matching configs (`--force` overwrites).

| Script | Does |
|---|---|
| `scripts/setup.sh` | clones whisper.cpp at a pinned commit, builds with Metal (`-ng` gives CPU runs from the same binary), downloads `ggml-large-v3-turbo` (f16), `q8_0`, `q5_0`, Silero VAD, and the faster-whisper venv + CT2 `large-v3-turbo` weights |
| `scripts/fixture.mjs` | downloads the source recording, converts to 16 kHz mono WAV, builds the variant |
| `scripts/transcribe.mjs` | runs the config matrix, normalizes words to `out/<run>__<audio>.words.json` |
| `scripts/fw_transcribe.py` | faster-whisper runner (`word_timestamps=True`, beam 5, no VAD) |
| `scripts/analyze.mjs` | WER, cross-engine offsets, energy checks, variant consistency |

## Fixture

- Source: LibriVox, *Estudio sobre el arte de hablar en público* (Louis Bautain), chapter 9,
  read in Spanish by "Tux". 9:47, single reader, clean studio-like audio.
  URL: <https://archive.org/download/hablarenpublico_1803_librivox/hablarenpublico_09_bautain.mp3>
  (item page <https://archive.org/details/hablarenpublico_1803_librivox>).
  License: Public Domain Mark 1.0 (<http://creativecommons.org/publicdomain/mark/1.0/>), as all LibriVox recordings.
- `media/original.wav`: the chapter, 16 kHz mono.
- `media/variant.wav`: original plus four silences (2.5, 4, 6, 3 s, placed inside
  existing pauses), one 2.4 s phrase repeated after a 0.8 s gap (a retake), and constant
  -60 dBFS room noise over the whole file (the LibriVox audio is noise-gated, a raw take
  is not). `media/variant.json` holds the edit map.

## Method (no human ground truth)

- **Text:** WER between engines after lowercasing and stripping punctuation. Reference
  `fw-f32-cpu` (faster-whisper, float32): independent implementation of the same weights.
- **Offsets:** words aligned by Levenshtein; |start| and |end| differences on exact matches.
- **Energy:** RMS per 10 ms hop (20 ms window). Speech = within 40 dB of the speech
  level (p90 of frames) and 10 dB above the floor (p10). Pauses = runs below that
  threshold ≥ 200 ms.
  - *Pause edges:* nearest reported word end vs energy pause start, nearest reported
    word start vs pause end (within ±1 s, else "missed"). A cut at a reported time
    "clips" when it lands more than 20 ms inside speech.
  - *All boundaries:* is the midpoint between consecutive words above threshold? Would
    snapping to the lowest-energy frame within ±100 ms bring it below?
- **Variant:** same engine on the variant; times mapped back through the edit map give drift;
  words inside inserted silences are hallucinations; the repeated phrase should appear twice.
- **DTW:** whisper.cpp stores one DTW time per token (its onset), so DTW views have
  starts only. `dtw-bias` shifts onsets by −140 ms, a bias fitted on this same fixture.
- **Speed:** RTF = wall time (including model load) / audio duration. 4 threads. The
  1-min load average before/after each run is recorded, because the machine was shared.

Limits: energy pause edges are not word edges. Soft word endings (/s/, breath, final
unstressed vowels) can sit under the threshold, so the energy "speech end" can be early
and slightly overstate clipping; connected speech often has no valley at all between words,
so the all-boundaries rate has a floor above 0 % even with perfect timestamps. faster-whisper float32 gave 1444 then 1450 words on two identical runs: engine output is not bit-stable. A LibriVox
reading is cleaner and more fluent than a talking-head take.

## Notes found while building

- whisper.cpp silently disables DTW when flash attention is on: DTW runs pass `-nfa`.
- whisper.cpp `--vad` + `-dtw` returns DTW times on the VAD-trimmed clock (seconds off).
- faster-whisper 1.2.1 with PyAV 19 fails in `decode_audio` (`metadata_errors` kwarg), so
  `fw_transcribe.py` decodes the WAV with numpy.
