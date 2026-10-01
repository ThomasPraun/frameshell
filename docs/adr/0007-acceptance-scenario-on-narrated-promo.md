---
status: accepted
---

# v0.1 acceptance runs on a narrated promo, not a camera recording

SPEC §11 describes the acceptance scenario as "I record a video" of someone talking to camera. No such recording exists. The material on hand is the Orkestra product tour: a 193 s Spanish voice-over (Gemini TTS, several takes per section), one rendered mp4 per product area, a Markdown script, synthesized music and sound effects. Making videos like it easier is why Frameshell exists.

The scenario for #28 is therefore built from that material:

- **Recording**: the voice-over takes of every TTS batch joined end to end, so sentences repeat (retakes) and the joins leave pauses (silences).
- **Footage**: the per-area mp4s as video clips; music and SFX as audio tracks; the script as a project script.
- **Steps kept from SPEC §11**: the agent removes silences and retakes and adds an intro (HyperFrames clip) with subtitles; the human restores two cuts in the transcript view; the agent resumes from `history --since`; export to `youtube-1440p` passes `--verify` with no lost words.

## Consequences

- Covers both SPEC use cases (transcript-driven editing and scripted video) in one run.
- TTS reads without natural pauses: silence removal is exercised mostly at take joins, less than on a real recording.
- Scenes are rendered footage: Remotion compositions are v0.2 (`@frameshell/remotion`), so they are not edited as code.
- Music under voice is lowered by hand (clip gain); automatic ducking is not in v0.1.
- A camera recording stays the better test of silence detection; rerun on one when available.
