---
status: accepted
---

# Shaped transitions chosen by cause

Extends ADR 0018. A transition can move the picture instead of mixing it: a wipe, a push, later an iris, a zoom, slats or a pixel grid. The agent picks the kind by why the picture changes, and the variety rules keep a film from repeating one. Decided by the owner on 2026-11-10 (#483, epic #451): option B, all recommendations accepted.

## Context (verified in the tree)

- A transition belongs to a clip edge (ADR 0018): `dissolve` on the incoming clip, `fadeIn`, `fadeOut`. `edgeTransitions` in `packages/schema/src/transitions.ts` is the one source of effective lengths. With no handle a dissolve plays as a dip through black.
- Until now a transition was opacity only: `fadeWeight` and `dissolveWeights` in `composite.ts`, applied by the preview (`edgeWeight`, `spanPlacement`) and by export (`pictureRamps`, the `fade` and `placementExpressions` twins in `export/animation.ts`).
- The preview composites in Canvas 2D (`#composite` in `engine.worker.ts`), so rectangle and circle clip paths and offsets need no WebGL. ADR 0018 had assumed masks would.
- ffmpeg `xfade` has no origin point, so an iris cannot open from a chosen element, and it would be a second path to keep in parity (ADR 0018 rejected it). A `geq` per-pixel alpha measured about 34 ms per 1080p frame on the managed ffmpeg 9.0.2.

## Decision

1. **A shape on the dissolve.** A shaped transition stays a `dissolve` plus an optional clip field `shape: { kind, direction? }`. Every ADR 0018 rule is kept: edge ownership, handles, `edgeTransitions` as the one source of effective lengths, equal-power sound, undo as patches, the split and cut rules. One rule changes for shaped dissolves only: `edgeTransitions` does not cut them to the handles (decision 3). The proposal said `edgeTransitions` would stay as it is; holding the edge frame needs this change, which the owner confirmed (2026-11-10). A timeline without `shape` is unchanged byte for byte, and so are its export plans. The schema rejects `shape` without `dissolve`, and on an audio track, so a hand edit is explained in `.frameshell/rejected/`; hosts older than this ADR reject files that carry `shape`.
2. **One geometry.** `shapeAt(shape, f)` in `transitions.ts` gives, at dissolve progress `f`, each picture's offset (fractions of the frame) and the frame rectangle it shows in. Progress eases in and out, f²(3−2f). Export and preview draw only what it returns; opacity weights do not apply to a shaped picture. A parity test samples it against the export expressions.
3. **No handle: hold.** Where a handle runs out, the outgoing clip's last frame or the incoming clip's first frame holds, as adapter clips already do (ADR 0018 decision 5), instead of dipping through black. Handles are used first when they exist; the held frame is only the fallback, so a shaped dissolve is cut to half of each clip but not to its handles. Sound before the source's first sample is silence. The result of the edit warns when a frame holds.
4. **Origin.** Iris and zoom will take `origin`, a rectangle `[x0, y0, x1, y1]` in fractions of the frame being rendered, so it survives formats (#469). The agent takes it from `inspect.point` (`box`, `frameBox`); markers (#458) can become another source.
5. **Dip cut** is `transition.set kind: "dip-cut"` sugar that writes opacity keys on the bottom-track clip; on an upper track it is refused with a message.
6. **Export cost.** A wipe's `geq` alpha step, about 0.5 s per shaped 1080p transition, is accepted for v1, on transition pieces only. If 4K proves too slow, core rasterises the masks and `alphamerge`s them.
7. **Order.** Push, wipe and iris first; zoom, slats and pixel grid later (a pixel grid is a square-cell mask in the same evaluator).
8. **Variety.** Never three transitions of one kind in a row, at most a third hard cuts, 3 to 5 kinds per film. The skill and `review` (#457) carry the rules. Confirmed by the owner (2026-11-10): `transition.set` returns a warning only when the bottom track breaks the first two (the owner asked for every rule; 3 to 5 kinds per film is left to the skill and `review`), and it counts scene cuts only: a cut between two clips of one asset (a jump cut inside one take) is not one.

**Compositor order.** Inside one part the preview and export apply grade, then the transition shape, then the alpha or matte mask, then the backdrop. ADR 0031 (in review, not on main yet) is to fix that order; this ADR follows it. A shape cuts the picture as it lands in the frame, so it multiplies whatever alpha the picture has: a wipe keeps the alpha of a render with alpha (`alpha(X,Y)` in the `geq`; the canvas clip path in the preview).

**Kinds.** `wipe`: a straight edge crosses the frame and uncovers the incoming clip, which shows in the strip the edge has crossed; the outgoing clip stays still under it. `push`: both pictures travel one frame in the direction, the outgoing one out and the incoming one in; they abut. `direction` (`left` default, `right`, `up`, `down`) is the way the incoming picture travels: `left` enters from the right edge.

**Operations.** `transition.set` takes `kind` `wipe` or `push` and `direction`. On the bottom video track it writes `dissolve` and `shape`; audio tracks get a crossfade. The bottom video track is the first shown picture track, as export and preview stack them: a hidden track is passed over, and a program track first leaves none. Any other video track named in `tracks` is refused; without `tracks` it is skipped with a warning. An edge of a nested clip is refused until slice 3. A lone edge fades, with a warning. `dissolve`, `fade`, `transition.remove`, split and cut clear `shape` with the `dissolve`. CLI `transition set --kind wipe|push --direction …`. Protocol 82.

**Export.** A push makes both pieces of the bottom track layers whose `overlay` x/y add `shapeAt`'s offsets as expressions of timeline time; the base is black under them. A wipe keeps the outgoing clip concatenated and adds `geq` to the incoming head: alpha is kept where the pixel centre lies in `shapeAt`'s rectangle. Frames past a handle are `tpad` clones of the edge frame; a head's sound before the source's first sample is padded with `adelay`. Golden plans pin both kinds.

**Preview.** `program.ts` passes the shape on each span's dissolve; `spanShape` evaluates `shapeAt` and `#composite` draws the part moved and cut by a Canvas 2D clip path. The decoder already holds the first and last proxy frame outside the source.

## Slices

1. Wipe and push on the bottom track, video projects only: schema, `shapeAt`, `transition.set` kinds and `direction`, export, preview, CLI, skill, the variety warning, this ADR.
2. Iris with `origin`, and dip cut.
3. Upper tracks (the outgoing picture under the inverse mask, the mask multiplying alpha), nested clips (a shaped dissolve on a window edge reaches its flattened clips like `nestedFades`, with a parity test), the inspector and the timeline mark.
4. Zoom, slats, pixel grid.

## Slice 2 as built: iris and dip cut

- **Iris.** `shape: { kind: "iris", origin? }`. `shapeAt` gives the incoming picture a circle (`ShapePart.circle`): centre at the middle of `origin` (frame fractions; no `origin`: the frame's centre), radius the eased progress times `circleReach`, the distance from the centre to the farthest frame corner, so at progress 1 it covers the frame in any aspect. The circle is in fractions so it stays a circle in pixels whatever the format. The rectangle's size is kept for zoom (slice 4); an iris uses only its centre and opens from a point, so the first frame of the transition shows none of the incoming clip. The outgoing picture does not move. The schema rejects `direction` on an iris, `origin` on a wipe or push, and an `origin` with x1 < x0 or y1 < y0.
- **Export.** `irisAlpha` in `export/animation.ts` is the twin of the circle: a `geq` alpha that keeps the incoming piece where the pixel centre is closer than `circleReach * p` to the centre (`hypot`), the same pieces and cost as a wipe. A subject of the outgoing plate clip (ADR 0032) gets the complement, as for a wipe. A parity test samples it against `shapeAt`; golden `shaped-iris-plan.json`; a real-ffmpeg test checks the circle in rendered frames.
- **Preview.** `shapedRect` turns the circle into output pixels and `#composite` clips the part with a Canvas 2D `arc` (even-odd against the frame for an outgoing subject).
- **Dip cut.** `transition.set kind: "dip-cut"` finds the clip ending at `at` on the bottom video track, clears the edge's transition there (a hard cut) and writes two `opacity` keys on that clip: its level at the fourth-last frame, and 60 % of that level at the last frame, so three frames darken over black. Keys between them are replaced, others kept; running it again writes the same keys. `duration` is ignored. Refused: an upper video track named in `tracks` (lower opacity there shows the track below, not black), an edge where no clip ends, a clip one frame long. Audio tracks named in `tracks` are left as they are, with a warning. `transition.remove` at that edge deletes the two keys when they still match that pattern; the variety warnings count such an edge as a `dip cut`, not a hard cut. Any other `transition.set` at that edge removes the dip keys first (one helper with `transition.remove`); when the keys no longer match (edited by hand), `transition.remove` leaves them and says so. The dip lives at the clip's end: `clip.trim` that moves the end rewrites it at the new last frames (gone, with a warning, when the clip is one frame long), and `clip.split` or `cut` drops it from the left part, whose new tail is no cut, while the right part keeps it at the same source seconds. A `speed` change does not move it yet.
- **Not in this slice.** An iris that closes (the outgoing picture shrinking onto the element), choosing the kind in the inspector, and showing a dip cut as a timeline mark or inspector entry (slice 3); the inspector keeps an iris's `origin` when its length changes. Protocol 113.

## Considered options

- **Recipes on ADR 0018 primitives only** (scale/x/y keys plus a short dissolve, opacity keys for a dip cut). Rejected: two of six kinds; push, wipe and iris are impossible with opacity as the only channel, and the variety rule could not be met.
- **ffmpeg `xfade` in export, hand-matched Canvas in the preview.** Rejected: no origin, bottom track only, and a second path with formulas copied by eye.
- **A WebGL shader catalogue in the preview, headless Chrome for export frames.** Rejected: a new GPU path and an export frame pipeline, far beyond the kinds needed.

## Consequences

- Schema: optional `shape` on video clips; JSON Schema regenerated. `edgeTransitions` skips the handle cut for shaped dissolves only.
- Protocol 82: `transition.set` `kind` `wipe`, `push`, and `direction`; registry description rewritten.
- Export of a wipe costs about 34 ms per 1080p frame over the transition; a push costs one more layer for the outgoing tail.
- A wipe on a bottom clip with keyed scale: the `geq` reads the layer's corner from the keyed expressions; the frame size changing per frame under keyed scale is not tested yet; slice 3 adds that test.
- In this slice a shape on an upper track (a hand edit) plays as a plain dissolve, with held frames past the handles, in both export and preview. `transition.set` refuses a shape at an edge of a nested clip (slice 3); a hand-edited one plays as a plain dissolve, and `edgeTransitions` (`playedShape`) treats it as one, so warnings and the timeline mark match what plays.
