---
status: accepted
---

# Fit a music track to the cut: back-timing, varispeed, drop shaping and candidates

#485 (epic #451) asks for `frameshell music fit <music clip> --end <marker or second>`: back-time a track so its own final hit lands on the end-card cut and plays unspliced before it, land exactly with a small varispeed, shape the music around a drop, and place several candidate tracks under the same picture at equal loudness. The owner decided option A on 2026-11-11 (the eight points below, every recommendation of the proposed decision accepted). It extends ADR 0029 (markers and beat grids) and ships in slices; **slices 1 (the shared TimeRef resolver) and 2 (`music.fit`) are built so far.**

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
2. `music.fit`: back-time, `--exact` varispeed, dry run, CLI, MCP, skill, protocol bump, the measured `atempo` check on a synthetic percussive signal. Built, see below.
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
- Wire change: the params above accept a string; protocol 88.

## Slice 2 as built (`music.fit`)

- **Method.** `music.fit { clip, end, from?, hit?, exact?, dryRun?, skip? }` (CLI `music fit <clip> --end <time>`, MCP `music_fit`; protocol 97; the `music` group is built in, plugins cannot shadow it). `clip` is a media clip of an audio track. `end` and `from` go through the shared resolver (`resolveTimeRefArg` in `timeline/time-ref.ts`, the one that wraps `resolveTimeRef` for the operations): seconds, a marker id or label, an offset. Planned by `music/run.ts` (clip, hit, duck, room), arithmetic in `music/fit.ts` (pure), hit in `music/hit.ts` (pure); written by `daemon.ts` as clip operations in one transaction `Music fit: …` (one proposal in review mode), like `cleanup`.
- **Back-timing (default, `mode: slide`).** The clip keeps its speed and moves: `start = end - (hit - in) / speed` on the frame grid, so the hit lands within half a frame of `end` (`offsetMs`; the frame grid is the limit, `in` is snapped too). If that start is before `from` (default 0) the intro is dropped instead: the start is `from` and `in` moves later (`introCut`, written by `clip.trim` with `snap: false`, then `clip.move`); if the track is shorter than the picture before the hit the music starts late (`silentBefore`). Nothing is looped, spliced or stretched. The result reports `before`, `after`, `landsAt`, `tail` (music after the hit) and `steps`.
- **A second fit restores the intro.** Where the start lands after `from` and the clip plays the file from `in > 0` (an earlier fit dropped the intro, or `clip add --in`), `in` moves earlier, down to 0, until the start reaches `from`: a later end does not leave a gap that the file could fill. The result says so in a warning and a step; `silentBefore` is only what the file cannot cover. Operations: `clip.move` first to where the start sits before the head trim, then `clip.trim`, since a head trim that goes earlier would put the start before 0. In `exact` the move goes first when the start goes earlier, else `clip.set`.
- **`exact` (varispeed).** Keeps `in` and the start (the clip's own, or `from`) and sets `speed` so `start + (hit - in) / speed = end` (`clip.set`, then `clip.move` when `from` moves it). The limit of ±1.7 % is on the change of the clip's current speed (so a clip already at 1.25 may go to 1.25 ± 1.7 %), enforced here and not in the schema. Beyond it the refusal names the percentage needed, the window of ends that fit (frame-exact, `valid.end`) and the other ways: move the end, trim the intro, drop `exact`. A speed that already lands changes nothing.
- **The final hit.** `hit` when given (confidence 1), else the last sharp jump in the 10 ms energy envelope (`EnergyStore`, the one ducking and cut snapping read) inside the part the clip plays: a rise of at least 6 dB over the loudest of the previous 30 ms, to within 14 dB of the track's loud level, jumps closer than 100 ms merged. Confidence is the geometric mean of the sharpness of the jump (6 dB: 0, 18 dB: 1) and of how far the sound falls away 0.5 to 1.5 s after it (6 dB: 0, 24 dB: 1; a track that stops within 0.7 s of the hit scores 0.7), times closeness to the end of the played part (full inside 10 s, none from 30 s). A hit within 40 ms of a hit measured in a current `beats/<stem>.beats.json` (`onsets`, the beat detector's spectral flux) is placed on it. Under 0.5 the hit is only a suggestion: slide proceeds with a warning, `exact` refuses (`low confidence`), and `hit.candidates` lists the last strong hits to pick with `--hit`. A track with no jump near its loud level (a drone, a fade) has no hit: `no hit`, pass `--hit`. Measured on synthetic music (kicks every 0.5 s, a crash with a 2.5 s ring): placed to within one 10 ms hop, confidence 0.98; a track that stops on its last hit 0.84; a fade-out none.
- **Duck keys.** When the clip carries `auto: "duck"` keys and the fit changes it, `track.duck` runs again on its track in the same transaction (decision 5). The first duck's parameters are not stored, so it runs with the method's defaults (read from the registry, not copied) over every other unmuted video and audio track whose clips carry no duck keys; `duck.under` and `warnings` say which. `skip: ["duck"]` leaves the keys and warns; with no track to listen to it warns too. `skip` ids are the skippable `steps` of a dry run (only `duck` is, today), anything else is refused with the valid ones.
- **Checked before writing.** The new place may not overlap another clip of the track (a clear refusal before any operation, since the engine would stop half way); a clip that is not a media clip of an audio track, a hit outside the part the clip plays, an `end` not after the earliest start.
- **Not written yet: the 5 ms `fadeIn`.** Decision text lists it among the fields a fit writes. No operation sets a fade below a frame (`transition.set` rounds up to one frame, 33 ms at 30 fps, which is audible as a fade and not the edge click guard the ticket means), and the export already gives every audio segment a 2 ms edge fade. It stays open for the slice that adds the music key marks (slice 4), with a way to write it.

### The `atempo` check (decides slice 7)

Measured on darwin-arm64 with ffmpeg 9.0.2 only; the test bounds are loose enough for other builds, but other platforms and ffmpeg builds were not checked.

Synthetic percussion (24 s at 120 BPM: a 60 Hz kick with 80 ms decay on every beat, noise snares on the backbeat, 8 ms noise hats between; `core/test/music-atempo.test.ts`), ffmpeg 9.0.2 on macOS arm64, 48 kHz, the kicks (about 45) measured on a 1 ms envelope (onset at 10 % of the peak, rise from 10 % to 90 %). `atempo` is the export's filter; tape resampling (`asetrate` then `aresample`, pitch follows speed) is what slice 7 would add.

| | onset against where the speed puts it | attack rise, mean (worst) | peak level, mean (worst) | length |
|---|---|---|---|---|
| input | - | 3.1 ms (4.3) | -2.2 dBFS (-2.6) | - |
| `atempo` ×1.017 | **-19.6 ms** (-20.7 to -17.5) | 5.7 ms (19.0) | -2.5 dBFS (-3.5) | -20.9 ms |
| `atempo` ×0.983 | **-20.6 ms** (-21.5 to -18.1) | 5.6 ms (18.6) | -2.5 dBFS (-3.6) | -21.9 ms |
| tape ×1.017 | +0.5 ms | 3.0 ms (4.2) | -2.2 dBFS (-2.6) | 0.0 ms |
| tape ×0.983 | +0.5 ms | 3.1 ms (4.4) | -2.2 dBFS (-2.6) | 0.0 ms |

What it says:

- **`atempo` plays the material about 21 ms early, the same for every hit** (the spread across the file is 3 ms), so it does not drift; it is the start-up of the filter (21 ms is 1024 samples at 48 kHz). The chain the compiler builds (`atrim`, `atempo`, `apad`, `atrim`) shows the same: a click at 1 s lands 20.9 ms early at ×1.017 and 21.9 ms at ×0.983 (13 ms at ×1.25, 12 ms at ×2). The preview resamples linearly and has no such shift. So in the export a varisped hit lands a fraction of a frame (0.6 at 30 fps) before `end`, and the two disagree by that much for any clip with a `speed`, not only a fitted one. `music.fit` warns about it in `exact` mode.
- **`atempo` softens attacks**: the mean rise of a kick doubles (3.1 to 5.7 ms), a few worst ones to 19 ms, and the mean peak drops 0.35 dB (worst 1.3 dB). Small, and masked in a mix, but measurable on a bare kick.
- **Tape resampling is clean**: +0.5 ms, the attack and peak unchanged, the length exact. Its cost is the pitch, 0.29 semitone at 1.7 %.
- **Reading for slice 7.** The artefacts are measurable but inaudible by the numbers (a sub-frame, constant shift, 2.6 ms of attack, 0.35 dB). The shift is the one that matters for "lands exactly", and it has a cheaper fix than a second speed semantics: pre-roll in the compiler chain, a change that moves the golden plans and the export of every sped-up clip, to be decided with #499 (the preview's stretch). Recommendation: do not add the tape flag for now; fix the shift in the compiler with #499, and listen to a real track before adding any schema field. Owner's call.

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
