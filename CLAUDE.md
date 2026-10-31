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
| People (`people.json`: model, links, `missing`, speaker name written into transcripts, confirm, review mode not holding it; ADR 0020) | `packages/schema/src/people.ts`, `packages/core/src/people/service.ts`, `packages/protocol/src/people.ts`; CLI `packages/cli/src/people-commands.ts`; acceptance `docs/acceptance/people.md` |
| Voice prints + speaker suggestions (fbank port of sherpa-onnx, CAM++ worker, cache, thresholds) | `packages/core/src/people/fbank.ts` (reference `core/test/fixtures/fbank-reference.json`), `people/voice-embed.ts`, `people/voices.ts`, `people/suggest.ts`; `docs/binaries.md` CAM++ |
| Face clusters + face, face-speaker, angle suggestions; people ranges | `packages/core/src/people/face-clusters.ts`, `face-suggest.ts`, `angle-suggest.ts`, `ranges.ts` |
| Worker-thread tasks + ONNX Runtime Web (one-shot runner, one loader, one cosine/mean: reuse, never copy; long-lived request/reply worker = `segment/engine.ts`) | `packages/core/src/worker-task.ts`, `onnx-web.ts`, `people/vector.ts` |
| Transcription (transcript file, word ids, audio source, export verify) | `packages/core/src/transcripts/transcriber.ts`, `transcripts/verify.ts` + `align.ts`; provider `plugins/whisper-cpp`; word normalization + spelled numbers shared by aligner, take compare, live follower: `packages/schema/src/spoken.ts`, `numbers.ts` (one source, never copy) |
| Timeline operations (engine, inverses, invariants, CLI verbs) | `packages/core/src/timeline/engine.ts`, `timeline/service.ts`; ADR 0004 |
| Export (compiler, presets, render job, frame capture) | `packages/core/src/export/compiler.ts` (pure, golden tests `packages/core/test/golden/`, regen `UPDATE_GOLDEN=1`), `export/service.ts` |
| History, transactions, revert (journal, grouping, conflicts) | `packages/core/src/history/`; SPEC §6.2 |
| Direct timeline file edits (watcher, stale/invalid rejection, `.frameshell/rejected/`, offline-edit catch-up) | `TimelineService.reconcile` in `packages/core/src/timeline/service.ts`, `timeline/watcher.ts`, `timeline/rejections.ts`; SPEC §6.4 |
| Cut snapping to audio energy (pauses, envelope cache) | `packages/core/src/media/energy.ts`, `media/energy-store.ts`, `timeline/snap.ts`; ADR 0003 |
| Photo segmentation (MobileSAM pins, worker, embedding cache, idle free, `segment.prepare`, click to 3 masks, `image.cutout` crop + placement, one tx) | `packages/core/src/segment/` (`segmenter.ts` math + cache, `engine.ts` worker, `service.ts` photo read, `cutout.ts`); `docs/binaries.md` "Photo segmentation"; ADR 0022; Pick in photos (prepare on Pick, mask outline, ↑/↓ size, "Cut out as layer") `renderer/src/preview/segment-pick.ts`, `preview/cut-out.ts`, `components/PickLayer.tsx`; e2e daemon uses `FRAMESHELL_SEGMENT_STAND_IN=1` (`segment/stand-in.ts`) |
| Generated clips (render cache, keys, background renders, export layers) | `packages/core/src/clips/renderer.ts`, `clips/cache-key.ts`; adapters `plugins/hyperframes` (ADR 0002), `plugins/remotion` (bundle as cache input, outside-project code, `refreshRenders`; ADR 0009); SPEC §6.5 |
| Plugin host, install, trust; npm the app bundles for machines without Node | `packages/core/src/plugins/host.ts`, `plugins/npm-runtime.ts`, `apps/desktop/scripts/bundle-npm.mjs`; author API `packages/plugin-api` |
| Desktop app (IPC surface main/renderer) | `apps/desktop/src/shared/api.ts` |
| Context menus (one in-page menu mounted in `App.tsx`, separators, danger items; welcome recent projects; Explorer Open/Reveal/Copy path/Move to Trash; timeline clip menu = key commands via `commandEdits`, track header + empty lane menus; epic #414) | `renderer/src/components/ContextMenu.tsx`, `renderer/src/file-commands.ts` (shared file items), `components/Explorer.tsx`, `clipItems`, `openTrackMenu` in `components/TimelinePanel.tsx`; main `src/main/trash.ts`; daemon `file.uses` `packages/core/src/file-uses.ts` |
| Desktop UI strings (en + es, language choice, parity test) | `apps/desktop/src/shared/i18n/`, renderer `t`/`rich` in `renderer/src/i18n.ts`, main `src/main/language.ts`; `apps/desktop/test/i18n.test.ts` |
| Agent guide above terminals (agent catalog, install commands, Start by path, suggestions), Connect Claude Desktop (config edit keeps other bytes) | `apps/desktop/src/main/agent-catalog.ts`, `main/claude-desktop.ts`, `renderer/src/components/AgentGuide.tsx` |
| New project from video (folder beside video, name clash, clone test), audio project background + subtitles (`main/audio-background.ts`), drops, Open with (single instance, `open-file`, Windows registry) | `apps/desktop/src/main/video-project.ts`, `main/media-files.ts`, `main/open-paths.ts`, `build/installer.nsh`, `renderer/src/components/Welcome.tsx`, `renderer/src/file-drop.ts`; ADR 0013 |
| Daemon events (subscribe, notifications, reconnect) | `notifications` in `packages/protocol/src/methods.ts`; `packages/core/src/events.ts`; `apps/desktop/src/main/daemon-link.ts` |
| Image projects (`kind: image`, layers, export as image, Layers panel, start from pictures or a video frame) | ADR 0017; `apps/desktop/src/main/image-layers.ts`, `main/frame-image.ts` (image from a video frame), `renderer/src/components/LayersPanel.tsx`, `renderer/src/layers/model.ts`; `useProjectKind` in `renderer/src/preview/useProgram.ts` |
| Review mode core (switch in `configDir/review.json`, one proposal per tx, route of non-`ui` changes, rebase/stale, accept/reject/wait, direct edits as proposals, `view` on reads; `ui`-only methods checked in daemon) | ADR 0019; `packages/core/src/timeline/service.ts` (`#route`, `#propose`, `#sync`, `acceptProposal`), `proposals/store.ts`, `proposals/review-switch.ts`; `onClosed` in `history/transactions.ts`; `onlyUi`, `viewOf` in `daemon.ts`; wire `packages/protocol/src/proposals.ts` |
| Review mode in app (switch in History view + File menu, proposal bar in every window incl. detached panels, editor, terminals; Before/After = `view: proposal` read by shared timeline feed; edit snaps back to Before; Ask agent frames stay current) | `apps/desktop/src/renderer/src/review/` (`model.ts` pure, `store.ts` one store), `components/ProposalBar.tsx`, `ReviewSwitch.tsx`; main `readReview`/`setReview` in `main/index.ts`; ADR 0019 |
| Timeline panel (canvas layout, paint, live updates, scene band from `script.outline` spans) | `apps/desktop/src/renderer/src/timeline/` (`scenes.ts` = band data); ADR 0015 |
| Transitions + keyframes (effective lengths, evaluators, ops, export, preview, timeline marks, inspector; none in image projects) | ADR 0018; `packages/schema/src/transitions.ts` (`edgeTransitions` = one truth for lengths), `composite.ts` (`placementAt`, `gainAt`, `fadeWeight`, `dissolveWeights`); engine `transitionSet`/`clipKey`; `packages/core/src/export/animation.ts` (ffmpeg twins); `renderer/src/preview/program.ts` (`pictureLayers`, `spanPlacement`); `renderer/src/timeline/transitions.ts`, `components/ClipInspector.tsx` |
| Layer placement + nested flattening (shared by export and preview) | `packages/schema/src/composite.ts` |
| Multicam model (groups, angles, program track, shots: invariants, shot layout + sound) | `packages/schema/src/timeline.ts`, `composite.ts` (`shotLayers`, `shotSound`); engine `checkShots`; SPEC §5.3; ADR 0016 |
| Face reframe (`multicam faces`: YuNet keys, worker thread, `faces` job; ONNX Runtime Web = binary manager `module` kind) | `packages/core/src/multicam/faces.ts`, `faces-worker.ts`; `binaries/manifest.ts`; `docs/binaries.md` |
| People face scan (`people scan`: YuNet landmarks, SFace prints, face tracks, `people` job, cache `.frameshell/people/`, gc) | `packages/core/src/people/scan.ts` (models + tracker, worker `scan-worker.ts`), `scan-run.ts` (job body), `scan-cache.ts` (cache format); ADR 0020 |
| Element adjustments (clip `elements`, CSS sheet + selector check, render key, adapters insert sheet, live bridge swap, probe `unit`) | `packages/schema/src/element-styles.ts`; engine `setElements`; `clips/renderer.ts`; `plugins/hyperframes/src/adapter.ts`, `plugins/remotion/src/elements.ts` (bundle copy); `LIVE_BRIDGE` in `apps/desktop/src/main/live-protocol.ts`; `packages/protocol/src/probe.ts`; ADR 0021 |
| Element mode (double-click a generated clip, drag/scale composition elements, engine layer skip, hold until new render, inspector list) | `renderer/src/components/ElementLayer.tsx`, `renderer/src/preview/element-edit.ts` (pure geometry), `preview/element-mode.ts`, `preview/pick-pages.ts`; ADR 0021 |
| Clip inspector, preview layer handles | `renderer/src/components/ClipInspector.tsx`, `renderer/src/preview/transform-edit.ts` |
| Preview player (program, engine worker, audio worklet, playhead store, clip render decode, multicam shots: one layer + decoder per angle slot) | `apps/desktop/src/renderer/src/preview/` (`video-source.ts` = proxy or render); ADR 0001, 0002; media URLs `apps/desktop/src/main/media-protocol.ts` |
| Live preview of generated clips (`frameshell-live://` scheme, seek bridge, iframe, topmost-layer rule) | `apps/desktop/src/main/live-protocol.ts`, `renderer/src/preview/live.ts`, `components/LivePreview.tsx`; daemon `clip.live`; ADR 0010 |
| Preview ADR 0001 thresholds (real app, opt-in, ~20 min) | `FRAMESHELL_PREVIEW_MEASURE=1 pnpm --filter @frameshell/desktop exec playwright test preview-thresholds`; results `docs/research/preview-playback-measurements.md` |
| Desktop selection (shared store, extend, never duplicate); playhead = `preview/transport.ts` | `apps/desktop/src/renderer/src/selection.ts` |
| Detached panels (panel windows, allowlist, placement in `configDir`, project window registry, global keys, maximize) | `apps/desktop/src/main/panel-windows.ts`, `renderer/src/panel-window.ts`, `renderer/src/windows.ts`, `components/Workspace.tsx`; ADR 0012 |
| Terminals across windows (pty outlives view, output ring + `terminal:attach` replay, Ask agent target) | `apps/desktop/src/main/output-ring.ts`, `main/terminals.ts`, `renderer/src/components/TerminalPanel.tsx`, `renderer/src/ask/ask-target.ts`; ADR 0012 |
| Cut to angle (keys 1-9, Shift adds; one transaction per playback; viewer click calls `cutToAngle`) | `apps/desktop/src/renderer/src/timeline/angle-cut.ts`, `angle-keys.ts`; listener in `components/Workspace.tsx`; main `timeline-editor.ts` (`burstGap`, `settle`); ADR 0016 |
| People panel (sidebar view, suggestions incl. angle, undo by list diff, pick = words + spans in selection, face thumb from proxy; transcript speaker rename renames person) | `apps/desktop/src/renderer/src/components/PeoplePanel.tsx`, `renderer/src/people/` (`model.ts` pure, `usePeople.ts` store, `pick.ts`), strings `shared/i18n/people.ts`; ADR 0020 |
| Multicam viewer (Angles sidebar view, detachable; proxy `<video>` per angle, turns mark, click = `cutToAngle`) | `renderer/src/components/AngleViewer.tsx`, `renderer/src/angles/model.ts`; ADR 0016 |
| Timeline editing (gestures, keys, undo/redo) | `renderer/src/timeline/edit.ts`; main `src/main/timeline-editor.ts` |
| Agent-labelled terminals (detection, `session.tag`, `agent:<label>:<session>` author, `FRAMESHELL_AGENT`) | `apps/desktop/src/main/agent-detect.ts`, `main/terminals.ts`; `packages/protocol/src/agents.ts`; SPEC §6.2 |
| History panel (list, diff marks, revert from UI) | `renderer/src/history/`, `components/HistoryPanel.tsx`; core `history/diff.ts` |
| Transcript view (struck words, restore op + passages, per-track ripple scope, word selection, word text edits) | `renderer/src/transcript/model.ts`, `components/TranscriptView.tsx` |
| Ask agent (Cmd/Ctrl+L, context menu, reference format, preview region, `.frameshell/context/`) | `renderer/src/ask/`; main `src/main/context-frames.ts` |
| Subtitle tracks (words, cues, presets, layout: shared by export and preview; ASS burn, bundled font) | `packages/schema/src/subtitles.ts`; `packages/core/src/export/ass.ts`, `export/fonts.ts`; `renderer/src/subtitles/`, `components/SubtitleInspector.tsx` |
| Scripts (outline parser, slugs, scriptRef check; shoot script lines, speakers, cues, `script.check`) | `packages/schema/src/script.ts` (`parseShootScript`), `packages/core/src/scripts/outline.ts`, `scripts/check.ts` |
| Shoot / Rodaje (shoot script conventions, takes, deviations, assembly; in-app capture, shoot session = one multicam group, teleprompter, live recognition; not `multicam direct`) | ADR 0023, 0024; spike numbers `docs/research/shoot-capture.md`; never `--use-fake-ui-for-media-stream` for screen capture |
| Teleprompter (stream of stops, sentences, focus-line offset + glide; one position store read/driven by Shoot view, takes #391, live follow #393; settings per viewer in `localStorage`) | `apps/desktop/src/renderer/src/teleprompter/` (`model.ts` pure, `store.ts` one store), `components/TeleprompterPanel.tsx`, strings `shared/i18n/teleprompter.ts`; ADR 0024 decision 6 |
| Live follow (pure follower port of spike, thresholds `FOLLOW_OPTIONS`, skipped marks, FREE hold; driver; audio tap 16 kHz; resident whisper-server in main, download only on consent, model by speed check; e2e stand-in `frameshellLiveHear`) | `renderer/src/teleprompter/follower.ts` (pure), `teleprompter/follow.ts`, `renderer/src/shoot/live.ts` + `live-tap.worklet.ts`; main `src/main/live-recognition.ts`; `docs/binaries.md` "Live recognition"; spike numbers `docs/research/shoot-capture.md` Q5/Q6 |
| Shoot recorder in app (Shoot view, sources + levels, recorder store outside view, chunks appended by main into `assets/shoot/<id>/*.part`, state `.frameshell/shoot/sessions/`, End/crash recovery = remux + `multicam.create` `offsets`, preview mute, content protection; e2e `FRAMESHELL_SHOOT_STAND_IN=1` + `--use-fake-device-for-media-stream`) | `apps/desktop/src/main/shoot-session.ts`, `main/shoot-capture.ts`, `registerShootIpc` in `main/index.ts`; `renderer/src/shoot/` (`model.ts` pure, `recorder.ts` store), `components/ShootPanel.tsx`; acceptance `docs/acceptance/shoot.md` |
| Shoot session takes (T/C ranges of a session, `shoot.session.cut` job: range of `.part` (finished file once End renamed it) → PCM → transcribe → words `.frameshell/shoot/takes/`, stand-in `FRAMESHELL_SHOOT_STAND_IN=1`; `shoot.session.end`: re-run takes without words, transcripts + group on shoot timeline + takes as shots; Shoot view takes UI; T/C feedback strip in Shoot view + teleprompter) | `packages/core/src/shoot/session.ts`, `shoot/service.ts` (`#sessionSource`), `shoot/assemble.ts` (shots); engine `shotAdd`; `renderer/src/shoot/takes.ts` (store), `takes-model.ts` (pure), `components/ShootTakes.tsx`, `components/TakeStatus.tsx` |
| MCP server (tools from registry, resources, frame images, default project from active window) | `docs/mcp.md`; `packages/mcp/src/server.ts`, `mcp/src/project.ts`; ADR 0014 |
| MCP UI state + navigation (`ui_*`, broker daemon → app window) | `docs/mcp.md`; `packages/core/src/ui/broker.ts`, `apps/desktop/src/renderer/src/ui-link.ts` |
| Release packaging, signing secrets, cutting a release | `docs/release.md` |
| Update check (mode per platform, opt-out, release update files, stale daemon after update) | `docs/release.md` "Updates"; `apps/desktop/src/main/updater.ts`, `main/update-check.ts`, `main/stale-daemon.ts` |
| Landing page frameshell.dev (Astro, own npm, Cloudflare Pages, hero video slot) | `website/README.md` |
| Agent skill (content, bundle into core, shipped hashes + refresh of project copy, plugin skill links, name check, Case B eval) | `skills/frameshell/`; `packages/core/src/skills/` (`refresh.ts`, `shipped.json` grows on `pnpm gen:skill`), `core/src/plugins/skills.ts`; `packages/cli/test/skill-docs.test.ts`; `evals/agent-skill/README.md` |

## Rules

- SPEC decisions settled. Want to change one: ask user first, then record ADR.
- English for code, comments, docs, CLAUDE.md. Talk to user in Spanish.
- Desktop UI strings: never literal in components. Add to area file in `apps/desktop/src/shared/i18n/`, English + Spanish (neutral Latin American, "tú"). Agent-facing text (CLI, skill, daemon errors, Ask references, journal labels) stays English. e2e pin English (`--lang=en`).
- TSDoc on every public member.
- `CHANGELOG.md`: Keep a Changelog + SemVer.
- Verify: `pnpm typecheck && pnpm lint && pnpm test`. Tests run built `dist/`, `pnpm test` builds first.
- Media tests use real managed ffmpeg, downloaded once to `.cache/test-binaries` (`FRAMESHELL_TEST_BINARIES_DIR` overrides). Fixtures synthetic, tiny, generated per test. Never commit media. Only exception: landing assets in `website/public/media/`, each < 25 MB.
- Proxy recipe changed: bump `RECIPE_VERSION` (cache key), else stale proxies reused. Clip cache entry layout or key recipe changed: bump `CACHE_LAYOUT_VERSION` (`clips/cache-key.ts`).
- Desktop change: also `pnpm test:e2e` (Playwright drives built Electron app).
- Playhead: one store, `preview/transport.ts`. Never keep a second playhead or play state.
- Panel code may run in detached panel window (ADR 0012). rAF, timers, observers, focus, fullscreen, `message`: take from element's own window (`ownerDocument.defaultView`). Global keys via `listenEverywhere`. Never `instanceof HTMLElement` on events or nodes: use `elementOf`/`isTag` (`renderer/src/windows.ts`).
- Renderer never writes project files: save via daemon `file.write`. Main only reads + watches. Only exception: Explorer Move to Trash (`main/trash.ts`, OS trash after confirm listing daemon `file.uses`).
- node-pty = N-API: no electron-rebuild. `apps/desktop/scripts/prepare-native.mjs` fixes `spawn-helper` exec bit.
- Zod model changed: run `pnpm gen:json-schema`, commit `packages/schema/json-schema/`. Drift test fails otherwise.
- New daemon method: one entry in `methods` registry (`packages/protocol/src/methods.ts`): Zod params, Zod result, model-facing description. Never bare TS interface.
- Wire change: bump `PROTOCOL_VERSION`.
- `skills/frameshell/` changed: run `pnpm gen:skill`, commit `packages/core/src/skills/core-skill.ts`. Drift test fails otherwise.
- CLI command, flag or MCP tool added or renamed: update skill. `skill-docs.test.ts` fails on names that do not exist or commands skill misses.
- Workspace = `apps/*`, `packages/*`, `plugins/*` only. Never add `spikes/*` or `website/` (own npm + lockfile, Node >= 22.22).
- User-level storage: only via `resolveAppDirs()` (`packages/protocol/src/app-dirs.ts`). Downloads, caches, app state = `dataDir`; user decisions, global config = `configDir`. Overrides: `FRAMESHELL_DATA_DIR`, `FRAMESHELL_CONFIG_DIR` only.

## Agent skills

### Issue tracker

GitHub Issues in `ThomasPraun/frameshell`, via `gh`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
