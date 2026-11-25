# Transcription

| Working on | Read |
|---|---|
| Transcript file, word ids, audio source, export verify | `transcriber.ts`, `verify.ts` + `align.ts`; provider `plugins/whisper-cpp` |
| Models (per-machine registry, app picker in transcript toolbar) | `model-registry.ts`, `providerContext` in `transcriber.ts`; wire `packages/protocol/src/models.ts`; CLI `packages/cli/src/model-commands.ts`; app `apps/desktop/src/renderer/src/components/ModelPicker.tsx`, `apps/desktop/src/renderer/src/transcript/model-choice.ts` |
| Cloud transcription consent (ADR 0046) | `consent.ts`; `localTranscription` in `packages/core/src/daemon.ts`; `TranscriptionProvider.free/remote/estimate` in `packages/plugin-api/src/index.ts`; app ask: `apps/desktop/src/main/CLAUDE.md`; provider `plugins/CLAUDE.md` |
| Text-only cloud models (ADR 0046 d11: cloud text over local whisper.cpp times) | `text-timing.ts` (`timeText`), `localTiming` in `transcriber.ts`; `ProviderModel.textOnly`, `TranscribeContext.timesText` in `packages/plugin-api/src/index.ts` |
| Words on timeline clock | `timeline-words.ts` (`placeWords`); `window.ts` |

## Rules

- Project names model id only. Per-machine registry `models.json` in `configDir`: id → file + SHA-256 + default per provider. ggml/gguf/ONNX only, pickle refused. `modelHash` in transcript. CLI `model`.
- Consent gate `confirmTranscription` in `transcribe` only, every run. Token = provider + model + asset hash + cost in whole cents. Ask carries `costUnknown` (not in token; `cost` null + false = declares free, no estimate; missing = unknown).
- Text-only model: local engine loaded before the ask, run before the upload; provider asked once (re-check windows local). One `timeText`, never a second text aligner.
- Every other caller loads via daemon `localTranscription` (`requireLocalTranscription`), never `plugins.transcriptionProvider` directly. `whisper-cpp` id free at any version.
