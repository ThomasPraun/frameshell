# Video from an audio recording

A podcast, a talk or a voice note has no picture; its owner wants a video. The spine is the audio and its word-level transcript. Commands assume the session rule of [SKILL.md](../SKILL.md).

## Three levels

| Level | Who makes it | What it is |
|---|---|---|
| **Simple** | The app, no agent | Audio on its own track, a still background, a subtitle track following the audio. The app builds it when the project starts from the audio file and the transcript exists. |
| **Medium** | You | Simple plus section titles, highlighted keywords and images. |
| **Explainer** | You | Medium plus up to one generated composition per scene (b-roll, diagrams, animated overlays). |

Ask which level the person wants when they did not say. For simple, check `frameshell timeline show --json` first: the app may already have done it, and then there is nothing to build.

## Steps

1. **Orient.** `frameshell timeline show --json` and `frameshell status`. The audio is usually on an audio track already and `transcripts/<file>.words.json` exists. Otherwise `frameshell import <file> --wait`, `frameshell track add audio`, `frameshell clip add <track> assets/<file>` and `frameshell transcribe assets/<file> --language <code>` (see [transcript-editing.md](transcript-editing.md)).
2. **Edit the audio first.** Cut silences and retakes now, in one transaction, and run `frameshell transcribe --verify` on an export if speech was cut. Visuals do not move with their words: a `cut` that trims or splits a generated clip still applies and returns a `warning` naming the clip, so cutting after building scenes means placing clips again. How to choose cuts: [transcript-editing.md](transcript-editing.md#choosing-cuts).
3. **Write the scene plan** (medium and explainer) as `scripts/<name>.md` before generating anything. One `## ` scene per section of the audio, each with the transcript words it covers right under the heading, then what is on screen:
   ```md
   ## Why the sky is blue
   <!-- words: talk.words.json w_000010..w_000042 -->
   Title card "Why the sky is blue", then a diagram of light scattering. Keyword "Rayleigh" highlighted.
   ```
   Take the word ids from the transcript, after the audio edit. Name the transcript file (`talk.words.json`, the file in `transcripts/`); the bare `w_000010..w_000042` works only while one transcript holds both ids. Scenes should follow the audio in order and cover it, with no gaps you do not mean. Format: [project-model.md](project-model.md#scripts).
4. **Check the plan.** `frameshell script outline scripts/<name>.md --json` returns each scene's `wordRange` and `span` (timeline seconds). Fix every entry in `warnings` (unknown ids, ambiguous bare range, reversed range) before going on.
5. **Wait for the human.** Show the plan, name the file, and stop. They correct it in the editor or tell you what to change. Build nothing until they say go; redo the outline check after each correction. Generated clips are slow and costly to redo, a plan is cheap.
6. **Build the clips.** One transaction per scene or per step the human may want to undo whole. Place each clip on the scene's `span`, linked to its scene:
   ```sh
   frameshell tx begin "scene: why the sky is blue"
   frameshell clip add <video-track> --type hyperframes --source compositions/sky.html --start 12.4 --duration 6.2 --props '{"title":"Why the sky is blue"}' --json
   frameshell clip set <clip> --script-ref scripts/talk.md#why-the-sky-is-blue
   frameshell tx commit
   ```
   Titles, overlays and compositions come from the `hyperframes` and `remotion` skills. `script outline` then lists the clip under its scene, and the timeline shows the span of every scene, filled or not. Look at each result with `frameshell frame --at <s> --out <file.png>`.
7. **Export and verify.** `frameshell render --preset youtube-1080p --json` (`vertical-1080x1920` for a 9:16 project), then `frameshell transcribe --verify exports/<file>.mp4 --json`. Done = `lost` empty and the person has the export path and the transaction ids.

## Rules

- **Images, b-roll and music come from your own tools.** Frameshell has no generation service. Save what you make as a new file, `frameshell import` it, and place it. Never write into existing files in `assets/`.
- **A late cut breaks placement, not the plan.** After any cut, run `frameshell script outline` again: `span` follows the words through the cut, clips do not. Move or trim the clips to the new spans.
- **Do not rebuild what the app made.** Leave the background and the subtitle track alone unless asked; change the subtitle look with `frameshell track set <track> --preset … --position …`.
- **Keep human edits.** Resume as in SKILL.md: read `history --since` before touching a scene the human moved.
