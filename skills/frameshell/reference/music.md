# Music on the cut

Fit a music track to the picture so its last hit lands on the cut (ADR 0037). Commands assume the session rule of [SKILL.md](../SKILL.md). Music is a media clip on an audio track; put it there with `frameshell clip add`, set its level (about 12 dB under the voice is a start), then fit it.

## Land the last hit on a cut

```sh
frameshell marker add --at 74.2 --label end-card
frameshell music fit <music clip> --end end-card --dry-run
frameshell music fit <music clip> --end end-card
frameshell music fit <music clip> --end end-card --exact
```

- **`--end`** is seconds, a marker id or label (`end-card`, `outro-1`) or a grid reference (`bar:16`, read on the clip as it is before the fit). It is the second the track's own final hit plays on. Mark the cut first with `marker add`, so the plan keeps following it.
- **The hit** is found on the track's energy: the last sharp jump in level near the end of the part the clip plays. The result gives its `confidence` (0 to 1) and the other strong hits (`hit.candidates`). You cannot listen: if the track fades out or goes on after its last accent the confidence is low, so read `hit.candidates` and pass the right one with `--hit <seconds of the file>`.
- **Default (slide).** The clip moves so the hit lands on `--end` (within half a frame) at the speed it has, and plays unspliced before it. The result says where the music starts. If that would be before `--from` (default 0) the intro is dropped instead (`introCut`: `in` moves later, which can fall mid-phrase). If the clip already plays the file from later than 0 (an earlier fit dropped the intro) and the start now lands after `--from`, the intro comes back as far as the file has it. If the whole file is shorter than the picture before the hit the music starts late (`silentBefore`), and nothing is looped or spliced: pick another track, or let the start be silent on purpose.
- **`--exact`.** Keeps the start (where the clip is, or `--from`) and changes the speed a little so the hit lands on `--end` exactly. At most 1.7 % of the clip's speed: beyond it the command refuses with the ends that would fit; move the end by a beat, trim the intro (`clip trim --in`), or drop `--exact`. A doubtful hit (confidence under 0.5) never changes the speed: pass `--hit`. Export keeps the pitch (atempo) but plays the music about 21 ms early at the changed speed, a fraction of a frame; the preview plays the pitch up or down by up to 0.3 semitone until its stretch lands. Prefer sliding when the intro can move.
- **`--dry-run`** prints the plan and changes nothing. `steps` lists what it would do.
- **One transaction** labelled `Music fit: …` (`frameshell revert <tx>` undoes it whole; in review mode it is one proposal). It writes only `start`, `in` and `speed` of the clip (and the duck keys below).
- **Duck keys.** Gain keys written by `duck` sit on the clip's own clock; after a move or a speed change they no longer match the voice. When the clip carries them, `music fit` runs `duck` again in the same transaction over every other unmuted video and audio track, with its defaults, and says so in `warnings` (`--skip duck` leaves the keys; run `duck` yourself with your own `--under` and `--depth`). Mute or avoid other music tracks before fitting a ducked clip, or the duck listens to them as speech.
- MCP: `music_fit`.

## Order

Cut the picture first, then fit the music, then `duck`. Fitting after the last cut keeps the cut the hit is for. If a later cut moves the end, run `music fit` again with the same marker: it plans from the clip as it is now.
