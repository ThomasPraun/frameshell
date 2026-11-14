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
6. **Style edits are journaled** (revertible, held by review mode) with the same project-config journal as formats (#496, ADR 0036).
7. **Fonts** are project files under `assets/fonts/` or a short list of bundled OFL faces. Frameshell never downloads fonts; an agent that fetches one imports it as an asset with its credit (#484). *Amended by ADR 0044 decision 4: brand capture may copy a face a page serves when the font file's own name table names OFL-1.1, Apache-2.0 or UFL, with its credits entry.*
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
- Daemon method `style.show { cwd }` (read-only; `style` null without a file; `InvalidProjectFile` on a bad file) with the safe zones of the named platforms, `PROTOCOL_VERSION` 80; CLI `frameshell style show [--json]`; MCP `style_show` from the registry. `file.write` refuses an invalid `style.json`.
- Nothing renders from the style yet; no existing output changes.

## Slice 2: style set, user styles (built)

- **One write path.** `style.json` is the `style` document of the config journal (ADR 0036): keyed state `style:<path>` per value of `STYLE_PATHS` (`packages/schema/src/style.ts`, derived from `resolveStyle`'s leaves, so a font, a colour, an ease and a list are one key each) plus `style:from`. A value null or absent in the file has no key; a state with no key is no file, so reverting the change that created `style.json` removes it. The document writes only the keys that changed into the file on disk, keeping `$schema`, key order and the rest (`packages/core/src/style/doc.ts`).
- **`style.set { path, value }`** (CLI `frameshell style set <path> <value>`, value JSON else text, `null` removes): checked against the schema before anything is journaled (InvalidOperation `path` or `value`), journaled with `undo` = `style.set` of the old value, held by review mode for anyone but `ui`.
- **User styles** in `<configDir>/styles/<id>.json` (`USER_STYLES_DIR`, only via the daemon's `resolveAppDirs()` dirs), ids lowercase `[a-z0-9_-]`, never a personality id. `style.save <name> [force]` copies the project file out without `from` (not journaled: not a project change; an existing one is kept unless `force`). `style.list` lists them with SHA-256, personality and `error` when invalid.
- **`style.apply <name|personality> [replace]`** (decision 10): a user style merges value by value over the project's values (`replace`: the file becomes exactly the user style) and records `from: { id, sha256 }` of the file's bytes; a personality sets only `motion.personality` (with `replace`, all the file keeps). The result lists every changed value in schema order. An invalid user style is InvalidGlobalConfig; an unknown name is InvalidOperation `not found` with the available ids.
- **`style.show`** gains `view` (an open proposal's version, ADR 0036 decision 4) and `from.status`: `same`, `changed` (the user style was edited since: apply it again to take the edit) or `missing`.
- **`file.write` of `style.json`** (ADR 0036 decision 5) is a `file.write` config operation when it changes a value, written as given at once or held whole by review mode; one that changes no value, or replaces an invalid file, is written at once. The review-mode refusal of slice 1 is gone.
- Wire: `PROTOCOL_VERSION` 98; `ConfigDocSchema` gains `style`.

## Slice 3: captions, caption fonts, tokens in generated clips (built)

- **Captions take the style as their base** (decision 11). `captionTokens` (`packages/schema/src/subtitles.ts`) maps a resolved style onto preset fields: text `colors.ink`, outline `colors.bg`, keyword `colors.keyword` else `colors.accent`, spoken word `colors.highlight` else the accent, font size `type.caption` (new, px on a 1080 short side, null = the preset's), and neither mark when `motion.highlight` is false (`calm`). Alpha is dropped: libass burns opaque text. `resolveSubtitleStyle(track, tokens)` layers default preset, style, then every value of a preset the track names, then the track's own fields; `scaledCaptions` (per format) comes last. A track that names a preset therefore looks as before; one that names none takes the style. `SubtitleStyle.styled` lists the style paths a look took. Values the style leaves null change nothing, so a project without caption values renders the same.
- `colors.highlight` colours the spoken word (its description said "box behind it"; no box is drawn).
- **Caption face.** `fonts.captions` picks the face whatever the preset: a `.ttf` or `.otf` file under `assets/fonts/`, or the bundled Archivo Black when the bundled family is named. A family without a file, a WOFF file, or a file that cannot be read falls back to the bundled face with a warning (`captionFontSource`, `styleCaptionTokens`, one decision for export and preview). The family libass matches and the line metrics (OS/2 win ascent and descent, hhea without OS/2) are read from the file by `parseFontMetrics`, moved to `packages/schema/src/font-file.ts` so the preview parses the same bytes; `subtitleLayout`, the ASS style and anchor use `SubtitleStyle.font`. `fonts.keyword` (a second face inside a line), `weight` and `tracking` do not reach captions yet.
- **Export.** `readCaptionTokens` (`packages/core/src/style/captions.ts`) reads `style.json` only when the timeline has a subtitle track; `RenderInput.captions` / `FrameInput.captions` carry the tokens; `RenderPlan.fonts` lists a project font by its project-relative path, which `writeFonts(dir, fonts, projectDir)` copies into `fonts/` (renamed when it clashes with the bundled file name). `render` adds the fallback warning. Golden plans are unchanged: none has a style.
- **Review** measures cue boxes for safe zones with the caption face's metrics (`captionFontMetrics`).
- **Preview** reads `style.json` and fetches the font through `frameshell-media://` (which now serves `.ttf`/`.otf` under `assets/fonts/`), registers it with `FontFace` per document, and follows edits of `style.json` and `assets/fonts/` (`renderer/src/subtitles/caption-style.ts`). The preview reads the file on disk, also while a review-mode proposal holds style changes.
- **Tokens in generated clips.** `styleTokenCss` (`packages/schema/src/style-tokens.ts`) writes `:root` variables (`--fs-color-<role>` for each colour set, `--fs-font-<role>` with `-weight` and `-tracking`, `--fs-type-*` in px, `--fs-motion-*`) and one `@font-face` per style font file, inlined as base64 data so render and live page need no extra files. The host makes it only for adapters that declare `styleTokens` (plugin API) and only when `style.json` exists (`readStyleTokens`, cached by file stats); its SHA-256 enters `clipCacheKey` as `style`, absent otherwise, so other adapters and projects without a style keep their keys and `CACHE_LAYOUT_VERSION` stays 1. Editing a value outside the sheet (brand text, rules, sound) keeps the keys. `RenderContext.styleCss` reaches the render; the `hyperframes` adapter inserts it as the first stylesheet of its render copy, so a composition that sets a variable itself keeps it. `clip.live` returns `styleCss`; the app's live page and the page `inspect.point` probes insert it first in their head, so element boxes are measured at the rendered values. Templates still copy values in at scaffold time.
- **Invalid `style.json`.** Export and the daemon refuse it where they would use it: every HyperFrames clip gets no render key (`InvalidProjectFile`), and `render`, `frame` and `review` of a timeline with a subtitle track fail until the file is fixed. The preview ignores the invalid file and draws captions from their presets.
- **Family name.** The parser names a face by its Windows family (name id 1), the name libass indexes, and takes the typographic family (16) only without one, so a static weight ("Montserrat ExtraBold") burns in its own face. A family holding a comma, quote or backslash falls back to the bundled face with a warning, in export and preview alike.
- Wire: `PROTOCOL_VERSION` 115 (`clip.live` `styleCss`; `style.show` gains `type.caption`).

## Consequences

- Later slices: `fonts.keyword` as a second caption face, font `weight` and `tracking` in captions, tokens for the Remotion adapter, and templates reading the variables instead of copying values.
- Every write of `style.json` by the daemon goes through the config journal; only a hand edit outside the daemon bypasses it, and shows as a hash gap on `revert` (direct on-disk edits are ADR 0036 slice 5).
- The proposal bar of the app lists only format changes so far; a proposal holding style changes shows them in `proposal status`/`proposal diff` (`style:<path>` keys) and in `style.show` with `view: proposal`.
- A host older than this ADR ignores `style.json`; nothing else reads it.
- Safe zones other than Instagram's are from editing guides, marked `measured: false`, to be measured before review (#457) fails a video on them.
