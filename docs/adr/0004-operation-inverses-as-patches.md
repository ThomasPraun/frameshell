---
status: accepted
---

# Timeline operations: one pure engine, inverses computed as patches

Every timeline mutation (SPEC §6.1) goes through one function,
`applyOperation(timeline, request, context)` in `packages/core/src/timeline/engine.ts`.
It returns the new timeline (revision + 1), a change summary and the inverse. The
inverse is never written by hand per verb: the engine diffs the result against the
input and emits a `timeline.patch` operation (whole tracks when a track appears,
disappears or its own fields change; single clips otherwise; track order when it
moved). `timeline.patch` is itself an operation the same engine applies, so undo,
redo and revert (#10) are "apply the stored inverse".

## Considered

1. **Per-verb command objects** (`validate`, `apply`, `invert` each). Rejected: nine
   bespoke inverses, and `cut` (ripple across tracks: trims, splits, drops, shifts)
   is the hardest to invert correctly. Inverse bugs would spread across verbs and be
   found only when a user reverts.
2. **Snapshot inverse** (store the whole previous timeline). Correct but heavy: a
   180-op silence pass on a 300-clip track journals 54 000 clips.
3. **Diff to a patch** (chosen). Correct by construction for every present and future
   verb, compact (only changed clips), and the same diff will record direct file
   edits as operations (SPEC §6.4). A property test applies random operation
   sequences and checks `apply(apply(t, op).inverse) = t` for every applied op.

## Consequences

- The inverse restores the input with canonical clip order (sorted by start). A
  hand-edited file with unsorted clips is normalized by its first operation.
- History shows inverses as patches, not verbs. The forward `op`/`args` stay in the
  record for display.
- Project facts (fps, media probe, nested timelines, plugin clip types, id
  generation) reach the engine through `EditContext`; tests pass an in-memory one.
  `EditContext.resolveEditPoint` is the seam for energy snapping (#12, ADR 0003):
  `cut` and `clip.trim` route every edge through it before frame snapping.
- New ids are random (`c_` / `t_` + 6 hex digits), never reused within one
  operation, so an id in history never names a different clip.
- Frame-grid comparisons use frame numbers, not 3-decimal seconds. With speed ≠ 1,
  cut and split snap the kept tail down and the kept head up, so parts never overlap;
  at most one source frame is skipped at such a cut.
