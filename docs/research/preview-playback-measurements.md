# Preview playback on the real app: ADR 0001 thresholds (#15)

The desktop preview meets all six pass thresholds of [ADR 0001](../adr/0001-preview-playback-technique.md). The measurement uses the spike's fixture and full 200-cut list, played by the real app. The pipeline was ingest, then the `frameshell-media://` protocol, the engine Worker (WebCodecs, OffscreenCanvas), and the program AudioWorklet.

## Reproduce

```sh
FRAMESHELL_PREVIEW_MEASURE=1 pnpm --filter @frameshell/desktop exec playwright test preview-thresholds
```

- Spec: `apps/desktop/e2e/preview-thresholds.spec.ts`. Analysis ported from `spikes/gapless-preview/scripts`: `apps/desktop/e2e/preview-analysis.ts`.
- First run: about 25 min. Generating the source takes about 4 min, ingest (hash, proxy, sidecar, waveform, thumbnails) about 2 min, and playback 16 min real time. Later runs reuse `.cache/preview-measure/` and take about 20 min.
- Quick variant: `FRAMESHELL_PREVIEW_MEASURE_MINUTES=2` gives a 2 min source and 22 cuts. `FRAMESHELL_PREVIEW_MEASURE_CUTS=N` plays only the first N cuts.
- Output: `apps/desktop/test-results/preview-thresholds/<run>.{json,md}`. The test fails when any threshold fails.
- Keep the window visible and the machine otherwise idle: the numbers are real-time measurements.

## Method (differences from the spike)

- Fixture: the same as the spike's. The source is 30 min of 1080p30 `testsrc2` with the 16-bit frame barcode and a 220 Hz sine at 0.5, and the cut list is the spike's seeded list (201 kept segments, 200 cuts, 961.6 s of program). The proxy and sidecar come from the app's own ingest recipe (`packages/core/src/media/recipe.ts`), not from the spike's ffmpeg command. The timeline is 201 media clips on `v1`.
- Video: the page reads the preview canvas's barcode on every `requestAnimationFrame` of the main thread. The engine draws in a Worker, so this is what the page samples at each vsync, not photons.
- Audio: a probe-only AudioWorklet recorder sits in the graph after the program worklet (`FRAMESHELL_PREVIEW_PROBE=1`). The recorded output is compared sample by sample with the program rebuilt from the sidecar, 2 ms fades included.
- Wall time: the spike's run quit at the end. The app shows the first frame paused before play and holds the last frame after the end, so wall time runs from the first frame after the start to the last frame of the program. The analysis extrapolates both ends by frame duration.
- A/V offset: the time the page first samples the new segment's frame, minus the time the splice is heard (`getOutputTimestamp`).

## Results (full 200-cut list, 2026-09-30)

Machine: MacBook Pro 14" Apple M3 (Mac15,3), macOS 26.3, Electron 44.5.0. The machine was shared with other agents' jobs; load average during the run was 3.0 to 5.7.

| metric | real app (#15) | spike B-chunkedself |
|---|---|---|
| stray (foreign) frames at cuts | 0 | 0 |
| dropped program frames at cuts | 0 | 0 |
| cuts with freeze >= 1 frame | 0 / 200 | 7 / 200 |
| freeze at cut ms, mean / p95 / max | 0.5 / 9.1 / 9.9 | 1.9 / 10.3 / 112.3 |
| dropped frames inside segments | 1 / 28445 | 4 / 28445 |
| audio: cuts with click / gap >= 1 ms / overlap | 0 / 0 / 0 | 0 / 0 / 0 |
| audio: repeated 128-sample quanta (whole run) | 0 | 0 |
| audio samples deviating from expected program | 0 of 46,155,200 | 0 of 46,155,200 |
| A/V offset at cut ms, mean [p5, p95] | 9.6 [0.9, 13.4] | 4.8 [1.2, 7.6] |
| wall time for 961.6 s program | 961.6 s | 961.6 s |
| page rAF interval p99 ms | 10.3 | n/a |

Engine counters: 30,143 frames decoded, 1,296 discarded (pre-roll), 28,847 drawn, 3 starved display ticks.

Thresholds (`checkThresholds`):

```
1 pass  stray 0, dropped at cuts 0
2 pass  freeze cuts 0.0 %, p95 9.1, max 9.9 ms
3 pass  interior drops 1/28445 = 0.00 %
4 pass  clicks 0, gaps 0, overlaps 0, repeated quanta 0; 0 of 46155200 samples deviate
5 pass  A/V p5 0.9, p95 13.4 ms (n=200)
6 pass  wall 961.6 s vs 961.6 s = 0.00 %
```

A 22-cut run (2 min source) on the same machine also passed all six: freeze p95 8.7 ms, A/V p95 15.2 ms, 0 of 3,992,000 samples deviating.

## Reading

- Drawing in a Worker removed the cut freezes the spike attributed to main-thread stalls: 0 cuts froze, against 7, and the worst freeze was 9.9 ms, against 112 ms. The React UI kept running during the whole run (timeline repaint and timecode every frame).
- The A/V offset is about 5 ms later than in the spike, still well within ±20 ms. A frame drawn by the Worker reaches the page's sample at the next page vsync, which the spike's same-thread draw did not pay.
- Not measured: seeking and scrubbing latency, more than one video track, Windows and Linux (CI runs the functional e2e there, not these thresholds), and a real recording.

## Start-up quanta skipped by Chromium (2026-09-30)

Chromium sometimes renders AudioContext quanta without calling the worklets' `process()`, and `currentFrame` still advances. We saw it at start-up with a second measurement app starting at the same time. The mixer and the recorder counted `process()` calls, so both fell behind the context clock. In two quick runs they were 1,408 and 7,296 frames behind (29 and 152 ms). The program audio then played that much after the picture, and the stop at the program end cut its tail: 298 and 6,281 deviating samples. On PR #102 the full run had 551 deviating samples. When the recorder started after the skip, almost every sample deviated: 97-99 % in three quick runs, like PR #102's second full run. Both worklets now use `QuantumClock` (`preview/mixer.ts`): their own count, but never behind `currentFrame`.

Quick runs with a second app starting at the same time, before the fix: 2 of 6 failed threshold 4. After the fix: 8 of 8 had 0 deviating samples.

Full 200-cut runs after the fix, on a shared machine (load average 2.7 to 8.4):

| run | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|
| a | FAIL: 1 frame dropped at 1 cut | freeze 0.5 %, p95 8.3, max 32.9 ms | 1/28445 | 0 of 46,155,200 deviate | p5 5.0, p95 16.0 | 0.00 % |
| b | pass | freeze 0.5 %, p95 8.3, max 16.9 ms | 0/28445 | 0 of 46,155,200 deviate | p5 3.5, p95 16.5 | 0.00 % |
| c | pass | freeze 0.0 %, p95 8.1, max 9.9 ms | 3/28445 | 0 of 46,155,200 deviate | p5 3.8, p95 15.3 | 0.00 % |

Run a's threshold 1 failure is video: 1 frame dropped at 1 cut, with a 32.9 ms freeze at that cut. The audio fix does not touch that path.
