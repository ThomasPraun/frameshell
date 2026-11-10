---
status: accepted
---

# A project style guide with measurable values

Every visual and sound decision of a video (colours, fonts, text sizes, how things move, how loud the music sits under the voice) should come from one place with numbers, not from "make it nice" improvised per pass. Templates (#466), captions (#460), the motion clip type (#465), review (#457), reference analysis (#471) and brand capture (#467) all read or write those values. Decided by the owner on 2026-11-10 in #468 (option A, all recommendations accepted); part of epic #451.

## Context (verified)

- Nothing held a style. The skill improvised one as prose: the reels playbook draft keeps notes in `scripts/style.md`, the critique draft appends banned defaults to "the person's style notes" (PRs #480, #486, unmerged).
- Caption look is hard-coded data: `SUBTITLE_PRESETS` and `resolveSubtitleStyle` in `packages/schema/src/subtitles.ts`, one bundled font (`SUBTITLE_FONT`, ADR 0006).
- The integrated loudness target already lives in `frameshell.json` `export.loudness`.
- `director.json` (ADR 0016) is a template plus partial overrides merged field by field (`resolveDirectorRules`); `people.json` (ADR 0020) is an optional root file validated on write.
- SPEC decision 7: JSON plus published JSON Schema; core is the only writer of project files.
- Measured numbers gathered in #468, #465, #452, #456, #457, #463 and #464: motion personalities (LottieFiles: playful 150-300 ms, premium 350-600 ms with 0 % overshoot and a 350/500/800 ms palette, corporate 200-400 ms with 0-3 %, energetic 100-250 ms with 15-30 %), spring presets, eases by role, stagger budgets; type floors at 1080p (hero 200 px, cards 110 px, nothing readable under 28 px, text from x 120 px); music about 12 dB and effects 20-25 dB under the voice, ducking 7 dB; a voice chain (high-pass 80-90 Hz, denoise, compressor -20 dB 2.5:1); platform UI zones on 9:16 (Instagram measured at 1080x1920: top 220, bottom 380, right 140 px).

## Decision

1. **A self-contained project file.** User styles (later) are a library in `configDir/styles/`, **copied** into the project with `from: { id, sha256 }`, never inherited live: a project renders the same on any machine and render keys depend only on project files.
2. **One `style.json` at the project root**, next to `director.json` and `people.json`. Optional: without it nothing changes.
3. **Plain JSON** (SPEC decision 7 unchanged), schema `style.json` published with the others.
4. **Notes, rules and the banned list live inside `style.json`** as string arrays in the person's words, so critique and review read them as data. The `scripts/style.md` habit migrates by a skill edit.
5. **Loudness, one source per thing.** The integrated LUFS target stays `export.loudness` / the preset. The style holds only relative levels (music and effects under the voice, ducking) and the voice-chain defaults; an effect set on a clip overrides the style's default.
6. **Style edits are journaled** (revertible, held by review mode) with the same project-config journal as formats (#496). Until that exists, the same stopgap as formats: agents may not change the style while review mode is on.
7. **Fonts** are project files under `assets/fonts/` or a short list of bundled OFL faces. Frameshell never downloads fonts; an agent that fetches one imports it as an asset with its credit (#484).
8. **Five motion personalities**: playful, premium, corporate, energetic (the measured numbers) and **calm** (no overshoot, no keyword highlight). A style picks one and overrides single values; objects merge field by field, as `director.json` does over its template.
9. **Safe zones are core data per platform with one home** (`packages/schema/src/safe-zones.ts`). Styles and formats name the platform; nobody copies its numbers. Each zone says whether it was measured.
10. **`style apply`** (later) merges a user style field by field and reports what changed; `--replace` overwrites.
11. **Caption layering: the most specific wins.** Style tokens are the base, a subtitle track's preset overrides them, a per-format override (#469) overrides both.

## Considered options

- **Live inheritance (`extends` a user style at read time).** Rejected: the same project would render differently on another machine or after a user-style edit, render keys would hash a file outside the project, and history and review mode could not see the change.
- **Prose only (`scripts/style.md`).** Rejected: review, captions, templates and the motion type cannot read numbers from prose reliably, and values drift between passes.
- **Numbers in `style.json` plus a `style.md` for notes and the banned list.** Rejected: two files for one concept, and critique wants the banned list as data.
- **Safe zones per style or per format.** Rejected: they are facts about a platform's app, not taste; one table avoids three diverging copies.

## Slice 1 (this ADR's first PR)

- Schema: `packages/schema/src/style.ts` (`StyleFileSchema`, `MOTION_PERSONALITIES`, `STYLE_DEFAULTS`, pure `resolveStyle`: every value as `{ value, source }`, source `file`, `personality` or `default`), `packages/schema/src/safe-zones.ts` (`SAFE_ZONES`), JSON Schema `style.json`.
- Units are checked: hex colours, seconds (maxima catch milliseconds), dB, px on a 1080 short side, font files under `assets/fonts/`. Unknown keys are refused so typos surface.
- Personality numbers: the duration ranges, premium's palette and the overshoot ceilings are the measured ones; the other palettes take each range's ends and middle, and eases, springs and staggers are picked from #465's curves, presets and budgets as starting points. Defaults: no colour, font or brand value (null = not decided, ask the person); type floors and sound levels from the sources above; personality `corporate`.
- Daemon method `style.show { cwd }` (read-only; `style` null without a file; `InvalidProjectFile` on a bad file) with the safe zones of the named platforms, `PROTOCOL_VERSION` 71; CLI `frameshell style show [--json]`; MCP `style_show` from the registry. `file.write` refuses an invalid `style.json`.
- Nothing renders from the style yet; no existing output changes.

## Consequences

- Later slices: user styles (`configDir/styles/` via `resolveAppDirs()`, `style apply`/`save`), a journaled `style set` with the review-mode stopgap of decision 6, captions taking the style as their base (decision 11, with a preview/export parity test), project fonts (metrics read from the file instead of the `SUBTITLE_FONT` constants), and tokens injected into generated clips the way ADR 0021 injects element CSS, entering the clip key only for adapters that opt in.
- Until `style set` exists, agents write `style.json` with `file_write` or their file tools, which is not journaled; the skill tells them not to while review mode is on.
- A host older than this ADR ignores `style.json`; nothing else reads it.
- Safe zones other than Instagram's are from editing guides, marked `measured: false`, to be measured before review (#457) fails a video on them.
