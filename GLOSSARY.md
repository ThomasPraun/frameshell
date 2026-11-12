# Frameshell

An IDE for video: an agent edits a declarative project from the terminal, a human corrects it in the timeline.

## Style (ADR 0028)

**Style guide**:
The project's `style.json`: brand, colours, fonts, type sizes, motion, sound levels, platforms, rules and banned list, as numbers.
_Avoid_: style notes, brand kit, theme

**User style**:
A style guide kept per machine for reuse, copied into a project (never linked to it).
_Avoid_: global style, template

**Motion personality**:
A named set of motion values (playful, premium, corporate, energetic, calm) a style starts from and overrides field by field.
_Avoid_: motion preset, animation style

**Token**:
One named style value a consumer reads (a colour role, a duration, a dip in dB), never an inline number.
_Avoid_: variable, setting

**Safe zone**:
The part of the frame a platform's app covers (buttons, captions, profile), in pixels of a reference frame; held once per platform, named by styles and formats.
_Avoid_: safe area (alone), margin

## Voiceover (ADR 0034)

**Voiceover**:
Narration generated from text by a speech provider, one take per line of a voiceover script.
_Avoid_: TTS (the technique, not the feature), narration track, dubbing

**Speech provider**:
What turns one line of text into spoken audio for `voiceover generate`: built into the daemon, or contributed by a plugin (`contributes.speechProviders`). Paid when its cost estimate is above 0.
_Avoid_: TTS engine, voice (a voice is one of a provider's voices)

**Voiceover script**:
A script in `scripts/` marked `voiceover: true`, read line by line like a shoot script; each line has a display form (captions) and a spoken form (what the voice says).
_Avoid_: narration script, TTS script

**Voiceover take**:
The generated audio of one voiceover script line, `assets/voiceover/<script slug>/<line id>.wav`, carrying the cache key it was made from.
_Avoid_: take (alone: a shoot recording), clip (until placed on a timeline)

## Talking to the agent (ADR 0025)

**Reference**:
The `[frameshell] …` lines that name what the person selected or pointed at, for an agent to read.
_Avoid_: context, prompt, mention

**Chat about this**:
The action that sends a reference of the selection to an agent target (Cmd/Ctrl+L, right-click).
_Avoid_: Ask agent (former name), send to agent

**Agent target**:
Somewhere a reference can go: an app terminal running an agent, or an external agent (an MCP client, a waiting `frameshell ask`) that presented itself to the daemon.
_Avoid_: agent (alone), session, recipient

**Inbox**:
The references waiting for one external agent target until it reads them.
_Avoid_: queue, mailbox

## Shoot (ADR 0023, 0024)

**Shoot script**:
A script in `scripts/` marked `shoot: true` that says, line by line, what each person says on camera; written by the agent from the person's own script, which stays untouched.
_Avoid_: compatible script, frameshell script, teleprompter text

**Take**:
One recording of part of a shoot script: one or more scenes, or part of one. In the app, a range of a shoot session.
_Avoid_: clip, attempt

**Shoot session**:
One continuous recording in the app, from Start to End: every source records without stopping, and takes are ranges in it. One multicam group per session.
_Avoid_: recording, session (alone: a CLI session is something else)

**Teleprompter**:
The panel that shows the shoot script while recording, with the word being said kept on a fixed focus line.
_Avoid_: prompter, autocue

**Deviation**:
A difference between a take and its shoot script (a word missing, changed or added, a line moved or restarted, a long pause, the wrong person, a scene too long or short), marked for the person to accept or record again; never blocking.
_Avoid_: error, mistake, warning

**Chosen take**:
The take of a scene that goes into the assembled timeline; the newest one covering it unless the person picks another.
_Avoid_: best take, selected take

**Cue**:
A bracketed mark in a shoot script (`[VISUAL: …]`) that is never spoken: what to show, how to say it. `[FREE: …]` is the cue for unscripted speech.
_Avoid_: mark, note, direction

## People (ADR 0020)

**Person**:
Someone in the project's footage, kept in `people.json` with a name and links to transcript speakers, multicam angles and face anchors, across any number of files.
_Avoid_: speaker (one voice in one transcript), participant, character, cast member, identity

**Voice print**:
A summary of how one transcript speaker sounds, computed from their speech and used only to suggest that speakers of different files are the same person; regenerable, never stored in the project.
_Avoid_: voice embedding, voiceprint, speaker profile

**Face cluster**:
The faces a face scan judges to be the same face across the scanned footage, not yet named; it may change when footage is added or scanned again.
_Avoid_: face group, face id, identity

**Face anchor**:
One face sample (a file, a second and a point in the picture) confirmed as a person's; faces closest to a person's anchors are that person's.
_Avoid_: face print, reference face, tag

**Suggestion**:
A link between a person and a speaker, angle or face that Frameshell computed and that waits for a person or an agent to confirm or reject it; nothing is linked without that answer.
_Avoid_: proposal (review mode's word), match, guess, auto-assignment

**Person range**:
A span of timeline time where a person speaks or is on screen, as `people ranges` returns it.
_Avoid_: segment, turn (a turn is an angle's speaking stretch on the group clock), occurrence

## Subject matte (ADR 0032)

**Matte**:
A grayscale video, frame for frame with an asset's proxy, white where the person in front is and black elsewhere; made once per asset content and cached, never stored in the project.
_Avoid_: mask (a Pick mask is one still picture, ADR 0022), alpha, segmentation, cut-out

**Plate**:
The video track whose person a track flagged `behind` goes behind: its clips are drawn as usual, and drawn again above the flagged track through their matte.
_Avoid_: background track, source track, base layer

## Motion (ADR 0033)

**Motion runtime**:
The page script (`frameshell-motion.js`, `window.FrameshellMotion`) that a HyperFrames composition loads from its own directory to paint every frame as a pure function of time: it binds one paint function to the composition clock and writes only 2D `transform` and `opacity`.
_Avoid_: animation library, motion engine, timeline (a timeline is the project's `timeline.json`)

**Spring**:
A closed-form damped oscillator that carries a value to a target, set by `response` (period, seconds) and `damping` (ratio ζ: 1 never overshoots, lower bounces); the presets are snappy, default, heavy and playful.
_Avoid_: bounce, elastic ease, physics animation

## Element adjustments (ADR 0021)

**Element adjustment**:
A move (`x`, `y`, composition CSS pixels) and uniform `scale` of one element inside a generated clip, stored in the clip's `elements` under the element's CSS selector and applied over the composition; the source file stays untouched.
_Avoid_: override, patch, element transform (a clip's `transform` places the whole clip)

**Element mode**:
The preview state entered by double-clicking a generated clip, where handles move and scale the element under the cursor instead of the clip; Escape leaves it.
_Avoid_: edit mode, isolation mode

## Effects (ADR 0031)

**Audio effect**:
One step that processes a media clip's sound, in list order: high-pass, denoise or compressor.
_Avoid_: filter, plugin, preset

**Voice chain**:
The audio effects that make a phone or laptop voice sound finished: high-pass at 85 Hz, light denoise, gentle 2.5:1 compression. Written into a clip as explicit entries, never as a name.
_Avoid_: voice preset, voice polish, mastering

**Bake**:
An asset's sound processed once through one chain of audio effects and cached in `.frameshell/audio-fx/`; preview and export both play it. One bake serves every clip of that asset and chain.
_Avoid_: render (that is a generated clip's), proxy, sidecar (that is the dry sound)

## Transitions and keyframes (ADR 0018, ADR 0030)

**Transition**:
A dissolve (plain or shaped) or a fade at a clip edge, stored on the clip (`dissolve`, `shape`, `fadeIn`, `fadeOut`) and centered on the cut; the timeline length never changes.
_Avoid_: effect

**Shaped transition**:
A dissolve whose `shape` moves the pictures instead of mixing them: a wipe (a straight edge uncovers the incoming clip) or a push (the incoming clip slides in and pushes the outgoing one out), in a `direction`; `shapeAt` gives its geometry. Picked by why the picture changes.
_Avoid_: slide, transition effect, xfade

**Hold** (of a shaped transition):
Where a shaped transition runs past a clip's handle, the clip's edge frame (the outgoing clip's last, the incoming clip's first) shows still instead of a dip through black.
_Avoid_: freeze frame (a separate edit), still

**Dissolve**:
A mix from the clip that ends at a clip's start into that clip, over the handles of both; for sound, an equal-power crossfade.
_Avoid_: cross dissolve, mix, blend

**Fade**:
A ramp from or to nothing inside one clip: black under the bottom track, transparent on upper tracks, silence for sound. A fade at a cut between two clips is a dip (fade out, then fade in).
_Avoid_: dip to black (that is two fades), fade transition

**Handle**:
Source material just outside a clip's `[in, out]` that a dissolve plays; a clip without enough gets a shorter dissolve or a dip (a shaped transition: a hold), never an error.
_Avoid_: tail, overlap, pre-roll

**Marker**:
A named point on a timeline's clock (`markers` in the timeline file: id, `at`, label, optional colour, ADR 0029): a hook, a beat to land on, a note. It moves with the material when a `cut` of every track ripples it and is deleted when the cut removes the moment it names. Paints and plays nothing.
_Avoid_: cue (a shoot script's `[LABEL: …]`), keyframe, chapter

**Beat grid**:
The beats of one music asset, measured by `beats.measure` into `beats/<name>.beats.json` (tempo, beat times in source seconds, which beat starts a bar, a confidence), with the person's corrections (`edits`: half or double time, bar start, offset) applied on top. LOW confidence means it may be double time or a bar off. A generated track writes its own exact grid.
_Avoid_: click track, tempo map, markers (a marker is a named point, not a beat)

**Tempo**:
The beat grid a timeline follows (`tempo` in the timeline file, ADR 0029): a music clip whose beats file gives the grid, carried through the clip's place so it moves with the music, or a nominal BPM for blocking a film before music exists. The app draws it (bars stronger than beats), dragged clips snap to it, and `--snap-to beat|bar` moves a command's times onto it.
_Avoid_: grid (the beats on the timeline clock are the grid; the tempo is what names its source), BPM setting

**Downbeat**:
The first beat of a bar. The detector takes it from the phase with most low-band energy; `edits.downbeat` overrides it.
_Avoid_: bar line, one

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

## Formats (ADR 0027)

**Format**:
One delivery size of a project's single edit (`formats` in `frameshell.json`: an id such as `9x16` and a frame size); every format plays the same cuts, captions and audio.
_Avoid_: variant, aspect, version, cutdown (a shorter edit is another timeline)

**Primary format**:
The first format, equal to the project `resolution`; its export is laid out as a project without formats is.
_Avoid_: master, main format, default format

**Cover**:
How an untransformed footage clip fills the frame of a non-primary format: the centre of its picture is cropped to the frame's aspect and scaled to fill it. Sources with alpha on an upper track (lower thirds, logos) are fitted whole instead.
_Avoid_: crop-to-fill (as a name), zoom, letterbox (the opposite)

**Config operation** (ADR 0036):
One journaled change of project config (a format added or removed, a `revert` of one), as keyed before/after values in `.frameshell/history/project.config.jsonl`; it belongs to a transaction like a timeline operation and is listed in every timeline's history.
_Avoid_: config edit, settings change

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

## Review sheets (#457)

**Review run**:
One `review` of a timeline or an exported file: contact, phone, motion-strip and loop-seam sheets in `.frameshell/review/<n>/` with a `review.json` manifest, for an agent to look at a whole film. Not Review mode: nothing waits for anyone and no project file changes.
_Avoid_: review (alone, it reads as Review mode), audit

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

## Transcription models (#427)

**Pinned model**:
A model a transcription provider ships, downloaded and checksum-verified by the host on first use.
_Avoid_: built-in model, bundled model

**Registered model**:
A model file the user registered on one machine under an id (`frameshell model add`), kept with its SHA-256 in `models.json` in the config dir. Projects name only the id, so the same project uses whichever file each machine registered.
_Avoid_: custom model path, local model

## Blender clips (ADR 0035)

**Blender clip**:
A generated clip (`type: "blender"`) whose `source` is a `.blend` in the project: the `@frameshell/blender` adapter renders its scene from the first frame up to the clip's end into the clip cache, as VP9 with alpha.
_Avoid_: 3D clip, Blender layer, Blender asset

**User install**:
A tool Frameshell uses but never downloads, because it belongs to the person (Blender): a package with no pinned builds, found only through a `binaries` override.
_Avoid_: system binary, external binary, unmanaged tool

**Draft**:
The quality of a Blender render in this version: EEVEE or Workbench with a transparent film, fast and not final art. `quality: "final"` (Cycles) comes in a later slice.
_Avoid_: preview render, low quality, proxy
