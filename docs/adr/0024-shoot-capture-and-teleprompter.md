---
status: accepted
---

# Shoot capture: record in the app, a teleprompter that follows the voice

ADR 0023 compares takes against a shoot script and assembles the first cut. This ADR records the takes inside Frameshell: camera, screen or a window (a Zoom or Meet call too), microphone and system audio. The teleprompter shows the script with the word being said kept centered, and Frameshell listens live so the person sees where they are and what they skipped. With both, one app goes from script to a finished video. Decided by the owner on 2026-10-24, from the spike in [`docs/research/shoot-capture.md`](../research/shoot-capture.md).

## Context (verified in the tree and in the spike)

- **Measured in the spike** (Apple M3, macOS 26.3, Electron 44.9.3):
  - `MediaRecorder` records MP4 (`avc1` + AAC) and WebM (VP9/VP8/AV1 + Opus) cleanly. MP4 + Opus is about 100 ms off, and VP8 has irregular timing and costs more CPU.
  - Chunks appended to disk from the main process survive a kill: MP4 loses at most one chunk (about 3.3 s), WebM about 1 s.
  - Two recorders started together are within 1 ms of each other, with 0.15 ms of drift over 5 min, when aligned by `performance.now()` read just before `start()`. The `start` event and the first chunk are late (150 ms and 3 s).
  - Real camera and microphone work. The screen through `getDisplayMedia`, with `setDisplayMediaRequestHandler` picking a `desktopCapturer` source, works at native size (3024x1964 on a Retina display). It delivers frames only when the screen changes (25 fps average, gaps up to 0.8 s on a still screen).
  - System audio with `audio: 'loopback'` captures other apps on macOS 26.3, through both the CoreAudio Tap and the older path. When nothing plays, the track is silence, not an error. The app's own sound is captured too.
  - `--use-fake-ui-for-media-stream` breaks screen capture.
  - whisper.cpp with a **resident** process (`whisper-server`, same pinned commit) and `-ac 400` takes 39 ms per 3 s window with `tiny`, 64 ms with `base` and 178 ms with `small` (Metal). The first run after install takes 16 s (shader compile). Short windows sometimes produce a repetition loop.
  - A pure follower (local alignment of the last 8 heard words against a script window) followed every synthetic read to the end with no wrong jump. It ran 0.03 to 0.10 s behind the spoken word at a 0.5 s hop, and recovered from a skipped sentence 1.3 to 2.4 s into the next one. Measured on synthetic Spanish speech only.
- **Not measured:** real camera against real screen latency, macOS 13 to 14.1, Windows, Linux, a real voice in the follower.
- Electron's own docs: `setContentProtection(true)` hides a window from capture on macOS and Windows, but apps using ScreenCaptureKit may still capture it on newer macOS (`electron.d.ts`, Electron 44).
- The managed whisper package ships `whisper-cli` only (`docs/binaries.md`). Transcription is per asset and explicit (SPEC decision 10). There is one detachable-panel system (ADR 0012) and one playhead (`preview/transport.ts`).
- Signed macOS builds lack the camera and microphone entitlements and the usage strings (`apps/desktop/build/entitlements.mac.plist`, `electron-builder.yml`).
- Multicam (ADR 0016): one group per conversation on one clock, one program track per group, screen angles and gallery recordings exist.

## Decision

1. **A recording session is continuous; takes are ranges in it.** From "Start shoot" to "End shoot", every source records without stopping, one file each, all under `assets/shoot/<session id>/` (`camera.mp4`, `screen.mp4`, `mic.m4a`, `system.m4a`). Re-recording does not stop the files. "Take" (key `T`) starts a new take, "Cut" (key `C`) ends it, and the scene the teleprompter shows is the take's start scene. A session is **one multicam group**: the camera and the screen are angles (the screen marked `screen`), the microphone and the system audio are mics, and the offsets come from `performance.now()` at each recorder's start. This settles the open point of ADR 0023: a session has one program track, and the chosen takes become shots on it. A shoot recorded over several sessions has one group per session.
2. **Sources and setup.** The Shoot view (Spanish UI: **Rodaje**) lists cameras, microphones, screens and windows. Frameshell's own list shows the `desktopCapturer` sources with thumbnails; the system picker is not used. System audio is a toggle. Each source shows a live level or a preview. If system audio stays silent for 10 s while it is on, the view says so, because the failure is silent. A microphone is the only required source. Screen and window frames are limited to 1440p.
3. **Format and safety.** Video is MP4 H.264 (`avc1`) + AAC, with WebM VP9 + Opus where MP4 is not offered. Audio-only sources are recorded the same way, without video. Chunks of 1 s are appended to disk by the main process. After a crash, the next open finds the unfinished session, remuxes its files and keeps every take already cut. Files under `assets/shoot/` are the person's media like any other: never edited, and ingested as usual once the session ends.
4. **Analysis per take, seconds after Cut.** While recording, the app also keeps 16 kHz PCM of the microphone (and of system audio, when on) per take. At Cut, that WAV is transcribed with the project's model (`whisper-cli`, as `transcribe` does), and with speakers when the shoot script has several people. The words get the session clock and go to ADR 0023's comparison. When the session ends, the takes' words become the transcript of `mic.m4a` (and of `system.m4a`), so the rest of Frameshell sees ordinary transcripts.
5. **Live recognition for the teleprompter only.** A resident `whisper-server` (new managed binary, same pinned commit, `docs/binaries.md` re-pin) runs `small-q5_1` (`base-q5_1` on machines below a measured speed) with `-ac 400`, on 3.5 s windows every 0.5 s of the microphone mixed with system audio. It warms up when the Shoot view opens, before Start. Live words only move the teleprompter and show provisional marks. They are never written to the project, and every deviation comes from step 4.
6. **Teleprompter.** A detachable panel (ADR 0012), so it can sit on a second screen or a prompter under the camera.
   - **Focus line:** the word being said stays at a fixed point in the middle of the panel, with the next words right after it, so the eyes do not travel. The text scrolls under the focus line; it never jumps.
   - **Whole sentence:** the current sentence is always fully visible. The part already said is dimmed, the current word highlighted, the rest plain. The speaker's name is shown at the start of each line, so in a call everyone's turn is visible.
   - **Cues:** shown small, or hidden by a toggle. A `[FREE: …]` slot shows its note and waits until speech stops.
   - **Live marks:** a skipped sentence is struck through as soon as the follower moves past it.
   - **Controls:** keys move by word (←/→) and line (↑/↓) when recognition is wrong, and a pause key holds the scroll. Font size and mirroring (for beam-splitter prompters) are settings.
   - **Follower:** a pure function, ported from the spike with unit tests, that never moves more than a few words ahead on one match.
7. **Frameshell stays out of the recording.** While a session records, the preview does not play sound. The Shoot view and the teleprompter call `setContentProtection(true)`. Where macOS still captures them (ScreenCaptureKit), the view says so and suggests recording a window instead of the whole screen, or putting the teleprompter on another display.
8. **Calls.** A Zoom or Meet call is recorded as a window (or screen) plus system audio, with your microphone apart. After the session, `multicam gallery` on the screen angle splits the tiles into angles (ADR 0016). Speakers on `system.m4a` and their `**Name:**` in the script link through `people.json` (ADR 0020).
9. **Platforms.** macOS 14.2+ has everything (verified on 26.3). On older macOS and on Linux there is no system audio: the toggle is off with a reason, and a loopback input device can be picked as a microphone. On Windows, `audio: 'loopback'` follows the Electron docs and is untested until a Windows run. Signed builds gain the camera and microphone entitlements (main and inherit plists) and `NSCameraUsageDescription`, `NSMicrophoneUsageDescription` and `NSAudioCaptureUsageDescription`.

## Considered options

- **One file set per take**, stop and start for each. Rejected: each take would be its own group and program track (ADR 0016), and the timeline would spread over many tracks. Re-arming devices between takes also takes seconds.
- **Record outside the app only (OBS, phone).** Rejected by the owner: capture is the point. ADR 0023 still takes imported files.
- **Live recognition writes the transcript.** Rejected: the windowed error rate (0.12 to 0.20) and the repetition loops are fine for following, not for deviations.
- **The browser's speech recognition.** Rejected: it needs a cloud service and does not run in Electron without one.
- **The macOS system picker for screens.** Rejected: experimental, macOS 15+ only, and it timed out in the spike.
- **Plain stacked clips** (camera on V1, screen on V2) instead of a group. Rejected: it loses shots, `direct`, gallery tiles and the screen angle rules that already exist.

## Acceptance scenario

> I open Rodaje, pick my camera, mic and the Zoom window, and turn on system audio: all four meters move. I press Start. The teleprompter on my second screen keeps the word I am saying in the middle. I skip a sentence, it strikes it and catches up. I press C, and four seconds later the scene shows "1 missing sentence". I press T and say it again. When we end the call, the timeline holds the whole episode with the call's tiles as angles, and Juan's lines are tied to Juan.

## Consequences

- Protocol bump: shoot session methods (`shoot.session.start`, `.take`, `.cut`, `.end`, `.recover`), a job kind for per-take transcription, and `shoot.changed` reasons. Schema: sessions and takes on the session clock in `shoots/*.json` (ADR 0023).
- New managed binary `whisper-server` and two small models. Re-pin in `docs/binaries.md`.
- Desktop: Shoot view, teleprompter panel, recorder in the renderer, file appends and crash recovery in main, entitlements and usage strings. UI strings in English and Spanish.
- e2e cannot use `--use-fake-ui-for-media-stream` for screen capture. Screen tests use a stand-in source, and the real devices get a manual acceptance doc (`docs/acceptance/shoot.md`).

## Implementation plan (each part ships and is tested alone)

1. Recorder: sources, levels, continuous session files, crash recovery, entitlements (macOS first).
2. Takes and analysis per take (step 4), joined to ADR 0023's comparison and assembly.
3. Teleprompter with manual scrolling and the focus line.
4. Live recognition (`whisper-server`) and the follower driving the teleprompter.
5. Calls: system audio, window capture, gallery and people after the session.
6. Windows and Linux runs; fix what they show.
