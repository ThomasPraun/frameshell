---
status: accepted
---

# Fit a music track to the cut: back-timing, varispeed, drop shaping and candidates

#485 (epic #451) asks for `frameshell music fit <music clip> --end <marker or second>`: back-time a track so its own final hit lands on the end-card cut and plays unspliced before it, land exactly with a small varispeed, shape the music around a drop, and place several candidate tracks under the same picture at equal loudness. The owner decided option A on 2026-11-11 (the eight points below, every recommendation of the proposed decision accepted). It extends ADR 0029 (markers and beat grids) and ships in slices; **slice 1, the shared TimeRef resolver, is what is built so far.**

## Context (verified)

- Markers are built (ADR 0029 slice 1). The beat grid, `tempo.clip`, `--snap-to` and TimeRef names (slices 2 to 4) did not exist; no `TimeRef` symbol was in the code. ADR 0029 decision 7 gave that ADR the shared contract that voiceover (ADR 0034 decision 15) and sound placement also wait on.
- `track.duck` (`media/duck.ts`) writes `gain` keys marked `auto: "duck"` on the music clip's own clock, so moving or retiming the clip afterwards shifts them against the voice. The parameters of a duck are not stored.
- Media clips take `speed`; export applies `atempo` (pitch kept), the preview resamples linearly, so pitch shifts there until #499. Every audio segment already has a 2 ms edge fade; clips take `fadeIn`/`fadeOut`.
- Loudness is measured only inside export (two-pass `loudnorm`); there is no per-asset measurement. `EnergyStore` holds 10 ms RMS envelopes. The one FFT is private in `multicam/sync.ts` (ADR 0029 decision 9 moves it).
- `cleanup` is the precedent for propose-then-apply: `dryRun` and `skip`, one transaction, or one proposal in review mode (ADR 0019).
- #478: never depend on the `hyperframes` CLI; build in core what works on footage or the whole program. The epic's licensing note: no code, templates or text from reel kits.

## Decision

1. **TimeRef first.** `--end` takes seconds or a marker id or label, resolved in the daemon by the shared TimeRef resolver, the first piece of ADR 0029 slice 4. `beat:`, `bar:` and word refs join the same resolver later. `music.fit`, sound placement and voiceover placement use it; none gets a private parser (cross rule 2 on #451).
2. **Varispeed uses the existing clip `speed`** (export `atempo`). The preview pitch gap stays until #499. A tape-resample flag (pitch follows speed, `asetrate`) is added only if the slice 2 listening check finds `atempo` artefacts on music.
3. **±1.7 % is a hard limit, enforced by `music.fit`.** Above it the method refuses with the needed percentage and alternatives (move the end by a beat, trim the intro). No schema limit on `speed`, no flag to raise it in v1.
4. **Candidates (2 to 7) are separate audio tracks**, all muted but the first, matched by static gain on a new cached per-asset EBU R128 measurement (ffmpeg `ebur128`, keyed by content hash, a `gc` entry). The same cache backs `duck --level` (#489) and sound placement (#463). No timeline "variant" concept.
5. **Duck keys follow the fit.** When fit moves or retimes a clip that carries `auto: "duck"` keys, duck re-runs in the same transaction (its last parameters if stored, else the defaults) and `warnings` say so.
6. **Drop scope in v1:** gain keys marked `auto: "music"`: a step-down before the hit, a short dip after, and an ending on a bar line (once beats exist) or a 2 to 3 s fade after the last word. The rising high-pass build is a later slice (a swept-filter effect kind in the ADR 0031 bake, on the source clock). "Silence, then one soft note" stays a skill technique.
7. **The final hit** comes from `--hit <source seconds>`, else from the energy envelope; the result reports it with a confidence, and low confidence never varispeeds.
8. **Beat-grid moves wait for ADR 0029 slices 2 and 3.** No second grid inside #485.

One mutating method `music.fit` (`dryRun`, `skip`, like `cleanup`), one transaction `Music fit: …` (one proposal in review mode), writing only existing fields: `start`, `in`, `speed`, a 5 ms `fadeIn` on every entry, `fadeOut` and gain keys. Back-time: `start = end - (hit - in) / speed`; a track too short is reported, never looped or spliced. CLI group `music` is built-in and reserved, so plugins may not shadow it (cross rule 5); MCP tools come from the registry.

## Slices

1. **Shared TimeRef resolver** (seconds | marker), in core, adopted by the time arguments that exist today. Built, see below.
2. `music.fit`: back-time, `--exact` varispeed, dry run, CLI, MCP, skill, protocol bump, the measured `atempo` check on a synthetic percussive signal.
3. Per-asset EBU R128 cache, candidates, `duck --level`.
4. Drop and ending keys (`auto: "music"`; schema `auto` enum, JSON Schema regeneration).
5. Grid moves, after ADR 0029 slices 2 and 3.
6. Swept high-pass build.
7. Tape-resample flag, only if slice 2 finds artefacts.

## Slice 1 as built (TimeRef)

- **Contract.** A time reference is a number of seconds, or a string tried in this order: numeric text; the id or label (ignoring case) of a marker of the timeline being edited; such a name followed by `+s` or `-s` (`hook+0.5`, `outro-1`); a scheme prefix. The whole string is tried as a name before the offset split, so a label like `end-card` is never read as `end` minus `card`. Marker labels are never id-shaped (ADR 0029 decision 2), so an id and a label never collide. `beat:`, `bar:` and `word:` are reserved: they are refused with a message that names what they wait for, and a built scheme joins by registering one resolver (`SCHEMES` in `time-ref.ts`). A marker labelled `beat:drop` still wins as a name.
- **Where it runs.** `resolveTimeRefs` (`packages/core/src/timeline/time-ref.ts`) runs in `TimelineService.apply`, in the operation's turn, against the timeline the operation applies to: the file, or the proposal timeline in review mode, so a marker added or moved earlier in the same transaction is seen. The engine and the journal only see seconds: a replay, a revert or an accepted proposal never depends on a marker staying where it was. An unknown name or a time before 0 fails as `InvalidOperation` naming the operation and the argument, and lists the markers.
- **Table.** `TIME_REF_FIELDS` (`packages/protocol/src/timeline.ts`) is the one list of the arguments that take a reference; the schema of each is a union of non-negative seconds and a name, and `ResolvedOperationArgs` gives the engine numbers. Adopted now: `transition.set` and `transition.remove` `at`, `clip.key` `time`, `clip.split` `at`, `cut` `from` and `to`, `clip.move` `start`, `clip.trim` `start` and `end`, `clip.add` `start`, `marker.add` and `marker.set` `at`. CLI: the matching flags (`--at`, `--start`, `--end`, `--from`, `--to`). Source-clock times (`in`, `out`) stay plain seconds.
- **Left for later.** The group-clock and other timeline-time arguments of `multicam.*`, `shot.*`, `track.duck` curves, `captions.set` `from`/`to`, `direct --from/--to` and the `ui` commands (`ui seek`) are not adopted; each joins by one line in the table plus its CLI flag. Word refs and `beat:`/`bar:` wait for their slices. A name does not resolve in the app's own edits (they send seconds).
- Wire change: the params above accept a string; protocol 86.

## Considered options

- **B. Tape-resample flag in v1** (deferred, decision 2): a new schema field and a second speed semantics for a pitch change of about 0.29 semitone at 1.7 %; added only if the listening check needs it.
- **C. Agent playbook plus a read-only `music.analyze`** (rejected): several transactions per fit, the arithmetic and the 1.7 % refusal redone by every agent, no single `revert`.
- **D. Candidates as a "variant" concept** (rejected): touches schema, engine invariants, patches, review keys, preview, export and the app for what muted tracks already do.

## Consequences

- An older Frameshell cannot read the `auto: "music"` mark (slice 4) or the swept-filter effect (slice 6); slices 1 to 3 add no schema field, so their timelines open in older versions that understand `speed`, `fadeIn` and keys.
- Until #499, a varisped clip sounds up to about 0.29 semitone different in the preview than in the export, with equal length and timing.
- Candidate tracks add muted tracks; export already skips them. The person deletes the losers until a later `music.pick`.
- A loudness cache under `.frameshell/` (regenerable, swept by `gc`).
- The beat grid file `beats/<stem>.beats.json` is defined once, in ADR 0029 slice 2, with a `detector` field that admits `exact`, before grid moves (slice 5) or sound music (#463) read it (cross rule 3 on #451).
