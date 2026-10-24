# Shoot scripts

A shoot script says, line by line, what each person says on camera, scene by scene. Frameshell compares each take against it and marks every difference (ADR 0023). This page covers writing one and checking it. Commands assume the session rule of [SKILL.md](../SKILL.md).

## The person's own script stays untouched

The person brings their script in any format: a `.docx`, a `.txt`, notes, another tool's Markdown. **Never write that file.** Write a new `scripts/<name>.md` from it and name the original in the frontmatter. If they only have an idea, write the shoot script directly and leave `source` out.

## Format

```markdown
---
title: Launch video
shoot: true
source: drafts/guion-lanzamiento.docx
source_hash: 3f9a1c0e2b7d
follow: words
---

## Hook (0:00–0:05)
**Ana:** ¿Cuántas pestañas tenés abiertas ahora mismo?
[VISUAL: Ana close-up, browser with 23 tabs behind]

## The problem (0:05–0:40)
**Ana:** Veintitrés. Yo también.
**Juan:** Y ninguna la vas a leer.
[FREE: Juan tells how he lost a client to an unread tab]
```

- **`shoot: true`** marks it. Without it the file is an ordinary script and the rest of this page does not apply.
- **`source`**: the original, relative to the project root or absolute. **`source_hash`**: the first 12 hex digits of its SHA-256 when you wrote the script (`shasum -a 256 <file> | cut -c1-12`; PowerShell `(Get-FileHash <file>).Hash.Substring(0,12).ToLower()`).
- **`follow`**: `words` (default) compares every word; use it for a written-out script. `topics` only checks that each line was talked about; use it for podcasts and talking points.
- **Scenes**: one `## ` heading each. A closing timing `(0:05–0:40)` (`m:ss` or `h:mm:ss`) is the scene's expected length. It is not part of the scene's anchor, so retiming keeps clip links.
- **Lines**: each non-blank text line is one line. Do not hard-wrap a sentence across source lines; one sentence or one breath per line reads best on the teleprompter.
- **Speakers**: `**Name:**` at the start of a line names who says it, and holds until the next name, across scenes. Use the names in `people.json` when the project has people (`frameshell people list`; case does not matter). With one speaker, leave names out entirely.
- **Cues**: `[LABEL: text]` or `[LABEL]` anywhere in a line is never spoken and never compared: what to show, how to say it. Labels are free; keep the person's language (`[IMAGEN: …]`). Two labels are reserved:
  - `[FREE: note]`: unscripted speech the take must contain (an anecdote, an improvised answer), checked only for presence and length.
  - `[TODO: note]`: something still to write; `script check` warns until it is gone.
- Headings below `##`, `---` rules, `<!-- comments -->` and fenced code are never spoken. Markdown links keep their text. Text before the first `## ` belongs to no scene: leave notes, durations and alternatives out of the file or in comments.

## From another tool's marks

| Their mark | Shoot script |
|---|---|
| Scene or beat headings with timings (`## HOOK (0:00–0:03)`) | Keep them as `## ` scenes with the timing |
| A story or anecdote the speaker tells in their own words (`[ANÉCDOTA: …]`, `[STORY: …]`) | `[FREE: …]` |
| An unverified fact or figure (`[DATO: …]`, `[FACT: …]`) | Ask the person; until it is filled in, `[TODO: …]` |
| Visuals, on-screen text, intent, delivery (`[IMAGEN: …]`, `[TEXTO: …]`, `[INTENCIÓN: …]`) | Keep as cues |
| `<placeholder>` or `{{placeholder}}` text | Ask the person and replace it |
| Speaker names in any style (`ANA:`, `Ana —`, a table column) | `**Ana:**` |
| A notes block after the script | Leave it out |

## Check, then hand over

1. `frameshell script check scripts/<name>.md --json`. It returns the scenes with their lines (`speaker`, `words`, `cues`), the speakers with the matching `people.json` person, `source.stale`, and `warnings`.
2. Fix every warning: unknown speaker names, empty scenes, leftover placeholders, a missing `source_hash`. The script is ready when `warnings` is empty.
3. Show the person the file and stop. They correct it in the editor; check again after each change.
4. When `source.stale` is true, the original changed after you wrote the script: write the shoot script again from it, keep the scene headings that did not change (clip links point at them), set the new `source_hash`, and check again.

`frameshell script outline` still works on a shoot script (scenes, anchors, linked clips).
