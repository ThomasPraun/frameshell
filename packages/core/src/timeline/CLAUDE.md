# Timeline (engine, service, time references, tempo, markers, direct edits)

| Working on | Read |
|---|---|
| Operations (engine, inverses, invariants, CLI verbs; ADR 0004) | `engine.ts`, `service.ts`; CLI `packages/cli/src/timeline-commands.ts` |
| Time references (ADR 0029 decision 7 + slice 4, ADR 0037) | `time-ref.ts` (`resolveTimeRefs`, `SCHEMES`, `resolveTimeRefArg`), called by `normalizeArgs` in `service.ts` (`wordsOf` option); `packages/core/src/transcripts/timeline-words.ts`; `TIME_REF_FIELDS` + `ResolvedOperationArgs` in `packages/protocol/src/timeline.ts`; CLI `when()` |
| Tempo + grid (ADR 0029 slice 3) | `TempoSchema` in `packages/schema/src/timeline.ts`; `tempo.ts` (`tempoGrid`, `snapRequest`); engine `tempoSet`/`clearOrphanTempo`; `patch.ts` + `history/revert.ts` key `tempo`; `media/beats-watcher.ts`; `operate`/`gridOf` in `daemon.ts`; CLI `tempo` + `snapTo()`; app grid: `apps/desktop/CLAUDE.md` |
| Markers (ADR 0029: `marker.*` ops, `cut`/ripple rule, patch + review keys) | `MarkerSchema` in `packages/schema/src/timeline.ts`; engine `markerAdd`/`cutMarkers`/`trimMarkers`/`rippleMarkers`, `patch.ts`; `history/revert.ts` keys |
| Direct timeline file edits (watcher, stale/invalid rejection, `.frameshell/rejected/`, offline-edit catch-up; SPEC §6.4) | `TimelineService.reconcile` in `service.ts`, `watcher.ts`, `rejections.ts` |
| Multicam model (groups, angles, program track, shots: invariants; SPEC §5.3, ADR 0016) | `packages/schema/src/timeline.ts`; engine `checkShots`, `shotAdd`; shot layout + sound in `composite.ts` (root Shared truths) |
| Engine setters of other areas | transitions `transitionSet`/`warnVariety`/`clipKey`, dip cut `dipCut`/`dipKeyIndexes` (ADR 0018, 0030); formats `clipSetInFormat`, `writeFormatKeys`; finish `letterboxSet`, `setVignette`, `setGrain`; elements `setElements`; motion blur `setMotionBlur`; matte `setBehind`/`clearStaleBehind`; music `musicShape` + `duckLane`/`restoredKeys` |

## Rules

- TimeRef = seconds or marker id/label + `±s` offset; `beat:`/`bar:` grid via `GridLoader`; `word:<text>[#n]` built via `WordLoader`. Resolved in daemon before engine; journal keeps seconds.
- `snapTo`/`--snap-to beat|bar|marker` resolved in daemon `operate` before engine; refuse LOW grid.
- `tempo` = music clip's beats file through clip start/in/speed, or nominal BPM. `tempo.set`/`tempo.show`. `beats/` watcher sends `beats.changed`; app reads timelines again.
- Shaped transitions: any video track; nested clip shape reaches its tracks via `NestHost.shapeIn`/`hostShapes`; variety warning. No transitions in image projects.
