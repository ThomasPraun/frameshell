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
