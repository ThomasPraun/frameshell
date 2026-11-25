# Plugins

Each plugin = own npm package; `files` whitelist (`node scripts/plugins-npm.mjs dry-run` checks tarballs). Author API `packages/plugin-api`. Host: `packages/core/src/CLAUDE.md`. Nested: `hyperframes/CLAUDE.md`, `blender/CLAUDE.md`.

| Plugin | Read |
|---|---|
| whisper-cpp (local transcription) | `packages/core/src/transcripts/CLAUDE.md` |
| remotion (bundle as cache input, outside-project code, `refreshRenders`; ADR 0009) | `remotion/src/`; element sheet bundle copy `remotion/src/elements.ts` |
| `@frameshell/openai-speech` (ADR 0034 decision 24) | `openai-speech/src/` (`provider.ts`, `prices.ts`, `wav.ts`); test `openai-speech/test/provider.test.ts`; host load `packages/core/test/openai-speech.test.ts`; install hint from the official table (below) |
| `@frameshell/openai-transcription` (ADR 0046) | `openai-transcription/src/` (long audio cut at pauses `pieces.ts`); test `openai-transcription/test/provider.test.ts`; consent: `packages/core/src/transcripts/CLAUDE.md` |

## Official plugin table

- ONE list of official plugins: `OFFICIAL_PLUGINS` in `packages/protocol/src/official-plugins.ts` (package, kind, provided ids, purpose, need, paid/cloud, managed downloads). Read by host install hints (`providerHint` in `packages/core/src/plugins/host.ts`), `plugin.catalog` (`packages/core/src/plugins/catalog.ts`), app `TRANSCRIPTION_PLUGIN`. Never a second list.
- Add, rename or change plugin: edit table in same change. `packages/core/test/official-plugins.test.ts` checks it vs `plugins/*` manifests + binary manifest.
- Only official plugins in catalog. Third-party stay terminal-only.

## Cloud providers (next cloud provider = same shape, own plugin)

- Key from `OPENAI_API_KEY` env, read per call; the app may put it there in the daemon (`credentials.provide`, key field in Plugins, ADR 0050). Plugins never read a key file. Every network text through `scrub`; never in errors/progress/files.
- `scrub` of openai-transcription = hand copy of openai-speech's + parity test (`openai-transcription/test`).
- Price from one table `MODEL_PRICES` with source + date; unknown model = `estimate` throws. Speech: price per character; model env `FRAMESHELL_OPENAI_SPEECH_MODEL` in `version`. Transcription: `gpt-transcribe` (`textOnly`, host times it, ADR 0046 d11) + `whisper-1` until 2027-02-26.
- Tests stub HTTP server only, never real API.
