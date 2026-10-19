# Frameshell

An IDE for video: an agent edits a declarative project from the terminal, a human corrects it in the timeline.

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
