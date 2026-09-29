# Frameshell

IDE for video. Agent edits project from terminal, human corrects in timeline. Open source, Apache 2.0.
Status: walking skeleton. pnpm monorepo: `packages/{schema,protocol,core,cli,plugin-api}`, `apps/desktop` (Electron). Node >= 22.

## Doc map

| Working on | Read |
|---|---|
| Anything (architecture, data model, CLI, plugins, MVP) | `docs/SPEC.md` |
| Domain terms | `GLOSSARY.md` |
| Past decisions and why | `docs/adr/` |
| Tickets | `docs/agents/issue-tracker.md` |
| Daemon wire protocol (methods, error codes) | `packages/protocol/src/methods.ts` |
| Managed binaries (ffmpeg pins, sources, licences, re-pin) | `docs/binaries.md` |
| Media ingest (proxy recipe, cache, job queue) | `packages/core/src/media/recipe.ts`, `media/service.ts`, `jobs/queue.ts` |
| Plugin host, install, trust | `packages/core/src/plugins/host.ts`; author API `packages/plugin-api` |
| Desktop app (IPC surface main/renderer) | `apps/desktop/src/shared/api.ts` |

## Rules

- SPEC decisions settled. Want to change one: ask user first, then record ADR.
- English for code, comments, docs, CLAUDE.md, UI strings (i18n-ready). Talk to user in Spanish.
- TSDoc on every public member.
- `CHANGELOG.md`: Keep a Changelog + SemVer.
- Verify: `pnpm typecheck && pnpm lint && pnpm test`. Tests run built `dist/`, `pnpm test` builds first.
- Media tests use real managed ffmpeg, downloaded once to `.cache/test-binaries` (`FRAMESHELL_TEST_BINARIES_DIR` overrides). Fixtures synthetic, tiny, generated per test. Never commit media.
- Proxy recipe changed: bump `RECIPE_VERSION` (cache key), else stale proxies reused.
- Desktop change: also `pnpm test:e2e` (Playwright drives built Electron app).
- Renderer never writes project files: save via daemon `file.write`. Main only reads + watches.
- node-pty = N-API: no electron-rebuild. `apps/desktop/scripts/prepare-native.mjs` fixes `spawn-helper` exec bit.
- Zod model changed: run `pnpm gen:json-schema`, commit `packages/schema/json-schema/`. Drift test fails otherwise.
- New daemon method: one entry in `methods` registry (`packages/protocol/src/methods.ts`): Zod params, Zod result, model-facing description. Never bare TS interface.
- Wire change: bump `PROTOCOL_VERSION`.
- Workspace = `apps/*`, `packages/*`, `plugins/*` only. Never add `spikes/*`.
- User-level storage: only via `resolveAppDirs()` (`packages/protocol/src/app-dirs.ts`). Downloads, caches, app state = `dataDir`; user decisions, global config = `configDir`. Overrides: `FRAMESHELL_DATA_DIR`, `FRAMESHELL_CONFIG_DIR` only.

## Agent skills

### Issue tracker

GitHub Issues in `ThomasPraun/frameshell`, via `gh`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
