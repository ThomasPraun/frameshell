# Frameshell

IDE for video. Agent edits project from terminal, human corrects in timeline. Open source, Apache 2.0.
Status: walking skeleton. pnpm monorepo: `packages/{schema,protocol,core,cli,mcp,plugin-api}`, `plugins/{whisper-cpp,hyperframes}`, `apps/desktop` (Electron). Node >= 22.

## Doc map

| Working on | Read |
|---|---|
| Anything (architecture, data model, CLI, plugins, MVP) | `docs/SPEC.md` |
| Domain terms | `GLOSSARY.md` |
| Past decisions and why | `docs/adr/` |
| Tickets | `docs/agents/issue-tracker.md` |
| Daemon wire protocol (methods, error codes) | `packages/protocol/src/methods.ts`; replay keys of `mutating` methods `packages/core/src/idempotency.ts` |
| Media ingest (proxy recipe, cache, job queue) | `packages/core/src/media/recipe.ts`, `media/service.ts`, `jobs/queue.ts` |
| Cache cleanup (`gc`: unused derived media, clip renders, temps; sweep on open) | `packages/core/src/gc.ts`; `MediaService.gc`, `ClipRenderer.gc` |
| Managed binaries (ffmpeg, whisper.cpp, headless Chrome, models: pins, sources, licences, mirror, re-pin) | `docs/binaries.md` |
| Transcription (transcript file, word ids, audio source, export verify) | `packages/core/src/transcripts/transcriber.ts`, `transcripts/verify.ts` + `align.ts`; provider `plugins/whisper-cpp` |
| Timeline operations (engine, inverses, invariants, CLI verbs) | `packages/core/src/timeline/engine.ts`, `timeline/service.ts`; ADR 0004 |
| Export (compiler, presets, render job, frame capture) | `packages/core/src/export/compiler.ts` (pure, golden tests `packages/core/test/golden/`, regen `UPDATE_GOLDEN=1`), `export/service.ts` |
| History, transactions, revert (journal, grouping, conflicts) | `packages/core/src/history/`; SPEC §6.2 |
| Direct timeline file edits (watcher, stale/invalid rejection, `.frameshell/rejected/`, offline-edit catch-up) | `TimelineService.reconcile` in `packages/core/src/timeline/service.ts`, `timeline/watcher.ts`, `timeline/rejections.ts`; SPEC §6.4 |
| Cut snapping to audio energy (pauses, envelope cache) | `packages/core/src/media/energy.ts`, `media/energy-store.ts`, `timeline/snap.ts`; ADR 0003 |
| Generated clips (render cache, keys, background renders, export layers) | `packages/core/src/clips/renderer.ts`, `clips/cache-key.ts`; adapter `plugins/hyperframes`; SPEC §6.5, ADR 0002 |
| Plugin host, install, trust | `packages/core/src/plugins/host.ts`; author API `packages/plugin-api` |
| Desktop app (IPC surface main/renderer) | `apps/desktop/src/shared/api.ts` |
| Daemon events (subscribe, notifications, reconnect) | `notifications` in `packages/protocol/src/methods.ts`; `packages/core/src/events.ts`; `apps/desktop/src/main/daemon-link.ts` |
| Timeline panel (canvas layout, paint, live updates) | `apps/desktop/src/renderer/src/timeline/` |
| Layer placement + nested flattening (shared by export and preview) | `packages/schema/src/composite.ts` |
| Clip inspector, preview layer handles | `renderer/src/components/ClipInspector.tsx`, `renderer/src/preview/transform-edit.ts` |
| Preview player (program, engine worker, audio worklet, playhead store, clip render decode) | `apps/desktop/src/renderer/src/preview/` (`video-source.ts` = proxy or render); ADR 0001, 0002; media URLs `apps/desktop/src/main/media-protocol.ts` |
| Preview ADR 0001 thresholds (real app, opt-in, ~20 min) | `FRAMESHELL_PREVIEW_MEASURE=1 pnpm --filter @frameshell/desktop exec playwright test preview-thresholds`; results `docs/research/preview-playback-measurements.md` |
| Desktop selection (shared store, extend, never duplicate); playhead = `preview/transport.ts` | `apps/desktop/src/renderer/src/selection.ts` |
| Timeline editing (gestures, keys, undo/redo) | `renderer/src/timeline/edit.ts`; main `src/main/timeline-editor.ts` |
| Agent-labelled terminals (detection, `session.tag`, `agent:<label>:<session>` author, `FRAMESHELL_AGENT`) | `apps/desktop/src/main/agent-detect.ts`, `main/terminals.ts`; `packages/protocol/src/agents.ts`; SPEC §6.2 |
| History panel (list, diff marks, revert from UI) | `renderer/src/history/`, `components/HistoryPanel.tsx`; core `history/diff.ts` |
| Transcript view (struck words, restore op, word selection) | `renderer/src/transcript/model.ts`, `components/TranscriptView.tsx` |
| Ask agent (Cmd/Ctrl+L, context menu, reference format, preview region, `.frameshell/context/`) | `renderer/src/ask/`; main `src/main/context-frames.ts` |
| Subtitle tracks (words, cues, presets, layout: shared by export and preview; ASS burn, bundled font) | `packages/schema/src/subtitles.ts`; `packages/core/src/export/ass.ts`, `export/fonts.ts`; `renderer/src/subtitles/`, `components/SubtitleInspector.tsx` |
| Scripts (outline parser, slugs, scriptRef check) | `packages/schema/src/script.ts`, `packages/core/src/scripts/outline.ts` |
| MCP server (tools from registry, resources, frame images) | `docs/mcp.md`; `packages/mcp/src/server.ts` |
| MCP UI state + navigation (`ui_*`, broker daemon → app window) | `docs/mcp.md`; `packages/core/src/ui/broker.ts`, `apps/desktop/src/renderer/src/ui-link.ts` |
| Release packaging, signing secrets, cutting a release | `docs/release.md` |
| Agent skill (content, bundle into core, plugin skill links, name check, Case B eval) | `skills/frameshell/`; `packages/core/src/skills/`, `core/src/plugins/skills.ts`; `packages/cli/test/skill-docs.test.ts`; `evals/agent-skill/README.md` |

## Rules

- SPEC decisions settled. Want to change one: ask user first, then record ADR.
- English for code, comments, docs, CLAUDE.md, UI strings (i18n-ready). Talk to user in Spanish.
- TSDoc on every public member.
- `CHANGELOG.md`: Keep a Changelog + SemVer.
- Verify: `pnpm typecheck && pnpm lint && pnpm test`. Tests run built `dist/`, `pnpm test` builds first.
- Media tests use real managed ffmpeg, downloaded once to `.cache/test-binaries` (`FRAMESHELL_TEST_BINARIES_DIR` overrides). Fixtures synthetic, tiny, generated per test. Never commit media.
- Proxy recipe changed: bump `RECIPE_VERSION` (cache key), else stale proxies reused. Clip cache entry layout or key recipe changed: bump `CACHE_LAYOUT_VERSION` (`clips/cache-key.ts`).
- Desktop change: also `pnpm test:e2e` (Playwright drives built Electron app).
- Playhead: one store, `preview/transport.ts`. Never keep a second playhead or play state.
- Renderer never writes project files: save via daemon `file.write`. Main only reads + watches.
- node-pty = N-API: no electron-rebuild. `apps/desktop/scripts/prepare-native.mjs` fixes `spawn-helper` exec bit.
- Zod model changed: run `pnpm gen:json-schema`, commit `packages/schema/json-schema/`. Drift test fails otherwise.
- New daemon method: one entry in `methods` registry (`packages/protocol/src/methods.ts`): Zod params, Zod result, model-facing description. Never bare TS interface.
- Wire change: bump `PROTOCOL_VERSION`.
- `skills/frameshell/` changed: run `pnpm gen:skill`, commit `packages/core/src/skills/core-skill.ts`. Drift test fails otherwise.
- CLI command, flag or MCP tool added or renamed: update skill. `skill-docs.test.ts` fails on names that do not exist or commands skill misses.
- Workspace = `apps/*`, `packages/*`, `plugins/*` only. Never add `spikes/*`.
- User-level storage: only via `resolveAppDirs()` (`packages/protocol/src/app-dirs.ts`). Downloads, caches, app state = `dataDir`; user decisions, global config = `configDir`. Overrides: `FRAMESHELL_DATA_DIR`, `FRAMESHELL_CONFIG_DIR` only.

## Agent skills

### Issue tracker

GitHub Issues in `ThomasPraun/frameshell`, via `gh`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
