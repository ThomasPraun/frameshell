# Shoot capture: formats, crash safety, sync, system audio, live recognition (spike for ADR 0024)

Spike code: [`spikes/shoot-capture/`](../../spikes/shoot-capture/README.md) (throwaway, own npm package, not in the workspace). Machine: Apple M3, macOS 26.3, Electron 44.9.3 (Chromium 152, `^44.5.0` resolved), managed ffmpeg 9.0.2, whisper.cpp v1.9.4 (pinned commit `927cfce3`). Run 2026-10-23. The question set comes from the "Rodaje" feature request: record takes in the app (camera, screen, microphone, system audio), a teleprompter that follows the voice, compare takes against a Markdown script.

**Measured** = produced by a script in the spike on this Mac. **Needs owner** = needs a real camera, a real microphone or macOS permissions that were not granted to the spike; the script and checklist are in the README. **Cited** = from docs, link given.

## What could not be measured here

- `getUserMedia({ audio })` hangs on this Mac in Electron 44, with `--use-fake-device-for-media-stream` and without it (5 s timeout, Chromium logs `Audio thread hang`). Video `getUserMedia` works (108 ms), WebAudio output works. Cause not found (camera and microphone TCC are `granted` for the process, so it is not the permission prompt). All "microphone" audio below is a WebAudio beep source standing in for the mic. A real-mic run is `npm run manual-mic`. If this reproduces on the owner's machine it is a blocker for the feature and the ADR must say how audio is captured instead.
- Real screen capture: Screen Recording is `denied` for the spike process, and calling `getDisplayMedia` would raise the system prompt, which the brief forbids. The "screen" in Q3 is a second canvas recorded by its own `MediaRecorder` (a stand-in). `npm run manual-screen` does the real thing.
- Real camera clock drift, real call audio and system audio (Q4): needs owner.

## Q1. Recording format

**Answer.** All ten tested types are supported by `MediaRecorder.isTypeSupported` in Electron 44 and all recorded cleanly: `video/mp4` with `avc1.42E01E`/`avc1.640028` + `mp4a.40.2` or `opus`, bare `video/mp4` (this one is **VP9 + Opus inside MP4**, not H.264), and `video/webm` with `vp8`, `vp9`, `av1`, `h264` + `opus`, and bare `video/webm` (= VP8). No decode errors in any file (`ffmpeg -f null`).

60 s per type, fake camera 1280x720 at 30 fps (`fps=30` needs the switch value `--use-fake-device-for-media-stream=fps=30`; without it the fake camera runs at 20 fps) plus beep audio. `report.json` has everything.

| Type | MB/min | Real fps | Frame dt sd / max | A/V start (ffprobe) | Duration known | CPU avg / max (% of one core) |
|---|---|---|---|---|---|---|
| mp4 avc1.640028 + aac | 3.4 | 30.001 | 0.41 / 35.7 ms | 0 | yes | 0.7 / 1.3 |
| mp4 avc1.42E01E + aac | 4.0 | 30.001 | 0.46 / 35.8 ms | 0 | yes | 1.0 / 2.3 |
| mp4 avc1.640028 + opus | 3.9 | 30.001 | 0.50 / 35.9 ms | 0 | yes | 1.1 / 1.8 |
| mp4 avc1 + opus | 4.5 | 30.001 | 0.39 / 35.7 ms | 0 | yes | 0.8 / 1.9 |
| mp4 (bare, VP9 + Opus) | 7.6 | 30.001 | 0.51 / 35.8 ms | 0 | yes | 1.9 / 2.9 |
| webm vp8 + opus | 5.6 | 29.767 | **6.5 / 266 ms** (3 gaps > 100 ms) | 103 ms | no | 3.5 / **15.7** |
| webm vp9 + opus | 7.6 | 30.001 | 0.60 / 35 ms | 142 ms | no | 1.9 / 2.4 |
| webm av1 + opus | 5.5 | 30.000 | 0.62 / 35 ms | 84 ms | no | 2.3 / 3.3 |
| webm h264 + opus | 4.5 | 30.000 | 0.60 / 35 ms | 78 ms | no | 0.8 / 1.3 |
| webm (bare, VP8) | 5.7 | 30.001 | 0.65 / 35 ms | 142 ms | no | 4.1 / 6.4 |

- Frame timing is regular everywhere except VP8 (one run with irregular frames and a 266 ms gap; the fake camera is a trivial scene, so this is encoder scheduling, not load). Presentation timestamps are monotonic in file order in all files.
- Sizes and CPU are for the synthetic fake camera (moving pacman); real footage costs more. CPU is the sum of `app.getAppMetrics()` over all Electron processes. It does not tell whether Chromium used VideoToolbox for H.264.
- **MP4 is fragmented** (`ftyp`, `moov`, then `moof`+`mdat` pairs) and has duration, so `ffprobe` reads it directly. **WebM has no duration element and no cues** while live: `ffprobe` shows no duration until the file is remuxed (`ffmpeg -c copy`).
- **A/V offset.** The `start_time` offsets in WebM (78-142 ms, audio later) say nothing about real sync. With the flash-and-beep source (`npm run q1b`, 25 s per type, 24 events each), audio onset minus flash frame: mp4+aac -59.4 ms (sd 2.9), webm vp9 -54.6 (1.5), webm h264 -57.3 (1.9), webm vp8 -73.0 (2.1), **mp4 + opus -154.7 (1.5)**. Negative = audio early. The common ~-55 ms is mostly the source (a canvas is captured up to one frame plus pipeline after it is drawn), but mp4+opus is a further ~100 ms off, repeatably. Cause not found (ffmpeg's reading of Opus in MP4 is a suspect). Inside the 5-minute dual recording (Q3) the same file drifted +2.2 ms/min (8 ms over 4.5 min) at an offset of about -180 ms under load.
- **Start latency.** `recorder.start()` to `start` event: 65-255 ms. First `dataavailable` after start: **3.2-3.3 s for MP4 (one chunk per fragment, 19 chunks in 60 s although `timeslice` was 1000)**, 0.8-0.96 s for WebM (59 chunks). That is a Chromium behaviour (see the Chromium bug linked in the addpipe article below), so MP4 gives you coarse chunks.

Sources: `MediaRecorder.start(timeslice)` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/start)); MP4 in MediaRecorder since Chrome 126 and fragmented output, chunk sizes follow fragment boundaries ([addpipe](https://blog.addpipe.com/duration-in-mp4-files-produced-by-chrome-safari/), a third-party article that links Chromium issue 401048625; not read by me).

**Recommendation for the ADR.**
- Record **MP4 `avc1.640028` + `mp4a.40.2`** (H.264 High + AAC): smallest, regular timing, duration and seeking from the start, ffmpeg and every editor reads it, A/V offset in line with WebM VP9. Avoid MP4 + Opus (extra ~100 ms) until the cause is known, and avoid VP8 (irregular timing).
- Fallback if the mp4 types are missing: `video/webm;codecs=vp9,opus` (needs a remux for duration).
- Treat the recorded file as a capture master, then run it through the existing proxy recipe. Do not trust container A/V offsets: store the page clock times (Q3) next to the file.
- Open: re-run with a real camera and microphone (`manual-mic`); the A/V offset must be remeasured with a clap, not with a canvas.

## Q2. Crash safety

**Answer.** Writing every chunk to disk from the main process (`ipcRenderer.invoke` + `appendFileSync`) works. Killing the whole Electron process group with SIGKILL 12.5 s after the `start` event left a readable file in all four tested types, and a stream-copy remux succeeded with no decode errors:

| Type | Chunks on disk | Raw file | After `ffmpeg -c copy` | Lost vs kill time |
|---|---|---|---|---|
| mp4 avc1.640028 + opus | 3 (fragments) | opens directly, duration 10.10 s, 303 frames | 10.10 s, 303 frames | **2.41 s** |
| mp4 avc1.640028 + aac | 3 | opens directly, 10.10 s | 10.10 s, 303 frames | **2.40 s** |
| webm vp9 + opus | 12 | no duration, 365 frames | 12.17 s, 365 frames | **0.34 s** |
| webm vp8 + opus | 12 | no duration, 365 frames | 12.17 s, 365 frames | **0.33 s** |

- Worst case loss = one chunk: about **3.3 s for MP4** (fragment length; the loss above depends on where the kill falls in the fragment), about **1 s for WebM**. The MP4 file needs no repair; the WebM needs a remux to get duration and seeking (ffmpeg warns `File ended prematurely`, the output is complete up to the last chunk).
- This was one kill per type, at one moment. A kill of only the renderer, or an OS crash with unflushed page cache, was not tested.

**Recommendation.** Stream chunks to `<project>/.frameshell/...` as they arrive (no buffering in the renderer), keep a small sidecar with the chunk arrival log and the start times (Q3), and on next launch offer "recover take": `ffmpeg -c copy` for WebM, nothing for MP4. State in the UI that MP4 can lose up to ~3 s, WebM up to ~1 s. If 3 s is too much, WebM VP9 is the crash-safer choice.

## Q3. Camera + screen at once

**Method.** Two `MediaRecorder`s in one renderer, started in the same tick: a 1280x720 "camera" stand-in (with beeps) and a 1920x1080 "screen" stand-in, both MP4 avc1.640028 + opus, both showing a 24-bit barcode of `performance.now()` (16 px per bit, decoded from every frame with ffmpeg) so the true time of every frame is known. 300 s, `npm run q3`.

**Measured** (9006 and 9004 frames, 0 outliers):

| | Camera | Screen |
|---|---|---|
| Wall time of file pts 0 (fit) | 154.77 ms | 155.64 ms |
| Drift vs page clock | +0.022 ms/min | -0.007 ms/min |
| Residual sd | 1.03 ms | 0.58 ms |

- **Start offset between the two files: -0.87 ms. Relative drift over 5 min: 0.15 ms total.**
- Which clock predicts where pts 0 is? `performance.now()` read **immediately before `recorder.start()`**: error -2.1 ms (camera) and -2.5 ms (screen). The `start` event arrives **+145 / +149 ms late** and the first `dataavailable` **+3.4 s late**: do not use them.
- The two recorders differed by 4 ms in `start` event time and 0.4 ms in call time, so starting both in the same tick is enough for ~1 ms.
- **Limits.** Both stand-ins are fed by the same Chromium clock, so this shows `MediaRecorder` timestamps are consistent, not that a USB camera, a display capturer and a microphone agree. Real devices have their own latency (capture pipeline of a webcam is often 50-200 ms before the frame reaches the page) and their own crystals (10-100 ppm would be 0.6-6 ms/min, 3-30 ms over 5 min), neither of which this run can show. `npm run manual-screen` records the real camera and the real screen at once with a visible barcode overlay for the screen; the camera has no ground truth, so the owner should add a clap/flash check (README).

**Recommendation.**
- Use one renderer, one `performance.now()` origin. Store for each recording `{ wallStart: performance.timeOrigin + startCallMs, startCallMs, recorder start/stop times }` in a sidecar and use `startCallMs` as the file's pts-0 time (precision ~2 ms measured).
- Align takes by that sidecar, then refine by audio cross-correlation when two recordings contain the same sound (suggestion, not measured). Add a calibration action for fixed device latency (clap in front of camera) once real measurements exist.
- For long takes record the drift check in the sidecar (end time vs duration) and only resample if it exceeds a frame.

## Q4. System audio

All **cited**; nothing was run (needs the permissions the spike was not granted). Electron docs at tag v44.5.0.

| OS | What Electron 44 offers | Source |
|---|---|---|
| macOS 14.2+ | `desktopCapturer`/`getDisplayMedia` audio through Chromium's **CoreAudio Tap** API (default since Electron 39). Needs `NSAudioCaptureUsageDescription` in `Info.plist` (when run from a terminal or IDE the parent app needs it). Without the permission the audio track is created in the `ended` state, **silent, no error in JS**. No fallback to the old ScreenCaptureKit path if tap creation fails. | [desktop-capturer v44.5.0](https://raw.githubusercontent.com/electron/electron/v44.5.0/docs/api/desktop-capturer.md), [Electron 39 notes](https://electronjs.org/ru/blog/electron-39-0) |
| macOS 14.2+ (opt out) | `app.commandLine.appendSwitch('disable-features', 'MacCatapLoopbackAudioForScreenShare')` restores the older Screen & System Audio Recording path; the flag works through Electron 44 and was removed upstream in M155, so it **does nothing from Electron 45** | same, and [docs PR 53646](https://releases.electronjs.org/pr/53646) |
| macOS 13 to 14.1 | Not covered by the Tap; the docs only say macOS 13+ has APIs for desktop audio without a kernel extension. The practical route is a virtual device (BlackHole) read with `getUserMedia`. | desktop-capturer v44.5.0 |
| macOS 12.7.6 and older | `getUserMedia` cannot capture desktop audio | same |
| Windows | `audio: 'loopback'` or `'loopbackWithMute'` in `session.setDisplayMediaRequestHandler`. The session doc says it is "currently only supported on Windows" | [session v44.5.0](https://raw.githubusercontent.com/electron/electron/v44.5.0/docs/api/session.md) |
| Linux | Nothing documented for loopback. PipeWire `getSources` returns only one source. Chrome offers system audio on Windows and ChromeOS, tab audio elsewhere (third-party source, 2019 era). Workaround to test: a PulseAudio/PipeWire "Monitor of ..." device read with `getUserMedia`. | desktop-capturer v44.5.0, [addpipe](https://addpipe.com/getdisplaymedia-demo/) |

Also: `systemPreferences.getMediaAccessStatus('screen')` reports the Screen Recording permission (it said `denied` for the spike). `useSystemPicker` is experimental and macOS 15+ only.

The two Electron docs disagree for macOS: the session page still says loopback is Windows-only, the desktop-capturer page describes the macOS tap. **Which one holds for `audio: 'loopback'` in Electron 44 on macOS is the first thing the manual test must settle.**

**Manual macOS test** (`npm run manual-sysaudio`, README checklist): plays a 440 Hz tone from the app, records screen + loopback 20 s, prints the track state and `volumedetect`. Run it (a) as is, (b) with `-- --no-cat`, (c) after granting Screen Recording and System Audio Recording to the terminal (or run the packaged app).

**Packaging fact from this repo** (not about the spike): `apps/desktop/build/entitlements.mac.plist` has no `com.apple.security.device.audio-input` or `device.camera`, and `electron-builder.yml` sets no usage-description strings; hardened runtime is on. A signed build will need both entitlements (also on the inherit plist, since the Helper processes open the devices) plus `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription` via `mac.extendInfo`. Sources: [electron-builder mac docs](https://www.electron.build/docs/mac), [Apple, configuring the hardened runtime](https://developer.apple.com/documentation/xcode/configuring-the-hardened-runtime.md); Apple's audio-input entitlement page is script-rendered and could not be read, so the exact wording is unchecked. The unsigned dev Electron already carries generic strings for all three keys (checked in its `Info.plist`).

**Recommendation.** Per OS: macOS 14.2+ Tap with the permission flow and a visible "audio is silent" check (read the track state and level, because failure is silent); older macOS and Linux: ask the user to pick a loopback input device; Windows: `audio: 'loopback'`. Build the UI around "mic only" being always valid and system audio being optional. Do not rely on the opt-out flag; Electron 45 removes it.

## Q5. Live recognition latency (whisper.cpp)

**Setup.** Spanish speech from macOS `say -v Paulina -r 175` (es_MX), 7 sentences, 30.0 s ("a", the script) and 30.9 s ("b", with deviations: sentence 3 skipped, extra words in sentence 2, "mixtas" read as "mezcladas", a restart of sentence 5). Windows of W seconds are cut every hop seconds, processed in order; latency is the real wall time of each call, and if a call is still running when the next window is ready the next one waits (simulated real-time). Greedy decoding (`-bs 1 -bo 1`), temperature fallback off, 4 threads, Spanish forced, per-word timestamps (`-ml 1 -sow`). Models from the pinned Hugging Face revision of `docs/binaries.md`.

Two ways to call whisper.cpp:
- **CLI** per window: the managed `whisper-cli` (Frameshell Metal build, `whisper-cpp-1.9.4-fs1`). Process start + model load every window.
- **Server**: `whisper-server`, built from the same pinned commit with Metal, model resident. The pinned package ships only `whisper-cli` (no `whisper-server`, no `whisper-stream`; `stream` needs SDL2 and a microphone), so any resident-model design needs a new build target or a different integration.

**Latency per window (p50, ms), W = 3 s, hop 1 s** (`out/q5/summary-*.json`; p95 is within 10-15% of p50 except for single outliers up to 0.9-1.7 s once per run, see below):

| Model | CLI ac default | CLI `-ac 400` | Server ac default | Server `-ac 400` |
|---|---|---|---|---|
| tiny | 146 | 128 | 78 | 39 |
| tiny-q5_1 | 123 | 110 | 75 | 35 |
| base | 208 | 166 | 144 | 64 |
| base-q5_1 | 170 | 122 | 143 | 56 |
| small | 461 | 321 | 471 | 178 |
| small-q5_1 | 378 | 222 | 469 | 156 |

- Metal on the M3. **Real-time factor** (processing time over audio hop) is 0.04-0.5; everything runs well inside real time, so no window ever queued, except one outlier call of 1.2-1.7 s per run for `small` with default context that made a window wait 0.2-0.7 s.
- `-ac 400` (encoder context 8 s instead of 30 s) cuts the latency by 2-3x and did not hurt accuracy; `-ac 200` was also fine for tiny/small but produced repetition loops twice with base. Keep ac above the window length in encoder frames (50 per second).
- **Cold start**: first call after a fresh install of the CLI took 16.3 s (Metal shader compile, as documented in `docs/binaries.md`, 15-25 s). The first call of a resident server after that took 0.05-0.6 s. A live feature must warm up before the take.
- **Accuracy.** Whole-file WER against the spoken text (`npm run q5-offline`): tiny 0.038/0.013, base 0.025/0.026, small 0.013/0.000, q5_1 variants the same within one word (a/b fixtures). Windowed WER (reference = the words overlapping the window, hypothesis = everything the window returned, so window-edge cut words count as errors; per-window WER capped at 1): tiny 0.20-0.22, base 0.16-0.20, small 0.12-0.19, with W = 3. W = 2 is worse (base 0.27-0.29, small 0.25-0.27), W = 4 is better (base 0.12-0.15, small 0.11-0.14).
- **Failure mode.** Every model size can produce a hallucination loop on a window ("la fecha de la fecha de ...", tiny default context was the first seen): 0-2 windows per 30 s file in 15 of the 66 runs. The follower ignores it (Q6, unit test). A repetition guard on the recognizer output is cheap.
- Caveats: the voice is TTS (clean, steady), the room is silent, the speaker is one person; real microphones, accents, hesitations and noise will be worse. Truth word times are proportional to characters inside exact sentence bounds (about +-0.15 s per word).

**Recommendation.** Model **small** (or `small-q5_1`, 190 MB, same accuracy and 10-30% faster than f16 here) with `-ac 400`, window 3-4 s, hop 0.5 s, on a **resident** process (p50 156-178 ms, real-time factor 0.3). `base-q5_1` (60 MB, p50 56 ms) is the low-end option for machines without Metal/CUDA; `tiny` is too inaccurate at window edges. Use the CLI only if a resident build is not possible (+90-145 ms per call, plus the model reload). Hop 0.5 s halves the follower lag (Q6) for twice the calls. Force the language from the script, and test an initial prompt made from the script text (not tried).

## Q6. Teleprompter follower

**Prototype**: `spikes/shoot-capture/scripts/follower.mjs`, pure functions, no I/O:
`tokenizeScript(markdown)`, `normalize(text)`, `createFollower(words)`, `advance(state, recognizedWords)` returning the new state (`idx` = last spoken script word) plus the jump and its evidence. Eight unit tests (`npm test`).

Approach: normalize accents, case, punctuation and digits (`30` = `treinta`); take the last 8 recognized words of the latest window (windows overlap, so the same words arrive repeatedly; the function is idempotent); local alignment (Smith-Waterman) against the script window `[idx - 12, idx + 28]` with exact (+2), near (+1.3, edit distance 1, or 2 on words of 8+ letters), prefix of a cut word (+1) and mismatch (-1.2), gaps -0.9/-0.8. Acceptance: a small step forward needs 2 matched words and score 3 (or one long exact word at +1/+2); a jump of more than 6 words needs 3 matched words and score 5.2; moving back (restart) needs the same; anything else is ignored. So a lone common word ("de"), a hallucination loop or unrelated speech never move the cursor (unit tests).

**Measured** (66 runs: every q5 configuration on both fixtures; `npm run q6`). Lag = time the follower first reports a script word, minus when the speaker finished it (so a lag of 0 means "highlighted as the word ends"; subtract roughly 0.3 s to get the lag behind the word's start).

| Configuration (server) | Window latency p50 | Lag behind word end p50 / p90 / max (fixture a) | Fixture b | Wrong jumps |
|---|---|---|---|---|
| small ac400, W 3, hop 0.5 | 160 ms | 0.09 / 0.42 / 0.57 s | 0.10 / 0.41 / 1.40 s | 0 |
| base ac400, W 3, hop 0.5 | 62 ms | 0.03 / 0.46 / 0.96 s | 0.07 / 0.50 / 1.81 s | 0 |
| small ac400, W 3, hop 1 | 178 ms | 0.42 / 0.85 / 1.07 s | 0.39 / 0.77 / 1.41 s | 0 |
| base ac400, W 3, hop 1 | 64 ms | 0.34 / 0.82 / 1.02 s | 0.29 / 0.79 / 2.30 s | 0 |
| small default ac, W 3, hop 1 | 471 ms | 0.73 / 1.15 / 1.36 s | 0.70 / 1.33 / 2.33 s | 0 |
| tiny ac400, W 3, hop 1 | 39 ms | 0.39 / 0.94 / 2.66 s | 0.34 / 1.29 / 2.66 s | 0 |

- Every script word was reached in all 66 runs (0 missed of 79 / 70 anchors) and the final position was the last word.
- **Wrong jumps: none.** No run ever ended up 5 or more words ahead of the speaker; at most one event 3-4 words ahead, which is the word being spoken when the window was cut (the truth uses proportional timing, so this is within its error). Forward jumps larger than 6 words: exactly 1 on fixture b in 30 of 33 runs (the skipped sentence), 2 in the tiny runs; on fixture a (no skip) 5 of 33 runs had one such jump, a catch-up after a window with few recognized words, never beyond the speaker.
- **Skipped sentence (b).** The follower needs three matching words before it believes a jump: it reached "El segundo consejo" 1.3-2.4 s after "El" ended over the 33 runs on fixture b (1.4 s in the recommended small configuration). During those 1-2 s the highlight stays on the last confirmed word, which is the safe behaviour.
- **Restart (b: "Por último, graba siempre" repeated).** One backward move, handled; the cursor then continued correctly.
- **Misread and added words** ("mezcladas", "bueno, la verdad es que son") did not derail it.
- The lag is dominated by the hop and the window-edge: hop 1 s gives a median of 0.3-0.45 s, hop 0.5 s gives 0.03-0.1 s. The recognition latency (40-180 ms) is small next to it.

**Recommendation.**
- Teleprompter state = `idx` from this follower; show the sentence, center word `idx + 1`, highlight `<= idx`. The follower is stateless apart from `idx`, so it can live in the renderer next to the recognizer stream.
- Feed it the full text of each new window (no de-duplication needed). Run recognition with hop 0.5 s.
- Keep the thresholds in one options object; they were tuned on TTS only. Re-tune with real recordings (the take comparison of Q "compare each take against the script" can reuse the same alignment on the final transcript).
- When the follower is "lost" (no accepted update for N seconds) show that state instead of guessing; a manual "I am here" click should set `idx`.
- Open: noisy real speech, speakers who paraphrase heavily, and scripts with numbers/dates/English terms (digits to words only covers 0-99).

## Owner runs (2026-10-24, same Mac)

**Measured** by the owner with real devices and permissions granted to Terminal (Screen & System Audio Recording, camera, microphone). Diagnostic: `npm run manual-screen-diag` (3 s per variant, each its own Electron process).

- **Microphone works.** `npm run manual-mic`: real camera + real mic, 20 s, audio present (mean -27.4 dB, peak 0 dB), 30.2 fps, no gap over 100 ms, 7.3% of one core. The hang above came from the spike's automated runs, not from Electron.
- **`--use-fake-ui-for-media-stream` breaks screen capture on macOS** (`NotReadableError: Could not start video source`, even with permission granted). It was always set in the spike and caused every earlier screen failure. Without it:

  | Variant | Result |
  |---|---|
  | `getDisplayMedia` + `setDisplayMediaRequestHandler` (source from `desktopCapturer`) | OK, 3024x1964 |
  | legacy `getUserMedia` `chromeMediaSource: 'desktop'` | OK; with desktop audio OK |
  | `getDisplayMedia` + `audio: 'loopback'` (CoreAudio Tap, default) | OK, audio track |
  | same with `MacCatapLoopbackAudioForScreenShare` disabled | OK, audio track |
  | `useSystemPicker: true` | timeout (picker not answered in time; not pursued) |

- **System audio from other apps is captured on macOS 26.3** with `audio: 'loopback'`, through both the Tap and the opt-out path: YouTube in a browser, mean -14 dB, peak 0 dB. With nothing playing the track is digital silence (-91 dB), not an error, so the UI must show a level meter. The app's own output is captured too (a 440 Hz tone the spike played came through at -13 to -21 dB), so the app must stay silent while recording or exclude itself.
- The display track arrives at native Retina size (3024x1964); the recorder must constrain it (1080p or 1440p).
- Not yet done: camera + screen sync with real devices (barcode + clap), macOS 13 to 14.1, Windows, Linux, real-voice follower run.

## Open items for the owner

1. Done: `manual-mic` works (see Owner runs).
2. `npm run manual-screen` (after removing the fake-UI switch from it): real camera + real screen together, start offsets and screen capture latency (barcode overlay); then a clap test for the camera.
3. Done on macOS 26.3: `audio: 'loopback'` captures other apps (see Owner runs). Still open: macOS 13 to 14.1, Windows, Linux.
4. Mp4 + Opus 100 ms offset: confirm or explain with a real player (not only ffmpeg).
5. Real-voice recording for the follower and the model choice.
