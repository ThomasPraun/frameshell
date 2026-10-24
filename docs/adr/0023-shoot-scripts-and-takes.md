---
status: accepted
---

# Shoot: scripts to record, takes compared word by word, first cut assembled

Frameshell directs a recording. A **shoot script** says what each person says, scene by scene. Each **take** is transcribed and compared word by word against it. Every **deviation** is marked and none blocks: the person lets it pass or records again. The newest take of each scene goes into a timeline in script order, so a first cut exists when the last scene is recorded, ready for the editing Frameshell already offers. Case A (SPEC §1) for the person who is on camera; also podcasts and calls with several people. Capture inside the app (camera, screen, microphone, system audio, teleprompter that follows the voice) is ADR 0024; this ADR also holds for takes recorded elsewhere and imported. Decided by the owner on 2026-10-24.

## Context (verified in the tree)

- **Scripts** (SPEC §5.5, decision 14): Markdown in `scripts/`, one scene per `##`, frontmatter `title`, `target_duration`, `aspect`, optional `<!-- words: … -->` per scene (ADR 0015). `parseScript` never fails, problems become `warnings` (`packages/schema/src/script.ts`); `script.outline` resolves word ranges to timeline spans (`packages/core/src/scripts/outline.ts`). Clips point at scenes with `scriptRef`. A scene has a word count, no lines, no speakers, no cues.
- **Alignment**: `alignWords` (`packages/core/src/transcripts/align.ts`) matches expected against heard words of the same speech **on the same clock** (2 s window, ADR 0003); it backs `transcribe --verify`. Script text has no clock, so it does not fit as is. `comparableText` (lowercase, accents and punctuation gone) and its similarity scoring do.
- **Transcription** is explicit and per asset (`transcripts/<asset>.words.json`), with speakers on demand (`transcribe --speakers`, ADR 0016) and people across files (`people.json`, ADR 0020).
- **Multicam** (ADR 0016): a group is the angles of one conversation on one clock, each angle one file at an offset; **one program track per group**. A gallery call recording becomes one group of crops (`multicam gallery`); a screen angle exists.
- "Director" is taken: `frameshell direct` and `director.json` turn speaking turns into shots (ADR 0016).
- Review mode (ADR 0019) holds timeline changes only. `people.json` changes apply at once, emit `people.changed` and are undone by their inverse (ADR 0020, decision 13).
- The timeline has no markers.
- The owner's own script skill (`spoken-script`, not in this repo) already writes `##` beats with timing, spoken lines and `[LABEL: …]` performance marks (`[IMAGEN: …]`, `[TEXTO: …]`, `[ANÉCDOTA: …]`) whose labels change per language. It has no speaker convention.

## Decision

1. **Shoot script = a script in `scripts/` that follows a few more conventions.** No new file kind and no fixed name. The person's own script (a `.docx`, a `.txt`, notes, any format) stays where it is and is **never written**. The agent writes the shoot script beside it from it, and names it in frontmatter:

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

   - `shoot: true` marks it; everything below only applies then.
   - Each non-blank text line is one **line** (a line, not a Markdown paragraph: the example has two speakers in one paragraph). `**Name:**` at its start says who speaks it and holds for the following lines until another name. Names match `people.json` people (ignoring case) when the project has them; otherwise they are free names. No name in the whole script = one speaker.
   - `[LABEL: text]` or `[LABEL]` anywhere is a **cue**: never spoken, never compared, kept with its position in the line. Labels are free (the agent may keep the person's own language). One label is reserved: `[FREE: …]` is unscripted speech the take must contain (an anecdote, an improvised answer), checked only for presence and length.
   - A timing in the heading (`(0:05–0:40)`) is the scene's expected length. It is left out of the scene's title and anchor, so retiming a scene keeps its `scriptRef`.
   - `follow: words` (default) compares every word. `follow: topics` (podcasts, talking points) only checks that each line was spoken about: a line counts as covered when enough of its content words appear, in any order.
   - `source_hash` is the first 12 hex of the original's SHA-256 when the agent wrote the script. When the original changes, `script check` reports the shoot script as **stale**; the agent writes it again.
2. **The skill teaches the format; `frameshell script check` proves it.** `skills/frameshell/` gains a reference page with these conventions and an example. It also covers how to turn marks of other script tools into cues (`[ANÉCDOTA: …]` → `[FREE: …]`) and the rule that the original stays untouched. `script check <file>` (daemon `script.check`, MCP tool) returns scenes, lines with speaker and spoken words, cues, `FREE` slots and expected lengths. Warnings: unknown speaker names, stale source, empty scenes, unresolved placeholders. Like `parseScript`, it never fails. `script outline` stays as it is.
3. **Take = one recording of part of a shoot script.** A take is an asset (or, from the app, the set of files one recording wrote, ADR 0024) linked to its shoot script. It may cover one scene, several, or part of one. The person or the app names the scene it **starts at**; the comparison finds where it really starts and ends. Takes and every decision about them live in one project file per shoot script, `shoots/<script slug>.json`, written only by the daemon. It holds the takes (assets, start scene, recorded at), the take chosen per scene, discarded takes and the accepted deviations. Like `people.json`: not in timeline history or review mode, each change has a one-command inverse, notification `shoot.changed`. Comparison results are derived data in `.frameshell/shoot/`, keyed by transcript and script hashes, and swept by `gc`.
4. **Comparison: a text alignment, no clock.** A new function in `packages/core/src/shoot/` aligns the script lines (spoken words only) against the take's transcript words, token level, with the normalization and similarity of `align.ts` (shared, not copied). Numbers are compared as said (`veintitrés` / `23`). Repeated attempts of a line are expected: the **last complete attempt** of each line is the one used, the earlier ones are restarts. Every difference becomes a deviation, with its scene, line, word span in the script, word span in the take (source seconds), what was expected and what was heard:

   | Kind | What |
   |---|---|
   | `missing` | script words with no heard words |
   | `changed` | heard words in their place with other text |
   | `added` | heard words with no script words (also speech before the first line and after the last) |
   | `moved` | a line heard out of script order |
   | `restart` | an earlier attempt of a line the take repeats |
   | `pause` | silence over 1.5 s inside a line |
   | `speaker` | the line's person did not say it (needs speakers or one source per person) |
   | `length` | scene length off its expected length by more than 25% |
   | `free` | a `FREE` slot with under 5 s of speech |

   **All are reported. None blocks recording, assembly or export.** A deviation that may come from transcription rather than from the speaker carries `maybeTranscription: true`: a close spelling, a number, a single short word. It is still reported. The person (or the agent, author recorded) **accepts** a deviation, the whole take, or records again. An accepted deviation stays accepted while its script line and its heard words are unchanged. A scene is **done** when its chosen take covers every line and all its deviations are accepted.
5. **Next = the first scene, in script order, that is not done.** Never enforced: takes may be recorded in any order, and a take may cover what comes next.
6. **Assembly: the first cut builds itself, as timeline operations.** `shoot.assemble` writes the timeline named in the shoot file (default `timelines/<script slug>.json`, created on first use). Each scene gets the chosen take's span from its first line to its last line, with restarts and pauses over 1.5 s cut out. Edges snap to pauses (ADR 0003), with 0.15 s handles. Clips are placed in script order with `scriptRef` to their scene. It runs after each take is analyzed when the app's shoot view is open, and on demand from the CLI and MCP. Every run is one transaction (label `Assemble <scene>`), journaled, undoable, held in review mode like any timeline change. It touches only the clips it placed (they carry the take id). Clips, overlays and subtitles the person or the agent added stay. Replacing a scene's take swaps that scene's clips and ripples what follows. The **chosen take** of a scene defaults to the newest take that covers it; the person may pick another.
7. **Cues stay in the script, with times.** `shoot.status` returns each cue with its timeline time in the assembled timeline (where the words around it were placed). The agent turns `[VISUAL: …]` into clips, overlays or generated scenes. No timeline markers in this ADR.
8. **What the agent sees.** `shoot.status <script>` (CLI `frameshell shoot status`, MCP): scenes with state (`none`, `deviations`, `done`), takes, chosen take, every deviation with its accepted flag, next scene, cues with times. `shoot.accept` / `shoot.choose` / `shoot.discard` change the decisions. Notifications: `shoot.changed` when a take is analyzed or a decision changes. The agent reacts to an analyzed take without being asked, for example by placing the b-roll of a scene that just became done. It never records and never accepts in the person's place unless asked.
9. **Names.** The feature is **Shoot** (Spanish UI: **Rodaje**), CLI `frameshell shoot …`, methods `shoot.*`. Not "director", which is the multicam director.

## Considered options

- **A fixed file `frameshell-script.md`.** Rejected: `scripts/` already holds scripts, `scriptRef` already points into it, and a project may shoot several scripts.
- **Frameshell reads the person's original directly.** Rejected: any format, no speakers, no cues. The agent is good at this conversion, and a check makes it safe.
- **Flag only big deviations (half a line lost).** Rejected by the owner: every deviation is marked; none blocks.
- **An LLM inside Frameshell judges takes.** Rejected (SPEC decisions 1 and 10): the comparison is deterministic and works without an agent; judgment ("take 2 has more energy") is the agent's.
- **Reuse `alignWords`.** Rejected: it needs both sides on one clock; script text has none. Its normalization and similarity are shared.
- **Takes and decisions inside the timeline.** Rejected: they outlive any one cut, and assembly would rewrite them.
- **Timeline markers for cues.** Deferred: a new timeline concept, worth it only if cue times from `shoot.status` are not enough.

## Acceptance scenario

> I give the agent my `.docx`. It writes `scripts/launch.md`, `script check` is clean. I record the hook: the panel shows "1 changed word, 1 pause", I let both pass, and "Next: The problem" appears. I record the problem twice; the second take becomes the chosen one and the timeline swaps it. After the last scene the timeline holds the whole video in script order. The agent places the visuals from the cues, I polish and export. I change the `.docx`: `script check` says the shoot script is stale.

## Consequences

- SPEC §5.1 (`shoots/`), §5.5 (shoot conventions), decision 29. GLOSSARY: shoot script, take, deviation, chosen take, cue.
- Protocol bump: `script.check`, `shoot.status`, `shoot.add` (link an existing asset as a take), `shoot.accept`, `shoot.choose`, `shoot.discard`, `shoot.assemble`, notification `shoot.changed`; schema for `shoots/*.json` with generated JSON Schema.
- Skill: new reference page; `skill-docs.test.ts` covers the new commands.
- The app's shoot view (panel with scenes, deviations shown as tracked changes, accept and re-record) is specified with capture in ADR 0024.
- **Takes with several sources** are ranges of one continuous recording session, one multicam group per session (ADR 0024, decision 1). Assembly places a session's chosen takes as shots on that group's program track. A take imported from a single file is a plain clip.

## Implementation plan (each part ships and is tested alone)

1. Shoot script conventions in `parseScript` (lines, speakers, cues, `follow`, `source_hash`), `script.check`, skill page.
2. `shoots/*.json` schema and store, `shoot.add`, comparison and deviations, `shoot.status`, accept/choose/discard. Takes imported from files.
3. `shoot.assemble`.
4. App shoot view (with ADR 0024).
