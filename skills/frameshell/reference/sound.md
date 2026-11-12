# Sound effects

Short sounds made offline by Frameshell itself (ADR 0038): no network, no third-party samples, no licence to read. Same arguments, same file. Commands assume the session rule of [SKILL.md](../SKILL.md).

## Make one

```sh
frameshell sound sfx whoosh --variant 2 --seed 5 --json
frameshell sound sfx click --pitch 1.1 --json
frameshell sound sfx riser --length 2.4 --json
```

- **Kinds:** `click`, `tick`, `pop`, `whoosh` (stereo), `riser`, `thump`, `impact`, `shutter`. `--variant 1` to `3` is a different recipe of the kind.
- **`--seed`** (default 0) is a family seed: sounds made with one seed share a timbre, so use one seed per film. Change `--variant` or `--seed` for another take of the same sound: the same whoosh on every cut is the tell of a bad edit.
- **`--pitch`** multiplies every frequency (0.5 to 2). Without it the take gets a seeded pitch between 0.9 and 1.3 and a level within 1.5 dB. **`--length`** is for `whoosh` (0.3 to 2 s) and `riser` (0.8 to 6 s) only.
- The take lands in `assets/sound/<kind>-<key>.wav` (48 kHz, 16-bit, peak about -3 dBFS) and is imported. Nothing goes on a timeline: place it with `frameshell clip add`. A take that is already current is `cached` and nothing is written; a file of that name you or the person made by hand is never overwritten (`InvalidOperation`).
- When the project keeps a `credits.json`, the take is recorded there as `own` work (`credited: true`); without one nothing is written, so a project of its own footage gets no export warning. See [credits.md](credits.md).
- MCP: `sound_sfx`.

## Put it on the picture

Every result has **`peakAt`**: the second of the take that must land on the picture. It is the transient of a hit, the peak of a whoosh (45 % of its length), the end of a riser. A sound that builds starts before its cue; its peak, not its start, is on it. Place the take at

`start = cue + offset - peakAt`

with the offset by role, in milliseconds (negative = before the picture): tap -60, knock -40, click -11, pop +30, whoosh peak +37, swell peak +42. A riser ends 75 ms before the hit (`start = hit - 0.075 - duration`). A cue can be a marker: `frameshell clip add <track> assets/sound/whoosh-1a2b3c4d.wav --start hook-0.346` puts a whoosh whose `peakAt` is 0.383 so that its peak falls 37 ms after the marker `hook`.

## Taste

- Sound only visible actions: a click on a click, a whoosh on a cut that moves, a tick on typing, a pop on a badge, one riser into one impact per film. About 85 % of cuts get no sound.
- At most 2 sounds on one frame, at most about 2 per 3 seconds, never the same take twice in a row. Rotate 2 or 3 variants and seeds.
- Keep them under the voice: the style's `sound.sfxUnderVoice` (20 dB by default) as the clip `gain`; a hit may sit 3 to 6 dB over the music bed, never over the voice.
- Leave at least two real silences before the peak of a film. Never put a noise whoosh on every transition.
- You cannot listen: check the result's `peakDb` and `rmsDb`, and look at the export with `frameshell review` ([critique.md](critique.md)).
