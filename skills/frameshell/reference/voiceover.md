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

- Takes land in `assets/voiceover/<script slug>/<line id>.wav`, trimmed of head and tail silence, and are imported (ingest queued). Nothing goes on a timeline: place them with `frameshell clip add`.
- Each line's `state`: `generated` (said now), `cached` (its take is current, nothing done), `copied` (same text moved to another line id). Edit a line and only that line is said again.
- A take file you or the person made or edited by hand is never overwritten: the call fails with `InvalidOperation` naming it.
- **Paid providers.** When the provider charges, or gives no cost estimate and does not declare itself free, the call generates nothing and fails with `ConfirmationRequired`; `error.data.cost` holds the estimate, or `null` when the cost is unknown. Tell the person (cost, or "unknown") and pass `--yes` only after they confirm it. Never confirm on your own. Cached lines never ask.
- A line repeated in one call is said once and copied (`copied`). Ctrl+C or a dropped connection does not stop a running generation: finished takes are kept and a paid run keeps going, so confirm the cost before `--yes`. Run it again to reuse them.
- `SpeechProviderNotFound`: no such provider here; `error.data.available` lists the ones there are. `SpeechFailed`: the provider failed on one line; the lines finished before it are kept and reused by the next call.
- MCP: `voiceover_generate` with `yes` under the same rule.

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
