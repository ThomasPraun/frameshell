# Review (`review`: sheets, metrics, requirements; #457)

Files: `card.ts` pure (card.md, #801: verdict + warnings + labelled numbers, layers via analyze `layer`), `plan.ts` pure, `sheet.ts`, `source.ts`, `service.ts`, `metrics.ts`, `requirements.ts`, `sound.ts`, `speed.ts`, `chart.ts`, `behind.ts` (pure), `safe.ts` pure, `placement.ts`, `sync.ts`, `loop.ts`, `delivery.ts` pure, `onsets.ts` (file decodes), `thresholds.ts`. Wire `packages/protocol/src/review.ts`; CLI `packages/cli/src/review-commands.ts`; MCP `reviewed` in `packages/mcp/src/server.ts` (returns images); skill `skills/frameshell/reference/critique.md`.

## Sheets

- Sheets: contact, safe-zone (`--platform`), phone, motion strips, loop seam, `cuts` (5 frames per cut, `cutPicks`); of timeline or exported file; into `.frameshell/review/<n>/`, last 10 kept.
- Frame sampling `plan.ts` + tiling `sheet.ts` = one shared module: `analyze` (#471) reuses, never copy.
- Timeline frames via `exports.frame`; file via ffmpeg.
- Safe zones only from `packages/schema/src/safe-zones.ts`. `safe.ts`: zones in film px + caption boxes. `placement.ts`: graphic alpha boxes + face boxes from cached `people scan`.
- Every threshold as data with Apache-2.0 attribution in `thresholds.ts`; none called from the hyperframes CLI.

## Metrics, craft warnings, requirements

- `metrics.json` + craft warnings. Per-clip kit: `pop` pair + `writeDifference` x4; `onion` = `onionBlend`; `speed` = hero point (media `clipHero`, generated `alphaHero`) → `speed.ts` pure spans (thresholds `SPEED_*` data) + `chart.ts` raster + `encodeRgbPng`.
- Truncated file rhythm = `shotLengthsRead` in `analyze/shots.ts`: one rule for analyze + review.
- `requirements.json` assertions (`staysInFrame` = `placement.ts` boxes against the reviewed format's frame), `fail` checks and per-clip waivers judged in `requirements.ts`. Per-clip requirements read the flattened timeline: nested clip = `<host>/<inner>`; bare inner id fails with the path. File schema `packages/schema/src/requirements.ts`.
- `requirements.json` = ADR 0036 config document `requirements` (`requirements-doc.ts` keys, `requirements-change.ts` `review.require`/`review.waive`), never written past the journal.
- Sound diff of one tx (`history.sound`, `sound-diff.ts` pure): `statesAround` (`history/diff.ts`) before/after, same `heardClips` + `levelAt`, per track; thresholds `SOUND_DIFF_*`.
- Sound review: timeline never mixed; each clip from `EnergyStore` envelope + gain + fades; roles voice/music/sfx/other. Music margin = style `musicUnderVoice` via `ReviewServiceOptions.musicUnderVoice`, never a constant. File = decoded mix for ending + clicks + 2-6 kHz harshness.
- Motion = analyze's scale (grey + rhythm rules: `packages/core/src/CLAUDE.md`). File: every frame via `readActivity` (`analyze/activity.ts`) + scene cuts. Timeline: sampled (`MotionSeries.step`, thresholds per sample interval, rhythm ESTIMATED).
- Word behind person: `metrics.behind` + check `behind`; covered share of word alpha by plate matte at 3 frames, face boxes; thresholds in `thresholds.ts`. Matte frame = export pick `matteFrameAt`; mattes read, never queued.
