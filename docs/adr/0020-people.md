---
status: accepted
---

# People in the project

Adds **people** to a project for v0.15: one optional file, `people.json`, that says who is who across transcripts, multicam angles and faces, so a person and an agent can ask "when does Juan speak" or "when is Ana on screen" and get timeline spans. Frameshell **suggests** links (same voice in another video, the face on screen while a voice speaks, the person behind an angle); a person or an agent confirms each one, and nothing is linked without a confirmation. Without `people.json` everything works as today. Decided by the owner on 2026-10-23.

## Context (verified in the tree)

- A transcript names who speaks per file only: `speakers` (`id` `s<n>`, free `name`, default `Speaker <n>`) and `speaker` on words, human corrections in `edits` (`packages/schema/src/transcript.ts`, `wordSpeaker`). Ids are stable across runs of `transcribe.speakers`: the voice sharing most words with the last run keeps its id and name, `nextSpeakerId` never reuses a dropped one (`transcripts/speaker-labels.ts`). Re-transcribing gives new words the speaker of the old words they overlap (SPEC §5.4). Nothing links `s1` of one file to `s2` of another.
- Diarization runs `sherpa-onnx-offline-speaker-diarization` (v1.13.8): pyannote segmentation, then CAM++ speaker embeddings clustered (`transcripts/speakers.ts`, `docs/binaries.md`). The tool prints only `start -- end speaker_NN` lines (`parseDiarization`); embeddings never leave it. The pinned release has no offline embedding tool (its archive lists only `sherpa-onnx-microphone-offline-speaker-identification`, a microphone program; checked 2026-10-22). The CAM++ model is a plain ONNX file already downloaded for diarization (`3dspeaker-campplus-en-voxceleb`, 29.6 MB, Apache-2.0): input `x` `[N, T, 80]` (80-bin fbank frames), output `embedding` `[N, 512]`. Loaded in the pinned ONNX Runtime Web 1.30.0 it ran 3 s of features in about 0.1 s single-threaded on an Apple M3 (2026-10-22).
- Multicam angles carry a `name` ("Person or camera, e.g. `Ana`"), an optional `mic` and an optional transcript `speaker`; speaking turns come from energy, painted turns or transcript speakers (`packages/schema/src/timeline.ts`, `multicam/group-turns.ts`, ADR 0016). Shots say which angles are on screen.
- Face detection: `multicam.faces` samples 2 frames per second (`FACE_SAMPLE_HZ`, `sampleFaceFrames`, frames 512 px wide) and runs YuNet on ONNX Runtime Web (managed `module` package) in a worker thread, as a background job of kind `faces` (`multicam/faces.ts`, `faces-worker.ts`). YuNet also outputs five landmarks per face (`kps_8`…`kps_32`); `decodeYunet` drops them today. Nothing is cached; nothing recognizes a face.
- SFace (OpenCV model zoo, `models/face_recognition_sface`, at the commit YuNet is pinned to, `26cc381e4d25`): `face_recognition_sface_2021dec.onnx`, 38,696,353 bytes, SHA-256 `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79` (large-file oid, matched on download), licence Apache-2.0 (the directory's `LICENSE`; not MIT). Input `data` `[1, 3, 112, 112]` (a face aligned by five landmarks), output `fc1` `[1, 128]`. In ONNX Runtime Web 1.30.0 single-threaded on an Apple M3: 39 ms per face. The int8 export (9.9 MB) took 100 ms per face there.
- Subtitle words come from the transcript of each followed clip (`subtitleWords`, `subtitleCues` in `packages/schema/src/subtitles.ts`), shared by export (ASS) and preview; a track's `style` is a loose object (`preset`, `position`).
- Review mode (ADR 0019) holds timeline changes only; transcripts, `director.json` and other project files change at once.
- The renderer has one selection store (`renderer/src/selection.ts`: clips, words, one `range`, …); sidebar views and detachable panels are listed in `apps/desktop/src/shared/layout.ts` (the Angles view is one).
- "Proposal" already means a held-back transaction in review mode (GLOSSARY, ADR 0019).

**Guiding principle: simple for the person and the agent, optional, nothing mandatory.** No person is needed for anything that works today; every link is one confirmation; anything Frameshell computes can be thrown away and computed again.

## Decision

1. **One file, `people.json`, at the project root.** Optional. Shape:

   ```json
   {
     "schemaVersion": 1,
     "people": [
       { "id": "p_3fa2c1", "name": "Juan",
         "speakers": [{ "transcript": "transcripts/ep1.words.json", "speaker": "s1" },
                      { "transcript": "transcripts/juan-lav.words.json" }],
         "angles": [{ "timeline": "main", "group": "g_talk", "angle": "juan" }],
         "faces": [{ "asset": "assets/ep1.mp4", "at": 12.5, "x": 0.41, "y": 0.33 }] }
     ],
     "dismissed": ["sg_9c04e1d2"]
   }
   ```

   - `id`: `p_` + 6 hex, core-generated and stable; hand-written ids (`p_juan`) are accepted. `name`: free text, unique (case-insensitive) in the file. Commands accept the id or the exact name.
   - `speakers`: a transcript and one of its speaker ids; without `speaker`, every word of that transcript (a person's own mic, a talking head never diarized).
   - `angles`: a multicam angle by timeline, group and angle id.
   - `faces`: **face anchors**, one face sample each: asset, source second and the point of the face as fractions of the picture. An anchor is a reference, not a face print: re-scanning finds the face at that point and names its cluster after the person.
   - Each link may carry `by` (the author that confirmed it, e.g. `agent:claude:…`), shown in the app.
   - Rules: a transcript speaker, an angle or an anchor belongs to at most one person. `dismissed` holds the ids of suggestions answered "no", so they are not asked again.
   - Why names and references only: the file can go into git and be read by a person, and it holds no biometric data. Links survive re-transcription and re-diarization because speaker ids are stable; a link whose transcript, speaker, angle or face is gone is reported as `missing` by `people.list` and ignored by ranges, never removed (a later run may bring it back).
2. **Derived data lives in `.frameshell/people/`** (gitignored, regenerable, swept by `gc` for assets that no longer exist): per-asset face scans, voice prints, clusters and face thumbnails. Deleting the folder deletes every face and voice embedding; links in `people.json` stay and are re-resolved by the next scan.
3. **Voice prints.** Per transcript speaker: CAM++ embeddings of up to 20 of its longest stretches of 1.5 to 10 s where no other speaker talks, averaged and normalized, computed from the transcription WAV (16 kHz mono, already extracted for whisper and diarization) by ONNX Runtime Web in a worker, with the 80-bin fbank features sherpa-onnx computes for the model, written in TypeScript. Cached per transcript, keyed by asset hash, the speaker's word assignment and the model id. A person's voice print is the mean of their linked speakers' prints. A few seconds per transcript, so they are computed when suggestions are asked for, never as a job.
4. **Face scans.** `people.scan` runs as a background job of kind `people` (`job.list`), on demand, never on import: transcription-like cost. Per video asset: the sampling of `faces.ts` (2 frames per second; frames decoded up to 1280 px wide, YuNet on a 512 px copy, so detection cost stays as today), YuNet landmarks decoded, every face of at least 32 px aligned to 112×112 and embedded by SFace, consecutive detections joined into face tracks (box overlap and embedding distance), one embedding per track per second. Cost: about 5 minutes per hour of one-person footage on an Apple M3 (YuNet about 20 ms per frame, SFace 39 ms per face), more per extra face. Cached per asset, keyed by asset hash, both model ids and the sampling version. Face clusters group tracks across all scanned assets (agglomerative, cosine distance over track means); cluster ids (`fc_…`) are for display and suggestions and may change between scans, which is why links store anchors. A face belongs to the person whose anchors it is closest to, within the threshold.
5. **Suggestions, never assignments.** `people.suggest` returns suggestions with a stable id (`sg_` + hash of kind and targets), a `kind`, the targets, a `score` and a one-line reason:
   - `speaker`: an unlinked speaker whose voice print is close to a person's (best match above the threshold and ahead of the second best by a margin). "s2 in ep2.words.json sounds like Juan (0.78)."
   - `face-speaker` (one camera): in an asset that has both a transcript with speakers and a face scan, the face cluster on screen for most of a speaker's time (at least 60% of it, and the only one above that), joined to the person already linked to either side, or a new person.
   - `angle` (multicam): each angle that is not a screen and has no person: the person named like the angle (an existing one, or a new one with that name), plus the angle's speaker (its `speaker` field, else its sound's transcript speaker when one speaker holds 80% of its words, else that whole transcript for a mic of its own), plus the face cluster that fills its picture when scanned. Confirmed once for all of them.
   - `face`: a cluster on screen for at least 10 s with no person: "Who is this?", with a thumbnail.
   Confirming applies the links (the anchor of a face is the cluster's most central sample); rejecting adds the id to `dismissed`. A person or an agent may confirm; nothing is linked otherwise. Undiarized transcripts are listed as a hint ("run `transcribe --speakers` to match voices"), and unscanned assets as "run `people scan`".
6. **Names follow into transcripts.** Linking a transcript speaker, and renaming its person, writes the person's name into that transcript's `speakers` entry; renaming a linked speaker in the transcript view renames the person. So subtitles, export and an agent reading a words file see the same name with no knowledge of people. Angle names are not rewritten: that would be a timeline operation, held by review mode; the People panel shows both.
7. **Ranges per person.** `people.ranges { person, timeline, what: "speaks" | "on-screen" }` returns merged timeline spans `{ start, end }` (seconds, sorted, pauses under 0.5 s bridged), with the total:
   - speaks: words of the person's linked speakers placed by the clips that play their assets (the mapping of `subtitleWords`, nested timelines flattened), and the speaking turns of their angles (painted turns included) placed through the program track's shots.
   - on-screen: shots that show one of their angles, and face samples of their faces placed by video clips that show the asset (±0.25 s around each sample). Clips covered by a layer above are not subtracted in v0.15; on a program track only the shot's angles count.
   The agent cuts or selects from them; spans are timeline seconds now, so ripple cuts go from the last span to the first (said in the result and the skill).
8. **Subtitles with names.** A subtitle track's `style` gains `speakerNames` (default false). When true, a cue never spans two speakers, and the first cue of each turn starts with the speaker's name ("Juan: …"): the transcript's speaker name, which decision 6 keeps equal to the person's. Words without a speaker get no name. Same function for preview and export.
9. **Daemon and CLI.** Methods in the registry, each with Zod params, result and a model-facing description, all MCP tools: `people.list`, `people.add`, `people.rename`, `people.remove`, `people.link`, `people.unlink`, `people.scan` (job), `people.suggest`, `people.confirm` (`reject: true` dismisses), `people.ranges`. Notification `people.changed`. The daemon is the only writer of `people.json` and writes it atomically; a hand edit is read on the next call, and an invalid file makes people methods fail with `InvalidProjectFile` while everything else works. People changes are not in timeline history; each has a one-command inverse, and the app's People panel undoes its last change with Cmd/Ctrl+Z (decision 13). CLI:

   ```
   frameshell people list [--json]
   frameshell people add <name> | rename <person> <name> | remove <person>
   frameshell people link|unlink <person> (--speaker <transcript>[:<speaker>] | --angle [<timeline>:]<group>:<angle> | --face <asset>@<seconds>[:x,y])
   frameshell people scan [<asset>…]
   frameshell people suggest [--json]
   frameshell people confirm <suggestion>… [--reject]
   frameshell people ranges <person> [--on-screen] [--json]
   ```
10. **Review mode.** `people.json` is not a timeline, so ADR 0019 does not hold its changes, as with transcripts. Links decide nothing in the output except subtitle names on a track that asked for them. Cuts an agent makes from ranges are timeline operations and are reviewed as any other. With review mode on, an agent that confirms a suggestion is not blocked: the link applies at once, shows "confirmed by agent" (from `by`) in the People panel, and the person can undo it there (decision 13) or unlink it.
11. **The app.** A **People** sidebar view, detachable (ADR 0012), next to Angles: suggestions on top (play the voice's longest stretch, the face thumbnail, Yes / No, a name field for new people), then each person with a colour, linked speakers, angles and faces, and seconds speaking and on screen in the main timeline. Clicking a person selects their words in the transcript view and their spans on the timeline; a Speaks / On screen toggle picks which. The selection store gains `person` and `spans` (disjoint timeline ranges), so Ask agent quotes `[frameshell] person p_3fa2c1 "Juan" · speaks · 14 spans, 03:20 total` and `ui_state` reports it. The transcript view's speaker label menu gains "Link to person"; the subtitle inspector gains "Show speaker names". Strings in a new `shared/i18n/people.ts`, English and Spanish.
12. **Privacy.** Everything runs locally; the only network use is downloading the pinned SFace model on the first scan. Embeddings and thumbnails stay in `.frameshell/people/`, never in `people.json`; scans happen only when asked for.

13. **Undo in the app.** Cmd/Ctrl+Z in the People panel undoes the last people change (rename, link, unlink, confirm, including an agent's), by applying its inverse through the same methods; one step, no people history. Elsewhere the key keeps its timeline meaning.
14. **SFace accepted by the owner** (2026-10-23): weights Apache-2.0; the training sets named in the SFace paper are research face datasets, noted in `docs/binaries.md`; everything runs locally.
15. **Settled later or left out:** suggestion thresholds are tuned on real recordings in their own issues; `multicam.faces` reading the scan cache comes later; occlusion by upper tracks is ignored in v0.15.

## Considered options

- **People inside transcripts or the timeline** (a person field on `speakers`, on angles). Rejected: a person spans files, and an angle edit is a reviewed timeline operation.
- **Assign voices automatically above a threshold.** Rejected by the owner: a wrong name in subtitles is worse than one more click.
- **Face or voice prints stored in `people.json`.** Rejected: biometric data in a file that goes into git, and prints change with the model; anchors and stable speaker ids are enough to re-resolve.
- **Cluster ids as links.** Rejected: clusters change when footage is added or rescanned.
- **Embeddings from the diarization tool.** Not possible with the pinned build (segments only); running CAM++ ourselves reuses the downloaded model and the face runtime, with no native code.
- **SFace int8** (9.9 MB). Rejected: 2.5× slower per face in WebAssembly.
- **Active speaker detection and lip reading** for voice↔face. Later: co-occurrence with one confirmation covers the single-camera case.
- **Reviewing people edits under review mode.** Rejected: review mode is about the timeline; links change no frame.
- **Calling them proposals.** Rejected: "proposal" is review mode's word.

## Acceptance scenario

> Two interview videos with the same host. I diarize both, name `s1` of the first "Juan" in the transcript view, and the People panel asks whether `s2` of the second is Juan; I say yes. I scan faces; it asks "Who is this?" with Ana's face and I type her name; it suggests that Ana's face goes with the other voice of the first video; I confirm. I ask the agent "cut every part where Ana is on screen from the second video"; it calls `people ranges Ana --on-screen` and cuts from the last span back. I turn on speaker names on the subtitle track and export: cues read "Juan: …".

## Consequences

- New project file `people.json` (Zod model, JSON Schema `people.json` regenerated) and `.frameshell/people/`; subtitle track `style.speakerNames`.
- Protocol bump: the `people.*` methods, notification `people.changed`, job kind `people`, `person` in `ui_state` and `ui_select`.
- New managed model `sface-2021dec` (38.7 MB, Apache-2.0, OpenCV zoo commit `26cc381e4d25`); `docs/binaries.md` records it. CAM++ gains a second user. `decodeYunet` returns landmarks.
- Skill: when to use `people ranges`, cutting from the last span, confirming only what the person agreed to or what is certain.
- Without `people.json`, nothing changes: no download, no scan, no new file.
- Not covered: occlusion by upper tracks in on-screen ranges, people across projects, active speaker detection, `multicam.faces` reading the scan cache (a later speed-up).
