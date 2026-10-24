# Acceptance: recording a shoot in the app (ADR 0024)

> I open Rodaje, pick my camera, mic and the Zoom window, and turn on system audio: all four meters and previews move. I press Start, talk for a few minutes while the call plays, and press End. The timeline gets one multicam group: the camera and the call window as angles (the window marked as a screen), my mic and the call's audio as mics, all in sync.

Steps 1 to 8 cover the recorder (#390): sources, levels, the continuous session, crash recovery and signing; steps 9 to 14 the takes (#391); steps 15 to 21 the teleprompter following a real voice (#393). The e2e test (`apps/desktop/e2e/shoot.spec.ts`) covers the same flow with Chromium's fake camera and microphone and a stand-in screen; the steps below need real devices and macOS permissions, which no test can grant.

Manual run by the owner with real devices, in the **packaged, signed** app (step 7) and in the built app (`pnpm --filter @frameshell/desktop build && pnpm --filter @frameshell/desktop start`). About 30 minutes. Note each friction as an issue; write results to `docs/research/shoot-acceptance-run.md` (date, version, machine, macOS version, numbers asked for below).

## Material

- A Mac on macOS 14.2 or later with a camera and a microphone (built-in is fine), a second app that plays sound (a browser with a video, or a Zoom or Meet test call).
- A fresh project. Camera, Microphone, Screen & System Audio Recording permissions not yet granted to Frameshell (System Settings > Privacy & Security), so the prompts are seen.
- Optional: a clapper or a hand clap in front of the camera, for the sync check.

## Steps

1. **Sources.** Open the Shoot view (Spanish UI: Rodaje). Click "Allow camera and microphone": macOS asks for camera and microphone with Frameshell's own wording. Check: the cameras and microphones are listed by name; the default mic is picked and its meter moves when you speak; picking the camera shows its picture.
2. **Screens and windows.** Click "Choose screen or window…": macOS asks for Screen Recording the first time. Check: screens come first, then windows, with thumbnails; no Frameshell window is in the list; the system picker never shows. Pick the browser or call window: its preview moves. Pick a whole Retina screen once and check in step 5 that `screen.mp4` is at most 1440 px on its shorter side.
3. **System audio.** Turn on System audio and play sound in the other app: its meter moves. Stop the sound for 10 s: the view warns that system audio is silent. Record which permission macOS asked for (System Audio Recording only, or also Screen Recording).
4. **Record.** Press Start shoot. Check: the time counts; the sources are locked; Frameshell's preview plays no sound if you press play; the camera light is on. In the other app, take a screenshot or a screen recording of the screen with Frameshell on it: Frameshell's windows are hidden (black or missing). If they still show (ScreenCaptureKit), note it. Switch the sidebar to another view and back, and move the Shoot view to its own window: the recording goes on. Clap once in front of the camera. Talk for 2 to 3 minutes.
5. **End.** Press End shoot. Check: "Saved 4 files to assets/shoot/<id>." and the multicam group note. In Finder, `assets/shoot/<id>/` holds `camera.mp4`, `screen.mp4`, `mic.m4a`, `system.m4a` (or `.webm` where MP4 was not offered: note which), no `.part` file; `.frameshell/shoot/sessions/` is empty. The files ingest like imports (status bar jobs). On the timeline: one program track `Shoot <id>`; the Angles view shows camera and window; `timeline.show` (or the file) has the window angle with `screen: true` and both mics. Play across the clap: picture and sound agree (note the offset you see, by eye, in frames).
6. **Crash.** Start a second session, record 30 s, then force-quit Frameshell (Activity Monitor > Force Quit, or `kill -9` of the main process). Open the project again and open the Shoot view. Check: "Recovered a shoot that was interrupted: assets/shoot/<id>."; a second group on the timeline; the files play to within about 3 s of the kill (MP4 loses at most one fragment). Also try reloading the window (View > Reload) while recording: the session is finished at once as a recovered one.
7. **Signed build.** In the packaged, signed app (`docs/release.md`): steps 1 to 3 work (the hardened runtime needs `device.camera` and `device.audio-input`, and the usage strings). Check the prompt texts are Frameshell's.
8. **Spanish.** Switch View > Language to Español: the view reads Rodaje, every label is Spanish.

## Takes (#391)

Needs a real whisper model (the project's `transcription` settings, `whisper-cpp` by default) and a shoot script: ask the agent to write `scripts/<name>.md` with `shoot: true` from a script of your own, two or three scenes. The e2e test (`apps/desktop/e2e/shoot-takes.spec.ts`) runs the same flow with a stand-in transcriber (`FRAMESHELL_SHOOT_STAND_IN=1`).

9. **Script and scenes.** Open the Shoot view: the shoot script is picked, its scenes are listed as "Not recorded", the first is current.
10. **A take.** Start shoot, press T, read the first scene leaving out a word, press C. Check: within a few seconds (note how many; first use downloads the model) the scene shows "1 to review", the line shows the word struck, and the deviation has Accept. Note any deviation the transcription made up (`maybeTranscription`).
11. **Record again.** Press T, read the scene right, press C. Check: the take picker lists two takes, the newest is in the cut, the scene is "Done". Pick the first take: its deviation shows again; pick Newest back.
12. **Accept.** On a take with a deviation you keep, press Accept (or Accept the whole take): the scene becomes "Done".
13. **Next scene and End.** Next scene, T, read it, C, then End shoot. Check: `transcripts/shoot/<id>/mic.words.json` holds the takes' words; the shoot's timeline (`timelines/<script>.json`) has the session's program track with one shot per chosen take, in script order, playing from the first to the last line of each; the preview plays them with the mic's sound. Type a fix into a word of the mic transcript: the take is compared again with it.
14. **Crash with takes.** Record a take, force-quit, reopen: the session is recovered and its cut takes become shots as at End.

## Live following (#393)

Needs a shoot script (as for the takes) and a network for the first download. The e2e test (`apps/desktop/e2e/teleprompter-follow.spec.ts`) feeds the follower words from a stand-in recognizer (`FRAMESHELL_SHOOT_STAND_IN=1`); only these steps hear a real voice. Write the numbers to `docs/research/shoot-capture.md`, section "Owner runs", as the real-voice follower run (Q6 was synthetic speech only).

15. **Download on consent.** Open the Shoot view on a machine where voice recognition was never installed: it says how much it downloads (~195 MB: `whisper-server` and `small-q5_1`) and downloads nothing until you click. Click: the note shows the progress, then "Getting voice recognition ready…" during the first run (Metal shaders: note how many seconds), then nothing.
16. **Model choice.** Read `<dataDir>/shoot/live-model.json` (macOS: `~/Library/Application Support/Frameshell/shoot/live-model.json`): the model picked and the measured milliseconds per window. On an M-series Mac expect `ggml-small-q5_1` under 350 ms; note the number.
17. **Follow.** Open the teleprompter on a second screen ("Open teleprompter"), keep the Shoot view open (it holds the microphone), check that the Follow voice switch shows a green dot. Read the first scene at your normal pace, without Start. Check: the highlight stays on the word you are saying or one behind (note the lag you see, roughly, in words or tenths of a second), never runs ahead, and the text glides.
18. **Skip and restart.** Skip a whole sentence: after three or four words of the next one the teleprompter jumps there and the skipped sentence is struck through. Restart a sentence from its beginning: it goes back. Say a few unrelated words, or cough: it does not move.
19. **Free slot.** Reach a `[FREE: …]` slot, talk freely for a while, then pause about two seconds and read on: it stays on the slot while you talk and moves on after the pause.
20. **Keys and hold.** While it follows, press ← and ↑: it goes where you say and follows on from there. Press Space (held): it stops following; Space again resumes. Turn Follow voice off: it no longer moves by itself.
21. **While recording.** Start shoot and record a take with T and C while it follows: the recording is unaffected (the meters, the files at End), and no live word ends up in the project (`transcripts/` gets only the take analysis). Note the CPU load in Activity Monitor (whisper-server and Frameshell).

## Other platforms (not run yet)

- macOS 13 to 14.1: System audio is off with a reason; a loopback device (BlackHole) picked as the microphone records the call's sound.
- Windows: `audio: 'loopback'` follows the Electron docs; untested.
- Linux: System audio is off with a reason; a PulseAudio/PipeWire "Monitor of …" input picked as the microphone.
