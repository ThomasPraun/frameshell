# Acceptance: people in the project (ADR 0020)

> Two interview videos with the same host, and a multicam conversation. I name the host in one transcript and the People panel asks whether a voice of the other video is him; I say yes. I scan faces; it asks "Who is this?" with the guest's face and I type her name, then suggests that her face goes with the other voice. The multicam angles are suggested as their people with their mics. I ask the agent to cut every part where the guest is on screen; it cuts from the last span back. Subtitles show speaker names, and picking a person in the panel selects their words and spans.

Manual run by the owner with real recordings, in the built app (not `pnpm dev`). About 45 minutes plus scan time. Note each friction as an issue; write results to `docs/research/people-acceptance-run.md` (date, version, machine, timings, scores the suggestions showed).

## Material

- `ep1.mp4`, `ep2.mp4`: two interviews, one camera each, same host (Juan), different guests (Ana in `ep2`), 10+ minutes each.
- A multicam conversation: one file per person, angles named after them (e.g. `Juan`, `Ana`), each with its own mic file.
- A fresh project; no `people.json`; network on (first scan downloads SFace, first suggestion CAM++ + ONNX Runtime Web if missing).

## Steps

1. **Nothing changes without people.** Import the files, transcribe both interviews with speakers (`frameshell transcribe --speakers`). Check: no `people.json`, no `.frameshell/people/`, no `people` job, transcripts unchanged, until step 2.
2. **Name a speaker.** In the People panel add `Juan`; link his voice in `ep1` with the picker. Check: the transcript view and `ep1.words.json` `speakers` read `Juan`. Rename `s1` in the transcript view to `Juan P.`; the person is renamed too. Cmd/Ctrl+Z in the panel puts `Juan` back.
3. **Cross-file voice suggestion.** The panel suggests the host's speaker in `ep2` "sounds like Juan (score)". Confirm. Check: `ep2.words.json` names him `Juan`; record the score and any wrong suggestion.
4. **Face scan and clusters.** Click "Scan faces". Check: job progress, then a "Who is this?" suggestion with Ana's face cropped from the frame. Type `Ana`, confirm. Then a `face-speaker` suggestion links Ana's face to the guest voice of `ep2`; confirm. Record scan time per hour of footage.
5. **Multicam angle suggestion.** Build the multicam group from the conversation files. Check: one `angle` suggestion per angle naming its person (or a new one with the angle's name) and saying which voice (and face, after a scan) it also links. Confirm one with the prefilled name; dismiss one and check it does not come back.
6. **Agent cuts from ranges.** In an app terminal ask the agent: "cut every part where Ana is on screen from the second video". Check: it runs `people ranges Ana --on-screen`, cuts from the last span to the first, and the cuts match what you see. With review mode on, run it again: the cuts wait as one proposal, while an agent's `people confirm` applies at once and shows "Confirmed by agent".
7. **Subtitles with names.** Turn on "Speaker names" in the subtitle inspector; export. Check: cues read "Juan: …" at each turn, no cue spans two speakers, preview and export agree.
8. **Panel selection.** Click Juan: his words are selected in the transcript view and his spans on the timeline; switch to On screen. Right-click > Ask agent quotes `[frameshell] person p_… "Juan" · speaks · N spans, MM:SS total`. Detach the panel; the same people and selection show.
9. **Missing and privacy.** Rename `ep1.mp4` on disk: its links show `missing`, nothing is deleted; rename it back and they resolve. Check `people.json` holds names and references only, and nothing but model downloads used the network. `frameshell gc` after deleting `ep2.mp4` sweeps its face scan and voice prints.
