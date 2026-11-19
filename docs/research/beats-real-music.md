# Beat detector on real and generated music: is a learned detector needed? (#689)

Check for [#689](https://github.com/ThomasPraun/frameshell/issues/689), the follow-up of ADR 0029 decision 10 (owner decision 2026-11-18, Q4 of #458: do the cheap check now). The question: does the DSP beat detector (`onset-flux@1`, `packages/core/src/media/beats.ts`) hold a usable grid on music that is not a click track, and is a learned detector (Beat This! on ONNX Runtime Web) warranted? Nothing was pinned, added to the product or committed: the harness is a spike outside the workspace, the audio lived in temp directories and was deleted.

## Result

**Go for the learned-detector spike, with a licence verdict of "usable", and a cheaper DSP fix list to try first.** The threshold was fixed before the run: go only if the DSP grid is wrong (not just octave-correctable with `edits.tempo`) on more than about 20 % of the real/CC0 set, or misses 15 ms on synthetic music.

| Criterion | Measured | Verdict |
|---|---|---|
| Wrong tempo that is not one octave off, CC0 set (17 tracks) | **3 of 17 = 18 %** (a further 4 are one octave off, 24 %) | just under 20 %, with n = 17 and one artist: not conclusive alone |
| Beat residual p95 over 15 ms on synthetic music | **38 of 48** counted tracks (`sound.music` takes, their variants, drum patterns) | **missed**; 10 of 48 hold 15 ms (7 with the right tempo, 3 one octave off). Click-like drum patterns hold it: p95 under 10 ms on all 7 whose tempo is not ambiguous |
| Confidence says when it is wrong | 7 of the 10 correct CC0 results are LOW; 14 of the 20 wrong or octave-off synthetic results have confidence 0.5 to 1.0 | not usable as a gate |

So the second clause is met on dense synthetic music and the first is borderline. The failures fall in six classes; only the last three need more than a constant or a prior to fix, and none was fixed here (detector changes need owner approval; see "If the detector changes").

## Method

- **Harness**: `spikes/beats-real-music/` (own `package.json`, outside the pnpm workspace). `run.mjs` reads a directory outside the repo with a `manifest.json` (file, expected `bpm`, optional exact beats), decodes each file with the managed ffmpeg like the ingest does (48 kHz stereo s16 sidecar; 16 kHz mono for the no-sidecar fallback), runs `analysePcm` from the built `packages/core/dist/media/beats.js` and prints per track: detected against expected BPM (exact, double, half or wrong, 3 % tolerance), confidence and LOW flag, the alternatives, and where the truth has beat times the residual of each detected beat to its nearest true beat (median, p95, signed bias with positive = late, and drift = last third minus first third). When the tempo is off it re-runs with the expected tempo as `hint`. It refuses a directory inside the repo.
- **Synthetic** (`make-corpus.mjs`, 51 tracks, 3 of them informational, truth exact): `sound.music` takes (`synthesizeMusic`: synthwave, lofi, minimal at 70, 85, 100, 118, 130, 150, 170 BPM, 16 bars with intro, build, drop and outro; truth = `musicGrid` beats); variants of three of them (low-pass 1.5 kHz, high-pass 1.2 kHz, compressed and limited, mp3 128k, pink noise plus two sustained sines at -9 dB, and the 16 kHz fallback decode); script-built drum patterns (4-on-floor, backbeat, tresillo, light, medium and triplet swing, 65 and 175 BPM outside the 70-170 fold, an all-off-beat pattern); two tempo ramps (rubato, informational); and soft-attack plucks without drums.
- **CC0 set** (`fetch-cc0.mjs`, 17 tracks): Internet Archive items whose metadata `licenseurl` is CC0 1.0 and whose title carries the tempo; the script refuses any other licence. The expected tempo is the artist's label; there are no beat times, so only tempo is judged. All are mp3 derivatives, 3 to 6 MB.
- Machine: Windows 11, Node 26, managed ffmpeg 9.0.1. The shared machine was busy, so the timings are not reported.

### CC0 tracks

All items are on `https://archive.org/details/<id>`, licence CC0 1.0 (`http://creativecommons.org/publicdomain/zero/1.0/`), checked in each item's metadata on 2026-11-18. Creator: Dante Ross, except `FRESH-Hip-Hop-Beat` (DKKK).

| Item id | Label | Detected | Class | Confidence |
|---|---|---|---|---|
| `TheSetUp75Bpm` | 75 | 150.01 | double | 0.92 |
| `TentPole75Bpm` | 75 | 150.20 | double | 0.14 LOW |
| `LateNight80Bpm` | 80 | 159.99 | double | 0.27 LOW |
| `Dreamt_772` | 80 | 107.05 | **wrong** (4/3) | 0.20 LOW |
| `TheLurk86Bpm` | 86 | 86.00 | exact | 0.84 |
| `AnacondaMaltLiquor90Bpm` | 90 | 89.96 | exact | 0.11 LOW |
| `SecretBoss90Bpm` | 90 | 89.99 | exact | 1.00 |
| `SnazzyBitch95Bpm` | 95 | 125.51 | **wrong** (4/3) | 0.39 LOW |
| `FRESH-Hip-Hop-Beat` | 95 | 93.97 | exact (1 %) | 0.17 LOW |
| `CoolUncle100Bpm` | 100 | 99.99 | exact | 0.80 |
| `UkeJoint100Bpm` | 100 | 99.24 | exact (0.8 %) | 0.17 LOW |
| `SlowSpeedChase110Bpm` | 110 | 110.13 | exact | 0.32 LOW |
| `Gaslight120Bpm` | 120 | 120.00 | exact | 0.15 LOW |
| `Broke120Bpm` | 120 | 120.15 | exact | 0.17 LOW |
| `EverybodyGetShot130Bpm` | 130 | 129.64 | exact (0.3 %) | 0.23 LOW |
| `CodeBreaker130Bpm` | 130 | 86.70 | **wrong** (2/3) | 0.30 LOW |
| `FromTheTop180Bpm` | 180 | 90.00 | half | 0.04 LOW |

Tempo labels are the artist's, and a track can feel like 150 as well as 75: the four octave results may be defensible readings. The three wrong ones are not (4/3 and 2/3 are not octaves).

## Failure classes

| Class | Where | What it looks like |
|---|---|---|
| **Octave** (double or half, the right tempo times 2 or 1/2) | 11 of 48 synthetic (150 and 170 BPM read as 75 and 85, 65 and 70 as 130 and 140, 175 as 87.5), 4 of 17 CC0 | `hint` with the expected tempo fixes every one. `edits.tempo` does too. Confidence is high on some (synthwave 150 and 170: 0.94 and 1.0; `TheSetUp`: 0.92), so no warning is shown |
| **Non-octave tempo** (3:2 or 4:3) | `minimal` at 130, 150, 170 BPM (read as 86.7, 100.0, 113.4 = exactly 2/3) and all six variants of minimal-150; CC0 `CodeBreaker` (130 read as 86.7, the same 2/3) and two 4/3 cases | the autocorrelation prefers a dotted-quarter pulse. `hint` fixes them, but the alternatives list offers only double and half, so `edits.tempo` cannot reach it by choosing an alternative. Confidence 0.5 to 0.7 on the synthetic ones: not LOW |
| **Tempo drift** (right tempo, period 0.2 to 0.7 % off) | all lofi takes with swing 0.16 (84.61 for 85, 117.45 for 118, 100.27 for 100), synthwave-100 (100.70), minimal-100 (100.19), their variants; CC0 `UkeJoint` (99.24 for 100), `FRESH` (93.97 for 95) | the straight grid walks away from the real beats by 100 to 300 ms over a minute (median error 35 to 200 ms). Mostly LOW; minimal-100 is not (0.81) |
| **Late constant bias** | dense mixes with a sub-bass kick: synthwave 118, 130 and variants (+11 to +17 ms), minimal 85 to 118 (+9 to +16 ms), my click-like kick patterns +4 ms | detected beats sit 9 to 17 ms after the nominal beat, with no drift and a p95 within 2 ms of the median. The onset refinement is late on a kick that builds low-frequency energy slowly. This alone puts those tracks at or just over the 15 ms budget |
| **Phase** | compressed and limited mix (217 ms), soft plucks without drums (139 ms, with 30 ms attacks and 0.6 s tails the floor of the refinement never settles), tresillo at 150 BPM read at half tempo on its 8-step cycle (96 ms), the all-off-beat pattern (246 ms, informational: the phase is ambiguous by design) | confident (1.0) on the synthetic ones |
| **Rubato** | two tempo ramps (informational) | LOW (0.17, 0.20), as it should be |

Not a failure: the 16 kHz fallback decode (synthwave-118: p95 18 ms against 16.5 ms at 48 kHz, confidence capped at 0.45 by design), mp3 at 128k, pink noise plus sustained sines, high-pass and low-pass filters: tempo and phase held in each, and the grid stayed as good as on the clean take (the bias is the same). Drift and 3:2 results appeared in lofi and minimal in every variant too, so they come from the take, not the processing.

Click-like patterns behaved: 4-on-floor, backbeats with swing up to a triplet, and tresillo at 110 BPM all gave the exact tempo with p95 4 to 10 ms and confidence 1.0. The "15 ms on a synthetic click track" bar of decision 10 holds; the dense synthetic music is what misses it.

### What the confidence says

LOW is set for 13 of 17 CC0 results and 20 of 48 counted synthetic ones. It is the right signal on the wrong results of CC0 (all 3 wrong ones are LOW) and on rubato, but it also flags 7 of the 10 correct CC0 tracks, and it is silent on 14 of the 20 octave and 3:2 errors of synthetic music (confidence 0.5 to 1.0). The alternatives are listed only when LOW, and only as double and half.

## Licence check (paper only, 2026-11-18)

Nothing was downloaded or pinned; sizes come from an HTTP HEAD.

- **Code**: `CPJKU/beat_this` `LICENSE`, https://raw.githubusercontent.com/CPJKU/beat_this/main/LICENSE: "MIT License / Copyright (c) 2024 Institute of Computational Perception, JKU Linz, Austria".
- **Weights**: the README (https://github.com/CPJKU/beat_this, section License) says: "The code and the published model weights are released under the MIT license. Note that some of the training files are fully copyrighted or under limited Creative Commons licenses, and it is up to the user to assess whether this may impact their use case." The weights themselves are MIT: usable commercially. The open point is the training data, which the authors flag and which Frameshell would have to accept as a legal risk or ask the owner to weigh.
- **Training data**: 16 datasets (ASAP, Ballroom, Beatles, Candombe, Filosax, Groove MIDI, GTZAN (held out of the `final*` models), GuitarSet, Hainsworth, Harmonix, HJDB, JAAH, RWC, SIMAC and others, per the Zenodo record https://zenodo.org/records/13922116, CC BY 4.0 for the spectrograms). Several are commercial recordings. No per-dataset licence audit was made.
- **Host and size**: https://cloud.cp.jku.at/index.php/s/7ik4RrBKTS273gp (a university cloud share; the inference code downloads `https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/<name>.ckpt`). `final0.ckpt` is 81 058 141 bytes (the README says about 78 MB per model); `small0` about 8.1 MB. Checkpoints are PyTorch Lightning files with the optimizer state stripped: the pin would be an ONNX export we make and host ourselves, not this file. A cloud share is not a stable source for a pin; the SHA-256 of the checkpoint and of the export would go into the manifest.
- **ONNX**: the README does not mention ONNX. Export from PyTorch is not verified here; the model works on a mel spectrogram with transformer blocks (not read in detail here), so the export, the mel front end (a JS port, as `people/fbank.ts` did for sherpa-onnx, with a reference fixture) and the peak-picking are the work, not the runtime. The runtime and loader exist: `loadOnnxModel` in `packages/core/src/onnx-web.ts` (ONNX Runtime Web, one-shot worker via `worker-task.ts`), with the model files pinned as `module`-kind entries of `packages/core/src/binaries/manifest.ts` (ADR 0022, `docs/binaries.md`).
- **madmom**: source is BSD, but model and data files are CC BY-NC-SA 4.0 (https://github.com/CPJKU/madmom, README "License"): excluded, as in decision 10.
- **Speed and accuracy of the model**: not measured. The licence allows it and the check says go, but it needs a PyTorch environment and an export, which is the spike itself and was left out of this cheap check.

## If the detector changes

Not done here (owner approves any detector change). Findings that look cheap, each to be measured with this harness on the same corpus first: refit the period over all hits with a final pass at finer resolution (drift); add the 3:2 and 4:3 neighbours to the alternatives and to the LOW rule (non-octave); a constant latency compensation of the refinement for slow-attack low-frequency onsets (bias); calibrate confidence so a correct-but-sparse result is not LOW. Any change bumps `onset-flux@N` in `BEAT_DETECTOR`, the cache key of the onset envelope (`b1`) if the envelope changes, and re-runs `pnpm test packages/core/test/beats`.

## What the spike should settle if it runs

1. Export Beat This! `small0` and `final0` to ONNX and run them on ONNX Runtime Web (wasm, one thread) on this corpus: speed per minute of audio and RAM on the user's machine class, against the DSP detector's few seconds.
2. Compare on the same tracks: octave and 3:2 errors, drift, bias; it returns beats and downbeats, so the downbeat (bar start, which the DSP picks by bass energy) is a second gain.
3. Decide with the owner: the training-data caveat, hosting the exported weights, and whether the DSP fixes above cover enough that the learned model is not worth 8 to 78 MB and a new pin.

## Reproduce

```sh
pnpm build
export FRAMESHELL_TEST_BINARIES_DIR=<repo>/.cache/test-binaries   # managed ffmpeg
export FRAMESHELL_BEATS_MUSIC_DIR=<a temp directory outside the repo>
node spikes/beats-real-music/make-corpus.mjs     # synthetic, ~3 min
node spikes/beats-real-music/run.mjs             # report + results.json
FRAMESHELL_BEATS_MUSIC_DIR=<another temp dir> node spikes/beats-real-music/fetch-cc0.mjs && node spikes/beats-real-music/run.mjs
```

Delete the directories afterwards: no audio is committed and none of it is kept.
