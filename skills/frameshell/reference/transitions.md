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

## Shaped transitions: pick by cause

A wipe or a push moves the picture instead of mixing it. It is stored as the incoming clip's `dissolve` plus `shape`, so everything above holds; sound still crossfades.

```sh
frameshell transition set --at 12.5 --kind push                  # the next topic slides in from the right, 0.5 s
frameshell transition set --at 30 --kind wipe --direction down    # the incoming shot is uncovered from the top
```

| Why the picture changes | Kind |
|---|---|
| A new topic at the same level, nothing else added | `push`, in the film's one dominant direction |
| A scan or sweep is already moving on screen | `wipe`, the way it moves |
| Time passes, a mood or a place changes softly | `dissolve` |
| A section opens or closes | `fade` |
| A chapter slam, an impact | hard cut (no transition) |

- `--direction` is the way the incoming picture travels: `left` (default, it enters from the right edge), `right`, `up` (enters from the bottom), `down`. Keep one dominant direction per film.
- 0.45 to 0.6 s fits most cuts; the default 0.5 s is fine.
- Shapes play on the bottom video track only for now: naming an upper video track in `--track` fails, and without `--track` upper tracks are skipped with a warning. Audio tracks crossfade.
- With no spare source around the cut, a shaped transition holds the outgoing clip's last frame or the incoming clip's first (a warning says so) instead of dipping through black. Trim the neighbours less to keep the motion.
- `--kind dissolve` or `fade`, `transition remove`, `clip split` and `cut` on that edge drop the shape.

### Variety rules

- Never three transitions of one kind in a row.
- At most a third of the scene cuts are hard cuts.
- Use 3 to 5 kinds in a film.
- Jump cuts inside one take are not scene cuts: leave them hard.

`transition set` adds a `variety:` warning when the bottom track breaks the first two rules. Read it and change a kind; it never blocks.

## Keyframes

```sh
frameshell clip key <clip> --prop scale --at 10 --value 1       # slow zoom: two keys
frameshell clip key <clip> --prop scale --at 20 --value 1.2
```

- `--prop` is `x`, `y`, `scale`, `opacity` or `gain` (audio tracks take only `gain`). `--at` is timeline seconds inside the clip; `--value` defaults to what plays there now.
- Between keys the value moves in a straight line, or by the leaving key's `--ease in|out|in-out`; it holds before the first and after the last. A keyed property ignores its static value (`clip set`).
- A key in the same frame is replaced. `--remove` deletes the key at `--at`; `--clear` deletes every key of `--prop`.
- Keys stay on the same frames of the clip's picture through trim, split and cut.
