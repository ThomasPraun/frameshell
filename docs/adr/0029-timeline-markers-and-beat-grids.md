---
status: accepted
---

# Timeline markers and beat grids measured per asset

Films are timed in beats and reels in words (#458, epic #451). Frameshell had words but neither markers nor a beat grid; ADR 0023 left markers out on purpose ("a new timeline concept"). This ADR adds both: markers on the timeline clock, and a beat grid measured per music asset and mapped onto the timeline through the music clip. Decided by the owner on 2026-11-10 in #458 (option A of the proposed decision, every recommendation accepted); the beat grid lives in core as decided in #478. It ships in slices; slices 1 (markers) and 2 (the beat detector, `beats.measure|show` and the beats file) are built so far.

## Context (verified)

- `TimelineSchema` (`packages/schema/src/timeline.ts`) is a strict object; `SCHEMA_VERSION` 1 has taken every additive field (`groups`, `keys`) without a bump.
- Inverses are diff patches (ADR 0004): `TimelinePatchSchema` (`packages/protocol/src/timeline.ts`) covered only `groups`, `tracks`, `clips` and `order`, so a top-level field needs its own patch entry or revert silently stops restoring it.
- Review mode (ADR 0019) decides staleness and rebase from the entity keys a patch touches (`packages/core/src/history/revert.ts`).
- Snapping in the app: `SnapPoint` with kinds `clip` and `playhead` (`renderer/src/timeline/edit.ts`); in core, the `EditPointResolver` seam that energy snapping (ADR 0003) uses for `cut` and `clip.trim`.
- The scene band (`renderer/src/timeline/scenes.ts`) already shows named spans under the ruler; markers are points, not spans.
- `EnergyStore` caches 10 ms envelopes; too coarse for ±8 ms beat snapping, and a different signal (RMS, not spectral flux).

## Decision

1. **Markers ripple with `cut`** like clip starts: markers after the cut move with the material, markers inside the removed range are deleted (named in `warnings`; `revert` brings them back). A marker on the cut's first frame stays: it marks the new edit point (confirmed by the owner in #458 after the slice 1 review, as is the next rule). Only a `cut` of every video, audio and program track moves or deletes markers; a cut of some tracks shifts clips against the rest, so markers stay where they are, because they belong to the whole timeline. A `ripple` `clip.trim` treats removed material like a `cut`: markers strictly inside the removed head or tail are deleted (a marker on the first removed frame stays), later ones shift, and the same every-track rule holds. `ripple` inserts and the growing side of a trim (the inverse of `cut`) shift markers at or after the insertion point like clip starts, so restoring cut material puts them back in step.
2. **Timeline markers only in v1.** `markers: [{ id: "m_<hex>", at, label, color? }]`, optional, on the timeline clock, `at` on the frame grid, ids unique among the file's ids, labels unique per timeline ignoring case (so a later `--at hook` resolves to one) and never shaped like a marker id (`m_` plus hex), so a reference is an id when it matches one and a label otherwise, never both, `color` one of `red`, `orange`, `yellow`, `green`, `blue`, `purple` (the app paints each from its theme; absent: the accent). Clip-anchored markers come later.
3. **Beat corrections live in a versioned project file** `beats/<stem>.beats.json` (asset, asset hash, detector, BPM, confidence, beats, downbeat phase, alternatives, human `edits` such as half/double time or phase), like transcripts; regenerable onset data lives under `.frameshell/`; `gc` never sweeps `beats/`. The watcher and direct-edit reconcile handle `beats/`.
4. **The timeline grid comes from one chosen music clip** (`tempo.clip`), with a nominal `bpm`/`offset` fallback for blocking a film before music exists; the schema checks the referenced clip exists.
5. **Markers of a nested timeline stay inside it** in v1.
6. **Energy snapping stays first** for `cut` and `trim`; snapping to beats or markers is opt-in per operation (`--snap-to beat|marker`). Beats never snap on low confidence. In the app, a dragged edge snaps to markers like it does to clip edges and the playhead.
7. **Names as times** (`--at hook`, `beat:32`, `bar:8`), resolved in the daemon. This ADR owns the shared **TimeRef** contract that voiceover and motion reuse; word refs (`"this#2"`, `"over+0.2"`) are a later slice of the same contract.
8. **Generated clips get beat and marker times** through an opt-in `RenderContext` timing field that is part of the cache key: only clips that ask re-render when the music moves.
9. **One FFT.** The radix-2 FFT of `multicam/sync.ts` moves to one shared module used by sync and beats.
10. **Learned detector only on failure.** If the DSP detector misses a grid residual under 15 ms on synthetic click tracks or fails on real music, run the learned-detector spike (Beat This! or similar on ONNX Runtime Web) after a licence check of its weights (madmom's are non-commercial).

From the review: the detector resamples the 48 kHz sidecar to its analysis rate; a result from the 16 kHz ffmpeg fallback is marked low confidence.

### Slice 1 as built (markers)

- Operations `marker.add`, `marker.set`, `marker.remove` (journaled, inverse patches, idempotent replays), read method `marker.list`; `timeline.show` lists markers. A marker is named by id or by label (ignoring case). Protocol 71.
- `TimelinePatchSchema` gains `markers` (upsert or delete by id); review mode and revert key them as `marker:<id>`, so a person's change to a proposal's marker makes the proposal stale, and a change to another marker rebases it.
- Direct edits of the timeline file go through the same rules: duplicate ids or labels, an id-shaped label and a time off the frame grid are rejected into `.frameshell/rejected/` (the schema, and `timeline.patch` for the grid); a journaled edit is written back sorted by `at`.
- CLI `frameshell marker add --at s --label l [--color c] | set <marker> | remove <marker> | list`; MCP tools from the registry.
- App: a marker lane under the ruler (shown while there are markers), a faint guide down the lanes, add, rename and delete from the ruler's right-click menu, `SnapPoint` kind `marker`; a trimmed edge put on a marker goes exactly (no energy snap), as on a clip edge.

### Slice 2 as built (beat detector and beats file)

- **Detector** (`packages/core/src/media/beats.ts`, pure, `onset-flux@1`): the recipe measured in #458. The source is resampled to 22.05 kHz (windowed sinc) and a spectral-flux onset envelope taken (window 2048, hop 128, log magnitude, 100 ms of silent pre-roll). Its peaks under 0.12 of the strongest are dropped and each remaining one is refined to the sample where a 0.5 ms average of the 30 Hz-high-passed signal rises 20% of the way from the energy minimum before it: the envelope alone is 20-50 ms late. Tempo is the autocorrelation peak of the envelope (interpolated lags, 35-340 BPM), weighted by a prior (the hint, else 120 BPM), then moved by octaves to the hint's octave, or into 70-170 BPM with no hint. Phase is the comb at 5 ms steps that collects most hit energy; one straight period is then fitted by weighted least squares over the hits, the window widening until it spans the audio, so a long track does not drift. Each beat snaps to a hit within 8 ms; the bar starts at the phase (of 4) with most 20-150 Hz energy in the 0.25 s after its beats. The grid runs from the first matched hit to the last.
- **Confidence** is `share^1.5 * (0.6 + 0.4 * periodic)`: `share` is how many beats between the first and last matched found a hit within 30 ms, `periodic` how strong the envelope's autocorrelation is at that tempo. Clicks on every second beat (calm music) fold into a double-time grid with `share` about 0.5, which is LOW (under 0.5); the file then lists `alternatives` (`double`, `half`, best supported first) and a human picks one with `edits.tempo`. The 16 kHz fallback decode (no finished ingest; transcription never waits for ingest either) caps confidence at 0.45. On synthetic click tracks the beats come out within 15 ms of the clicks (a few ms in the tests), at half time, double time, with a hint, with missing clicks and a noise bed, over 150 s at a non-round 127.6 BPM.
- **Where it runs**: a worker thread (`media/beats-worker.ts`, the shared `worker-task.ts` runner), so the daemon's event loop is never blocked; about 5 s for a 3-minute track. Tracks over 10 minutes are refused (a grid is for music). The onset envelope, which is most of the cost, is cached by content hash and analysis rate in `.frameshell/beats/<hash>-b1-<rate>.f32` (`BeatsStore`, modelled on `EnergyStore`, which stays a separate store: a 10 ms RMS dB envelope is too coarse and a different signal); measuring again with another hint reuses it. `gc` sweeps it once no asset has that content (`classifyBeatsCache`, kind `beats`) and never touches `beats/`.
- **One FFT**: the radix-2 FFT of `multicam/sync.ts` moved to `packages/core/src/fft.ts` (twiddle table per size), used by sync and the detector (decision 9). `people/fbank.ts` keeps its fixed 512-point transform, pinned to its reference by test. The per-asset file naming of transcripts moved to `asset-names.ts` and is shared with beats.
- **The beats file** `beats/<stem>.beats.json` (SPEC §5.9, `BeatsFileSchema`, JSON Schema `beats.json`) is defined once for every writer: `detector` is `exact` (a generator that knows its beats, #463; no `sampleRate`, `residualMs` or `onsets` needed) or `<id>@<version>` (cross rule 3 of #451). `edits` are `tempo` (`double`, `half`), `downbeat` and `offset`, applied by one `effectiveBeatGrid`. Same naming and ownership as transcripts: the name whose file records the asset, else the first free one, never overwritten for another asset (`InvalidOperation`, reason `name taken`). Measuring again keeps `edits` unless `resetEdits`.
- **Direct edits** of `beats/` (decision 3): `file.write` validates `beats/**/*.beats.json` like transcripts and keeps the old file when the new one is invalid. There is no watcher or reconcile for it, because nothing caches the file: `beats.show` reads it on every call, and an editor that writes it directly is read on the next call (a broken file is `InvalidProjectFile`). A watcher joins when slice 3 puts the grid on the timeline and a change must repaint the app.
- **Methods**: `beats.measure` (mutating, a background job of kind `beats`, step `beats`; params `asset`, `bpm` hint, `resetEdits`) and `beats.show` (read; the grid with `edits` applied, `current` false when the asset changed since); CLI `frameshell beats measure|show`; MCP `beats_measure`, `beats_show`. Protocol 86.
- **Nominal grid**: `nominalBeatFrame(i, bpm, fps, offset)` rounds each beat once from its index (a rounded step added up drifts 2 frames in 32 beats at 128 BPM and 30 fps, pinned by test). Slice 3 uses it for the grid before music exists.
- Not in this slice: `tempo`, the grid in the app, `--snap-to` (slice 3); TimeRef (slice 4); a learned detector (decision 10, only if real music fails); downbeat confidence; a meter other than 4.

## Considered options

- **B. Markers plus one grid stored in the timeline file** (rejected): the grid does not follow the music clip, so moving or trimming the music silently desyncs every beat; hundreds of measured beats land in every inverse patch; a second timeline re-measures.
- **C. Beats as markers** (`kind: beat`, rejected): hundreds of markers bloat history and proposals, beats do not follow the music, and there is no place for confidence or half/double-time correction.
- **D. A learned detector first** (deferred, decision 10): a new pinned model and worker for a gain not measured on our material.
- **Markers fixed on timeline seconds**, as sequence markers in some editors (rejected, decision 1): after a ripple cut they would point at different material.

## Consequences

- An older Frameshell rejects a timeline that carries `markers` (the timeline schema is strict); the CHANGELOG says so.
- The export compiler and preview never read markers: they paint and play nothing.
- Later slices: (3) the grid in the app, `tempo.clip`, `--snap-to`; (4) TimeRef names in time arguments, then word refs.
