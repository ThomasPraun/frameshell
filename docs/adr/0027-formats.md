---
status: accepted
---

# Formats of a project: one edit, re-blocked per format

Ticket #469 (epic #451) asks for 16:9, 1:1, 4:5 and 9:16 deliveries from one project, each re-blocked rather than letterboxed. The owner decided on 2026-11-10 (option A of the proposal on #469, every recommendation accepted): formats live in the project, the automatic layout comes first, and sparse per-format overrides follow where it is wrong. This ADR records that decision. It amends SPEC §3.5 step 4 (crop-to-fill was "a later option"), §5.2 and §6.5.

## Context (verified in the tree, 2026-11-10)

- One frame per project: `frameshell.json` has a single `resolution` (`packages/schema/src/project.ts`). A timeline has no size of its own.
- Export sizes came from presets (`youtube-1080p`, `youtube-1440p`, `vertical-1080x1920`). Media whose aspect differs from the output was letterboxed (`layerRect` fits, then maps `transform.x/y` from project pixels to output pixels). The compiler already took any output size.
- Multicam re-blocks already: each angle's `reframe` keys are a point in the source, and `shotLayers` lays the tiles out per output size (ADR 0016).
- Generated clips render at the project size (`RenderContext.width/height`), and the clip cache key holds `fps`, `width` and `height`, so a render at another size is another cache entry with no key change.
- Subtitles size from the frame's short side (`subtitleLayout`), so captions keep their pixel size in 9:16.
- Timing never depends on the frame: clips, transitions, keys and audio are format-free.
- Measured rules from the #469 comments: canvases 1920x1080, 1080x1080, 1080x1350, 1080x1920; the first format listed is the primary one; vertical type is about landscape x 1.3-1.35; a variant is never a crop of another and its layout is chosen by the variant's name.

## Decision

1. **Formats are project-wide**, in `frameshell.json` `formats: [{ id, width, height }]`.
2. **The first format is the primary one and equals `resolution`.** A project without `formats` has one format, its resolution, with the built-in id of that canvas or `<width>x<height>`. Existing projects, and the primary output of every project, are unchanged.
3. **In a format other than the primary, an untransformed full-frame media clip covers the frame**: the centre of its picture with the frame's aspect, scaled to fill it (later around a #459 focus point). A clip with a transform or picture keys keeps its fitted placement, offsets mapped from project pixels as before. Multicam program tracks keep their own per-output layout (`shotLayers`, `reframe`): the cover rule skips shots. Generated clips are not cropped: they render at the format's size (decision 12).
4. **The format owns the frame; a preset gives codec, bitrate and loudness.** A preset asked for whose aspect differs from a format rendered is refused. A preset of the format's aspect sets the output size when asked for, or in the primary format (so `youtube-1440p` still scales a 1080p project, and a 4K project keeps its default preset's size). A default preset (`export.defaultPreset`, else `youtube-1080p`) of another aspect is rendered at the format's own size.
5. **Per-format overrides** (a later slice) may carry `transform`, picture keys, `hidden`, `props`, `elements`, `focus` and subtitle `style`, never timing or audio.
6. **Built-in ids**: `16x9` 1920x1080, `1x1` 1080x1080, `4x5` 1080x1350, `9x16` 1080x1920, each with exactly that canvas. Custom ids are allowed (`web-1600x900`). Ids are lowercase letters, digits and `-`; `png`, `jpg`, `jpeg` and `webp` are reserved because `frameshell frame --format` takes both.
7. **Captions in vertical formats are 1.3x larger** (the low end of the measured range), except in the primary format, whose output stays byte-identical.
8. **The HyperFrames adapter rewrites `data-width`/`data-height` on its render copy**, after a short spike against the producer version in use (slice 3). Until then a HyperFrames render at another size is letterboxed by its own page.
9. **The preview's 9:16 toggle becomes a switcher over the declared formats** (slice 2).
10. **Handles, Pick and element mode in a format write to that format's override** (slice 4).
11. **A daemon method edits formats**: `format.list`, `format.add`, `format.remove` (CLI `frameshell format list|add|remove`), journaled, undoable, routed through review mode.
12. **Background renders cover only the primary format.** Other formats render on export, on `frame` in that format, or when the preview switches to them. `gc` keeps the cached renders of every declared format.

One pure function, `resolveFormat(timeline, project, id)` in `packages/schema/src/formats.ts`, says how a timeline lays out in a format (frame size, `cover`, `captionScale`, and later the timeline with overrides applied). Export, `frame`, and later the preview and review read it.

## Considered options

- **One timeline per format nesting a shared edit timeline.** Rejected: a nested timeline is placed as one picture, so footage inside it cannot be re-blocked per format, and per-format captions need another mechanism.
- **Fork a timeline per format.** Rejected: every cut or text fix after the fork must be repeated in each copy, which is the drift the epic exists to remove.
- **Automatic re-block only, no overrides.** Kept as the first layer; rejected as the whole answer because a lower third placed for 16:9 cannot be moved for 9:16 alone and a person correcting the timeline would have no per-format handle.
- **`render --formats` picking a preset per aspect by itself.** Rejected (decision 4): the format owns the frame, so no preset table per aspect is needed.

## Consequences

- **Schema:** `formats` in `ProjectConfigSchema`, checked after parsing (primary equals `resolution`, unique ids, built-in canvases, even sizes after the first, none in image projects). `ProjectConfigSchema` is strict, so a host older than this ADR refuses a project that has `formats`. JSON Schema regenerated.
- **Compiler:** `RenderInput`/`FrameInput` take `variant` (`cover`, `captionScale`); absent, plans are byte-identical to before, so every existing golden stays. Covering is a `crop` in source pixels (`coverCrop`, the multicam tile crop) before `scale` to the frame.
- **Clip renders:** `ClipRenderer.ensure` takes a size; the cache key already holds it, so the key recipe and `CACHE_LAYOUT_VERSION` do not change. `gc` keys every clip at every declared format size.
- **Wire** (`PROTOCOL_VERSION` 71): `render` takes `formats` (one job per format, file `<name>-<format>.<container>`, `renders` in the result); `frame` takes `projectFormat` (its `format` stays the image type); new `format.list`, `format.add`, `format.remove`; new error `FormatNotFound`. CLI `render --formats`, `frame --format <id>`, `format list|add|remove`; MCP tools follow from the registry; the skill documents them.
- **Behaviour change:** `render --preset vertical-1080x1920` (or `frame --preset`) in a 16:9 project is refused with a hint to `format add 9x16` and render that format. A vertical project without an explicit preset now exports at its own size instead of a letterboxed 1920x1080.
- **Format journal:** each change is a line in `.frameshell/history/project.config.jsonl` (op id, author, args, formats before and after), and the result names the call that undoes it (`undo`). Removing the last other format removes `formats`, so `frameshell.json` is byte-identical to before the first add.
- **Not covered by slice 1:** overrides, the preview switcher, the HyperFrames resize, review per format (#457), `revert` of a format change by its id and review-mode routing of format changes (both need history and proposals to cover `frameshell.json`, which today hold timelines only; format changes apply at once, like `transcription.set` and `file.write` of `frameshell.json`).

## Implementation plan (each slice ships and is tested alone)

1. Automatic layer for export: schema, `resolveFormat`, compiler cover and captions, renders per format and `gc`, `render --formats`, `frame --format`, `format list|add|remove`, this ADR and the SPEC.
2. Preview switcher over the declared formats, replacing the hard-wired 9:16 toggle, with a parity test against `resolveFormat`.
3. HyperFrames resize spike and adapter change.
4. Per-clip and per-track overrides, `--format` on `clip set` and `track set`, editing in a format from the preview.

## Side effects

- **Existing exports:** unchanged for every same-aspect preset; goldens byte-identical. Changed: an explicit preset of another aspect than the project is refused (decision 4).
- **Plugin API:** `RenderContext.width/height` is now the size being rendered, the project's or a format's. Adapters that ignore it still work; their render is fitted (letterboxed) in that format.
- **Clip render load:** a render per generated clip per exported format, on the single clip queue. Background renders stay primary-only.
- **Not affected:** timing, operations and their inverses, the timeline journal, transcripts, the audio pass and loudness.
