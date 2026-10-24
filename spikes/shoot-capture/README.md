# Spike: shoot capture ("Rodaje") (PROTOTYPE, throwaway)

Questions: record formats, crash safety, camera + screen sync, system audio, live recognition latency and a
teleprompter follower, before ADR 0024. Answers and numbers: [`docs/research/shoot-capture.md`](../../docs/research/shoot-capture.md).

Self-contained npm package. Not part of any pnpm workspace. Electron `^44.5.0` (same major as `apps/desktop`), Node >= 22.
Generated files stay in `media/`, `out/`, `models/`, `bin/` (all gitignored). Nothing is installed system-wide.
ffmpeg/ffprobe: the managed copy in `.cache/test-binaries` if present, else `ffmpeg-static`/`ffprobe-static`.

```sh
cd spikes/shoot-capture
npm install
```

Keep the machine otherwise idle; CPU and timing numbers are real measurements. Runs use Chromium fake devices
(`--use-fake-device-for-media-stream=fps=30`, `--use-fake-ui-for-media-stream`). Kill stray spike processes with
`ps -axo pid,command | grep spikes/shoot-capture/node_modules/electron`, never by process name alone.

## Reproduce

| Q | Command | Time | Output |
|---|---|---|---|
| 1 | `npm run q1` (`-- --seconds=60`) | ~12 min | `out/q1/report.json`: per mime type size, fps, frame timing, A/V start, CPU |
| 1 | `npm run q1b` | ~3 min | `out/q1b-report.json`: audio minus video offset from a flash+beep source |
| 2 | `npm run q2` | ~2 min | `out/q2-report.json`: SIGKILL mid-recording, remux, loss |
| 3 | `npm run q3` (`-- --seconds=300`) | ~6 min | `out/q3-report.json`: start offset and drift of two simultaneous recorders (barcode of `performance.now()` in every frame) |
| 3 | `npm run q3-avdrift` | 1 min | A/V drift inside `out/q3/cam.mp4` |
| 5 | `npm run fixtures` | seconds | `media/speech/{a,b}.wav` (macOS `say -v Paulina`), script in `scripts/speech-data.mjs` |
| 5 | `npm run setup-whisper` | ~5 min | builds `bin/build/bin/whisper-server` (pinned commit, Metal). Also get the managed CLI and models, see below |
| 5 | `node scripts/q5-whisper.mjs --exec=server --models=small --ac=400 --fixtures=a,b --windows=3 --hop=0.5` | | `out/q5/*.json`, `summary-*.json`: latency, windowed WER per config |
| 5 | `npm run q5-offline` | 1 min | whole-file WER per model |
| 6 | `npm run q6` | seconds | `out/q6-report.json`: follower lag, wrong jumps, skip recovery over every q5 config |
| 6 | `npm test` | seconds | follower unit tests |

Whisper downloads (once):

```sh
gh release download whisper-cpp-1.9.4-fs1 -R ThomasPraun/frameshell -p 'whisper-cli-1.9.4-darwin-arm64-metal.tar' -D bin/
mkdir -p bin/cli && tar -xf bin/whisper-cli-1.9.4-darwin-arm64-metal.tar -C bin/cli
REV=5359861c739e955e79d9a303bcbc70fb988958b1   # same revision as docs/binaries.md
for m in tiny base small tiny-q5_1 base-q5_1 small-q5_1; do
  curl -L -o models/ggml-$m.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/$REV/ggml-$m.bin; done
```

`q5-whisper.mjs` flags: `--exec=cli|server`, `--models=a,b`, `--ac=0,400` (whisper audio context, 0 = default),
`--windows=3`, `--hop=1`, `--fixtures=a,b`, `--limit=N` (first N windows, smoke test). The first CLI call after a new
binary path pays the Metal shader compile (~16 s here); the script's `warmupMs` shows it.

## Files

- `src/main.cjs`, `src/page.js`: one Electron window that records N streams at once (`fake` camera + WebAudio beeps, canvas
  barcode sources, `display`, real `cam`), appends every chunk through the main process (the crash-safety path), logs timings.
- `scripts/lib.mjs`: ffprobe/ffmpeg helpers, frame timing stats, barcode decoder, WER.
- `scripts/follower.mjs`: the teleprompter follower (pure). `truth.mjs`: ground truth for the fixtures.

## Known environment problem

`getUserMedia({ audio: true })` hangs (timeout) on the dev Mac in Electron 44 even with fake devices, so the fake
"microphone" is a WebAudio source (`beepSource` in `src/page.js`). Check that on the owner's machine first.

## Manual checklist (owner; needs a real camera, microphone and macOS permissions)

Run from a terminal that is allowed to use the camera and microphone. Never grant permissions to anything you do not trust.

1. **Microphone** `npm run manual-mic`. Expected: a 20 s `out/manual-mic/cam.webm` with a video and an audio stream and a
   `report.json`. If the run prints `FAILED` or the app sits for 20 s with no result, record that `getUserMedia({audio})`
   hangs and note the macOS version.
2. **Camera + screen** `npm run manual-screen`. Needs System Settings > Privacy & Security > Screen Recording for the
   terminal (or for Electron). A barcode of `performance.now()` is drawn at the top-left of the app window and recorded
   with the screen. Check in `report.json`: both files exist, `displayTracks` live, frame timing regular, `marks`.
   For the camera/screen sync, during the 20 s hold a phone with a stopwatch or clap in front of the camera
   while the screen shows the barcode; note the audio/video offset you see.
3. **System audio, macOS** `npm run manual-sysaudio` (the app plays a 440 Hz tone, records the screen with `audio: 'loopback'`).
   Needs Screen Recording and System Audio Recording permission for the terminal; macOS 14.2+ for the CoreAudio Tap.
   Read `report.json`: `audioVolume.max_volume` near -10 dB means the tone was captured; `displayTracks[*].readyState: "ended"`
   or `max_volume: -91` means silent capture (the documented failure when the permission is missing).
   Repeat with `npm run manual-sysaudio -- --no-cat` (disables Chromium's Tap path, works through Electron 44 only).
   Also test while a real call (Meet/Zoom) plays in another app, and with headphones connected.
4. **Other OS** (if you have them): Windows `audio: 'loopback'` is documented to work; Linux: try a PulseAudio/PipeWire monitor
   source with `getUserMedia`. Record what you see.
5. **Real voice** for the follower: record a take with `manual-mic`, run `ffmpeg -i out/manual-mic/cam.webm -ar 16000 -ac 1 media/speech/real.wav`
   and feed it to `q5-whisper.mjs` (add a fixture entry in `truth.mjs` if you want scoring).
