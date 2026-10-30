# Shoot acceptance run (owner, real devices)

Run of `docs/acceptance/shoot.md` by the owner on 2026-10-27 to 2026-10-29.

- Machine: MacBook Pro, Apple M3, macOS 26.3.
- App: built app from `main` (`pnpm --filter @frameshell/desktop build`, then `electron .`), last run on 760247b (#412). Not the packaged, signed app: step 7 is still open.
- Project: a fresh `frameshell init` project with a five-scene shoot script (two `[FREE: …]` slots, numbers written as digits). The `@frameshell/whisper-cpp` plugin was added by hand, because `init` does not add a transcription provider (#411).

## Recorder (steps 1 to 5, 8)

- Camera, microphone, screen and system audio record together: `camera.mp4` 1920x1080 H.264, `screen.mp4` 2216x1438 from a 3024x1964 Retina screen (shorter side under 1440 px), `mic.m4a` and `system.m4a` AAC. The four files of a 20 s session agree in length to within 25 ms.
- Frameshell's windows are absent from `screen.mp4` (content protection works with the macOS 26.3 capture path).
- End leaves no `.part` file and an empty `.frameshell/shoot/sessions/`; the session becomes one multicam group on the timeline.
- Windows on other desktops and in full screen were not listed at first (#406). Fixed in #407, then checked.
- Spanish UI: labels read Rodaje. The voice download button was not recognisable as a download; reworded in #408.
- Not done: the clap sync check by eye, the force-quit recovery (steps 6 and 14), the signed build (step 7).

## Takes (steps 9 to 13)

- Deviations are found as expected: a struck word, `del` heard as `de`, voseo (`empezás`, `podés`, flagged `maybeTranscription`), missing words, restarts, long pauses, an unread `[FREE: …]` slot, added speech and scene lengths. Numbers written as digits match the spoken words.
- A short take with only silence got a made-up "Thank you." from whisper.
- A take cut right before End lost its analysis (race between cut and End). Fixed in #412: End re-runs takes without words, and the cut reads the finished file once `.part` is gone.
- T and C gave no visible sign in the first runs. #412 added the take strip in the Shoot view and the teleprompter. Final run: the owner saw the red strip on T and "analyzing…" then the result on C, and called it much clearer. One 52 s take, 10 deviations, one accepted from the Shoot view, End assembled it.

## Live following (steps 15 to 21)

- Model choice: `ggml-small-q5_1`, 179 ms per window (`live-model.json`).
- With a quiet machine the teleprompter follows "very well". With the machine loaded (load average above 17 from test runs) recognition lagged and following broke down.
- The `[FREE: …]` slot moved on too early; #408 raised the pause to 2.5 s and asks for 4 s of speech first.
- Recognition stopped for good after the 10-minute idle shutdown; #410 wakes it again and shows its state in words (Listening, Starting…, Off with a Turn on button, Not installed, Unavailable). #410 also added "Back to start".
- Final run: the teleprompter showed Listening and followed, "a little slow but fine".
- Not noted: first-run seconds (Metal shaders), the lag in words, CPU load while recording.

## Left for a later stage

The owner judged the flow as working, with improvements for a next stage: follow latency, tooltips across the app (#409), and a missing transcription provider that nothing reports (#411).
