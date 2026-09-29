# Spike #2: gapless preview of a dense cut list (PROTOTYPE, throwaway)

Question: can the Electron preview play a 30-minute CFR proxy with ~200 cuts without visible or
audible hiccups at cut boundaries, and which technique should ticket #15 use?
Decision and numbers: [`docs/adr/0001-preview-playback-technique.md`](../../docs/adr/0001-preview-playback-technique.md).

Self-contained npm package. Not part of any pnpm workspace. Uses local `ffmpeg-static`,
`electron` and `mp4box`; nothing installed system-wide.

## Reproduce

```sh
cd spikes/gapless-preview
npm install
npm run fixture   # ~30 min synthetic source + proxy + PCM sidecar + cut list into media/ (gitignored)
npm run measure   # plays the full cut list with A1, A2, B, B-bufsrc (one visible window each, ~16.5 min each), then analyzes
```

- Quick smoke run: `node scripts/run-all.mjs --cuts=20` (first 20 cuts only).
- One run: `node scripts/run-all.mjs B` (ids: `A1`, `A2`, `B`, `B-bufsrc`, `B-chunked`, `B-chunkedself`, `C-osc`, `C-wsine`).
- Every run used in the ADR: `node scripts/run-all.mjs A1 A2 B B-bufsrc B-chunked B-chunkedself C-osc C-wsine` (~1 h 50 min).
- Sample-exact audio check (audio-clocked runs): `node scripts/audio-residual.mjs A2 B B-bufsrc B-chunkedself`.
- Repeated render quanta: `node scripts/repeated-quanta.mjs C-osc C-wsine A1 A2 B B-bufsrc B-chunked B-chunkedself`.
- Barcode sanity check on the proxy: `node scripts/check-barcode.mjs 0 1 777`.
- Re-analyze existing raw logs: `npm run analyze` (writes `out/summary.md`, `out/summary.json`, `out/<T>.cuts.json`).
- Keep the window visible and the machine otherwise idle: numbers are real-time measurements.

## Fixture (`scripts/make-fixture.mjs`)

- `media/source.mp4`: 1920x1080 30 fps, 30 min, long GOP (300). `testsrc2` pattern, burned-in
  human counter (`drawtext`, when the ffmpeg build has it) and a machine-readable 16-bit frame
  barcode (top-left, row 0 = bits of the frame number, row 1 = complement as a checksum).
  Audio: continuous 220 Hz sine at 0.5 amplitude, so any splice without a fade is a sample jump.
- `media/proxy.mp4`: the proxy recipe under test. 960x540, CFR 30 fps, H.264 High, GOP 15,
  no B-frames, `+faststart`, AAC 48 kHz.
- `media/proxy.pcm`: mono s16le 48 kHz decoded from the proxy audio (Web Audio sidecar).
- `media/cutlist.json`: seeded; 201 kept segments (200 cuts), lengths log-uniform 0.5-20 s,
  removed gaps log-uniform 0.2-4 s, frame-snapped.

## Techniques (`src/renderer.js`)

| run | video | clock | audio |
|---|---|---|---|
| A1 | two `<video>` elements; the idle one is paused on the next in-frame. When the active one presents its last frame (`requestVideoFrameCallback`) it pauses; one frame later the idle one is revealed and `play()`ed | element | element audio, routed through Web Audio gains (switched at the reveal) |
| A2 | same double buffer, but the idle element is pre-seeked 5 frames before the in-point and started hidden 5 frames early to absorb `play()` latency; revealed once it presents the in-frame; outgoing element pauses on its last frame; ±3 % `playbackRate` nudges with hysteresis keep it on the audio clock | `AudioContext` | PCM sidecar, one `AudioWorklet` writes pre-faded (2 ms) segment samples at exact sample frames |
| B | WebCodecs `VideoDecoder` (hardware) fed from the mp4box sample table; decodes from the keyframe before each in-point, discards pre-roll, keeps up to 12 frames ready, draws the `VideoFrame` for the current program frame to a canvas | `AudioContext` | same worklet as A2 |
| B-bufsrc | same as B | `AudioContext` | one `AudioBufferSourceNode` per segment, `start(t)` at the splice (control for the worklet) |
| B-chunked | same as B | `AudioContext` | worklet fed raw s16 in 0.5 s messages, fades applied in the worklet (main thread never loops over samples) |
| B-chunkedself | same as B | `AudioContext` | as B-chunked, but the worklet keeps its own sample counter instead of reading the global `currentFrame` (recommended shape) |
| C-osc, C-wsine | none | - | 300 s audio-only controls: native `OscillatorNode`, and a worklet computing the sine without messages |

## What is measured and how

- Video: every `requestAnimationFrame` the visible surface (active `<video>` or the canvas) is drawn
  into a small canvas and the barcode decoded. That is the frame the page shows at that vsync
  (measured at the renderer, not at the panel). From that sequence, per cut: frames of the
  program never shown (dropped), extra hold time of the boundary frames (freeze, in ms and
  duplicated frames), and frames outside the kept ranges (stray, e.g. pre-roll or overrun).
  Same metrics inside segments give a non-cut baseline.
- Audio: all output passes through an `AudioWorklet` recorder that writes raw f32 to `out/<T>.f32`.
  Per cut window: sample jumps above 0.05 (clicks; a clean 220 Hz sine never exceeds 0.0144),
  silence runs of 1 ms or more (gaps), samples above 0.6 (two sources overlapping).
- A/V offset at a cut: time the first new video frame is sampled minus the time the audio splice
  is heard (`AudioContext.getOutputTimestamp`). Approximate: rAF time precedes photons by about
  one vsync.
- Repeated quanta: non-silent 128-sample render quanta identical to the previous quantum
  (`scripts/repeated-quanta.mjs`; also a row in the summary). The worklet also reports how often
  the global `currentFrame` differed from its own quantum counter (`frameClockMismatches` in `out/<run>.json`).
- CPU: `app.getAppMetrics()` every 2 s, summed over all Electron processes.

## Recorded results (this machine)

`results/` keeps the console logs of the runs behind the ADR (raw `out/` data is gitignored):

- `summary.md`: A1, A2, B, B-bufsrc, B-chunkedself on the full 200-cut list.
- `full-run.log` (A1, A2, B, B-bufsrc), `chunked-run.log` (B-chunked), `final-run.log`
  (B-chunkedself, plus sample-exact residual and `currentFrame` mismatch counts).
- `control-run.log`: C-osc, C-wsine and repeated-quanta counts for every run.
- `diag-run-60cuts.log`: B-chunked vs B-chunkedself on the first 60 cuts (`currentFrame` diagnosis).
  This run overwrote the full-length `out/B-chunked.*` files, so the full B-chunked numbers live
  only in `chunked-run.log`.
- `fixture.log`: fixture generation times and sizes.
