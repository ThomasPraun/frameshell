---
name: whisper-cpp
description: Transcribe project media to word level with the local whisper.cpp provider. Use before cutting footage by words, finding retakes or silences, or building subtitles.
---

# whisper-cpp transcription

`frameshell transcribe <asset>` writes `transcripts/<asset>.words.json`: every word with a stable `id`, `text`, `start`, `end` (source seconds, 3 decimals) and `confidence`.

- Language: pass `--language es` (or set `transcription.language` in `frameshell.json`). Without it whisper auto-detects.
- Models: `large-v3-turbo-q5_0` (default, 574 MB), `large-v3-turbo-q8_0`, `large-v3-turbo` (f16). Pick with `--model`.
- First run downloads the engine and model, and on macOS builds whisper.cpp and compiles Metal shaders: minutes, once. Later runs start in about 2 s.
- `start` is the DTW onset: it lags real speech by ~140 ms. `end` comes from audio energy. Neither is a safe cut point: cut in pauses between words, never at raw word times.
- whisper can drop a repeated phrase (a retake). Do not assume every spoken take is in the text; check pauses too.
- Human corrections live in `edits` (`{ "w_000002": { "text": "a todos" } }`). Re-transcribing keeps them for words found again.
