# Music (fit, candidates, duck level, shape; ADR 0037)

| Working on | Read |
|---|---|
| Fit a track to the cut (`music.fit`: final hit on the energy envelope, slide or `--exact` varispeed within ±1.7 %, duck again, dry run) | `hit.ts` + `fit.ts` pure, `run.ts` plan, write in `daemon.ts`; `timeline/time-ref.ts` (`resolveTimeRefArg`); CLI `music fit` in `packages/cli/src/timeline-commands.ts`; `skills/frameshell/reference/music.md` |
| Candidate tracks at one loudness, `duck --level`, `audio.duck` settings | `run.ts` fit, `candidates.ts`, `pick.ts` = `music.pick`; `media/loudness-store.ts`, `media/loudness-plan.ts` (`planLevels`); `duckPlanner` + `writeSteps` in `daemon.ts` |
| Steps down before a hit, ending fade (`music.shape`, slice 4) | `shape.ts` (pure curve), `shape-run.ts` (plan); `musicShape` + `duckLane`/`restoredKeys` in `timeline/engine.ts`; `duckAgainStep` in `daemon.ts` |

## Rules

- `music.pick` keeps one candidate track, removes the rest. One candidate rule `CANDIDATE_TRACK_NAME`.
- `duck --level` = number or `"style"` (`sound.musicUnderVoice`). Level re-applied by fit/shape/grid (`levelAgainStep`).
- `music.shape` writes `auto: "music"` gain keys + `audio.shape`; duck + fit run again.
