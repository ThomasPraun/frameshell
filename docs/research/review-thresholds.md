# Review thresholds: where each number comes from

The numbers `review` judges a film by live in `packages/core/src/review/thresholds.ts` and `packages/core/src/review/metrics.ts`; the visual-event scale it shares with `analyze` lives in `packages/core/src/analyze/rhythm.ts`. This note lists the source of each one, so the code comments do not need ticket numbers.

Every threshold is a judgment with a number, so `review` reports it as a warning, never a failure (decided in #478, which also set the rule: build `review` in core, port HyperFrames' `check` thresholds as data with attribution, never call the `hyperframes` CLI).

## Sources

| Key | Source | Licence / kind | Where it was gathered |
|---|---|---|---|
| **HF** | HyperFrames `check` and `measure` (<https://github.com/heygen-com/hyperframes>) | Apache-2.0, ported with attribution in the file headers | #478 decision table; #457 full pass |
| **FP** | Owner's full pass over launch-film guides and kits (contact sheets, motion strips, metrics, craft warnings) | Owner notes | #457 comment of 2026-11-10 ("Full-pass additions") |
| **ES** | earshot (`Leonxlnx/earshot`) ranges the owner measured on seven launch films, and its mechanical audio QA | Owner measurements | #457 comment of 2026-11-10 ("Third pass") |
| **2.5D** | 2.5D shorts course: delivery check with ffprobe, sound review list | Owner notes | #457 comment of 2026-11-10 |
| **CVE** | claude-video-effects recipe for a word behind the person | Owner notes | #461 comments |
| **Owner** | Owner decision | Decision | Date given in the row |
| **Ours** | Chosen while building; no source gives the number. The reason is in the constant's TSDoc | Implementation choice | |

## Picture (`metrics.ts`, `rhythm.ts`)

| Constant | Value | Source |
|---|---|---|
| `STILL_WARN_S` | 3 s | HF (`check`: more than 3 s unchanged) |
| `SILENT_FILM_S` | 15 s | HF (`check`: silent film over 15 s) |
| `SHORT_CUE_FLOOR_S` | 0.4 s | HF / FP (reading floor for 1 to 2 words) |
| `BLANK_SPREAD` | 4 grey levels | FP (near-blank: luma standard deviation under 4 at 160 px) |
| `BIG_CHANGE_SHARE` | 15 % of 255 | ES (visual event: 15 % mean grey change) |
| `BIG_CHANGE_RATIO` | 4x | ES (visual event: 4 times its surroundings) |
| `BIG_CHANGE_FLOOR` | 1 grey level | Ours (keeps noise in a still picture from being 4x of nothing) |
| `BIG_CHANGE_SURROUND_S` | 0.5 s | Ours (half a second spans a gesture, not a shot) |
| `SEAM_CONTINUOUS` | 10 grey levels | FP (loop seam: under 10 reads continuous, a hard cut is about 40 to 80) |

## Loudness and delivery

| Constant | Value | Source |
|---|---|---|
| `TRUE_PEAK_LIMIT` | -1 dBTP | FP (measure on the decoded final file; the AAC encode adds about 0.9 dB) |
| `PHONE_BAND_GAP_LU` | 6 LU | FP gives the case (one mix 9 LU quieter in the phone band); the 6 LU cut-off is ours |
| `DELIVERY_*` | 2 frames, 1.5 LU, 0.01 fps | 2.5D (size, frame rate and duration equal the plan); the tolerances are ours |

## Sync

| Constant | Value | Source |
|---|---|---|
| `SYNC_MATCH_S` | 0.12 s | FP (visual onset within ±0.12 s) |
| `SYNC_EARLY_S`, `SYNC_LATE_S` | 45 ms, 75 ms | ES (perception: early from 45 ms, late from 75 ms) |
| `SYNC_NEAR_S` | 0.1 s | ES (hit within ±100 ms, scored against a chance baseline) |
| `SYNC_EXCLUDED_KINDS` | whoosh, riser, tick | FP |
| `SYNC_CHANCE_SHIFTS_S`, `SYNC_MIN_SOUNDS`, `SYNC_CHANCE_MARGIN` | see file | Ours (ES gives the method, not these numbers) |

## Sound review list

| Constant | Value | Source |
|---|---|---|
| `VOICE_OVER_BED_DB` | 6 dB | 2.5D ("the voice is always on top"); 6 dB is half the style guide's `musicUnderVoice` (ADR 0028) |
| `SFX_REPEAT_MAX` | 2 | 2.5D ("no whoosh repeated more than twice") |
| `MACHINE_GUN_PLAYS` | 4 | ES (4 events of one sample, pitch spread under 0.1 semitone) |
| `CHOP_DB` | -35 dB re peak | ES (unfaded tail) |
| `ENDING_TAIL_S`, `ENDING_DBFS` | 50 ms, -45 dBFS | ES |
| `LOUDEST_BEFORE` | 85 % of the runtime | ES |
| `LOUDEST_WINDOW_S` | 0.4 s | EBU R128 momentary window |
| `LOUDEST_MARGIN_DB` | 1 dB | Ours (about the smallest level change a listener notices) |
| `CLICK_BAND_HZ`, `CLICK_RATIO`, `CLICK_SHARE`, `CLICK_BURST_S`, `CLICK_CONTEXT_S` | 14 kHz, 9x, 80 %, 1 ms, 20 ms | ES |
| `CLICK_FLOOR_DBFS` | -60 dBFS | Ours (under it a burst is quantization dust) |
| `MASKING_SLACK_DB` | 3 dB | ES gives the rule (under 0 dB is masked); the 3 dB slack is ours |
| `HARSH_BAND_HZ`, `HARSH_DB` | 2 to 6 kHz, 6 dB | ES |
| `HARSH_REFERENCE_FLOOR_DB` | 20 dB | Ours |
| `EDGE_JUMP_DB` | 19 dB | ES's click ratio (9x = 19 dB) |

## Motion and graphics

| Constant | Value | Source |
|---|---|---|
| `SPEED_*` | see file | FP asks for a speed graph that exposes linear moves and dead stops; the numbers are ours |
| `GRAPHIC_*` | see file | Ours (sampling of a generated clip's alpha) |

## Word behind the person (ADR 0032)

| Constant | Value | Source |
|---|---|---|
| `BEHIND_FINE` | 30 to 55 % covered | CVE |
| `BEHIND_FLOATS`, `BEHIND_EATEN` | 15 %, 65 % | CVE gives the numbers; Owner (2026-11-17) made them warning bands |

## Not covered here

Safe zones per platform are data in `packages/schema/src/safe-zones.ts`; caption numbers are in `packages/schema/src/subtitles.ts`. Limits on how many items a list shows (`*_LISTED`) are output caps, not judgments.
