---
status: accepted
---

# Batch variants: a template timeline patched in memory per data row

#477 (epic #451) asks for `frameshell batch`: one edit, many variants (sizes, languages, product rows), each row setting clip props or swapping assets, every row rendered, and a manifest that lets a failed row be re-run alone. The owner decided option A on 2026-11-11, with every recommendation of the proposed decision accepted (the ten points below). **Slices 1 to 4 are built; the later work (slice 5) is not.**

## Context (verified)

- `ExportService.render` read the timeline file by id, compiled and checked every format with stand-in clip renders and bakes, then queued one `render` job per format. `#resolved` already took an in-memory timeline (`frame` uses it for review-mode proposals).
- The clip render cache key covers type, source, `props`, `elements`, inputs, fps and size, so a row with other props is a new cache entry without a key change, and equal rows share one render. `ClipRenderer.ensure` takes any timeline object.
- Props are an untyped record checked by the adapter's Standard Schema (`clip.set`, `clipTypeInfo`). Typed template props are ADR 0033 slice 2 (#466), not landed.
- No engine operation swaps a media clip's `asset`; only `clip.add` takes one.
- Review mode (ADR 0019) and the journals cover timeline and config files only. Writing one timeline file per variant would bring the watcher, background clip renders, journal entries and one proposal per row.
- The general job queue runs two jobs at once, FIFO, and dedupes a queued or running job of the same kind, project, asset and output. `gc` keeps clip renders while a render or clip job of the project runs.

## Decision

1. **Template = a timeline** of the project (`template`, default `main`). A single generated clip is a one-clip timeline; there is no clip-only mode.
2. **Slots live in the batch file** (`*.batch.json`, `packages/schema/src/batch.ts`, JSON Schema `batch.json`): `slots: { <name>: "<clipId>.props.<dot.path>" | "<clipId>.asset" }`, `rows: [{ id, ...values }]` with ids `[a-z0-9-]`, unique, used as file names, and optional `formats`, `preset`, `quality`. A slot a row leaves out keeps the template's value. Once #466 typed props ship, slot names may default to prop names.
3. **In-memory variants.** Each row's timeline exists only in memory. A props value is written at its path over the clip's props (missing objects created, arrays indexed by number) and applied through the engine's `clip.set` (`TimelineService.applyInMemory`), so the adapter's schema checks it. Nothing is written under `timelines/`, journaled or proposed.
4. **One row at a time** into the general queue as ordinary `render` jobs; no new job kind and no parallel rows in v1. The next row is queued from the job watcher when the last job of the row before ends, so the queue never goes idle between rows (the daemon's idle exit sees it busy), and `gc` treats a project with a running batch as busy.
5. **Asset swap** keeps the clip's in, out and placement and is never retimed. The row fails when the new file lacks the stream the track plays or ends before `out` (with the slack the engine gives a requested out). The file is probed through the same `TimelineService.source` every placing operation uses. Swapped assets reach the ADR 0026 provenance warnings like any placed asset: each entry carries them.
6. **Per-language voiceover:** a row swaps the voiceover asset; when a subtitle track follows that clip's track, the new asset must have a transcript, else the row fails naming it. Batch never calls `voiceover.generate`, so it never spends money. Per-line placement waits for ADR 0034 slice 4.
7. **JSON only** in v1; CSV later.
8. **Bad rows** fail the whole call with InvalidOperation and data `{ op: "batch.render", row, slot, reason }`; errors of the render check keep their code and gain `row`. No new error code.
9. **No gc roots** for the clip renders of done rows in v1: they are regenerable.
10. **Manifest** at `<out>/manifest.json` (default out `<project>/exports/<batch file name>/`): per row × format `status`, `output`, `job`, `error`, `startedAt`, `finishedAt`, `duration`, `warnings`, plus the batch's `state` (`running` left behind means the daemon stopped mid-batch). Written atomically on each job state change. `batch.render` is mutating (idempotency replay like every mutating method), validates every row × format first, queues the first row and returns with the manifest path. Formats come from `frameshell.json` on disk (ADR 0019 §5), never a pending config proposal.

Outputs are `<out>/<row>.<container>`, with `-<format>` before the extension when the batch lists formats (the `render --formats` rule). `ExportService.planRender` is `render` up to the queue: it takes an in-memory timeline and a path stem, and its `start` queues synchronously; `render` is `planRender(...).start()`, so its params and outputs are unchanged.

## Limits in v1

- Slots reach only top-level clips of the template: not clips inside nested timelines, multicam angles, `elements` or per-format props.
- A second `batch.render` into the same `out` (compared after symlinks resolve) while one runs is refused, and so is a batch whose rows would write one output twice (row `a` in format `web-1x1` and row `a-web` in `1x1`).
- Props paths and slot names may not use `__proto__`, `prototype` or `constructor`.
- An asset swap does not rewrite the `phrases` of a subtitle track that follows the clip: they keep the template asset's word ids, so the new asset's words fall back to the style's grouping.
- No call cancels a whole batch: later rows are not queued yet, so `job.cancel` on a row's job skips that row and the next one starts.
- Variant clip renders are cache entries no timeline keys, so `gc` removes them once no batch runs; a re-run renders them again.

## Slices

1. Schema, planner and validation, `--dry-run`. Built.
2. Render driver, manifest, MCP tool from the registry, protocol bump, short skill mention. Built.
3. Re-run: `--rows`, `--failed` (including rows left `queued` or `running` by a daemon exit), `--force`. Built, see below.
4. Skill: when to batch, the monetisation caution from #477, per-language rows, never paid generation from batch. Built: `skills/frameshell/reference/batch.md`.
5. Later: #466 typed props, a #457 review column, ADR 0034 per-line placement, CSV.

## Re-runs (slice 3, as built)

`batch.render` takes `rows`, `failed` and `force` beside `file`, `out`, `formats` and `dryRun`; the CLI flags are `--rows`, `--failed`, `--force`.

- **Choosing.** `rows` is a list of row ids or `first..last` ranges (both ends in, the file's order; ids never hold `.`); the call fails with InvalidOperation `{ row, reason: "unknown row", field: "rows" }` for an id the file lacks and for a reversed range. `failed` keeps the chosen rows (default every row) that have no manifest entry yet or an entry that is not `done`. It reads `<out>/manifest.json` and is refused (InvalidOperation, `field: "failed"`) when there is none, it is not a valid manifest or it names another batch file; a plain run ignores such a manifest.
- **Skipping.** A chosen row is skipped, and listed in the result's `skipped`, when the manifest has a `done` entry for each output the row would write and every file exists; `force` renders it anyway. This applies to a plain run too, so after editing a row or the template the person passes `force` (the manifest holds no hash of the data, so a changed row is not detected). A row whose file was deleted renders again.
- **Only chosen rows are planned.** The rows a call does not render are neither validated nor compiled, so a bad row elsewhere does not block re-running one failed row. A skipped row is still planned, to learn its outputs before comparing them with the manifest, and its outputs count in the clash check; the entries of rows left alone count too.
- **Manifest merge.** The new manifest holds every row of the file that has entries, in file order: freshly queued entries for the rendered rows, the earlier ones for the rest. Entries of rows the file no longer has are dropped. An earlier entry left `queued`, `running` or `planned` by a stopped daemon is rewritten as `canceled` with the error "The daemon stopped before this render ended." in the rows the call leaves alone (`failed` picks it up like any not-done entry); `state` is `done` once every entry this run queued ended. A call with nothing left to render queues no job, writes no manifest and returns the existing entries; `preset` is null when no row was chosen.
- **Wire.** Protocol 118: params `rows`, `failed`, `force`; result `skipped`, and `preset` nullable. The CLI waits only for the renders the call queued and exits 1 only if one of those failed.

## Skill (slice 4, as built)

`skills/frameshell/reference/batch.md` says when to batch (data varies, structure does not) and when not (different timing or structure per row; a longer swapped take never lengthens the video), carries the monetisation caution of the owner's comment on #477 (episodes need an original story, voice and visuals each time; batch is for sizes, languages and product rows, and the agent says so before building a template-filled series), explains the batch file, the manifest and re-runs, and per-language rows (swap the voiceover take, transcribe it first when captions follow it, never `voiceover.generate` from batch).

## Rejected

- **A timeline file per row** (option B): watcher, background renders, journal entries and one review-mode proposal per row, and cleanup left to the person.
- **A project copy per row** (C): duplicated media or links, cold caches, per-project plugin trust.
- **Clip-only batch** (D): no footage, sound or subtitles per row, and a second export path; a one-clip timeline covers it.
