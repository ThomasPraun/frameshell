# Kokoro-82M as a local voice: speed, Spanish quality and an own G2P (#677)

ADR 0034 decision 14 keeps Kokoro-82M as the local voice candidate, behind a spike, with a grapheme-to-phoneme step
written in TypeScript and nothing GPL anywhere (no eSpeak NG, no `phonemizer`). This spike ran Kokoro on the ONNX
Runtime Web pin Frameshell already has, through core's one loader, with an own Spanish and English G2P, and measured
speed on a laptop CPU and quality through the voiceover pipeline's own misread round trip. Throwaway code and how to
reproduce: [`spikes/kokoro/`](../../spikes/kokoro/README.md). Measured JSON: `spikes/kokoro/results/`.

**Status: provisional.** The owner listens to the takes after this note lands (about 10 minutes, commands in
[Listening](#listening-the-one-human-step)); the verdict stands or changes with that.

## Question and the go rule (set before measuring)

Owner decisions of 2026-11-18 (#677, Q3). Kokoro goes ahead only if all three hold:

1. **Speed:** real-time factor (synthesis time / audio length) **below 1.0** on one laptop CPU, single-threaded
   WebAssembly (`numThreads = 1`, as `loadOnnxModel` sets it), for the int8 or the fp32 weights.
2. **Spanish quality:** word error rate of the Spanish lines through the whisper round trip **within 5 points of the
   `command` provider baseline** on the same lines.
3. **Licences:** no GPL code or data in the path; int8 weights (~92 MB) downloaded on demand.

## Verdict

**No-go for now, on speed alone** (provisional until the owner has listened and, if he wants, run the bench on his
Mac). Quality and licences pass:

| Criterion | Threshold | Result | |
|---|---|---|---|
| Speed | RTF < 1.0, single-threaded WASM | int8 **RTF 4.2 to 5.4** on an i7-8550U (fp32 and q8f16 the same); projected about 2 on an Apple M3 | **fails** |
| Spanish WER | within 5 points of the command baseline | **3.0 %** (int8, `ef_dora` and `em_alex`); 0 lines `misread` | **passes** |
| No GPL | none in code or data | own G2P; weights, voices, tokenizer, dictionary Apache-2.0 | **passes** |

The Spanish criterion passes whatever the baseline turns out to be: a baseline WER is at least 0, and 3.0 is within 5
points of any value from 0 up. No Spanish voice is installed on the measuring machine (only Microsoft Zira en-US and
Hedda de-DE), so the Spanish baseline itself was not measured; the command for a Mac is in [Reproduce](#reproduce).

Decision 14 of ADR 0034 is not edited by this PR. It already says Kokoro waits behind this spike; once the owner
confirms the verdict, the follow-up records it there as an as-built line (a no-go, or a go with the runtime change
below).

## Measurements

Machine: Intel Core i7-8550U (4 cores, 8 threads, 1.8 GHz base), 20 GB RAM, Windows 11 Home (10.0.26300), Node
26.13.1, `onnxruntime-web` 1.30.0 as the binary manager installs it (`ort.wasm.min.mjs` + `ort-wasm-simd-threaded.wasm`),
loaded by `loadOnnxModel` (`packages/core/src/onnx-web.ts`) with `numThreads = 1`. **The machine was shared with
other agents' jobs and read 100 % CPU load when checked during the runs**, so wall times are upper bounds. Each line also
records the CPU time of the thread that ran the model (`process.threadCpuUsage`), which load inflates less (hyper-
threads sharing a core and lower turbo clocks still slow it). One cold process per variant and mode; one warm-up run,
then each line once.

### Speed

int8 on every speed line, main thread (`results/speed-i7-8550U-int8-all.json`). RTF = synthesis wall time / audio
length; "cpu RTF" uses the model thread's CPU time instead:

| Line | Tokens | Audio | Synthesis | RTF | cpu RTF | Runs |
|---|---|---|---|---|---|---|
| `s-03s` (Spanish, short) | 37 | 2.4 s | 11.9 s | 4.97 | 4.75 | 1 |
| `s-08s` (Spanish) | 111 | 6.1 s | 31.7 s | 5.17 | 5.00 | 1 |
| `s-20s` (Spanish, 3 sentences) | 271 | 15.1 s | 77.1 s | 5.10 | 4.90 | 1 |
| `s-08s-en` (English) | 89 | 5.8 s | 30.9 s | 5.38 | 5.11 | 1 |
| `s-long` (Spanish paragraph) | 688 | 34.0 s | 162.8 s | 4.79 | 4.74 | 2 |

Variants on the two short lines, each in a fresh process, in the main thread and in a worker thread
(`results/speed-i7-8550U-variants.json`):

| Variant | Download | Cold load | RTF `s-03s` main / worker | RTF `s-08s` main / worker | Peak RSS main / worker |
|---|---|---|---|---|---|
| int8 `model_quantized.onnx` | 92.4 MB | 1.9 s / 2.3 s | 4.64 / 4.21 | 4.61 / 4.50 | 528 / 645 MB |
| q8f16 `model_q8f16.onnx` | 86.0 MB | 5.0 s / 4.8 s | 4.69 / 4.51 | 4.49 / 4.48 | 538 / 641 MB |
| fp32 `model.onnx` | 325.5 MB | 3.2 s / 2.5 s | 4.32 / 4.93 | 4.72 / 4.72 | 1234 / 1262 MB |

fp16 (`model_fp16.onnx`, 163 MB) was not run: on a CPU without fp16 arithmetic it can only be as fast as fp32 at
half the download, and q8f16 already covers the "small download" end.

- **RTF is about 4.5 to 5 for every variant and every length**, and it does not fall with longer lines. An earlier
  probe of the same lines under heavier load (other agents' builds) gave RTF 6.3 to 9.2 wall, 6.2 to 8.2 cpu: the
  numbers above are the less loaded run, and still upper bounds.
- **Quantization buys size, not speed.** int8 and q8f16 run at the fp32 speed on WebAssembly (as the SFace int8
  export was slower than fp32 there, `docs/binaries.md`), and the quality round trip did not find int8 worse than
  fp32 (below).
  int8 is the variant to pin: 92 MB and half the memory of fp32.
- **Cold load:** 1.9 to 2.3 s int8, 2.5 to 3.2 s fp32, about 5 s q8f16. The first run after load (a 4-token
  warm-up, `ˈola.`) took another 3.0 to 4.9 s.
- **Peak resident memory** of the whole process: 530 to 710 MB with int8 or q8f16, 1.2 GB with fp32.
- **Worker thread vs main thread:** the same speed within the noise of the shared machine; a worker costs about
  100 MB more resident memory. A provider belongs in a worker anyway: a 30-second synthesis on the daemon's event
  loop would stall every other request.
- **G2P:** under 3 ms a line, nothing next to the model.
- **Machine yardstick:** YuNet on a 512×288 frame through the same loader took 46.5 ms here (median of 40, right
  after the runs above); `docs/binaries.md` gives about 20 ms on an Apple M3. Scaling Kokoro by that ratio (2.3)
  projects **RTF about 2 on an M3**: an estimate, not a measurement. `node src/bench.ts int8 fp32` on the M3
  replaces it.

Why it is slow: Kokoro is StyleTTS 2 with an iSTFTNet decoder (model card) that makes the 24 kHz waveform through
stacks of 1-D convolutions and transposed convolutions, so the work grows with the audio, not the text, and one
WebAssembly thread does all of it. This spike did not profile which operators dominate.

### Sequence limit and chunking

Kokoro reads at most 512 ids: 510 phoneme tokens plus the pad id 0 at each end, and the style vector is the voice
pack's row for the token count (`voices/*.bin` is 510 rows of 256 floats). The 700-character Spanish paragraph
(`s-long`) is 688 tokens; `chunk()` cut it at a sentence end into 2 runs and joined the audio end to end. Each run
ends on its period's own trailing silence, so the join adds no pause of its own; whether it sounds like a sentence
end inside one run is for the owner's ear (not checked by a person yet). A sentence longer than 510 tokens falls back to commas,
then spaces. The model card notes voices do best between about 100 and 200 tokens (`VOICES.md`): a provider should
cut long lines at sentence ends well before 510.

### Quality through the misread round trip

Every take went through `verifyTakes` (`packages/core/src/voiceover/verify.ts`) with the whisper-cpp provider and
its default model `large-v3-turbo-q5_0`, exactly the check `voiceover.generate` runs, so `clean` / `doubtful` /
`misread` are the pipeline's own states. WER = word edits / script words, both sides read by `spokenTokens`
(`packages/schema/src/spoken.ts`: digits the transcription writes meet the spelled number), best of the spoken and
display forms as `checkLine` does. Lines are in `spikes/kokoro/src/lines.ts`; the spoken form is
`spellNumbersIn(display)`, what the voiceover script hands a provider.

| Take set (`results/<tag>.json`) | Voice | Lines | WER | clean / doubtful / misread |
|---|---|---|---|---|
| `es-int8-dora` | Kokoro int8, `ef_dora` | 10 Spanish (101 words) | **3.0 %** | 7 / 3 / 0 |
| `es-int8-alex` | Kokoro int8, `em_alex` | same | **3.0 %** | 7 / 3 / 0 |
| `es-fp32-dora` | Kokoro fp32, `ef_dora` | same | 5.0 % | 6 / 4 / 0 |
| `es-int8-dora-stops` | Kokoro int8, `ef_dora`, G2P without b/d/g allophones | same | 4.0 % | 6 / 4 / 0 |
| `en-int8-heart` | Kokoro int8, `af_heart` | 5 English (58 words) | 5.2 % | 3 / 1 / 1 |
| `en-sapi-zira` | `command` baseline: Windows SAPI Microsoft Zira (en-US) | same | 6.9 % | 3 / 1 / 1 |
| (Spanish `command` baseline) | none installed on the machine | | not measured | |

What the transcription heard differently, every set:

- **`Ximena` → "Simena"** (all Spanish sets): the G2P reads initial `x` as `s`; the name is said with `x` (Jimena).
  A rule gap, not the voice: an exception list or a respelling fixes it.
- **`ge` → "G"** (all Spanish sets): the transcription writes the letter's name as the letter; the take is right.
- **`Frameshell` → "Framesse" / "Framessey"** (Spanish) and **"Framichelle"** (English, letter fallback; Zira:
  "Frame shell"): an invented brand read by spelling rules. Every take with it was `doubtful`, never `misread`; a
  respelling `{Frameshell|freim shel}` is the pipeline's answer.
- **`perro` → "pero", `cerro` → "Cero"** (fp32 `ef_dora`; `cerro` also with the allophones off): a trill heard as a
  tap. The G2P gives `r` in all of them, the same ids for int8 and fp32, so this is the voice's rendering; the int8
  takes of both voices were heard right. One line is too little to call fp32 worse; it is no reason to pay 325 MB.
- **`dollars` missing twice** (`en-04`, Kokoro and Zira alike): whisper writes "$25", and `spokenTokens` does not read
  `$`; the take is right (see the pipeline finding at the end).

No Spanish line was `misread` in any set. Every Spanish difference is a name, a letter name or a trill.

## G2P

Kokoro reads phoneme symbols, not letters. Upstream, its Spanish voices were trained on espeak-ng `es` output
(`VOICES.md`: `lang_code='e'`, espeak-ng `es`), mapped into Kokoro's symbols by misaki's `EspeakG2P`; English on
misaki's own dictionaries with espeak as fallback. Both espeak and `phonemizer` are GPL-3.0, so neither is used, and
nothing from espeak-ng's rule or list files was copied: the Spanish rules below are written from Spanish spelling.

### Spanish (`spikes/kokoro/src/g2p-es.ts`, about 150 lines, no data file)

Spanish spelling is close to phonemic, so rules cover native words:

- **Letters:** `c` before e/i and `z` → `s` (seseo, Latin American; `θ` with `seseo: false`); `qu`, `c` → `k`;
  `gu` before e/i → `g`, `gü` → `gw`, `g` before e/i and `j` → `x`; `h` silent; `ll` → `ʝ` (yeísmo; `ʎ` optional);
  `y` → `ʝ`, but a vowel at the word end (`hoy`, `muy`) and as the word "y"; `ñ` → `ɲ`; `ch` → `ʧ`; `r` trilled
  word-initially, after l/n/s and as `rr`, tapped `ɾ` elsewhere; `x` → `ks`, `s` word-initially, `x` in a short list
  (México, Oaxaca, Texas); doubled consonants of loanwords said once.
- **b/v, d, g allophones:** stops after a pause or a nasal (and `d` after `l`), `β ð ɣ` elsewhere, across word
  boundaries, as espeak `es` writes them. `n` → `m` before labials, `ŋ` before velars.
- **Glides:** an unaccented i/u next to another vowel is not a nucleus: rising `j`/`w` (bueno → `bwˈeno`), falling
  kept as the vowel letter (aire → `ˈaiɾe`); `ui`/`iu`: the first glides.
- **Stress:** the written accent; otherwise penultimate nucleus for words ending in a vowel, n or s, last nucleus
  otherwise. Function words (articles, clitics, short prepositions and conjunctions) unstressed. The mark goes right
  before the stressed vowel, espeak's and misaki's placement (`kˈasa`).
- **Numbers:** not here: the voiceover script already hands providers `spellNumbersIn` text (the one number speller).

**Mismatch with espeak, measured:** the knob that most likely differs from espeak's output, the b/d/g allophones,
was switched off (`--no-allophones`: always `b d g`) and the same lines measured again: WER 4.0 % against 3.0 %,
the one extra difference a trill (`cerro`), not a b/d/g word. Kokoro reads both spellings intelligibly, so the round
trip cannot tell which is closer to its training; the allophones stay the default because espeak `es` writes them
(owner to judge by ear which sounds less clipped). Stress placement, glide symbols and `n` assimilation were not
varied.

**Where rules are not enough:** names and loanwords spelled by other languages' rules. `Ximena` (said Jimena) was
read `s` and heard "Simena"; `Frameshell` read as Spanish letters was heard "Framesse". `WhatsApp`, `Instagram`,
`YouTube` and `link` came through the rules clean. The pipeline already has the fix for the rest: a respelling
`{Frameshell|freim shel}` in the script (ADR 0034 decision 7), and a short exception list for frequent names (like
the `x` list) costs nothing.

### English (`spikes/kokoro/src/g2p-en.ts`)

- **Dictionary:** misaki's US "gold" lexicon (`misaki/data/us_gold.json`, 90,201 entries, 3.0 MB), Apache-2.0 as
  the whole misaki repository. It is written in exactly the symbols Kokoro's English voices were trained on, which a
  CMUdict mapping would only approximate. Heteronyms with part-of-speech entries (`read`, `record`) take `DEFAULT`.
- **Endings:** `-s`, `-'s`, `-ed`, `-ing` on a dictionary stem, attached the way misaki does (`minutes`, `dollars`,
  `pauses` are not in the gold list).
- **Context words:** `the` → `ðə` / `ði` before a vowel, `a` → `ə`, `an` → `ən`.
- **Fallback:** crude letter-to-sound with stress on the first vowel, for words in neither: in the test lines only
  `Frameshell` (heard "Framichelle"), the case a respelling covers.
- **CMUdict** (`cmusphinx/cmudict`, BSD-2-Clause-style licence of Carnegie Mellon University) is the alternative if
  the misaki list is ever unwanted: 135k words in ARPAbet, which needs a mapping to Kokoro's symbols (`AH0` → `ə`,
  `ER` → `ɜɹ`/`əɹ`, diphthongs → `A I W Y O`) and loses misaki's flap `ɾ` and `ᵊ`. Not used here.

## Licences

| Part | Source | Licence | Note |
|---|---|---|---|
| Kokoro-82M v1.0 weights (all ONNX variants) | `hexgrad/Kokoro-82M`, ONNX export `onnx-community/Kokoro-82M-v1.0-ONNX` | Apache-2.0 | Model card: trained on permissive or non-copyrighted audio; names CC BY data (Koniwa, SIWIS) in the training set, which concerns the training data, not a duty on the weights |
| Voice packs `voices/*.bin` | same repositories | Apache-2.0 | |
| `tokenizer.json` (the 114-symbol vocabulary) | `onnx-community/Kokoro-82M-v1.0-ONNX` | Apache-2.0 | Small enough to carry as a table in code |
| misaki US gold dictionary | `hexgrad/misaki` `misaki/data/us_gold.json` | Apache-2.0 (repository `LICENSE`) | The repository does not say where the entries come from |
| CMUdict (not used) | `cmusphinx/cmudict` | BSD-2-Clause-style (CMU) | |
| ONNX Runtime Web 1.30.0 | existing pin | MIT | unchanged |
| whisper.cpp + `large-v3-turbo-q5_0` | existing pins | MIT | the round trip only |
| Spanish and English G2P | this spike | Apache-2.0 (Frameshell) | no espeak-ng code or data, no `phonemizer` |

Kokoro was trained on espeak-ng phonemes, but the weights carry no GPL: espeak was a tool in training, and no espeak
code or data runs or ships here.

## Download and pin (proposed, not edited into `docs/binaries.md`)

On demand like MobileSAM: nothing downloads until the first `voiceover generate` with the Kokoro provider. From
Hugging Face, pinned by revision `1939ad2a8e416c0acfeecc08a694d14ef25f2231`, URL form
`https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/<revision>/<file>`, no mirror. Sizes and SHA-256
are the large-file oids at that revision, and each download in this spike hashed to them:

| Id | File | Size | SHA-256 | Licence |
|---|---|---|---|---|
| `kokoro-82m-int8` | `onnx/model_quantized.onnx` | 92.4 MB (92,361,116) | `fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478` | Apache-2.0 |
| (`kokoro-82m-fp32`) | `onnx/model.onnx` | 325.5 MB (325,532,232) | `8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb` | Apache-2.0 |
| `kokoro-voice-ef_dora` | `voices/ef_dora.bin` | 0.5 MB (522,240) | `f66ec66bd295acb18372e37008533a9a3228483ccd294e7538d5d9294ac9a532` | Apache-2.0 |
| `kokoro-voice-em_alex` | `voices/em_alex.bin` | 522,240 | `27809e9eafdcbcfff90a3016c697568676531de2a2c39cee29c96c7bd6b83e95` | Apache-2.0 |
| `kokoro-voice-em_santa` | `voices/em_santa.bin` | 522,240 | `ad43b774e1ca24d05c6161297d8aeb770ac3d29bb95daf516727af5f7d543683` | Apache-2.0 |
| `kokoro-voice-af_heart` | `voices/af_heart.bin` | 522,240 | `d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b` | Apache-2.0 |

Also measured, not proposed: `model_q8f16.onnx` 86,033,585 B, `04c658aec1b6008857c2ad10f8c589d4180d0ec427e7e6118ceb487e215c3cd0`;
`model_fp16.onnx` 163,234,740 B, `ba4527a874b42b21e35f468c10d326fdff3c7fc8cac1f85e9eb6c0dfc35c334a`.
The English dictionary, if downloaded rather than shipped: `https://raw.githubusercontent.com/hexgrad/misaki/fba1236595f2d2bf21d414ba6e57d25256afada3/misaki/data/us_gold.json`,
3,000,469 B, SHA-256 `dc414872a49a28ae6c141463d502fd945f3b2fde040484fdc47d00cc4612686f`. `tokenizer.json` at the
Kokoro revision: 3,497 B, `77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34`.

I/O the code depends on: inputs `input_ids` int64 `[1, n + 2]` (0, ids, 0), `style` float32 `[1, 256]` (voice row
`n`), `speed` float32 `[1]`; output `waveform` float32, 24 kHz mono.

## Follow-up slice (if the owner turns this into a go)

Only once speed has an answer: the single-threaded WebAssembly path this spike measured does not reach RTF 1 on a
laptop. Options, none measured here:

- **More threads.** The threaded WebAssembly build cannot start its workers under Node (`docs/binaries.md`), so
  one worker per sentence is the cheap way: lines cut at sentence ends run in parallel worker threads, each with its
  own session (about 0.5 GB each with int8). If it scaled perfectly, four workers on four cores would give RTF about
  1.2 on this laptop and about 0.5 on an M3; not measured, and four sessions hold about 2 GB.
- **A native runtime.** `onnxruntime-node` was rejected for face detection (native addons, about 300 MB). The pinned
  sherpa-onnx build ships native ONNX Runtime and has a Kokoro text-to-speech mode, but its Kokoro front end uses
  espeak-ng data for non-English text: whether its C API takes token ids from our G2P was not checked.
- **Accept slow generation** with progress (a 60-second script at RTF 5 is 5 minutes on this laptop, about 2 on an
  M3; cached takes are free afterwards, decision 9): a product call, not the owner's stated rule.

The slice itself, after that answer:

1. **Built-in `SpeechProvider`** `kokoro` in `packages/core/src/voiceover/` (`free: true`, `voices()` from the voice
   packs with `languages`), looked up with the stand-in and `command` providers (decision 4), running in a worker
   thread through `worker-task.ts` (one-shot) or a long-lived request/reply worker like `segment/engine.ts` (one
   loaded session reused across lines, idle free).
2. **G2P** as `voiceover/g2p-es.ts`, `g2p-en.ts`, ported from the spike with unit tests on the rules (stress, glides,
   allophones, digraphs) and the vocabulary table in code.
3. **Binary manager model kind** for the pins above (`kokoro-82m-int8`, one id per voice), the English dictionary
   either the same way or shipped compressed, `docs/binaries.md` section, and an opt-in real-download test.
4. **`loadOnnxModel`'s `OrtModule` type** gains `int64` tensors (`BigInt64Array`): the spike casts around it.
5. **ADR 0034 decision 14** as-built entry; CLI and skill gain only the provider id.

Pipeline finding along the way, not Kokoro's: `spokenTokens` does not read currency, so whisper writing "$25" for
"twenty five dollars" counts as two missing words and makes `en-04` `misread` for every voice, the Windows SAPI
baseline included. `compareTake` should read `$`, `€` and `%` like the number speller does (a small schema change for
its own ticket).

## Listening (the one human step)

The objective check cannot say whether a voice sounds natural, whether stress lands right, or whether chunk joins
are audible. The owner listens to the takes after the PR (about 10 minutes): Spanish `ef_dora` and `em_alex`, int8
against fp32, allophones on and off, the long paragraph's joins, and English `af_heart`. No audio is committed
(CLAUDE.md: never commit media); regenerate them with the commands below (about 20 minutes of synthesis on the
measuring laptop, under 10 on an M3 if the projection holds), then `node src/clean.ts`.

## Reproduce

```sh
pnpm install --frozen-lockfile && pnpm build                       # repo root
export FRAMESHELL_TEST_BINARIES_DIR=<repo>/.cache/test-binaries     # ffmpeg + onnxruntime-web
cd spikes/kokoro
node src/fetch.ts int8 fp32                                        # weights, voices, tokenizer, dictionary
node src/synth.ts es-int8-dora int8 ef_dora es                     # WAVs: $TMPDIR/frameshell-kokoro-spike/out/quality/<tag>/
node src/synth.ts es-int8-alex int8 em_alex es
node src/synth.ts es-int8-dora-stops int8 ef_dora es --no-allophones
node src/synth.ts es-fp32-dora fp32 ef_dora es
node src/synth.ts en-int8-heart int8 af_heart en
KOKORO_LINES=s-long node src/bench-one.ts int8                     # the chunked paragraph: out/speed/int8/s-long.wav
node src/check.ts es-int8-dora                                     # optional: installs whisper.cpp + 574 MB model into the work dir
node src/baseline.ts es-say-paulina es say -v Paulina --data-format=LEI16@22050 -o {out} -f -   # macOS Spanish baseline
node src/check.ts es-say-paulina
node src/bench.ts int8 fp32                                        # speed on this machine
node src/clean.ts                                                  # deletes downloads, whisper and every WAV
```
