---
status: accepted
---

# Transcription: whisper.cpp large-v3-turbo q5_0 with DTW onsets; cuts always snap to energy

Frameshell keeps whisper.cpp as the default transcription provider, ships
`ggml-large-v3-turbo-q5_0` (574 MB) as the default model, and runs it with DTW token
timestamps. No engine gives word boundaries that can be cut at directly, so snapping
cuts to audio energy (ticket #12) is required, not optional: word timestamps choose
*which* gap to cut, energy analysis chooses *where* in the gap. Measured in spike #4
(`spikes/whisper-word-timing/`, full tables in its `results/summary.md`).

## Evidence

Setup: Apple M3 (8 GB, 4 threads), whisper.cpp built from source with Metal at
`6e4ab854` (lib 1.9.4), faster-whisper 1.2.1 (CTranslate2 4.8.2) in a uv venv.
Fixture: 9:47 LibriVox Spanish reading (Public Domain Mark), plus a variant with four
inserted silences (2.5 to 6 s), one repeated phrase and -60 dBFS room noise. No human
ground truth: reference is agreement between engines plus energy analysis (pause =
≥200 ms below "speech level − 40 dB"). The machine was shared with other jobs during
the runs (1-min load average 2 to 8 recorded per run; one discarded faster-whisper run
saw 19), so speed numbers are upper bounds.

**Speed** (RTF = wall time incl. model load / audio duration, original fixture):

| config | Metal | CPU |
|---|---|---|
| whisper.cpp f16 | 0.083 | 0.259 |
| whisper.cpp q8_0 | 0.084 | not measured |
| whisper.cpp q5_0 | 0.087 | 0.231 |
| whisper.cpp + DTW (f16 / q8_0 / q5_0) | 0.101 / 0.108 / 0.104 | not measured |
| faster-whisper int8 | no Metal backend | 0.345 |
| faster-whisper float32 | no Metal backend | 1.227 |

DTW forces flash attention off (whisper.cpp disables DTW otherwise) and costs about
+20 %. Every recorded whisper.cpp run spent 0.3 to 0.7 s compiling Metal shader libraries at process
start (`results/summary.md`). The first Metal run on the machine was slower, but its log
was overwritten and the spike has no procedure for a cold shader cache, so the cold-start
cost is not measured.

**Text.** WER against faster-whisper float32: whisper.cpp 1.2 to 3.5 % across all
configs, faster-whisper int8 0.3 %. whisper.cpp configs with the same f16 weights
(Metal/CPU, DTW on/off, VAD on/off) differ from each other by up to 5.1 %, and faster-whisper float32 produced 1444 then 1450
words on two identical runs: differences below ~3 % are noise, so q5_0 shows no
measurable loss against f16 (2.1 % vs 3.0 % WER vs reference).

**Word timing** (ms, |error| mean / p95 / worst; original fixture):

| timing source | vs faster-whisper, start | pause edges vs energy | cut at raw time clips speech | clips > 100 ms | drift on variant (p95) |
|---|---|---|---|---|---|
| whisper.cpp token timestamps (f16 / q5_0) | 387/1280/5140 · 278/720/6720 | end 110/360/740, start 166/460/910 (f16) | end 60 %, start 50 % (f16) | 16 to 36 % | 990 to 1510 ms |
| whisper.cpp DTW onset (f16 / q5_0) | 290/720/2940 · 293/720/4880 | start 147/320/540, late by +147 | start 98 to 100 % | 64 to 65 % | 20 to 30 ms |
| DTW onset − 140 ms (bias fitted on this fixture) | 161/580/3080 | start 57/170/400 | 35 to 39 % | 13 to 14 % | 20 to 30 ms |
| faster-whisper float32 | reference | end 88/150/260 (−87, early), start 172/460/610 (+99, late) | end 92 %, start 90 % | 42 to 55 % | 30 ms |

- whisper.cpp token timestamps are unbiased but noisy and unstable: shifting the audio
  moves them by up to seconds, and they smear real words into inserted silences.
- DTW onsets are stable (same words, shifted audio: p95 drift 20 to 30 ms) but lag
  speech by ~140 ms. whisper.cpp stores one DTW time per token, so there is no DTW word
  end; the next onset is the only end available.
- faster-whisper words are stable but shrunk inward (ends early, starts late). It is
  not a fix for boundaries.
- At most 23 % of all inter-word boundaries fall in an energy pause (77 to 100 % land
  in speech, depending on engine); a ±100 ms snap leaves 60 to 86 % in speech. Connected speech has
  no clean cut point between most words. Clean cuts exist only at pauses.

**Raw take behaviour** (variant): no inserted silence produced invented text; words
timestamped inside silences were neighbouring real words with smeared token times.
One whisper.cpp run (f16 + DTW, no VAD) **dropped the repeated phrase** from the text;
the other six whisper.cpp runs and faster-whisper kept it. `--vad` combined with DTW is
broken at the pinned commit: DTW times are not remapped to the original timeline
(mean error 45 s on the original, 53 s on the variant).

## Decision

- **Engine:** whisper.cpp (Metal where available). faster-whisper rejected: no Metal on
  macOS, 4× slower at its fastest CPU setting (int8, RTF 0.345 vs 0.087), a Python
  runtime to ship, and its timestamps still need snapping.
- **Model:** `ggml-large-v3-turbo-q5_0` default (574 MB vs 1.62 GB f16). Same Metal
  speed, faster on CPU, no measurable text loss. q8_0 (874 MB) gains nothing. f16 stays
  selectable.
- **Timestamps:** run with `-dtw large.v3.turbo` (implies `-nfa`). Word `start` = DTW
  onset. Word `end` = next word's onset tightened to the last speech frame before it
  (energy), since DTW gives no end. Never cut at raw engine times. Do not combine
  `--vad` with DTW until whisper.cpp remaps DTW times.
- **Snapping (#12): required.** Target the interior of an energy-detected pause, not a
  valley near the reported time. Search window at least ±500 ms (DTW onset error p95
  320 ms, worst 540 ms to 1 s; token and faster-whisper p95 up to 610 ms). A cut requested where no pause exists is applied at the
  lowest-energy frame and reported as unclean.

## Considered options

- *Cut at word timestamps directly:* 38 to 100 % of pause-edge cuts clip speech.
- *Fixed DTW bias correction (−140 ms):* halves clipping but the bias was fitted on this
  fixture only; kept as a starting guess inside the snap window, not as the strategy.
- *VAD pre-segmentation:* fewer clipped starts with token timestamps, kept the retake,
  but breaks DTW today.

## Consequences

- **docs/SPEC.md** (to be edited by the maintainer): §2 decision 10 and §7 table: default
  model `large-v3-turbo-q5_0`. §5.4 example `model` value, and note that `end` is
  energy-derived. §13 risk "word timestamp accuracy": energy snapping is mandatory and
  DTW is required, not "when available"; add risk "retake silently dropped from the
  transcript" (whisper can collapse repeated phrases), mitigated by `--verify` and by
  pause-based cut candidates that do not rely on text alone. §14: close the
  quantization open item.
- **#12:** default window ±500 ms, pause-interior target, report unclean cuts.
- **#20:** flags `-dtw large.v3.turbo -nfa -ml 1 -sow -ojf`; derive words from segments;
  no `--vad` with DTW; energy-derived `end`.
- **#6:** pin the whisper.cpp version (DTW/VAD behaviour changes between commits);
  download q5_0 by default; measure first-run (cold cache) Metal shader compile before
  deciding whether first-run UX needs a warm-up step or progress message.

## Limits

No human-labelled word boundaries. Energy edges are not word edges: soft endings and
breaths near the threshold blur them. The fixture is a clean, fluent, noise-gated
audiobook reading by one speaker, not a real talking-head take; the variant only
approximates one. Speed was measured on a shared machine. CPU-only speed for DTW and
q8_0 was not measured. Linux/Windows backends (CUDA, Vulkan) were not measured.
