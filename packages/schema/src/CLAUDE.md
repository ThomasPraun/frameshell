# Schema (Zod models + shared evaluators)

- Zod model changed: run `pnpm gen:json-schema`, commit `packages/schema/json-schema/`. Drift test fails otherwise.
- Evaluators here are the one source for export (core) and preview (desktop): root `CLAUDE.md` Shared truths. Change one: run its parity test.
- `effects.ts` stays zod-free: the preview engine worker imports it.
