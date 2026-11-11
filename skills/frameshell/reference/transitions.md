# Transitions and keyframes

Everything is optional and has a default. A project without them is unchanged.

## Transitions

A transition belongs to a clip edge; clips stay where they are and the timeline length never changes.

```sh
frameshell transition set --at 12.5                              # dissolve into the clip starting at 12.5, 0.5 s
frameshell transition set --at 58 --kind fade --duration 1       # fade the last clip out over its final second
frameshell transition remove --at 12.5
```

- With only `--at`, it applies to that edge on every video and audio track that has one (sound crossfades). `--track <track>` (repeatable) limits it. Multicam program tracks are skipped with a warning: shots cut hard.
- `--kind dissolve` (default) mixes the two clips; `--kind fade` dips through black. A clip's start or end with nothing butted to it fades in or out for either kind.
- A dissolve is centered on the cut and borrows source before the incoming clip's `in` and after the outgoing clip's `out`. With little to borrow it shortens, or plays as a dip; nothing fails, and `warnings` says what plays. Read them: trim the neighbours less, or ask for a shorter `--duration`.
- A later `clip move`, `cut` or `clip trim` that leaves a dissolve without a clip before it adds a warning (it plays as a fade in until the clips butt again).
- `clip split` gives the left part the dissolve and fade in, the right part the fade out; the new cut has none.

## Keyframes

```sh
frameshell clip key <clip> --prop scale --at 10 --value 1       # slow zoom: two keys
frameshell clip key <clip> --prop scale --at 20 --value 1.2
```

- `--prop` is `x`, `y`, `scale`, `opacity` or `gain` (audio tracks take only `gain`). `--at` is timeline seconds inside the clip; `--value` defaults to what plays there now.
- Between keys the value moves in a straight line, or by the leaving key's `--ease in|out|in-out`; it holds before the first and after the last. A keyed property ignores its static value (`clip set`).
- A key in the same frame is replaced. `--remove` deletes the key at `--at`; `--clear` deletes every key of `--prop`.
- Keys stay on the same frames of the clip's picture through trim, split and cut.

## Reframe to vertical

```sh
frameshell clip reframe <clip>                      # 9x16 around the largest face
frameshell clip reframe <clip> --person Ana         # that person's face, from `people scan`
frameshell clip reframe <clip> --anchor 0.3         # no face: fixed horizontal position, 0 left edge, 1 right edge
```

- It writes `scale` (the cover scale, static) and `x`/`y` (keys where the face moves, static where it holds) in one transaction; `revert <tx>` undoes it, and `clip key` or the inspector edit the keys after. It replaces the clip's own `x`, `y` and `scale`.
- The face lands centered, 30 % from the top, and the frame never shows outside the picture. Rotation metadata is applied first: a phone's portrait clip needs no more than the headroom.
- Read `faces` against `samples` and every `warning:`. No face found leaves the clip as it was: look at a frame (`frame --at <s> --out <file.png>`), find where the speaker stands, pass `--anchor`.
- In a 16:9 project the preview shows the clip zoomed; the framing shows in a `vertical-1080x1920` export (`frame --preset vertical-1080x1920` to check).

## Music under a voice

```sh
frameshell duck <music track> --under <voice track>                # 7 dB down while someone speaks
frameshell duck <music track> --under <voice> --under <other> --depth 9 --release 600
```

`duck` listens to the sound of the `--under` tracks (video or audio, muted tracks and clips ignored) and writes `gain` keys on every clip of the audio track `<track>`: the clip's level minus the dip, which is complete when the voice starts (`--attack`, ms) and lets go `--release` ms after it ends. Speech is sound above `--threshold` dBFS (default -38; negative values need the `=`: `--threshold=-40`); stretches closer than `--gap` seconds (default 0.6) merge, so the music does not pump between words. The MCP tool is `track_duck`.

- The keys are ordinary gain keys marked `auto: "duck"`: the person sees and edits them in the clip, preview and export play them. Run it again after a cut, a move or a retake and it replaces its own keys, keeps the ones set by hand (`clip key` clears the mark of a key it sets), and a clip no voice reaches loses its old ones.
- A hand-set gain key defines the level the dip is taken from, and a lane holds its first key back to the clip start: one key at 30 s of `-3` makes the whole clip sit at -3 dB first. A hand key where someone speaks is dipped too (the next run puts its level back and dips it again). Set the level of the music with `clip set --gain` (no keys) or key it deliberately.
- Editing a duck key (`clip key` on it) makes it a hand key: its value is now a level, and the next run dips it where a voice speaks. To lift the music under a voice, run it again with a lower `--depth`.
- Set the music's level first (about 12 dB under the voice is a common start), then duck: the dip is relative to the level the clip plays at.
- The sound is measured at source level: a voice clip turned down with `clip set --gain` still counts as speech. A voice in a nested timeline clip is not heard (`warnings` says which), and a multicam program track cannot be named in `--under` (it is refused): for now the angles and mics of a multicam group cannot be ducked under.
- A voice file that cannot be decoded is named in `warnings`; if ffmpeg cannot be fetched the command fails and changes nothing.
