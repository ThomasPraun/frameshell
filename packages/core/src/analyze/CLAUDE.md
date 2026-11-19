# Reference analysis (`analyze`, #471)

- Files: `shots.ts` + `palette.ts` + `look.ts` + `rhythm.ts` + `events.ts` + `speech.ts` + `pitch.ts` + `audio.ts` + `curve.ts` + `ink.ts` + `lip.ts` + `align.ts` + `correlate.ts` pure; `lip-run.ts`, `diff.ts`, `activity.ts`, `picture.ts` = the one frame pass, `loudness.ts`, `scene.ts`, `service.ts`. `BeatsStore.measureAudio` in `media/beats-store.ts`. Wire `packages/protocol/src/analyze.ts` (result typed by hand: TS7056). CLI `packages/cli/src/analyze-commands.ts`. MCP `withSheets` in `packages/mcp/src/server.ts`. Skill `skills/frameshell/reference/reference-video.md`.
- MEASURED/ESTIMATED/DECISION `labels` on every value; tables in `protocol/src/analyze.ts`. Add a key for every new field; test walks result.
- Rhythm constants = one scale with `review` #457 metrics: reuse, never copy (`packages/core/src/CLAUDE.md`).
- Mouth sync: box of the file's `people scan`, made on demand by `AnalyzeServiceOptions.scanFaces` when none is cached; `faces: false` / `--no-faces` skips; no landmarks cached.
- `analyze.diff`: activity alignment, SSIM, side-by-side sheet (`diff.ts`, `align.ts`).
- Style `suggestions` (`suggest.ts` pure) never applied by analyze. Apply only via `style.apply` `analysis` = config journal (ADR 0028 slice 4).
- Tempo by the `beats` detector on a file outside the asset store.
- Audio (`audio.ts` pure): sentences from the project's transcription via `AnalyzeServiceOptions.transcribe`; YIN pitch `pitch.ts`; effects = `soundHits` minus words and beats; all ESTIMATED, never stems.
- Sheets reuse `review/images.ts` + `plan.ts`, never copy.
- Output into `.frameshell/analysis/<name>/`, replaced by a run of the same name. Times = frame / fps rounded down `frameStart`. Job kind `analyze`.
