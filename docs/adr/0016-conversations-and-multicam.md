---
status: accepted
---

# Conversations with several people: multicam and a rule-based director

Adds use case C to SPEC §1 and takes multicam off its out-of-scope list. A podcast, interview, panel or recorded call has one picture per person. A human producer cuts to whoever speaks, holds a two-shot on a quick exchange and goes wide on laughter. Frameshell does this after the recording, by rules, and the human corrects it (grilling 2026-10-17). Live switching is out of scope.

## Context (verified in the tree)

- `frameshell cut` is a ripple cut over every video and audio track by default, so synced sources stay in sync when silences go.
- Per-file audio energy envelopes exist for cut snapping (`packages/core/src/media/energy.ts`, ADR 0003).
- Layer placement and nested flattening are shared by export and preview (`packages/schema/src/composite.ts`).
- Transcript words carry no speaker (SPEC §5.4).

## Decision

1. **Sources.** First, one file per person (video and audio each, as Riverside or one camera and one mic per person give). Then a gallery-view call recording cut into one source per tile, and a set of cameras with separate mics. Files that do not start together are synced by audio cross-correlation, with a manual offset to fix it.
2. **Multicam group and program track.** A group holds the synced sources, called **angles**, each with its offset, crop and audio gain. A **program track** holds one clip per **shot**: `{ shot, angles }` over a time range of the group. Shots: `solo`, `two-up`, `grid`, then `screen` and picture-in-picture. Preview and export resolve each shot into layers through `composite.ts`. Every angle's audio plays under every shot; shots switch pictures only. Changing a shot is changing one clip, and a ripple cut cuts the program track like any other.
3. **Who speaks.** From each angle's own mic energy when every person has a mic. When the audio is mixed, from local speaker diarization (a managed binary, like whisper.cpp), which also sets a `speaker` on transcript words. A manual correction in the UI always overrides both. Visual cues (call-app speaker borders, lip motion) are not used.
4. **Director.** `frameshell direct` turns speaking turns into shots by the rules of `director.json` in the project: minimum and maximum shot length, two-shot on quick exchanges or overlap, wide on silence and laughter, cut lead (J-cut), weight per person. It ships templates (`interview`, `podcast-calm`, `panel-dynamic`) and is deterministic: the same input gives the same shots. Every shot carries a `confidence` and a reason. The agent reviews the low ones for what rules cannot see ("hold the reaction after the punchline"). Re-running it over a range keeps shots the human authored.
5. **Correcting by hand.** The program track shows one colour per person, and the inspector changes shot and angles. Keys 1-9 switch the angle at the playhead, also while playing. A multicam viewer panel shows every angle in a grid; clicking one cuts to it. The viewer is a detachable panel (ADR 0012).

## Considered options

- **No new concept**: one track per person, clips split and hidden. Rejected: one shot change touches several tracks, and an hour leaves hundreds of fragments.
- **The agent picks every shot.** Rejected: hundreds of turns per hour cost tokens and are not reproducible. The agent reviews instead.
- **Rules as JS plugins.** Deferred until `director.json` cannot express a real case.
- **Live switching during a call** (Meet Media API, meeting bots, WebRTC). Out of scope: a low-latency compositor and streaming product, not an editor.

## Acceptance scenario

> I open three files of a podcast, one person each. I ask the agent "build the multicam, interview style, and remove the silences". I watch the program track fill. While playing, I fix two shots with the number keys. I ask the agent to continue; it keeps my shots. I export 16:9, and `--verify` reports no lost words.

## Consequences

- Timeline schema change (group, program track, shot clip): JSON Schema regenerated, `PROTOCOL_VERSION` bumped, export compiler and preview engine extended, skill updated.
- Delivery: v0.10 has one file per person, sync, group and program track, `solo`/`two-up`/`grid`, `direct` and the correcting UI. v0.11 has diarization and `speaker`, gallery recordings, camera sets, `screen` and picture-in-picture, and 9:16 reframing.
