---
status: accepted
---

# Preview plays proxies with WebCodecs on the audio clock, not double-buffered `<video>`

The preview (#15) decodes the CFR proxy with WebCodecs `VideoDecoder` and draws frames to a canvas, driven by the `AudioContext` clock. Program audio is a PCM sidecar played by one `AudioWorklet` that writes each kept segment at exact sample frames. We measured double-buffered `<video>` elements (the approach SPEC §3.4 planned) on the same 200-cut fixture. They froze for a frame or more on 14.5 % (A2) to 58.5 % (A1) of cuts. With element audio (A1) every cut also had a silence gap (mean 60.6 ms), and 196 of 200 had a click. The WebCodecs path showed no foreign frames and no dropped frames at any cut. Its audio matched the expected program sample for sample. The fallback (background preview renders of dense regions) is not needed at this density.

## Context and method

Spike #2, prototype in `spikes/gapless-preview/` (reproduce: `npm install && npm run fixture && npm run measure`).

- Machine: MacBook Pro 14" Apple M3, 120 Hz built-in display, macOS 26.3, Electron 44.4.5.
- The machine was shared with other agents' jobs during the runs. Load average at the start of each run was 2.6-8.8. Runs were real time, one visible window at a time.
- Fixture: synthetic, not a real recording. The source was 30 min of 1080p30 `testsrc2` with a burned-in frame counter and a machine-readable 16-bit frame barcode, plus a continuous 220 Hz sine. The proxy under test was 960x540, CFR 30 fps, H.264 High, GOP 15, no B-frames, AAC 48 kHz. The cut list was seeded: 201 kept segments (200 cuts) of 0.5-20 s (log-uniform), 961.6 s of program.
- Video metric: on every `requestAnimationFrame`, the visible surface's barcode was decoded, which gives the frame shown at that vsync. From that sequence the harness counted, per cut:
  - dropped program frames;
  - freeze, meaning the extra hold of the boundary frames beyond one frame duration;
  - stray frames from outside the kept ranges.

  It ran the same counts inside segments as a baseline.
- Audio metric: an `AudioWorklet` recorder captured the graph output. Per cut it counted sample jumps above 0.05 (clicks; the clean sine never exceeds 0.0144), silence runs of 1 ms or more (gaps), and samples above 0.6 (overlap). For audio-clocked runs, `audio-residual.mjs` also compared every output sample to the expected program.
- A/V offset at a cut: the time the first new video frame was sampled minus the time the audio splice was heard (`getOutputTimestamp`).

## Results (full 200-cut list, measured)

| metric | A1 `<video>` + element audio | A2 `<video>` pre-rolled + worklet audio | B WebCodecs + worklet audio | B-bufsrc WebCodecs + BufferSource per segment | **B-chunkedself** (chosen) |
|---|---|---|---|---|---|
| stray (foreign) frames at cuts | 0 | 0 | 0 | 0 | 0 |
| dropped program frames at cuts | 0 | 2 (1 cut) | 0 | 0 | 0 |
| cuts with freeze >= 1 frame | 117 / 200 | 29 / 200 | 4 / 200 | 2 / 200 | 7 / 200 |
| freeze at cut ms, mean / p95 / max | 21.8 / 41.1 / 133.6 | 6.7 / 50.0 / 149.0 | 2.1 / 9.8 / 64.7 | 1.3 / 4.2 / 155.2 | 1.9 / 10.3 / 112.3 |
| dropped frames inside segments | 171 / 28445 | 114 / 28445 | 7 / 28445 | 16 / 28445 | 4 / 28445 |
| audio: cuts with click | 196 | 0 | 1 | 15 | 0 |
| audio: cuts with gap >= 1 ms | 200 (mean 60.6 ms, max 90.7) | 0 | 0 | 0 | 0 |
| audio: cuts with overlap | 0 | 0 | 0 | 4 | 0 |
| audio: repeated 128-sample quanta (whole run) | 0 | 16 | 29 | 0 | 0 |
| audio samples deviating from expected program | n/a | 2006 | 3640 | 4470 | **0 of 46,155,200** |
| A/V offset at cut ms, mean [p5, p95] | -30.4 [-33.5, -27.1] | 17.4 [5.1, 24.6] | 4.0 [0.5, 7.8] | 3.7 [0.5, 7.6] | 4.8 [1.2, 7.6] |
| wall time for 961.6 s program | 968.7 s | 963.6 s | 961.6 s | 961.6 s | 961.6 s |
| CPU, all Electron processes, mean % of one core | 2.8 | 3.3 | 2.5 | 1.8 | 5.1 |

An extra full run, B-chunked (s16 chunks, global `currentFrame`), had 0 cut freezes, 0 audio defects at cuts and 21 repeated quanta. All freezes in the B-family runs (4, 2, 7) fell within 100 ms of a renderer main-thread stall (rAF interval > 25 ms). Of the A2 freezes, 26 of 29 did not; those come from `<video>` start latency.

Chromium behaviour found on the way:

- One `AudioBufferSourceNode.start(t)` per segment gave deviation bursts of 5.2-7.9 ms at 15 of 200 cuts (`results/residual-run.log`). This was one run; whether the same cuts are hit on every run was not measured.
- Inside `AudioWorkletProcessor.process()`, the global `currentFrame` was one quantum (128 frames) behind the real position 28 times in a 16-minute run, apparently only when the worklet receives messages. The C-wsine control had no messages and 0 repeated quanta. Indexing audio by `currentFrame` therefore repeats a 128-sample block, which is an audible tick. A processor-owned sample counter removed it: 0 deviations.

## Pass thresholds for #15

Measured with this harness, or an equivalent one, on the fixture above, full 200-cut list, on an Apple M3. The preview passes when all of these hold:

1. Stray frames at cuts: 0. Dropped program frames at cuts: 0.
2. Freeze of 1 frame or more at no more than 5 % of cuts (10 of 200). Freeze p95 no more than 17 ms. No freeze above 167 ms (5 frames).
3. Dropped frames inside segments no more than 0.1 % of program frames.
4. Audio: 0 clicks, 0 gaps of 1 ms or more, and 0 overlaps at cuts. 0 repeated render quanta over the run. Output sample-exact to the expected program (residual above 0.02 on 0 samples) when the recorder is in the graph.
5. A/V offset at cuts: p5 and p95 within ±20 ms.
6. Wall time within 0.1 % of program duration.

A1 fails 2, 3, 4, 5 and 6: freeze at 58.5 % of cuts, 0.60 % interior drops, clicks and gaps at cuts, A/V p5 -33.5 ms, wall time 0.74 % long. A2 fails all six: 2 dropped frames at a cut, freeze at 14.5 % of cuts (p95 50 ms), 0.40 % interior drops, 16 repeated quanta (2006 deviating samples), A/V p95 +24.6 ms, wall time 0.21 % long. B and B-bufsrc fail 4 only (B: 1 click, 29 repeated quanta; B-bufsrc: 15 clicks, 4 overlaps). B-chunkedself passes all six. Check: `node scripts/check-thresholds.mjs` (`results/thresholds.log`); wall times are rounded to 0.1 s.

## Consequences

- **SPEC §3.4 Preview**, first bullet: replace "played in `<video>` elements, double-buffered per track …; audio mixed with Web Audio" with the design above. That design is WebCodecs decode from the keyframe before each in-point, pre-roll discarded, frames drawn on the audio clock. Audio is a PCM sidecar mixed in an `AudioWorklet` with its own sample counter and 2 ms edge fades. The SPEC owner makes this edit; this ADR does not.
- **SPEC §13** risk row "Gapless multi-clip preview in `<video>`": mitigation becomes the above. Preview renders stay a documented fallback only.
- **SPEC §6.3 and ticket #7** (proxies): the proxy recipe must be H.264, CFR, fixed GOP 15 (0.5 s), **no B-frames**, faststart. With no B-frames, decode order equals display order, so sample index equals frame index. Import also writes a PCM sidecar next to the proxy (regenerable). The measured mono s16le 48 kHz sidecar is 164.8 MiB per 30 min; stereo would be twice that.
- **#15** reads samples through the `frameshell-media://` range protocol (SPEC §3.2) with an MP4 demuxer (the spike used mp4box.js 2.4.1 and Node `fs`). It should run decode and draw in a Worker with `OffscreenCanvas`. Every B-family freeze coincided with a main-thread stall, and the real app's React UI will stall the main thread more than the spike did. That worker variant was not measured.
- **#17** (audio tracks) mixes into the same worklet rather than one node per clip.

## Not measured

- A real talking-head recording, as the fixture was synthetic by instruction. The decode load of 960x540 H.264 should be similar, but that was not verified.
- MediaSource Extensions: not built. The spike compared `<video>` against WebCodecs only, so MSE remains an untested alternative.
- Photons: the video metric is what the renderer samples at rAF, not what the panel emits. For `<video>`, the compositor presents frames independently of the main thread, so A1/A2 figures may differ from what is on screen by about one vsync.
- Audio at the device: the recorder sees the graph output, not device underruns, and nobody listened to the runs.
- More than one video track, seeking and scrubbing latency, higher proxy resolutions, Windows and Linux, and decode or draw in a Worker.
- Run-to-run variance: each configuration ran once on the full list, on a shared machine.

## Addendum (#104): the worklet clock never falls behind `currentFrame`

A processor-owned sample counter alone was not enough. Under load Chromium can render AudioContext quanta without calling a worklet's `process()`, while `currentFrame` keeps advancing; a pure own-count then stays behind the context clock for the rest of playback, so program audio plays up to ~150 ms late and its tail is cut. Threshold 5 does not see this (it measures the scheduled splice, not the heard audio); threshold 4 does, intermittently.

Rule now: each quantum's frame is `max(own count, currentFrame)` (`QuantumClock` in `preview/mixer.ts`, used by the mixer and the probe recorder). A stale `currentFrame` still never repeats a block; skipped quanta can no longer make audio late. Assumption, documented but not measured: a stale `currentFrame` is only ever behind the true frame, never ahead. Details and measurements: `docs/research/preview-playback-measurements.md`.
