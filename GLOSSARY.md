# Frameshell

An IDE for video: an agent edits a declarative project from the terminal, a human corrects it in the timeline.

## Video from audio (ADR 0015)

**Scene plan**:
A script in `scripts/` whose `##` scenes are each tied to a range of transcript words and say what is on screen there.
_Avoid_: storyboard, shot list

## Multicam (ADR 0016)

**Angle**:
One synced source of a multicam group (usually one person's picture and mic), with its offset, crop and gain.
_Avoid_: camera, feed, participant

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
