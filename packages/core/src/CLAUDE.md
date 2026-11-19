# Core (daemon)

Area files: `media/`, `timeline/`, `export/`, `batch/`, `clips/`, `review/`, `analyze/`, `music/`, `sound/`, `people/`, `transcripts/`, `voiceover/`, `matte/`, `brand/` (each has a `CLAUDE.md`). Test flags: `packages/core/test/CLAUDE.md`.

## Rules (one helper per job: reuse, never copy)

- Every config write via `ConfigJournal` (`config/`), never direct. Every config change via `changeConfig`. ADR 0036.
- Worker threads: one-shot runner `worker-task.ts`, one ONNX Runtime Web loader `onnx-web.ts`, one cosine/mean `people/vector.ts`: reuse, never copy. Long-lived request/reply worker = `segment/engine.ts`.
- One FFT `fft.ts`: reuse (beats, spectrogram).
- Loudness: reuse `LoudnessStore` (`media/loudness-store.ts`), never measure twice.
- `wavBytes` (`transcripts/window.ts`) writes any WAV: reuse, never copy.
- Words on timeline clock: one placer `placeWords` (`transcripts/timeline-words.ts`), shared by cleanup, TimeRef `word:`, generated clips (`wordsOf`); never a second placer.
- Tempo grid: ONE place computes the grid on the timeline clock, `timeline/tempo.ts` (`tempoGrid`, `snapRequest`); never a second grid builder.
- Picture rhythm: still/big-change/burst constants + functions only from `analyze/rhythm.ts`: one scale for `analyze` + `review`, never a review copy. One grey `greyOf` + `pictureFilter` (`analyze/picture.ts`); never ffmpeg `format=gray`.
- Global config `configDir` `config.json`: one reader `readGlobalConfig` (`global-config.ts`), shared by binary overrides + `speech.command`.
- Providers (`SpeechProvider` contract + `contributes.speechProviders`): one host lookup for transcription + speech providers (`#provider` in `plugins/host.ts`); built-in providers before plugins.
- Transcription callers (ADR 0046): consent gate `confirmTranscription` in `transcribe` only, every run. Every other caller (analyze, shoot takes, voiceover verify, ...) loads via daemon `localTranscription` (`requireLocalTranscription`), never `plugins.transcriptionProvider` directly. Detail: `transcripts/CLAUDE.md`.
- `daemon.ts` handler or call into area X: read X's `CLAUDE.md` first; daemon-side rules live there (refuse LOW grid in `operate`: `timeline/`; render `matte` step: `matte/`; `duckPlanner`/`levelAgainStep`: `music/`; `speech.command` never in `frameshell.json`: `voiceover/`).
- ffmpeg rawvideo reader `media/raw-frames.ts`: shared by matte + faces.

## Areas without own file

| Working on | Read |
|---|---|
| Cache cleanup (`gc`: unused derived media, clip renders, temps; sweep on open) | `gc.ts`; `MediaService.gc`, `ClipRenderer.gc` |
| Job queue (clip queue priority interactive/background + starvation limit, `job.cancel`: ADR 0035 d6) | `jobs/queue.ts`; CLI `packages/cli/src/job-commands.ts` |
| History, transactions, revert (journal, grouping, conflicts) | `history/`; diff `history/diff.ts`; SPEC §6.2 |
| Project config journal (`project.config.jsonl`, keyed ops `format:<id>`, legacy lines read not migrated, `planConfigRevert`, config in `history`/`revert`/`tx abort`; ADR 0036) | `config/` (hand edits of `frameshell.json` formats + `style.json`: `direct-edits.ts`, head snapshot, `TimelineService.directConfigEdit`); `FormatService` in `formats.ts`; `revertConfig` in `daemon.ts` |
| Formats (`formats` in `frameshell.json`, primary = `resolution`; `format.*` journal; renders per format, `gc` keeps all declared; ADR 0027) | `formats.ts` (`format.*`); evaluator: root Shared truths |
| Review mode core (switch in `configDir/review.json`, one proposal per tx, route of non-`ui` changes, rebase/stale, accept/reject/wait, direct edits as proposals, `view` on reads; `ui`-only methods checked in daemon; ADR 0019) | `timeline/service.ts` (`#route`, `#propose`, `#sync`, `changeConfig`, `#syncConfig`, `acceptProposal`), `proposals/store.ts`, `proposals/review-switch.ts`; `onClosed` in `history/transactions.ts`; `onlyUi`, `viewOf` in `daemon.ts`; wire `packages/protocol/src/proposals.ts` |
| Plugin host, install, trust; npm the app bundles for machines without Node | `plugins/host.ts`, `plugins/npm-runtime.ts`, `apps/desktop/scripts/bundle-npm.mjs`; author API `packages/plugin-api` |
| Cleanup (`cleanup`: pauses + retakes from transcript words and audio energy, candidates, `--dry-run`, one tx; #455) | `cleanup/` (`plan.ts` pure, `speech.ts` kept words + sound on timeline clock, `run.ts`), handler `cleanup` in `daemon.ts`; wire `packages/protocol/src/cleanup.ts`; CLI `cleanup` in `packages/cli/src/timeline-commands.ts` |
| Reframe one clip to vertical (`clip.reframe`: cover scale + face-following x/y keys, person/anchor modes, sampling `range`; reuses multicam face keys; epic #451) | `reframe.ts` (pure geometry), `clip.reframe` in `daemon.ts`, `sampleFaceFrames`/`proposeReframeKeys` in `multicam/faces.ts`, `PeopleService.faceTrack`; CLI `clip reframe` in `packages/cli/src/timeline-commands.ts` |
| Face reframe (`multicam faces`: YuNet keys, worker thread, `faces` job; ONNX Runtime Web = binary manager `module` kind) | `multicam/faces.ts`, `multicam/faces-worker.ts`; `binaries/manifest.ts`; `docs/binaries.md` |
| H.264 encoder choice (probe VideoToolbox/NVENC/x264 once per machine, cache `encoders.json`, tiers draft/final/master/preview, `render --quality`, doctor speed class + disk estimate) | `encoders/` (`tiers.ts` pure settings, `probe.ts` probe + cache, `profile.ts`); `testEncode` in `binaries/probe.ts` = the one test encode (codec list reuses it); `encode` in `RenderInput` (`export/compiler.ts`); `docs/binaries.md` |
| Photo segmentation (MobileSAM pins, worker, embedding cache, idle free, `segment.prepare`, click to 3 masks, `image.cutout` crop + placement, one tx; ADR 0022) | `segment/` (`segmenter.ts` math + cache, `engine.ts` worker, `service.ts` photo read, `cutout.ts`, `stand-in.ts`); `docs/binaries.md` "Photo segmentation"; app Pick: `apps/desktop/src/renderer/src/preview/CLAUDE.md` |
| Grade analysis + compare (`grade.analyze` = `signalstats` levels + bounded suggestion, reads only; `grade.compare` = looks on one frame via `ExportService.frame` + `writeSheet`, never edits; `look:` in a compare look; ADR 0031) | `grade/` (`levels.ts` parse, `suggest.ts` pure targets in `SUGGEST`, `analyze.ts` ffmpeg, `compare.ts` `resolveLooks`); wire `packages/protocol/src/grade.ts`; looks table: root Shared truths |
| Asset provenance + credits (`credits.json` root ledger; entry on `import --source-url/--licence/--author` or `credits set`; `credits.check` verdict, unverified never pass; credit line derived; `render` warning only once ledger has entry; ADR 0026) | `packages/schema/src/credits.ts` (model, `licenceInfo`, `creditLine`), `credits/service.ts`, `timelineRefs` in `file-uses.ts`; wire `packages/protocol/src/credits.ts`; CLI `packages/cli/src/credits-commands.ts`; skill `skills/frameshell/reference/credits.md` |
| Style guide (`style.json`: schema, unit checks, 5 motion personalities, `resolveStyle` value + source, `STYLE_PATHS`; every write = `style` config doc of ADR 0036, never a second path; user styles `configDir/styles/`, `style set/apply/save/list`; token sheet into generated clips `styleTokenCss`; ADR 0028) | `packages/schema/src/style.ts`, `packages/schema/src/style-tokens.ts`; `style/` (`doc.ts` keyed doc, `service.ts`, `read.ts`, `tokens.ts`, `captions.ts`); `packages/cli/src/style-commands.ts` |
| Scripts (outline parser, slugs, scriptRef check; shoot script lines, speakers, cues, `script.check`) | `packages/schema/src/script.ts` (`parseShootScript`), `scripts/outline.ts` (`plannedSpan`), `scripts/check.ts` |
| Shoot / Rodaje (ADR 0023, 0024: shoot script conventions, takes, deviations, assembly; shoot session = one multicam group; not `multicam direct`) | spike numbers `docs/research/shoot-capture.md`; app capture: `apps/desktop/CLAUDE.md` |
| Shoot session takes (T/C ranges of a session; `shoot.session.cut` job: range of `.part` (finished file once End renamed it) → PCM → transcribe → words `.frameshell/shoot/takes/`; `shoot.session.end`: re-run takes without words, transcripts + group on shoot timeline + takes as shots) | `shoot/session.ts`, `shoot/service.ts` (`#sessionSource`), `shoot/assemble.ts` (shots); engine `shotAdd`; stand-in `FRAMESHELL_SHOOT_STAND_IN=1` |
| Agent targets + inboxes outside app (ADR 0025: `target.*`/`inbox.*`, MCP registers on `initialize`, `frameshell ask --take/--wait`; `claude-code` = target `claude`) | `targets/inbox.ts`, `packages/protocol/src/targets.ts`, `clientAgentLabel` in `packages/protocol/src/agents.ts`; `DaemonLink.register` in `packages/mcp/src/server.ts`; `packages/cli/src/ask-command.ts`; app: `apps/desktop/CLAUDE.md`; `docs/mcp.md` |
| Daemon events, new daemon method | `packages/protocol/src/CLAUDE.md`; `events.ts` |
| Headless Chrome pages (`inspect.point`, `clip verify`, 3D SwiftShader flag) | `inspect/live-page.ts`, `inspect/chrome.ts` |
| File uses (`file.uses`: what references a file, for Move to Trash + credits) | `file-uses.ts` |
