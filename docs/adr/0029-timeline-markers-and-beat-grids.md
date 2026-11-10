---
status: accepted
---

# Timeline markers and beat grids measured per asset

Films are timed in beats and reels in words (#458, epic #451). Frameshell had words but neither markers nor a beat grid; ADR 0023 left markers out on purpose ("a new timeline concept"). This ADR adds both: markers on the timeline clock, and a beat grid measured per music asset and mapped onto the timeline through the music clip. Decided by the owner on 2026-11-10 in #458 (option A of the proposed decision, every recommendation accepted); the beat grid lives in core as decided in #478. It ships in slices; slice 1 (markers) is what is built so far.

## Context (verified)

- `TimelineSchema` (`packages/schema/src/timeline.ts`) is a strict object; `SCHEMA_VERSION` 1 has taken every additive field (`groups`, `keys`) without a bump.
- Inverses are diff patches (ADR 0004): `TimelinePatchSchema` (`packages/protocol/src/timeline.ts`) covered only `groups`, `tracks`, `clips` and `order`, so a top-level field needs its own patch entry or revert silently stops restoring it.
- Review mode (ADR 0019) decides staleness and rebase from the entity keys a patch touches (`packages/core/src/history/revert.ts`).
- Snapping in the app: `SnapPoint` with kinds `clip` and `playhead` (`renderer/src/timeline/edit.ts`); in core, the `EditPointResolver` seam that energy snapping (ADR 0003) uses for `cut` and `clip.trim`.
- The scene band (`renderer/src/timeline/scenes.ts`) already shows named spans under the ruler; markers are points, not spans.
- `EnergyStore` caches 10 ms envelopes; too coarse for ±8 ms beat snapping, and a different signal (RMS, not spectral flux).

## Decision

1. **Markers ripple with `cut`** like clip starts: markers after the cut move with the material, markers inside the removed range are deleted (named in `warnings`; `revert` brings them back). A marker on the cut's first frame stays: it marks the new edit point. Only a `cut` of every video, audio and program track moves markers; a cut of some tracks shifts them against the rest, so markers stay. `ripple` trims and inserts (the inverse of `cut`) move markers like clip starts under the same rule, so restoring cut material puts them back in step.
2. **Timeline markers only in v1.** `markers: [{ id: "m_<hex>", at, label, color? }]`, optional, on the timeline clock, `at` on the frame grid, ids unique among the file's ids, labels unique per timeline ignoring case (so a later `--at hook` resolves to one), `color` one of `red`, `orange`, `yellow`, `green`, `blue`, `purple` (the app paints each from its theme; absent: the accent). Clip-anchored markers come later.
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
- CLI `frameshell marker add --at s --label l [--color c] | set <marker> | remove <marker> | list`; MCP tools from the registry.
- App: a marker lane under the ruler (shown while there are markers), a faint guide down the lanes, add, rename and delete from the ruler's right-click menu, `SnapPoint` kind `marker`; a trimmed edge put on a marker goes exactly (no energy snap), as on a clip edge.

## Considered options

- **B. Markers plus one grid stored in the timeline file** (rejected): the grid does not follow the music clip, so moving or trimming the music silently desyncs every beat; hundreds of measured beats land in every inverse patch; a second timeline re-measures.
- **C. Beats as markers** (`kind: beat`, rejected): hundreds of markers bloat history and proposals, beats do not follow the music, and there is no place for confidence or half/double-time correction.
- **D. A learned detector first** (deferred, decision 10): a new pinned model and worker for a gain not measured on our material.
- **Markers fixed on timeline seconds**, as sequence markers in some editors (rejected, decision 1): after a ripple cut they would point at different material.

## Consequences

- An older Frameshell rejects a timeline that carries `markers` (the timeline schema is strict); the CHANGELOG says so.
- The export compiler and preview never read markers: they paint and play nothing.
- Later slices: (2) the beat detector, `beats.measure`, `beats.show` and the beats file, tested on synthetic click tracks; (3) the grid in the app, `tempo.clip`, `--snap-to`; (4) TimeRef names in time arguments, then word refs.
