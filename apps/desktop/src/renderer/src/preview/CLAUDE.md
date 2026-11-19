# Preview player

Program, engine worker, audio worklet, playhead store (`transport.ts`), clip render decode. ADR 0001, 0002. Media URLs `apps/desktop/src/main/media-protocol.ts`. Evaluators shared with export: root Shared truths (parity tests in `apps/desktop/test/preview-*.test.ts`).

## Rules

- `video-source.ts` = proxy or render. `drop-log.ts` = dropped frames starved vs cadence; CI fails on starved only.
- Multicam shots: one layer + decoder per angle slot.
- Grade: `grade.ts`, WebGL2 `GradePass` in engine worker; tables made in renderer `useGradeTables` (`useGradeTables.ts`); span key `tableKey` (`program.ts`) = new key per new table (edited LUT); player sends each table once `withNewTables`.
- Vignette in the grade WebGL2 pass. Grain: hash lattice in same pass, matched to export by `grainSpread`, not pixels; TS twin of shader grain `grain.ts`. e2e `vignette-preview.spec.ts`, `grain-preview.spec.ts`.
- Letterbox overlay: `letterboxOverlay` in `program.ts`, `LetterboxBars` in `components/PreviewPanel.tsx`.
- Audio effects: preview plays bake as sidecar (`useAudioBakes.ts`, `ProgramOptions.bakes` in `program.ts`). Glass: `backdrop.ts` (`BackdropPass`).
- Subject matte (ADR 0032): internal `matte.status` queues mattes. Subject span = plate layer's decoded frame (`sharesLayer`, never its grade output) + matte alone on alpha decoder; own proxy decoder only where source frames differ (MX2); same windows + base-plate shapes as export. Files `subjectPicture`/`inSubjectWindows`/`sharesPlateFrame` in `program.ts`, `sourceFrameAt` in `decode-plan.ts`, `mattedSource`/`matteOnlySource` in `video-source.ts`, `#sharedFrame` in `engine.worker.ts`; `useSubjectMattes.ts` (`useMatteStatus` = one `matte.status` poll per view); e2e decoder counts `subject-preview.spec.ts`.
- Transitions: `pictureLayers`, `spanPlacement`, `spanShape` in `program.ts`; `#composite` in `engine.worker.ts`.
- Formats: `viewsInFormat`, `useProjectFormats` in `useProgram.ts`; `cover` in `program.ts`. Edit in format from preview handles + inspector.

## Areas

| Working on | Read |
|---|---|
| Live preview of generated clips (iframe, topmost-layer rule; ADR 0010) | `live.ts`, `components/LivePreview.tsx`; main `apps/desktop/src/main/live-protocol.ts` |
| Element mode (double-click a generated clip, drag/scale composition elements, engine layer skip, hold until new render, inspector list; ADR 0021) | `components/ElementLayer.tsx`, `element-edit.ts` (pure geometry), `element-mode.ts`, `pick-pages.ts` |
| Pick in photos (prepare on Pick, mask outline, ↑/↓ size, "Cut out as layer"; ADR 0022) | `segment-pick.ts`, `cut-out.ts`, `components/PickLayer.tsx`; e2e daemon `FRAMESHELL_SEGMENT_STAND_IN=1` |
| Layer handles | `transform-edit.ts` |
