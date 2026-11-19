# People (ADR 0020)

| Working on | Read |
|---|---|
| Model (`people.json`: links, `missing`, speaker name written into transcripts, confirm; review mode does not hold it) | `packages/schema/src/people.ts`, `service.ts`, `packages/protocol/src/people.ts`; CLI `packages/cli/src/people-commands.ts`; acceptance `docs/acceptance/people.md` |
| Threshold tuning `people tune` | `tuning.ts`, `PeopleService.tune`; results `docs/research/people-acceptance-run.md` |
| Voice prints + speaker suggestions (fbank port of sherpa-onnx, CAM++ worker, cache, thresholds) | `fbank.ts` (reference `packages/core/test/fixtures/fbank-reference.json`), `voice-embed.ts`, `voices.ts`, `suggest.ts`; `docs/binaries.md` CAM++ |
| Face clusters + face, face-speaker, angle suggestions; people ranges | `face-clusters.ts`, `face-suggest.ts`, `angle-suggest.ts`, `ranges.ts` |
| Face scan (`people scan`: YuNet landmarks, SFace prints, face tracks, `people` job, cache `.frameshell/people/`, gc) | `scan.ts` (models + tracker, worker `scan-worker.ts`), `scan-run.ts` (job body), `scan-cache.ts` (cache format) |
| App panel | `apps/desktop/CLAUDE.md` |

## Rules

- `people tune` = read-only: replays confirmed links; never sets a constant.
