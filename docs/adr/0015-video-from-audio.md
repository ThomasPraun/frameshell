---
status: accepted
---

# Videos made from an audio recording

Extends use case A (SPEC §1). A podcast, a talk or a voice note has no picture, and its owner wants a video for it: some want only subtitles on a background, some want a full explainer. Both start from the same spine, the audio and its word-level transcript, instead of a written script (grilling 2026-10-17).

## Context (verified in the tree)

- Audio files already import into a project and transcribe: drops accept `wav`, `mp3`, `m4a`, `aac`, `flac`, `ogg`, `opus` (`MEDIA_EXTENSIONS`, `apps/desktop/src/main/media-files.ts`), and ingest takes any file with an audio stream.
- A new project can only start from a video: the welcome screen, drops on it and Open with use `VIDEO_EXTENSIONS` (ADR 0013).
- Subtitle tracks follow an audio or video track and take its words; presets live in `packages/schema/src/subtitles.ts`.
- There is no solid-colour clip type: core clip types are `media` and `timeline`, the rest come from adapters. Images import as media.
- Scripts are Markdown, one scene per `##` heading, referenced by `scriptRef` (SPEC §5.5).

## Decision

1. **New project from audio.** The welcome screen, drops on it and Open with also take audio files. The flow is the one of ADR 0013: a folder beside the file, import, transcription. An audio file has no picture size, so the confirmation offers 16:9 (1920x1080, the default) or 9:16 (1080x1920); fps is 30 and the sample rate comes from the audio.
2. **Three levels of detail.**
   - **Simple** (built in, no agent): the audio on A1, a still background on V1 and a subtitle track following A1, placed once the transcript exists, in one undoable step. The background is an image the app writes into `assets/` (a plain colour with the project title) or one the user picks. No adapter and no headless Chrome needed, so it works on a fresh install.
   - **Medium** and **explainer** (made by the agent): section titles, highlighted keywords and images, up to one HyperFrames or Remotion composition per scene with b-roll.
3. **Visual plan first.** For medium and explainer the agent writes a script in `scripts/` before generating anything: one `##` scene per section of the audio, each tied to a range of transcript words, saying what is on screen. The human corrects the plan, then the agent builds the clips with `scriptRef` pointing at their scene. A scene names its words with an HTML comment under its heading, `<!-- words: w_000010..w_000042 -->`, so the Markdown still reads cleanly. `script outline` resolves the range to timeline time, and the timeline shows the span of every scene, filled or not.
4. **Generated media stay the agent's job** (SPEC decision 10): images, b-roll and music come from whatever tools the agent has. Frameshell adds no generation service.
5. **Edit the audio before the visuals.** Silences and retakes are cut first, then scenes are built. The skill says so, and a ripple cut that falls inside an adapter clip returns a warning naming the clip. Clips do not move with their words; the word ranges in the plan let the agent place them again.

## Considered options

- **A use case of its own (D).** Rejected: the tools are those of case A; only the spine differs.
- **The agent makes every level.** Rejected for the simple level: it is deterministic, and the target user may have no agent connected yet.
- **Clips anchored to words**, moving when the audio is cut. Deferred: a new anchoring model on the timeline, worth it only if the edit-first rule proves too strict.
- **AI avatars with lip sync.** Out of scope: complex, fast-moving, and costly per render.

## Acceptance scenario

> I drag `podcast.mp3` onto Frameshell and within a minute have a video with subtitles on a background. I ask the agent for an explainer. It shows me the scene plan, I correct two scenes, it generates the compositions, and I export. `--verify` reports no lost words.

## Consequences

- The scene `words` comment is a new script convention: the outline parser, `scriptRef` checks and the skill change; no timeline schema change.
- Shipped in v0.9, before multicam (ADR 0016), which reuses the scene plan for its review step.
