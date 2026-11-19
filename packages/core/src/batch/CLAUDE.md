# Batch variants (ADR 0040)

- Files: `packages/schema/src/batch.ts`; `variant.ts` slots, `service.ts` driver + manifest + re-run merge + cancel, `select.ts` rows/failed choice; `ExportService.planRender`, `TimelineService.declaredProps`.
- `*.batch.json` rows patched in memory, never under `timelines/`. One row at a time into queue.
- `manifest.json` with row-data `hash`: changed row re-renders, no `--force`. `batch.cancel`.
- Unknown prop slot refused via `ClipAdapter.declaredProps`.
