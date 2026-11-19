# Protocol (daemon wire)

- Registry type, errors, helpers: `methods.ts`. Method entries: one module per area `methods/*.ts`; shared schemas `methods/shared.ts`. Replay keys of `mutating` methods: `packages/core/src/idempotency.ts`.
- New daemon method: one entry in its area module `methods/*.ts` (spread into `methods`; new area module also joins `MethodRegistry`): Zod params, Zod result, model-facing description. Never bare TS interface. Area d.ts hits TS7056: split area module or annotate big schema (`z.ZodType<T>`).
- Daemon events: `notifications` in `methods.ts`; emitter `packages/core/src/events.ts`; app side (subscribe, reconnect) `apps/desktop/src/main/daemon-link.ts`.
- Analyze result typed by hand in `analyze.ts` (TS7056). Its MEASURED/ESTIMATED/DECISION `labels` tables live there: rule in `packages/core/src/analyze/CLAUDE.md`.
