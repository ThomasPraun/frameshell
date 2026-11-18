# Spike: Kokoro-82M as a local voice, own G2P (PROTOTYPE, throwaway)

Spike of [#677](https://github.com/ThomasPraun/frameshell/issues/677) (epic #451, ADR 0034 decision 14). Answers: speed of
Kokoro on ONNX Runtime Web single-threaded WebAssembly on a laptop CPU, Spanish quality through the pipeline's own
whisper round trip, and whether a TypeScript G2P with no GPL code or data (no eSpeak NG, no `phonemizer`) is good
enough. Findings and numbers: [`docs/research/kokoro-local-voice.md`](../../docs/research/kokoro-local-voice.md).

Self-contained npm package with no dependencies, never part of the pnpm workspace. It imports the **built** repo
(`pnpm build` at the repo root first): core's one ONNX loader `loadOnnxModel` (`packages/core/dist/onnx-web.js`) on
the managed onnxruntime-web 1.30.0, the number speller (`spellNumbersIn`), the WAV writer, `verifyTakes` and
`spokenTokens`, and the whisper-cpp plugin. TypeScript runs as is (Node >= 23.6 strips types).

| Path | What |
|---|---|
| `src/pins.ts` | Pinned files: model variants (Hugging Face revision + large-file SHA-256), five voices, tokenizer, misaki dictionary |
| `src/fetch.ts` | Downloads them into the work dir, size + hash checked |
| `src/g2p-es.ts` | Spanish: orthography rules to Kokoro phonemes (seseo, yeísmo, b/d/g allophones, stress, glides) |
| `src/g2p-en.ts` | English: misaki US gold dictionary, -s/-ed/-ing endings, crude letter fallback |
| `src/kokoro.ts` | Token ids from `tokenizer.json`, style row by token count, 510-token chunking, one run per chunk |
| `src/lines.ts` | Test lines (display form; spoken form = `spellNumbersIn`) |
| `src/g2p-show.ts` | Prints phonemes and token counts of every line |
| `src/bench-one.ts`, `src/bench.ts` | Cold load, ms and real-time factor per line (wall and thread CPU), peak RSS, main thread vs worker |
| `src/synth.ts` | Kokoro takes of the quality lines (one variant, voice, language, G2P options) |
| `src/baseline.ts` | Takes from a TTS program run like the `command` provider (stdin text, `{out}`) |
| `scripts/sapi-command.txt` | Windows SAPI (Zira, en-US) as such a program |
| `src/check.ts` | `verifyTakes` with whisper-cpp over a take set; WER by `spokenTokens`; writes `results/<tag>.json` |
| `src/clean.ts` | Deletes the work dir |
| `results/` | The measured JSON behind the note (committed; no audio, no weights) |

## Reproduce

Weights (~92 MB int8, 325 MB fp32, 86 MB q8f16), whisper.cpp with its 574 MB model and every WAV go to the work
dir, `$TMPDIR/frameshell-kokoro-spike` (override `KOKORO_SPIKE_DIR`), never into the repo.

```sh
pnpm install --frozen-lockfile && pnpm build          # repo root
export FRAMESHELL_TEST_BINARIES_DIR=<repo>/.cache/test-binaries   # ffmpeg + onnxruntime-web (installed by the media tests)
cd spikes/kokoro
node src/fetch.ts int8 q8f16 fp32
node src/g2p-show.ts
node src/bench.ts int8 q8f16 fp32                     # long: one cold process per variant and mode
KOKORO_LINES=s-03s,s-08s node src/bench-one.ts int8 worker
node src/synth.ts es-int8-dora int8 ef_dora es        # WAVs to listen to: <work dir>/out/quality/es-int8-dora/
node src/synth.ts es-int8-alex int8 em_alex es
node src/synth.ts en-int8-heart int8 af_heart en
node src/synth.ts es-fp32-dora fp32 ef_dora es
node src/synth.ts es-int8-dora-stops int8 ef_dora es --no-allophones
node src/check.ts es-int8-dora es-int8-alex en-int8-heart es-fp32-dora es-int8-dora-stops
# command-provider baseline (macOS Spanish voice; any program that reads stdin and writes a WAV works):
node src/baseline.ts es-say-paulina es say -v Paulina --data-format=LEI16@22050 -o {out} -f -
node src/check.ts es-say-paulina
node src/clean.ts                                     # deletes downloads, whisper, WAVs
```
