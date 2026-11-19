# Beat detector on real and generated music: is a learned detector needed? (#689)

Check for [#689](https://github.com/ThomasPraun/frameshell/issues/689), the follow-up of ADR 0029 decision 10 (owner decision 2026-11-18, Q4 of #458: do the cheap check now). The question: does the DSP beat detector (`onset-flux@1`, `packages/core/src/media/beats.ts`) hold a usable grid on music that is not a click track, and is a learned detector (Beat This! on ONNX Runtime Web) warranted? Nothing was pinned, added to the product or committed: the harness is a spike outside the workspace, the audio lived in temp directories and was deleted.

## Result

The tables below are the baseline of `onset-flux@1`. The four DSP fixes the owner approved (2026-11-19, Q3) are measured in [After the DSP fixes](#after-the-dsp-fixes-onset-flux2); that section carries the updated go/no-go.

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
| **Late constant bias** | dense mixes with a sub-bass kick: synthwave 118, 130 and variants (+11 to +17 ms), minimal 85 to 118 (+9 to +16 ms), the script-built click-like kick patterns +4 ms | detected beats sit 9 to 17 ms after the nominal beat, with no drift and a p95 within 2 ms of the median. The onset refinement is late on a kick that builds low-frequency energy slowly. This alone puts those tracks at or just over the 15 ms budget. The cause is an interpretation, not proven: the bias is measured against the nominal `musicGrid` times and the generated kick takes about 2 ms to reach its first peak, which does not explain all of 9 to 17 ms. Drift and 3:2 do not depend on it |
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

Done as `onset-flux@2`, below. At the time of the first check: not done (owner approves any detector change). Findings that look cheap, each to be measured with this harness on the same corpus first: refit the period over all hits with a final pass at finer resolution (drift); add the 3:2 and 4:3 neighbours to the alternatives and to the LOW rule (non-octave); a constant latency compensation of the refinement for slow-attack low-frequency onsets (bias); calibrate confidence so a correct-but-sparse result is not LOW. Any change bumps `onset-flux@N` in `BEAT_DETECTOR`, the cache key of the onset envelope (`b1`) if the envelope changes, and re-runs `pnpm test packages/core/test/beats`.

## After the DSP fixes (onset-flux@2)

Owner decision 2026-11-19 (Q3 of #689): change the detector to `onset-flux@2`, DSP only, same envelope, beats file and wire (`alternatives` and `edits.tempo` stay `double`/`half`). Targets set before the run: p95 residual of 15 ms or less on at least 90 % of the synthetic tracks whose tempo is right, median bias 10 ms or less, no CC0 tempo that is not an octave off, at most 2 correct CC0 tracks wrongly LOW. Same corpus as above (51 synthetic tracks rebuilt with `make-corpus.mjs`, the 17 CC0 items fetched again with `fetch-cc0.mjs`, both in temp directories outside the repo, deleted afterwards). The baseline was re-run first and reproduced the tables above exactly.

### Before and after

| | `onset-flux@1` | `onset-flux@2` |
|---|---|---|
| Synthetic, counted (48): exact tempo / octave off / other tempo | 28 / 11 / 9 | 34 / 12 / 2 |
| Synthetic, right tempo with p95 within 15 ms | 7 of 28 (25 %) | **32 of 34 (94 %)** |
| Synthetic, all counted tracks with p95 within 15 ms (any octave) | 10 of 48 | 41 of 48 |
| Synthetic, median signed bias of right-tempo tracks | +12.7 ms | **+0.8 ms** |
| CC0 (17): exact / octave off / other tempo | 10 / 4 / 3 | 12 / 5 / **0** |
| Synthetic confusion: right tempo LOW / confident | 15 / 13 | 7 / 27 (3 of the 7 are the 16 kHz decode, capped at 0.45 by design) |
| Synthetic confusion: wrong (octave or other) LOW / confident | 6 / 14 | 1 / 13 |
| CC0 confusion: right tempo LOW / confident | 7 / 3 | **3** / 9 |
| CC0 confusion: wrong (octave or other) LOW / confident | 6 / 1 | 1 / 4 |

Drift (signed median of the last third minus the first third, ms) and median error on the tracks the fix was aimed at:

| Track | @1 tempo, drift, median | @2 tempo, drift, median |
|---|---|---|
| lofi-85 (swing 0.16, vinyl clicks) | 84.61, +146, 56.0 | 85.01, -2.3, 2.1 |
| lofi-100 | 100.27, -71, 60.3 | 100.01, -2.7, 2.4 |
| lofi-118 | 117.45, +106, 39.3 | 117.96, +7.4, 2.9 |
| synthwave-100 | 100.70, -142, 196.2 | 100.01, -0.8, 0.9 |
| minimal-100 | 100.19, -34, 16.1 | 100.00, 0.0, 0.6 |
| lofi-85, 16 kHz decode | 85.12, -38, 24.3 | 85.01, -2.5, 3.3 |
| CC0 `UkeJoint100Bpm` (no beat truth) | 99.24, LOW 0.17 | 100.00, 0.94 |
| CC0 `FRESH-Hip-Hop-Beat` (no beat truth) | 93.97, LOW 0.17 | 95.00, 1.00 |

Every lofi variant (low-pass, high-pass, compressed, mp3, noise bed) went the same way: p95 5.6 to 11.6 ms, drift under 4 ms.

### What each fix did

Measured one at a time with the fast loop of the harness (decoded signals and envelopes cached, the detector staged from source), in the order bias, drift, 3:2, confidence.

1. **Latency bias: the cause was the detector, shown before fixing.** Against the exact `musicGrid` beat of synthwave-118, the attack envelope (0.5 ms average of the 30 Hz high-passed signal) rises at 0.0 ms: the generated kick starts on the beat, so the generator is not late. But |y| of a 100-150 Hz kick returns to near zero every 4-5 ms, and the loudest point the refinement started from was the kick's third or fourth cycle (median +13.9 ms); the walk back to the floor stopped at the zero crossing just before it (median +11.3 ms), so the onset landed at +12.2 ms. The 20 % rise level, the smoothing width and the high-pass phase lag were not the cause. Fix: the floor and the walk back read a 10 ms running maximum of the attack (one rise per kick instead of one per half cycle), and the onset is the first sample reaching 20 % of the way from the floor without a 10 ms gap under that level; the floor is the lowest point in the 50 ms before the loudest one. No constant is subtracted. Hit onsets moved from +12.2 to +0.8 ms on synthwave-118, from +7.5 to +0.9 ms on minimal-85, from +4.2 to +0.3 ms on the click-like patterns. Alone this took right-tempo p95 passes from 7 of 28 to 18 of 28.
2. **Drift: the cause was the starting grid, not the 3 % clamp.** The autocorrelation period was 0.2-0.7 % off and the phase was found with that period over the whole track (102 ms off on lofi-85), so the first fit window matched wrong hits, among them the lofi preset's vinyl clicks (strong, broadband, random). Fix: the period within 1 % of the autocorrelation's, in steps of 0.025 %, and its phase, are chosen together by the comb over the middle minute of hits; after the widening fit, three refits over the whole audio match against the last fit with tolerances 30, 20 and 15 ms. The straight-line model stays. With fix 1 this took right-tempo p95 passes to 26 of 28 and turned 4 correct CC0 results from LOW to confident.
3. **3:2 and 4:3 inside detection.** For the measured tempo, its double, and the four rivals (x3/2, x3/4, x2/3, x4/3), a grid is fitted and its beat energy taken (mean strength of the hit within 15 ms of each beat). A rival replaces the measured tempo when its energy is at least 1.25 times the larger of the measured tempo's and its double's (the double holds every measured beat too, so a rival must beat both), at least 0.15 in absolute terms (wandering real tracks have rivals at 0.09-0.12 that would otherwise win), and the measured grid spans at least 24 beats; of the rival's two octaves the tempo prior picks, as for the first pick. On the corpus, right tempi had rivals up to 1.12 times, dotted-quarter misreads 1.34 times and up, except two (minimal-150 high-passed 1.10, compressed 1.19) that stay wrong. This fixed 7 of 9 synthetic and all 3 CC0 non-octave errors (`Dreamt` now reads 160, an octave of its label; `SnazzyBitch` 95; `CodeBreaker` 130). Nothing was added to `alternatives` or `edits.tempo`.
4. **Confidence.** The old `periodic` term was saturated at 1 on every track of the corpus, so confidence was `share^1.5` alone and penalised sparse but correct grids (a song whose second beat has no hit has `share` 0.64). New: `min(1, share / 0.75)` times precision, the share of matched beats whose hit is within 15 ms mapped 0.5 → 0 and 0.8 → 1 (wandering CC0 tracks: 0.61-0.68; straight grids 0.74 and up). Two caps: when the half grid holds 90 % of its beats with 1.8 times the energy per beat (the calm-music double-time case the unit test pins), the old `share^1.5`; when a 3:2 rival reaches 1.15 times without switching, 0.45 (LOW). `LOW_BEAT_CONFIDENCE` stays 0.5. Effect on top of fixes 1-3: CC0 right-tempo LOW 4 → 3 (`CodeBreaker` 0.39 → 0.63), `FromTheTop` (octave) became LOW, the compressed 3:2 misread stays LOW, synthwave-85 (octave) became confident.

### Against the targets

| Target | Result |
|---|---|
| p95 within 15 ms on at least 90 % of right-tempo synthetic tracks | **met**: 32 of 34. The two misses: lofi-130 puts 2 s of beats into the take's ringing tail, where the vinyl clicks go on after the final hit; the soft-pluck stress track (30 ms attacks, no drums) keeps its phase 139 ms off |
| Median bias 10 ms or less | **met**: +0.8 ms |
| No CC0 tempo that is not an octave off | **met**: 0 of 17 (was 3) |
| At most 2 correct CC0 tracks wrongly LOW | **missed by one**: 3 (`SlowSpeedChase110Bpm` 0.38, `Broke120Bpm` 0.27, `EverybodyGetShot130Bpm` 0.17). In all three the straight grid walks 30-60 ms off the hits for stretches of the track (a section at another tempo, or played loosely); LOW is what the grid is worth there, as for the rubato ramps. Raising them would need a non-straight grid, which ADR 0029 rules out |
| Wrong but confident drops, few correct turn LOW | non-octave errors: 6 confident of 9 → 1 of 2 synthetic, 0 CC0. Octave errors became more confident (synthetic 8 of 11 → 12 of 12, CC0 1 of 4 → 4 of 5), because their grids now hold their beats as well as the right tempo's would: a grid at 150 on a 75 BPM hip-hop track finds a hit on every beat. No measure tried (energy of the double and half grids, their shares) told them apart on this corpus |

Short takes, outside the corpus: on 8-bar `sound.music` takes (21, 15-27 s) `@2` holds the right tempo within 15 ms on 5 against 2 for `@1`, but reads two dotted-quarter tempi that `@1` read right (synthwave-130 as 97.6, lofi-100 as 133; both LOW), and synthwave-118 locks 210 ms off the beat on mis-refined hat hits (confidence 0.70). Takes this short hold too few beats for the 3:2 check; the 24-beat floor stops the worst of it. Generated takes get an `exact` beats file anyway.

Speed: detection (after the cached envelope) takes about 0.7 s per corpus track against 0.25 s (up to 8 grid fits instead of 1); the envelope, still most of the cost, is unchanged.

Existing beats files keep `onset-flux@1` and their grid; nothing migrates. `frameshell beats measure` writes `@2`. The envelope cache key stays `b1`.

### Go/no-go for the learned spike, updated

The DSP fixes meet three of the four targets and miss the fourth by one track whose LOW is honest. What is left is the octave ambiguity, which no grid evidence measured here resolves and the prior decides (`edits.tempo` and `hint` fix it; the alternatives are only listed when LOW), the two 3:2 misreads on processed variants, and short takes. A learned detector would mainly address octave and downbeat, which DSP does not; it is no longer needed for drift, bias or the 3:2 errors of this corpus. Whether to run the spike for octave and downbeat alone is the owner's decision (separate ticket, ADR 0029 decision 10; licence verdict above unchanged).

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
