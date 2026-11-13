# Voiceover

A narration generated from text: one voiceover script, one spoken take per line, written into the project as audio assets (ADR 0034). Frameshell ships no voice: a speech provider (a plugin, or one built into this machine) says the lines. Commands assume the session rule of [SKILL.md](../SKILL.md).

## Format

A voiceover script is a script in `scripts/` read with the shoot script line rules ([shoot-scripts.md](shoot-scripts.md)): `## ` scenes, one line per non-blank text line, `[LABEL: …]` cues never read.

```markdown
---
title: Launch video
voiceover: true
language: es
provider: kokoro
voice: ef_dora
---

## Hook (0:00–0:09)
¿Cuántas pestañas tenés abiertas? Son 23.
[VISUAL: browser with 23 tabs]

## The fix (0:09–0:18)
{Frameshell|freim shel} las cierra por vos.
```

- **`voiceover: true`** marks it. `voiceover generate` refuses any other script.
- **`language`** goes to the provider. With `es` or `en`, numbers written with digits are spelled out for the voice (`23` → `veintitrés`) and stay digits in captions.
- **`{display|spoken}`** shows `display` and makes the voice say `spoken`: respell names and terms the voice gets wrong. Ask the person once about an unknown term.
- **`provider`, `voice`**: defaults for calls that name none.
- **Budget**: a voice reads about 2.5 words/s. A scene whose words take longer than its heading timing gets a warning: cut words, never stretch the picture.
- Line ids are `<scene slug>-<n>` (`hook-1`, `the-fix-1`): the position among the scene's spoken lines.

## Generate

```sh
frameshell voiceover generate scripts/launch-vo.md --json
frameshell voiceover generate scripts/launch-vo.md --lines hook-1 --voice em_alex --json
```

- Takes land in `assets/voiceover/<script slug>/<line id>.wav`, trimmed of head and tail silence, and are imported (ingest queued). Nothing goes on a timeline until you run `voiceover place` (below).
- Each line's `state`: `generated` (said now), `cached` (its take is current, nothing done), `copied` (same text moved to another line id). Edit a line and only that line is said again.
- A take file you or the person made or edited by hand is never overwritten: the call fails with `InvalidOperation` naming it.
- **Paid providers.** When the provider charges, or gives no cost estimate and does not declare itself free, the call generates nothing and fails with `ConfirmationRequired`; `error.data.cost` holds the estimate, or `null` when the cost is unknown. Tell the person (cost, or "unknown") and pass `--yes` only after they confirm it. Never confirm on your own. Cached lines never ask.
- A line repeated in one call is said once and copied (`copied`). Ctrl+C or a dropped connection does not stop a running generation: finished takes are kept and a paid run keeps going, so confirm the cost before `--yes`. Run it again to reuse them.
- `SpeechProviderNotFound`: no such provider here; `error.data.available` lists the ones there are. `SpeechFailed`: the provider failed on one line; the lines finished before it are kept and reused by the next call.
- MCP: `voiceover_generate` with `yes` under the same rule.

## Phrases and misreads

Every line in the result carries both, for the lines it asked for, cached ones included.

- **`phrases`**: the take cut where it falls silent for 60 ms or more, as `{ from, to, heard }` ranges of the take in seconds (`heard`: the words inside, when the line was checked). They are the cuts of phrase clips, one per phrase, so a person corrects a cut by trimming that clip: `voiceover place` makes them. `phraseFade` (12 ms) is reported but not applied: a clip fade is whole frames, and each phrase already keeps 20 ms before and 30 ms after its sound.
- **`check`**: the take transcribed by the project's transcription provider and compared with the line's spoken text. `status` is `clean`, `doubtful` (every difference may be the transcription's: a number, a close spelling, a short word it dropped) or `misread` (the voice said something else); `misreads` lists each `missing`, `changed`, `added`, `moved`, `restart` or `pause` with what was `expected` and `heard` and where (`at`, take seconds). A line with respellings also passes when heard as written (`Frameshell` for `{Frameshell|freim shel}`). Fix a `misread` by respelling the term or rewording the line, then generate again: only that line is said again. A `doubtful` line is worth one listen, not a rewrite.
- **`verification`** says whether the check ran. It is `skipped` (never an error, the takes are still written) when the project is not trusted (its plugins do not load until the person agrees to trust it and you re-run with `--trust`), has no transcription plugin (`frameshell plugin install @frameshell/whisper-cpp`), `--no-verify`/`verify: false` was passed or the transcription failed; `reason` says which. Tell the person when it was skipped: the lines are unchecked. The first check may download the transcription model.
- Re-run `voiceover generate` after editing a take by hand to check it again: cached lines say nothing and cost nothing.

## Place on the timeline

```sh
frameshell voiceover place scripts/launch-vo.md --json
frameshell voiceover place scripts/launch-vo.md --at hook-1=hook+0.5,the-fix-1=bar:3 --json
frameshell voiceover place scripts/launch-vo.md --lines the-fix-1 --at the-fix-1.2=beat:17 --dry-run --json
```

- One transaction `Voiceover: launch-vo (2 lines)` (`revert` undoes it; review mode holds it as one proposal). It reads the takes `voiceover generate` wrote, so generate first: a line with no take fails and is named. It never speaks and never costs.
- Every phrase of every line becomes a media clip of its take (`in`/`out` from the phrase, on whole frames, `scriptRef` `<script>#<scene>`) on the audio track `Voiceover` (made when absent; `--track` names another audio track). The phrases of a line keep the spacing the take has.
- **Where**: `--at line=time` anchors a line (`hook-1`) or one phrase of it (`hook-1.2`, counting from 1). A time is seconds, a marker id or label with an optional offset (`hook`, `hook+0.5`), or a point of the timeline's grid (`beat:9`, `bar:3`; needs `tempo.set`, and a grid that is not LOW confidence), the same references every time argument takes. Commas separate the entries, so a label with a comma needs its marker id. A line or phrase with no `--at` follows the previous one by `--gap` seconds (0.4); the first starts at `--start`, else right after the track's last clip, else 0. The clip starts on the nearest frame, so the first sound follows by about 20 ms.
- **Picture rules**: when voice and picture disagree, move the picture: anchor lines on the markers and beats the picture already has, then adjust the cut. A transition starts 3 to 6 frames before a line ends.
- The voice never overlaps itself: a phrase that would start before the previous one ends, or on a clip already on the track, fails (`InvalidOperation`) naming both, and nothing is written. Move the anchor or drop it.
- **Re-placing**: clips that already play these takes fail the call, naming them. After `voiceover generate` changed a take (the result warns when it replaced one a clip plays), run `place --replace`: it removes those clips and places the phrases again in the same transaction. Use `--lines` to place only some lines.
- `--dry-run` plans and reports every clip (`clip: null`) without writing. A take said from older text than the line has now is placed with a warning: generate it again.
- No fades and no per-phrase tempo yet. MCP: `voiceover_place`.

## The `command` provider

`--provider command` (or `provider: command` in the frontmatter) runs the TTS program the person installed on this machine. It is free (no `--yes`) and works in any project, trusted or not. It exists only when the person set it up in the global config, `<configDir>/config.json` (macOS: `~/Library/Application Support/Frameshell/config.json`); a project's `frameshell.json` cannot define it and is refused if it tries. Without it the call fails with `SpeechProviderNotFound` naming that file. Never write the program into the project: ask the person to add it.

```json
{
  "speech": {
    "command": {
      "run": ["piper", "--model", "/models/es_ES-davefx-medium.onnx", "--output_file", "{out}"],
      "voices": ["default"],
      "defaultVoice": "default",
      "version": "1"
    }
  }
}
```

- `run`: program and arguments, no shell. The spoken text arrives on stdin. `{voice}`, `{language}` (the script's `language`) and `{out}` inside an argument are replaced. The program must write a mono 16-bit PCM WAV to `{out}`, or to stdout when no argument has `{out}`. A relative program path resolves against the config folder; a bare name is found on `PATH`.
- `voices` (ids, or `{ "id", "label", "languages" }`) limits `--voice`; without it any voice id is passed through. `defaultVoice` is used when nothing names one.
- `version`: part of every take's cache key. Change it when the program or its model changes, so the takes are said again.
- `timeoutSeconds` (default 120) kills a line that takes too long. A failing program (`SpeechFailed`) shows its exit code and the end of its stderr.
- The config is read on every call: no restart after editing it.
