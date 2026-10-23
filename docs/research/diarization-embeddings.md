# Speaker diarization: CAM++ embeddings on the native runtime (#359)

`transcribe.speakers` (ADR 0016 decision 3) ran `sherpa-onnx-offline-speaker-diarization` v1.13.8 end to end. The tool runs pyannote segmentation, embeds each (chunk, local speaker) with CAM++ on its bundled native ONNX Runtime 1.28.2, and clusters those embeddings. Issue #359 suspected the native embeddings were wrong. This note measures that and records the fix.

## Decision

sherpa-onnx now only finds the **speech segments**. Frameshell embeds each segment with CAM++ on **ONNX Runtime Web**, as voice prints already do (`people/voice-embed.ts`), and groups the segments into voices (`clusterVoices` in `transcripts/speaker-labels.ts`). The clustering is average linkage on cosine similarity, cut at 0.55 or into `--people` voices. It reuses the face clusters' `averageLinkage`, now in `people/vector.ts`. Segments shorter than 1 s do not shape the voices: each one joins the voice whose mean is nearest.

- Diarization error rate on six synthetic conversations: **56.3% → 4.2%** with the count found from the voices, and **47.2% → 3.9%** with the count given. On a 26 min conversation of 6 voices: **65.3% → 2.5%** and **61.0% → 2.1%**.
- Cost: diarization takes about 35-40% longer (26 min of audio: 100 s → 140 s on an Apple M3). The first run also installs the ONNX Runtime Web pin (33 MB) unless people or face tools already did. No new pin, no protocol change, same output format.

## The bug, reproduced

The same features (80-bin fbank from `people/fbank.ts`, mean subtracted) were fed to CAM++ on sherpa-onnx's native `libonnxruntime.dylib`, through a small C program against the ONNX Runtime C API, and on ONNX Runtime Web 1.30.0. The input was one 10 s turn of one voice, cut to growing frame counts.

| Frames | Native vs ORT Web (cosine) |
|---|---|
| 150 | 0.49 |
| 200 | 0.50 |
| 250 | 0.28 |
| 375 | 0.92 |
| 398 | 1.00 |
| 400 | 0.75 |
| 425 | 0.25 |
| 575 | 0.94 |
| 625 | 0.30 |
| 975 | 0.98 |
| 1000 | 0.77 |

- **Native** agrees with ORT Web only just below a multiple of 200 input frames, where the model's `AveragePool` (100 frames after its first stride, `ceil_mode`) has an almost full last window. Elsewhere it jumps: the native embedding of 420 frames has cosine 0.47 with that of 400 frames of the same speech.
- **ORT Web** changes smoothly: cosine 0.99+ between neighbouring lengths. A speaker embedding should behave like this.
- **Every native runtime tried behaves the same:** ONNX Runtime 1.17.1, 1.24.4 and 1.28.2 (sherpa-onnx v2.0.0's `onnxruntime-<version>` macOS builds and the v1.13.8 pin) give identical numbers. sherpa-onnx v2.0.0, released 2026-10-23, still ships 1.28.2. `--embedding.provider=coreml` gives the same diarization as CPU.

## Method

- **Recordings:** macOS `say` voices, 16 kHz mono, alternating turns of 1 to 3 sentences (from "Yeah." to about 15 s), with pauses of 0.15 to 0.85 s and a noise floor near -50 dBFS. The truth is each turn's trimmed span. Generated per run, never committed.

  | Id | Voices | Length | Turns |
  |---|---|---|---|
  | s1 | Daniel, Karen, Fred | 203 s | 30 |
  | s2 | Samantha, Tessa | 194 s | 30 |
  | s3 | Flo, Kathy, Moira | 228 s | 36 |
  | s4 | Daniel, Ralph | 170 s | 24 |
  | s5 | Grandpa, Rishi, Reed (UK), Karen | 282 s | 40 |
  | s6 | Aman, Daniel | 181 s | 26 |
  | long | Daniel, Karen, Samantha, Rishi, Fred, Moira | 1568 s | 220 |

  Apple's US "Eddy" and "Reed" voices were dropped from a first set: CAM++ on ORT Web cannot tell them apart (cosine 0.81 between them, 0.80 within each), so they are one voice to any embedding. In the final set, turns of one voice score 0.69 to 0.89 with each other and turns of two voices 0.10 to 0.49.
- **Metric:** diarization error rate (missed speech + false alarm + speaker confusion, over reference speech), 10 ms frames, 0.25 s collar around each true turn edge, best one-to-one mapping of found voices to true ones. "Auto" lets the voices decide how many people there are; "known" passes the count (`--people`).
- **Before:** the pinned tool as Frameshell ran it (default threshold 0.5, `--clustering.num-clusters` when known).
- **After:** the built `sherpaDiarizer`: the tool with `--min-duration-off=0`, then the steps above.

## Results

| Recording | Before, auto | Before, known | After, auto | After, known |
|---|---|---|---|---|
| s1 | 59.5% (11 voices found / 3) | 47.1% | 0.6% (3/3) | 0.6% |
| s2 | 56.4% (8/2) | 42.5% | 13.5% (2/2) | 13.5% |
| s3 | 55.3% (13/3) | 46.8% | 3.4% (5/3) | 1.6% |
| s4 | 66.2% (10/2) | 39.0% | 2.5% (2/2) | 2.5% |
| s5 | 56.5% (12/4) | 61.0% | 1.4% (4/4) | 1.4% |
| s6 | 44.0% (8/2) | 46.5% | 3.7% (2/2) | 3.7% |
| **Mean s1-s6** | **56.3%** | **47.2%** | **4.2%** | **3.9%** |
| long (26 min) | 65.3% (34/6) | 61.0% | 2.5% (8/6) | 2.1% |

Before, nearly all the error is speaker confusion: the segments were right, the voices were not. After, misses and false alarms stay under 1%. What is left is mostly a sherpa-onnx segment that spans two voices (s2), and small extra voices when the count is not given (s3, long).

Variants tried on s1-s6 with the count left to the voices:

- **Cut line:** 0.50 gives 8.3%, 0.55 gives 4.7%, 0.60 gives 5.2%, 0.65 gives 5.9%. With the count given, all of them give 4.5%. On the long recording, 0.50 merged two voices (16.5%), and 0.55 found the fewest extra voices.
- **Shortest segment that shapes the voices** (on the tool's over-segmented output, threshold 0.05, cut 0.60): 0.5 s gives 6.3%; 1, 1.5 and 2 s give 3.6-4.0%.
- **Segments from the tool:** sherpa-onnx's default `--min-duration-off` (0.5 s) merges segments its bad clusters call one voice, across real turn changes: 7.5% instead of 5.2% at a 0.60 cut. A lower clustering threshold (0.05) splits more finely and does slightly better (4.0%), but the tool then keeps hundreds of clusters: 1.5 GB peak memory on the 26 min recording, against 0.47 GB at the default. So the default threshold stays.

## Options not taken

- **Re-pin sherpa-onnx:** no release has a different runtime result. Every native ONNX Runtime tried gives the same embeddings.
- **Pad segments to whole pooling windows:** the tool embeds inside its own process, so its segments cannot be padded from outside. Patching the model's `AveragePool` cannot work either: the needed padding depends on the input length.
- **Our own segmentation as well:** pyannote on ORT Web plus sherpa-onnx's chunk stitching would drop the native tool entirely. It would be much more code, and the tool's segments already have under 1% missed speech and false alarms here.

## Limits

- The voices are synthetic, clean, and never overlap. Real recordings (room noise, crosstalk, laughter, people talking at once) need a check by hand before tuning the line further. When two people talk with no pause, a sherpa-onnx segment can span both voices; re-clustering cannot split it (see s2).
- The cut line (0.55) was chosen on these recordings. Neighbouring values within ±0.1 stay within a few points.
