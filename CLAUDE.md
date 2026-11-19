# Frameshell

IDE for video. Agent edits project from terminal, human corrects in timeline. Open source, Apache 2.0.
Status: alpha (release in `README.md`). pnpm monorepo: `packages/{schema,protocol,core,cli,mcp,plugin-api,motion}`, `plugins/{whisper-cpp,hyperframes,remotion,blender,openai-speech,openai-transcription}`, `apps/desktop` (Electron). Node >= 22.

## Doc map

Area rules live in nested `CLAUDE.md` files. Claude Code loads one when you read a file under its dir. Change in area X from outside X (CLI verb, wire entry, app UI): read X's file first.

| Working on | Read |
|---|---|
| Anything (architecture, data model, CLI, plugins, MVP) | `docs/SPEC.md` |
| Domain terms | `GLOSSARY.md` |
| Past decisions and why | `docs/adr/` |
| Tickets | `docs/agents/issue-tracker.md` |
| Daemon wire protocol, new daemon method, error codes, replay keys | `packages/protocol/src/CLAUDE.md` |
| Zod models, shared evaluators | `packages/schema/src/CLAUDE.md`; Shared truths below |
| Core daemon: gc, jobs, history, config journal, review mode core, plugin host, style, credits, cleanup, reframe, encoders, segmentation, grade analysis, shoot takes, agent targets, events | `packages/core/src/CLAUDE.md` |
| Media ingest, proxies, energy snapping, beat grid, loudness cache, audio effects bake | `packages/core/src/media/CLAUDE.md` |
| Timeline operations, time references, tempo grid, markers, direct file edits | `packages/core/src/timeline/CLAUDE.md` |
| Export, OTIO + Premiere XML hand-off, cover, captions burn | `packages/core/src/export/CLAUDE.md` |
| Batch variants | `packages/core/src/batch/CLAUDE.md` |
| Generated clips (render cache, keys, verify, compare, elements, motion blur) | `packages/core/src/clips/CLAUDE.md` |
| Review sheets, film review, requirements | `packages/core/src/review/CLAUDE.md` |
| Reference analysis (`analyze`) | `packages/core/src/analyze/CLAUDE.md` |
| Music fit, candidates, duck level, shape | `packages/core/src/music/CLAUDE.md` |
| Sound effects, generated music, audition | `packages/core/src/sound/CLAUDE.md` |
| People, voice prints, faces | `packages/core/src/people/CLAUDE.md` |
| Transcription, models, cloud consent | `packages/core/src/transcripts/CLAUDE.md` |
| Voiceover | `packages/core/src/voiceover/CLAUDE.md` |
| Video subject matte | `packages/core/src/matte/CLAUDE.md` |
| Brand capture, Figma import | `packages/core/src/brand/CLAUDE.md` |
| Core test flags, stand-ins, real-library tests, golden files | `packages/core/test/CLAUDE.md` |
| Motion runtime | `packages/motion/src/CLAUDE.md` |
| Desktop app (IPC, UI strings, panels, menus, timeline panel, shoot, teleprompter) | `apps/desktop/CLAUDE.md` |
| Desktop main process | `apps/desktop/src/main/CLAUDE.md` |
| Preview player | `apps/desktop/src/renderer/src/preview/CLAUDE.md` |
| Plugins, cloud providers | `plugins/CLAUDE.md`; `plugins/hyperframes/CLAUDE.md`; `plugins/blender/CLAUDE.md` |
| Managed binaries (ffmpeg, whisper.cpp, headless Chrome, models: pins, sources, licences, mirror, re-pin) | `docs/binaries.md` |
| MCP server (tools from registry, resources, frame images, default project from active window, `--channel` Claude Code channel push; `ui_*` state + navigation, broker daemon → app window) | `docs/mcp.md`; `packages/mcp/src/server.ts`, `packages/mcp/src/project.ts`; `packages/core/src/ui/broker.ts`, `apps/desktop/src/renderer/src/ui-link.ts`; ADR 0014 |
| Agent skill (content, bundle into core, shipped hashes + refresh of project copy, plugin skill links, name check, Case B eval) | `skills/frameshell/`; `packages/core/src/skills/` (`refresh.ts`, `shipped.json` grows on `pnpm gen:skill`), `packages/core/src/plugins/skills.ts`; `packages/cli/test/skill-docs.test.ts`; `evals/agent-skill/README.md` |
| Release packaging, signing secrets, cutting a release, update files | `docs/release.md` |
| Landing page frameshell.dev (Astro, own npm, Cloudflare Pages, hero video slot) | `website/README.md` |

## Shared truths (export + preview + engine + CLI; one source, never copy)

One owner per concept. Export, preview, engine and CLI import it. Change one: run its parity test.

| Concept | Owner | Parity / guard |
|---|---|---|
| Layer placement, nested flattening, shot layers + sound, fades, dissolve weights | `packages/schema/src/composite.ts` (`placementAt`, `gainAt`, `fadeWeight`, `dissolveWeights`, `shotLayers`, `shotSound`) | `apps/desktop/test/preview-*.test.ts` |
| Transition lengths + shape geometry (wipe/push/iris = `dissolve` + `shape`; upper track: outgoing under inverse mask; hold edge frame past handle; OTIO + Premiere dissolves read them, never recompute) | `packages/schema/src/transitions.ts` (`edgeTransitions` = one truth for lengths, `shapeAt` = one truth for shape geometry) | export twins `packages/core/src/export/animation.ts` |
| Formats: cover crop, caption scale, cover rules, per-format overrides | `packages/schema/src/formats.ts` (`resolveFormat`, `formatOf`, `formatCrop`, `scaledCaptions`) + `formatTimeline`: one truth for export, `frame`, clip renders, gc, preview | `apps/desktop/test/preview-formats.test.ts` |
| Grade: `.cube` parse, table, `applyGradeTable` (= lut3d + shader math), LOG hint | `packages/schema/src/grade.ts` (`gradeTable`, `logFootageHint`: one evaluator) | `packages/core/test/grade-render.test.ts`, `apps/desktop/test/preview-grade.test.ts`, e2e `grade-preview.spec.ts` |
| Built-in looks `warm/cool/filmic/punchy/faded/mono` | one table `GRADE_LOOKS` in `packages/schema/src/grade-looks.ts`; never a second table or a bundled LUT | `grade.looks`, `clip set --grade-look` copies it into the clip |
| Film finish (ADR 0043): letterbox bars, vignette, aspect parser | `packages/schema/src/finish.ts`: ONE `letterboxBars` (export `drawbox` + preview overlay), ONE `vignetteGain` (export `geq` plate + `blend` + preview grade pass), `parseAspect` (one parser with CLI) | `apps/desktop/test/preview-letterbox.test.ts`, `preview-vignette.test.ts`, `preview-grain.test.ts`; `packages/core/test/letterbox-render.test.ts`, `vignette-render.test.ts`, `grain-render.test.ts` |
| Clip effects (ADR 0031): audio effects (`audio.effects`, voice chain), glass backdrop (style `glass`, `--glass`) | `packages/schema/src/effects.ts` (normalization + `bakeRef`, zod-free for worker); glass `backdrop` of generated clips = one layer description for export `backdropUnder` + preview `BackdropPass`, upper tracks only | `apps/desktop/test/preview-backdrop.test.ts` |
| Subject matte layers (ADR 0032) | `withSubjectLayers` in `packages/schema/src/composite.ts`, called by `flattenTimeline` | `apps/desktop/test/preview-subject.test.ts` (vs `compileFrame`) |
| Captions: presets, layering, face metrics | `packages/schema/src/subtitles.ts` (`captionTokens`, `styleCaptionTokens`: one decision for export + preview), `packages/schema/src/font-file.ts` (`parseFontMetrics`, never copy) | `apps/desktop/test/caption-style.test.ts` |
| Spoken words + spelled numbers (aligner, take compare, live follower, voiceover) | `packages/schema/src/spoken.ts`, `packages/schema/src/numbers.ts` (`spellNumbersIn`); one source, never copy | |
| Time references (TimeRef): seconds, markers, `beat:`/`bar:`, `word:` | `packages/core/src/timeline/time-ref.ts` + `TIME_REF_FIELDS` in `packages/protocol/src/timeline.ts`: one table of fields, never a private parser per verb (CLI `when()`, `music fit`, `sound place`, `voiceover place`, scene band planned range `readPlannedRange`) | |
| Safe zones per platform | `packages/schema/src/safe-zones.ts`: one home, named never copied | |
| Cost text of paid runs | ONE `formatCost` in `packages/protocol/src/cost.ts`: core messages + app boxes, never a twin | |
| JSON config edit keeping other bytes (Claude Desktop, Claude Code setup) | `packages/cli/src/config-file.ts` | |

## Rules

- SPEC decisions settled. Want to change one: ask user first, then record ADR.
- English for code, comments, docs, CLAUDE.md. Talk to user in Spanish.
- Agent-facing text (CLI, skill, daemon errors, Ask references, journal labels) stays English. Desktop UI strings: `apps/desktop/CLAUDE.md`.
- TSDoc on every public member.
- `CHANGELOG.md`: Keep a Changelog + SemVer.
- Verify: `node scripts/test-scope.mjs` prints what change can break (unit filter, e2e yes/no); run that, not whole suite. Iterate on area test files only (`pnpm test packages/core/test/beats`). Tests run built `dist/`, `pnpm test` builds first. CI uses same script; push to main runs all. Area reads files outside own package (new cross-area read): add to `scripts/test-scope.mjs`.
- e2e (`pnpm test:e2e`, Playwright drives built Electron app): local only when `apps/desktop` changed. CI runs it when `test-scope` says so.
- Media tests use real managed ffmpeg, downloaded once to `.cache/test-binaries` (`FRAMESHELL_TEST_BINARIES_DIR` overrides). Fixtures synthetic, tiny, generated per test. Never commit media. Only exception: landing assets in `website/public/media/`, each < 25 MB.
- Wire change: bump `PROTOCOL_VERSION`.
- `skills/frameshell/` changed: run `pnpm gen:skill`, commit `packages/core/src/skills/core-skill.ts`. Drift test fails otherwise.
- `packages/motion/` or `packages/schema/src/motion.ts` changed: run `pnpm gen:motion`, commit `plugins/hyperframes/src/motion-runtime.ts`. Drift test fails otherwise.
- CLI command, flag or MCP tool added or renamed: update skill. `skill-docs.test.ts` fails on names that do not exist or commands skill misses.
- Workspace = `apps/*`, `packages/*`, `plugins/*` only. Never add `spikes/*` or `website/` (own npm + lockfile, Node >= 22.22).
- User-level storage: only via `resolveAppDirs()` (`packages/protocol/src/app-dirs.ts`). Downloads, caches, app state = `dataDir`; user decisions, global config = `configDir`. Overrides: `FRAMESHELL_DATA_DIR`, `FRAMESHELL_CONFIG_DIR` only.
- New `CLAUDE.md`: under `<pkg>/src/`, `<pkg>/test/` or an app/plugin root, never in a dir that ships (package root, `skills/`, `plugins/*/skills/`, npm `files`). `node scripts/claude-md-check.mjs` checks placement + backticked paths (CI).

## Agent skills

### Issue tracker

GitHub Issues in `ThomasPraun/frameshell`, via `gh`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
