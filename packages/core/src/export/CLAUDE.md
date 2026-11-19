# Export

| Working on | Read |
|---|---|
| Compiler (pure), presets, render job, frame capture | `compiler.ts` (golden tests `packages/core/test/golden/`, regen `UPDATE_GOLDEN=1`), `service.ts`, `presets.ts` (`gif` preset, caps, `fitInside`) |
| Loop seam check (`render --loop`, ADR 0039) | `seam.ts` |
| True-peak limiter (ceiling per codec + bitrate as data), loudness re-measure loop `settleTrim` | `true-peak.ts`; `limitedAnalysis`/`muxStep` trim in `compiler.ts` |
| Cover image + finished frame 0 (`cover` method, `render` option `cover`: one big word over a frame, hook word found in transcripts, thumbnail check, frame 0 = own 1-frame segment; black frame 0 warning) | `cover.ts` (pure), `font-metrics.ts` (TTF widths of bundled face), `compileRender`/`compileFrame` `cover` in `compiler.ts`, `ExportService.cover` in `service.ts`; CLI `frameshell cover`, `render --cover-frame` |
| Captions burn (ASS, bundled font) | `ass.ts`, `fonts.ts`, `font-metrics.ts`; evaluator: root Shared truths |
| Export twins of schema evaluators (root Shared truths) | transitions `animation.ts` (ffmpeg twins), compiler `pieceShape`/`reach`; grade `grade.ts`, `gradedChain`, `gradeFiles` (`lut3d` into work dir); finish `letterboxChain`, `lookedChain`, `vignette.ts`, `grain.ts`; effects `audioGraph`, `backdropUnder`; matte `mattedPiece`; formats `#resolved` + `outputSize` in `service.ts`, `layoutTimeline` in `compiler.ts` |
| Generated clips in export | `confirmFinals` in `service.ts`; `generatedFrameAt` in `compiler.ts` = the frame capture reads; batch `ExportService.planRender` |

## Rules

- Letterbox: bars over finished picture, under captions, primary format only via `formatTimeline`. Vignette: after grade, on the crop that shows.
- Grain: seeded `noise` plate, phase = timeline frame mod 64, `concat` of 64-frame copies (never `loop`), `grainmerge`.
- Matte: export `alphamerge`.

## Hand-off exports (OTIO ADR 0045, Premiere XML ADR 0047)

- Files derived: export only, never read back.
- Files: `otio.ts` (pure; golden `packages/core/test/golden/otio-edit.json`), `premiere-xml.ts` (pure; golden `packages/core/test/golden/premiere-edit.xml`), `handoff.ts` (shared). `ExportService.otio`, `ExportService.premiereXml` + `#handoffGuard`/`#handoffFacts` in `service.ts`. Wire `export.otio`, `export.premiereXml` in `packages/protocol/src/methods/export.ts`. CLI `packages/cli/src/export-commands.ts` (`export premiere`). App menu: `apps/desktop/CLAUDE.md`. Tests: `packages/core/test/CLAUDE.md`.
- Dissolve between butted clips: from `edgeTransitions`, never recompute. OTIO = `Transition.1`. Premiere = Cross Dissolve; dissolve clipitems keep explicit start/end + unwidened in/out (no -1 convention). `clipLength` reused; clip placement `placeClip` shared.
- Sound of video-track media clips: `mirrorsSound`/`soundMirrorName` in `otio.ts` = one place, by asset kind, never audio-stream probe. OTIO = mirror Audio track per video track after real audio tracks (`mirrorOf`, linked by `clipId`, muted = disabled). Premiere = linked audio clipitems via `mirrorsSound` from `otio.ts`, never twin.
- What is left out: `Dropped`/`leftOut` in `handoff.ts`, one list shared with OTIO, never copy. OTIO: gain = metadata + warning; dips/fades/shape/sound fades = warnings; shaped dissolve plain + metadata + warning. Image project refused `InvalidOperation`.
- Premiere = xmeml v4, hand written, no dependency, `XMEML_VERSION` one constant. `pathurl` ALWAYS absolute `file://localhost/` (`C%3a` drive): no relative mode, no flag, file not portable. UNC path spelling pinned by test, unverified. `audio.gain` = Audio Levels filter (linear, clamp +12 dB + warning, UNVERIFIED in Premiere). Every `<rate>` = project rate.
