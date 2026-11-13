# Music on the cut

Fit a music track to the picture so its last hit lands on the cut (ADR 0037). Commands assume the session rule of [SKILL.md](../SKILL.md). Music is a media clip on an audio track; put it there with `frameshell clip add`, set its level (about 12 dB under the voice is a start), then fit it. No track to use: `frameshell sound music` makes one and places it ([sound.md](sound.md#music-bed)); its final hit is exact, so fitting it is reliable.

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
- **Duck keys.** Gain keys written by `duck` sit on the clip's own clock; after a move or a speed change they no longer match the voice. When the clip carries them, `music fit` runs `duck` again in the same transaction with the settings the duck was run with (`--under`, `--depth`, `--attack`, `--release`, `--threshold`, `--gap`, kept in the clip's `audio.duck`) and says so in `warnings`. A clip ducked before the settings were kept gets the defaults over every other unmuted video and audio track: mute or avoid other music tracks first, or the duck listens to them as speech. `--skip duck` leaves the keys. **Music keys** (`music shape`) are run again the same way, before the duck (`--skip shape` leaves them).
- MCP: `music_fit`.

## Candidates: several tracks at one loudness

```sh
frameshell music candidates assets/music/a.wav assets/music/b.wav assets/music/c.wav --end end-card --dry-run
frameshell music candidates assets/music/a.wav assets/music/b.wav assets/music/c.wav --end end-card
```

Puts 2 to 7 files under the same picture so the person can pick by ear (MCP `music_candidates`). Each file goes on its own new audio track `Music 1` to `Music n`, all muted but the first, with a static clip gain that brings every file to one loudness: the EBU R128 integrated loudness of the whole file, measured once per file and cached under `.frameshell/loudness/`. The target is `--loudness <LUFS>`, else the quietest file's own, so no file is made louder than it is (a warning says when a raise would push a peak over -1 dBTP).

- **Without `--end`** the files start at `--from` (default 0), play whole, and the order you gave is the rank.
- **With `--end`** each is fitted like `music fit` slides a clip: its own final hit lands on `--end`. The rank puts files that cover the picture before the hit first, then the files whose final hit is surer (`hit.confidence`); ties keep your order. Read each candidate's `warnings`: a doubtful hit, a dropped intro, a late start.
- A file that cannot be placed (silent, no sound, no final hit, undecodable) is in `skipped`; the rest go on. `--dry-run` changes nothing.
- One transaction labelled `Music candidates: …`; `revert <tx>` undoes it whole.
- **Choose:** the person listens, then `track set <track> --unmuted` on the winner and `track remove <track> --force` on the others. Run `music fit` on the clip that stays (its start is already fitted when `--end` was given), then `duck`.
- Loudness is matched over the whole file, not over the part that plays: a track whose played part is quieter or louder than its average sits off by that much. Check by ear.

## Shape: step down before a hit, fade at the ending

```sh
frameshell music shape <music clip> --drop slam --drop 41.6 --ending 74.2 --dry-run
frameshell music shape <music clip> --drop slam --drop 41.6 --ending 74.2
frameshell music shape <music clip> --ending bar:17 --fade 0.3
frameshell music shape <music clip> --clear
```

The music steps down **before** a hit instead of ducking after it (MCP `music_shape`). A hit is a moment of the picture: a title slam, a sound effect, the cut into the end card. `--drop <time>` (repeat it per hit; seconds, a marker, `beat:N` / `bar:N`) puts the music `--depth` dB down (default 9) by `--lead` seconds before the hit (0.4), keeps it down until `--hold` seconds after it (0.3) and brings it back over `--release` (0.6). `--ending <time>` is where the closing fade begins (the end of the last word, or a marker): the music fades straight down over `--fade` seconds (2.5) to inaudible and stays there to the clip's end. A short `--fade` with `--ending bar:17` stops it on a bar line. The "silence, then one soft note" ending is not a flag: `clip split` the music after the stop and `clip add` a single soft note (`sound sfx`).

- **What it writes.** Gain keys on the clip, marked `auto: "music"`, taken from the clip's level (`audio.gain` or its hand keys). Running it again replaces only those keys; keys you set by hand (`clip key`) stay, and a hand key inside a dip stays as set with a warning. `--clear` removes the music keys. Editing a music key by hand takes its mark, so the next run leaves it.
- **With duck.** The shaping replaces the clip's duck keys, so when the clip carries them `duck` runs again in the same transaction with the settings it was run with (`audio.duck`). Both dips hold: the voice ducks the shaped music. Shape before or after `duck`; either order ends the same.
- **With `music fit`.** The hits are on the picture, the keys on the clip's clock. The times are kept in the clip's `audio.shape`, and `music fit` runs the shaping again after it moves the clip (`--skip shape` leaves the keys; a warning says they no longer line up). A hit outside the clip is left out with a warning.
- **Not here.** The rising high-pass build before a drop is a later slice. You cannot hear the result: read the `curve` of a `--dry-run` and look at the keys with `timeline show`.
- One transaction labelled `Music shape: …`; `revert <tx>` undoes it whole.

## Order

Cut the picture first, then fit the music, then `music shape` and `duck`. Fitting after the last cut keeps the cut the hit is for. If a later cut moves the end, run `music fit` again with the same marker: it plans from the clip as it is now (and runs `music shape` and `duck` again for you).
