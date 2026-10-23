# Frameshell

An IDE for video: an agent edits a declarative project from the terminal, a human corrects it in the timeline.

## Transitions and keyframes (ADR 0018)

**Transition**:
A dissolve or a fade at a clip edge, stored on the clip (`dissolve`, `fadeIn`, `fadeOut`) and centered on the cut; the timeline length never changes.
_Avoid_: effect, wipe (a shaped transition, not supported)

**Dissolve**:
A mix from the clip that ends at a clip's start into that clip, over the handles of both; for sound, an equal-power crossfade.
_Avoid_: cross dissolve, mix, blend

**Fade**:
A ramp from or to nothing inside one clip: black under the bottom track, transparent on upper tracks, silence for sound. A fade at a cut between two clips is a dip (fade out, then fade in).
_Avoid_: dip to black (that is two fades), fade transition

**Handle**:
Source material just outside a clip's `[in, out]` that a dissolve plays; a clip without enough gets a shorter dissolve or a dip, never an error.
_Avoid_: tail, overlap, pre-roll

**Keyframe**:
A value of one clip property (`x`, `y`, `scale`, `opacity`, `gain`) at a time on the clip's own clock (the seconds `in` counts), stored in the clip's `keys`; between keyframes the value follows the ease, outside them it holds. "Key" for short.
_Avoid_: automation point, marker

**Ease**:
How a value moves from one keyframe to the next: `linear`, `in`, `out` or `in-out`.
_Avoid_: curve, interpolation, Bézier

## Image projects (ADR 0017)

**Image project**:
A project with `"kind": "image"`: one still picture, the first frame of its main timeline, exported as PNG, JPEG or WebP.
_Avoid_: still project, photo project

**Layer**:
A video track of an image project, shown in the Layers panel; the first track is the bottom layer.
_Avoid_: level, sheet

## Photo segmentation (ADR 0022)

**Mask**:
A grayscale PNG at a photo's own pixel size marking one part of it (255 inside, 0 outside), written under `.frameshell/context/` when Pick segments a point; one click gives three, from a small part to the whole object.
_Avoid_: selection, matte, segment (the reference part that names a mask)

**Cut-out**:
A new layer holding only the masked part of a photo, as a PNG with alpha in `assets/`, placed exactly over the photo (`image.cutout`).
_Avoid_: sticker, extraction, crop

**Background removal**:
A cut-out followed by hiding or removing the photo layer under it; two steps, not an operation of its own.
_Avoid_: remove bg, matting

## Review mode (ADR 0019)

**Review mode**:
A per-project choice of the person in the app, off by default, under which every timeline change not made in the app waits as a proposal instead of applying.
_Avoid_: proposal mode, approval mode, review switch (the control that turns it on)

**Proposal**:
One transaction by an agent (or another author outside the app) held back for review: shown before and after, then accepted or rejected whole. At most one per project at a time.
_Avoid_: suggestion, draft, pending change, changeset

**Stale proposal**:
A proposal the person's own edit made out of date by changing a clip, track or group it also changes; it closes without applying, and its author redoes it.
_Avoid_: conflicted proposal, expired proposal

## Video from audio (ADR 0015)

**Scene plan**:
A script in `scripts/` whose `##` scenes are each tied to a range of transcript words and say what is on screen there.
_Avoid_: storyboard, shot list

## Multicam (ADR 0016)

**Angle**:
One synced picture of a multicam group (usually one person), with its offset and crop. Its sound is its own file's, a mic's, or none.
_Avoid_: camera, feed, participant

**Reframe**:
An angle's keys over group time saying which point of its picture a tile centers on when it cuts the picture to its aspect (a solo in a 9:16 export of a 16:9 camera).
_Avoid_: pan, crop track, auto-crop

**Mic**:
A separate sound file of a multicam group with its own offset and gain. Angles pick one; one mic may serve several angles and plays once.
_Avoid_: audio track, recorder

**Gallery recording**:
One call recording (Zoom, Meet, Teams) in gallery view: every person in a tile of one picture, one mixed sound. `multicam gallery` makes one angle per tile, each a crop of that file.
_Avoid_: grid recording, speaker view (that has one picture)

**Multicam group**:
The set of angles of one conversation, on one shared clock.
_Avoid_: multicam clip, sync group

**Program track**:
The track that holds the shots of a multicam group.
_Avoid_: switch track, edit track

**Shot**:
A clip on the program track that shows chosen angles in a layout (`solo`, `two-up`, `grid`, `screen`, `pip`) over a time range.
_Avoid_: cut, layout, scene

**Director**:
The deterministic rule engine (`frameshell direct`, `director.json`) that turns speaking turns into shots.
_Avoid_: auto-switcher, virtual producer

**Speaker**:
One person speaking in a transcript (`speakers`: id and name), found by speaker diarization; each word names its speaker.
_Avoid_: voice, cluster, participant

**Painted turn**:
A stretch of the group clock a person marked as spoken or silent for one angle (`painted` in the group, `multicam paint`); it replaces the angle's measured speaking turns inside its range.
_Avoid_: manual turn, override
