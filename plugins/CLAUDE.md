# Plugins

Each plugin = own npm package; `files` whitelist (`node scripts/plugins-npm.mjs dry-run` checks tarballs). Author API `packages/plugin-api`. Host: `packages/core/src/CLAUDE.md`. Nested: `hyperframes/CLAUDE.md`, `blender/CLAUDE.md`.

| Plugin | Read |
|---|---|
| whisper-cpp (local transcription) | `packages/core/src/transcripts/CLAUDE.md` |
| remotion (bundle as cache input, outside-project code, `refreshRenders`; ADR 0009) | `remotion/src/`; element sheet bundle copy `remotion/src/elements.ts` |
| `@frameshell/openai-speech` (ADR 0034 decision 24) | `openai-speech/src/` (`provider.ts`, `prices.ts`, `wav.ts`); test `openai-speech/test/provider.test.ts`; host load `packages/core/test/openai-speech.test.ts`; install hint `SPEECH` in `packages/core/src/plugins/host.ts` |
| `@frameshell/openai-transcription` (ADR 0046) | `openai-transcription/src/` (long audio cut at pauses `pieces.ts`); test `openai-transcription/test/provider.test.ts`; consent: `packages/core/src/transcripts/CLAUDE.md` |

## Cloud providers (next cloud provider = same shape, own plugin)

- Key from `OPENAI_API_KEY` env only, read per call. Every network text through `scrub`; never in errors/progress/files.
- `scrub` of openai-transcription = hand copy of openai-speech's + parity test (`openai-transcription/test`).
- Price from one table `MODEL_PRICES` with source + date; unknown model = `estimate` throws. Speech: price per character; model env `FRAMESHELL_OPENAI_SPEECH_MODEL` in `version`. Transcription: `whisper-1` only.
- Tests stub HTTP server only, never real API.
