# Sound effects and music

Short sounds and music beds made offline by Frameshell itself (ADR 0038): no network, no third-party samples, no licence to read. Same arguments, same file. Commands assume the session rule of [SKILL.md](../SKILL.md). Music: [below](#music-bed).

## Make one

```sh
frameshell sound sfx whoosh --variant 2 --seed 5 --json
frameshell sound sfx click --pitch 1.1 --json
frameshell sound sfx riser --length 2.4 --json
```

- **Kinds:** `click`, `tick`, `pop`, `whoosh` (stereo), `riser`, `thump`, `impact`, `shutter`. `--variant 1` to `3` is a different recipe of the kind.
- **`--seed`** (default 0) is a family seed: sounds made with one seed share a timbre, so use one seed per film. Change `--variant` or `--seed` for another take of the same sound: the same whoosh on every cut is the tell of a bad edit.
- **`--pitch`** multiplies every frequency (0.5 to 2). Without it the take gets a seeded pitch between 0.9 and 1.3 and a level within 1.5 dB. **`--length`** is for `whoosh` (0.3 to 2 s) and `riser` (0.8 to 6 s) only.
- The take lands in `assets/sound/<kind>-<key>.wav` (48 kHz, 16-bit, peak about -3 dBFS) and is imported. `sound sfx` puts nothing on a timeline: `sound place` does (below). A take that is already current is `cached` and nothing is written; a file of that name you or the person made by hand is never overwritten (`InvalidOperation`).
- When the project keeps a `credits.json`, the take is recorded there as `own` work (`credited: true`); without one nothing is written, so a project of its own footage gets no export warning. See [credits.md](credits.md).
- MCP: `sound_sfx`.

## Put it on the picture

```sh
frameshell sound place whoosh --at hook,hook+6 --seed 4
frameshell sound place click --at 12.4 --role knock
frameshell sound place whoosh --cuts <track-id> --which 2,5
frameshell sound place tick --typing --from 8 --to 10.5 --rate 7
```

One call is one transaction (`Sound: 2 whoosh`): `revert` undoes it, review mode holds it as one proposal. It makes the take like `sound sfx` (same arguments, same file) and puts it on the audio track `SFX` (made when it is missing; `SFX 2`, `SFX 3` where sounds overlap in time; `--track` names another audio track). MCP: `sound_place`, which also takes several `cues` of different kinds in one call.

- **Where.** `--at` takes seconds or a marker, as every time argument (`hook`, `hook+0.5`, several separated by commas); `--cuts <track>` puts one on the start of every clip after the first of that track, or on the numbered ones (`--which 1,3`, counted from 1); `--typing` makes a run of keys (kind `tick` or `click`, up to 10 a second, jittered, rotating takes) between `--from` and `--to`.
- **Offset.** Every result has **`peakAt`**: the second of the take that must land on the picture (the transient of a hit, the peak of a whoosh, the end of a riser). A sound that builds starts before its cue; its peak, not its start, is on it. The take lands at `cue + offset - peakAt`, the offset by `--role`, in milliseconds (negative = before the picture): tap -60, knock -40, click -11, pop +30, whoosh peak +37, swell peak +42; a riser ends 75 ms before the cue. Without `--role` a kind takes its own (click and shutter `click`, tick `tap`, pop and thump `pop`, whoosh `whoosh`, impact `knock`); `--offset ms` replaces it.
- **Whole frames.** A clip starts on a frame and plays whole frames, so a sound is within half a frame of where asked (at 30 fps the -11 ms of a click is lost). A sound starting before the timeline with nothing left (or under one frame long, below 20 fps) is in `skipped` with the reason, not an error; one that only loses its head is placed with a warning.
- **Gain.** The clip `gain` is minus the style's `sound.sfxUnderVoice` (20 dB by default; see [project-model.md](project-model.md#style)) plus the `--tier`: `primary` 0 (the default for most kinds), `secondary` -4 (shutter), `texture` -8 (tick, typing). `--gain dB` replaces it.
- **Variants.** Without `--variant` the takes of one kind rotate through 1 to 3 along the timeline and across calls, so the same whoosh is not twice in a row; give `--seed` for another family.
- **Warnings** (the call still places everything; fix them with `clip move` or `clip remove`, or `revert` and ask again): more than 2 sounds on one frame; two ticks closer than 66 ms or two pops closer than 114 ms; two keys of a typing run closer than 87 ms once rounded to frames (lower `--rate`); one take twice in a row. They count sounds already on the audio tracks.

## Music bed

```sh
frameshell sound music synthwave --json
frameshell sound music lofi --bars 16 --at intro-end --sections intro:2,full:6,build:2,drop@reveal,outro:2 --accents logo
frameshell sound music minimal --bpm 104 --length 30 --chords Dm,Bb,F,C --seed 3 --no-place --json
```

A track synthesized from a seed: drums, bass, chords, a melody from the minor pentatonic of the first chord. Presets: `synthwave` (118 BPM, Am F C G, saw chords, a kick on every beat), `lofi` (78 BPM, Dm9 G13 Cmaj7 Am7, electric piano, swung hats, vinyl, dark), `minimal` (110 BPM, mallet stabs, plucked bass, metallic hats, no pads). `--bpm` 50 to 180, `--meter` 2 to 7 beats a bar, `--chords` one per bar, repeating. Change `--seed` for another tune with the same settings.

- **Length.** Whole bars: `--bars`, or `--length` seconds (the bars whose end is nearest), else from `--at` to the end of the timeline. The track then ends on a **final hit** (the first chord, a crash and a big kick on the downbeat after the last bar, `hitAt` in the result) and rings 2.5 s. At most 128 bars and 300 s.
- **Parts.** `--sections` lists `kind[:bars][@time]`: `intro`, `full`, `dark` (stripped: under a voice or a busy picture), `build` (a climbing motif, a clap roll and a riser that ends 75 ms before the next part), `gap` (one hit, then silence, so the next downbeat lands hard), `drop` (everything, with a crash on its first beat), `outro` (half time). `@time` (a marker, seconds) starts the part on the nearest bar: put the drop on the hero reveal, about 30 to 60 % into the film. Without it: intro, full, build and drop (from 8 bars), outro. `--accents` adds a crash and a big kick on the nearest beat (a logo, a call to action).
- **What lands.** `assets/sound/music-<preset>-<key>.wav` (48 kHz, 24-bit stereo, -14 LUFS, sample peak at most -1 dBFS) and its **exact beat grid** `beats/sound/music-<preset>-<key>.beats.json` (`detector: exact`, confidence 1): never run `beats measure` on it. Placed (unless `--no-place`) in one transaction `Music: …` on the audio track `Music` (made when missing; `Music 2` when that time is taken; `--track` names one) at `--at` (default 0), gain minus the style's `sound.musicUnderVoice` (12 dB; `--gain` replaces it). When the timeline has no `tempo`, it now follows the new clip, so `--at bar:9`, `beat:17` and `--snap-to beat` work at once; an existing tempo is kept with a warning (`tempo set --clip <id>` to switch).
- **Fit it.** The final hit is a strong onset in the grid: `frameshell music fit <clip> --end end-card` lands it on the end card. Duck it under the voice with `duck`.
- Credits as for effects: recorded as `own` work when the project keeps `credits.json`. MCP: `sound_music` (`sections` as `[{ kind, bars?, at? }]`).
- You cannot listen: read `lufs` and `peakDb`, and listen-check with the person before export. Synthesis reads cheap next to a licensed track for premium work: say so and offer one.

## Taste

- Sound only visible actions: a click on a click, a whoosh on a cut that moves, a tick on typing, a pop on a badge, one riser into one impact per film. About 85 % of cuts get no sound.
- At most 2 sounds on one frame, at most about 2 per 3 seconds, never the same take twice in a row. Rotate 2 or 3 variants and seeds.
- Keep them under the voice: the style's `sound.sfxUnderVoice` (20 dB by default) as the clip `gain`; a hit may sit 3 to 6 dB over the music bed, never over the voice.
- Leave at least two real silences before the peak of a film. Never put a noise whoosh on every transition.
- You cannot listen: check the result's `peakDb` and `rmsDb`, and look at the export with `frameshell review` ([critique.md](critique.md)).
