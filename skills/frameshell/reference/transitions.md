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
- A fade is whole frames (33 ms at 30 fps). For a shorter sound ramp, such as a 12 ms de-click on a cut inside a take, use `clip set <clip> --audio-fade-in 12 --audio-fade-out 12` (milliseconds, media clips, sound only): sample-accurate in export and preview, at most half the clip, none at an edge a dissolve crossfades. It multiplies with a fade; `0` removes it; `clip split` drops it at the new cut.

## Shaped transitions: pick by cause

A wipe, a push or an iris moves or cuts the picture instead of mixing it. It is stored as the incoming clip's `dissolve` plus `shape`, so everything above holds; sound still crossfades.

```sh
frameshell transition set --at 12.5 --kind push                          # the next topic slides in from the right, 0.5 s
frameshell transition set --at 30 --kind wipe --direction down            # the incoming shot is uncovered from the top
frameshell transition set --at 41 --kind iris --origin 0.6,0.2,0.8,0.4    # the next shot opens from the button that just lit up
frameshell transition set --at 55 --kind dip-cut                         # a hard cut, the outgoing frame darkened just before it
```

| Why the picture changes | Kind |
|---|---|
| A new topic at the same level, nothing else added | `push`, in the film's one dominant direction |
| A scan or sweep is already moving on screen | `wipe`, the way it moves |
| Something on screen just lit up (a button, a card) and the next shot is about it | `iris`, from that element |
| A hard cut that needs a beat of weight, without a mix | `dip-cut` |
| Time passes, a mood or a place changes softly | `dissolve` |
| A section opens or closes | `fade` |
| A chapter slam, an impact | hard cut (no transition) |

- `--direction` is the way the incoming picture travels: `left` (default, it enters from the right edge), `right`, `up` (enters from the bottom), `down`. Keep one dominant direction per film. Only `wipe` and `push` take it.
- `--origin x0,y0,x1,y1` is the element an iris opens from, in fractions of the frame (0 to 1, x0 <= x1, y0 <= y1): a circle grows from its centre until it covers the frame. Take it from `frameshell inspect --at <s> --point x,y`: a photo mask's `frameBox` (`--segment`) as it is; a generated clip element's `box` (`x`, `y`, `width`, `height` in project pixels, for a clip that fills the frame) as `x/W, y/H, (x+width)/W, (y+height)/H` of the project size; or the point itself, `x,y,x,y`. Without it the iris opens from the frame's centre. Only `iris` takes it; fractions keep it right in every format.
- 0.45 to 0.6 s fits most cuts; the default 0.5 s is fine.
- Shapes play on every video track with the edge, like a dissolve; `--track` limits them. On an upper track the shape cuts both clips: the outgoing one shows only where the incoming one does not, over the tracks below, so a title or card can wipe, push or iris off and the next one on. A render's own transparency is kept. Audio tracks crossfade.
- At an edge of a nested timeline clip the shape plays inside it too: on the clip starting its window on its own track, and on its upper tracks (a title inside a nested scene wipes in with the scene, instead of fading in over the outgoing picture).
- The app's clip inspector offers the same kinds at each clip edge (a direction for `wipe` and `push`; `dip-cut` on the bottom track), and the timeline marks each kind; an iris picked there opens from the frame's centre, so set `--origin` yourself when it should open from an element.
- With no spare source around the cut, a shaped transition holds the outgoing clip's last frame or the incoming clip's first (a warning says so) instead of dipping through black. Trim the neighbours less to keep the motion.
- `--kind dissolve` or `fade`, `transition remove`, `clip split` and `cut` on that edge drop the shape.

### Dip cut

`--kind dip-cut` makes the edge a hard cut on the bottom video track and darkens the clip ending there by 40 % over its last 3 frames. It writes two `opacity` keys on that clip (`clip key` keys you can see and edit); `--duration` is ignored. Sound and the other tracks are not touched; naming an upper video track fails (lowering opacity there would show the track below, not black). Running it again writes the same keys. `transition remove` at that edge takes the two keys away; trimming the clip's end moves them to its new last frames, and a split keeps them on the right part.

### Variety rules

- Never three transitions of one kind in a row.
- At most a third of the scene cuts are hard cuts.
- Use 3 to 5 kinds in a film.
- Jump cuts inside one take are not scene cuts: leave them hard.

`transition set` adds a `variety:` warning when the bottom track breaks the first two rules. Read it and change a kind; it never blocks.

## Landing on a moment: markers

A marker names a timeline second the person or you care about: `frameshell marker add --at 12.5 --label hook`. Read them with `frameshell marker list` and use their `at` for a transition or a key (`transition set --at 12.5`, `clip key … --at 12.5`). The person sees them on the lane under the ruler, and clips dragged in the app snap to them.

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
- Set the music's level first (about 12 dB under the voice is a common start), then duck: the dip is relative to the level the clip plays at. `--level 12` does the first step by loudness: it measures the voice (each voice file's EBU R128 loudness plus its gain, averaged by the time it plays) and the music file (both measured once per file and cached), and sets each music clip's static gain so the music sits 12 dB under the voice. A clip with gain keys of its own is left alone and named in the warnings. Run it again after the voice changes.
- The sound is measured at source level: a voice clip turned down with `clip set --gain` still counts as speech. A voice in a nested timeline clip is not heard (`warnings` says which), and a multicam program track cannot be named in `--under` (it is refused): for now the angles and mics of a multicam group cannot be ducked under.
- A voice file that cannot be decoded is named in `warnings`; if ffmpeg cannot be fetched the command fails and changes nothing.
