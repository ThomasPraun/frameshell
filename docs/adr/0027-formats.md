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
3. **In a format other than the primary, an untransformed full-frame media clip covers the frame**: the centre of its picture with the frame's aspect, scaled to fill it (later around a #459 focus point). A clip with a transform or picture keys keeps its fitted placement, offsets mapped from project pixels as before. Multicam program tracks keep their own per-output layout (`shotLayers`, `reframe`): the cover rule skips shots. Generated clips are not cropped: they render at the format's size (decision 12). **A source with alpha on an upper track (a webm or ProRes title, a PNG overlay) is not cropped either: it is fitted whole until per-format overrides exist (decision 13 of #469); on the base track alpha does not change the rule.** The probe records the fact (`media.video.alpha`).
4. **The format owns the frame; a preset gives codec, bitrate and loudness.** A preset asked for whose aspect differs from a format rendered is refused. A preset of the format's aspect sets the output size when asked for, or in the primary format (so `youtube-1440p` still scales a 1080p project, and a 4K project keeps its default preset's size). A default preset (`export.defaultPreset`, else `youtube-1080p`) of another aspect is rendered at the format's own size.
5. **Per-format overrides** (a later slice) may carry `transform`, picture keys, `hidden`, `props`, `elements`, `focus` and subtitle `style`, never timing or audio.
6. **Built-in ids**: `16x9` 1920x1080, `1x1` 1080x1080, `4x5` 1080x1350, `9x16` 1080x1920, each with exactly that canvas. Custom ids are allowed (`web-1600x900`). Ids are lowercase letters, digits and `-`; `png`, `jpg`, `jpeg` and `webp` are reserved because `frameshell frame --format` takes both.
7. **Captions in vertical formats are 1.3x larger** (the low end of the measured range), except in the primary format, whose output stays byte-identical.
8. **The HyperFrames adapter rewrites `data-width`/`data-height` on its render copy** (slice 3, spike in [Evidence](#evidence-hyperframes-render-at-a-format-size-slice-3)). It sets the size of the first `data-composition-id` root of the copied entry (outside scripts, styles and comments) to the render's `RenderContext` width and height, and nothing else, when the declared aspect differs from the render's by more than 1 % (the `sameAspect` rule of export). Of the same aspect, or with no declared size, the copy stays as written: the render keeps the composition's own size and export scales it, so the primary output of an existing composition is unchanged. Sub-compositions keep their sizes. The runtime's `stage()` and `pick()` (ADR 0033) read the root, so a template lays out for the format it renders in.
9. **The preview's 9:16 toggle becomes a switcher over the declared formats** (slice 2).
10. **Handles, Pick and element mode in a format write to that format's override** (slice 4).
11. **A daemon method edits formats**: `format.list`, `format.add`, `format.remove` (CLI `frameshell format list|add|remove`), journaled, undoable, routed through review mode.
12. **Background renders cover only the primary format.** Other formats render on export, on `frame` in that format, or when the preview switches to them (`clip.renders` with `format`, slice 3). `gc` keeps the cached renders of every declared format.

One pure function, `resolveFormat(timeline, project, id)` in `packages/schema/src/formats.ts`, says how a timeline lays out in a format (frame size, `cover`, `captionScale`, and later the timeline with overrides applied). Export, `frame`, and later the preview and review read it.

## Considered options

- **One timeline per format nesting a shared edit timeline.** Rejected: a nested timeline is placed as one picture, so footage inside it cannot be re-blocked per format, and per-format captions need another mechanism.
- **Fork a timeline per format.** Rejected: every cut or text fix after the fork must be repeated in each copy, which is the drift the epic exists to remove.
- **Automatic re-block only, no overrides.** Kept as the first layer; rejected as the whole answer because a lower third placed for 16:9 cannot be moved for 9:16 alone and a person correcting the timeline would have no per-format handle.
- **`render --formats` picking a preset per aspect by itself.** Rejected (decision 4): the format owns the frame, so no preset table per aspect is needed.

## Consequences

- **Schema:** `formats` in `ProjectConfigSchema`, checked after parsing (primary equals `resolution`, unique ids, built-in canvases, even sizes after the first, none in image projects). `ProjectConfigSchema` is strict, so a host older than this ADR refuses a project that has `formats`. JSON Schema regenerated.
- **Compiler:** `RenderInput`/`FrameInput` take `variant` (`cover`, `captionScale`); absent, plans are byte-identical to before, so every existing golden stays. `ExportSource.video.alpha` (from the probe, `MediaProbe.video.alpha`, absent in manifests cached before it: they are probed again) turns the cover off for upper-track clips; `layoutTimeline` is the one place that decides it. Covering is a `crop` in source pixels (`coverCrop`, the multicam tile crop) before `scale` to the frame.
- **Clip renders:** `ClipRenderer.ensure` takes a size; the cache key already holds it, so the key recipe and `CACHE_LAYOUT_VERSION` do not change. `gc` keys every clip at every declared format size.
- **Wire** (`PROTOCOL_VERSION` 79): `render` takes `formats` (one job per format, file `<name>-<format>.<container>`, `renders` in the result); `frame` takes `projectFormat` (its `format` stays the image type); new `format.list`, `format.add`, `format.remove`; new error `FormatNotFound`. CLI `render --formats`, `frame --format <id>`, `format list|add|remove`; MCP tools follow from the registry; the skill documents them.
- **Behaviour change:** `render --preset vertical-1080x1920` (or `frame --preset`) in a 16:9 project is refused with a hint to `format add 9x16` and render that format. A vertical project without an explicit preset now exports at its own size instead of a letterboxed 1920x1080. An `export.defaultPreset` of another aspect than the project likewise gives only codec, bitrate and loudness: a 16:9 project with `defaultPreset: vertical-1080x1920` exports at 1920x1080 instead of letterboxed into 1080x1920, and that render's `warnings` say so.
- **Format journal:** each change is a line in `.frameshell/history/project.config.jsonl`, written before `frameshell.json`, and the result names the call that undoes it (`undo`). Removing the last other format removes `formats`, so `frameshell.json` is byte-identical to before the first add. Since ADR 0036 a line is a keyed config operation (`doc`, `patch` of `format:<id>` keys, `tx`, `txLabel`, hash chain); lines written before it (formats before and after) are read as such.
- **Decision 11 stopgaps, both gone:** since ADR 0036 slice 1 format changes join the caller's transaction, `history` lists them, and `revert` of their `op` or `tx` (and `tx abort`) undoes them; `revert` no longer refuses them with reason `format change`. Since ADR 0036 slice 2 review mode holds them: a format change by anyone but the app (`ui`) waits in the transaction's proposal (`proposal` in the `format.add`/`format.remove` result) instead of being refused with ProposalState `forbidden`.
- **Not covered by slice 1:** overrides, the preview switcher, the HyperFrames resize (slice 3), review per format (#457).
- **Slice 3** (`PROTOCOL_VERSION` 99): the HyperFrames adapter sizes its render copy (decision 8; `plugins/hyperframes/src/frame-size.ts`, its `sameAspect` a hand copy of the schema's with a parity test, since a plugin ships only its own files). `clip.renders` takes `format` (an id of `format.list`): the states of that format's renders, with the missing ones queued, the way the preview switcher (slice 2) will ask; FormatNotFound for an unknown id. The cache key recipe and entry layout are unchanged (the key already holds the size), so `CACHE_LAYOUT_VERSION` stays 1 and primary renders keep their keys and pixels. Renders at another aspect cached by slice 1 builds (letterboxed, never released) keep their keys too: delete `.frameshell/cache/clips` in such a project to render them again. Live pages (ADR 0010) still show the composition at its own size, fitted into the format.

## Implementation plan (each slice ships and is tested alone)

1. Automatic layer for export: schema, `resolveFormat`, compiler cover and captions, renders per format and `gc`, `render --formats`, `frame --format`, `format list|add|remove`, this ADR and the SPEC.
2. Preview switcher over the declared formats, replacing the hard-wired 9:16 toggle, with a parity test against `resolveFormat`.
3. HyperFrames resize spike and adapter change (done), `clip.renders` per format.
4. Per-clip and per-track overrides, `--format` on `clip set` and `track set`, editing in a format from the preview.

## Side effects

- **Existing exports:** unchanged for every same-aspect preset; goldens byte-identical. Changed: an explicit preset of another aspect than the project is refused (decision 4).
- **Plugin API:** `RenderContext.width/height` is now the size being rendered, the project's or a format's. Adapters that ignore it still work; their render is fitted (letterboxed) in that format.
- **Clip render load:** a render per generated clip per exported format, on the single clip queue. Background renders stay primary-only.
- **Not affected:** timing, operations and their inverses, the timeline journal, transcripts, the audio pass and loudness.

## Evidence: HyperFrames render at a format size (slice 3)

Measured on 2026-11-12 with `@hyperframes/producer` 0.9.30 and the managed `chrome-headless-shell`, macOS (Apple silicon), by `plugins/hyperframes/test/format-real.test.ts` (opt-in, `FRAMESHELL_TEST_REAL_HYPERFRAMES=1`).

- **The root's size decides the page.** The producer's compiler reads `data-width`/`data-height` of the first `[data-composition-id]` element as the composition's size, and the capture sets the Chrome viewport to it; its page runtime also reads them for the root. The output file has that size.
- **Nothing else needs editing.** The plain scaffold and every template write `html, body { width: <w>px; height: <h>px }` and a viewport meta with the scaffold size. Rewriting only the root's attributes gave the same frames as also rewriting the meta and adding a last `html, body` sheet: the scaffold's card at 6 % left, 10 % bottom of a 180x320 render from a 320x180 composition, alpha identical at every probed pixel, and the `lower-third` template byte-identical in both variants. The adapter therefore changes the two attributes only.
- **A resized composition equals one scaffolded at that size.** `lower-third` scaffolded at 480x270 and rendered at 270x480, and `end-card` at 270x480 and 360x360, decoded with libvpx at 0.3, 0.8 and 1.5 s: at most 0/255 apart from the same template scaffolded at the render size (the test allows 2/255). `pick()` therefore sees the format.
- **Cost.** A 2 s composition at 270x480 renders in about 5 s alone (10-30 s per pair while other suites ran); a format adds one render per generated clip on the single clip queue, as the Side effects say.
- **Limit.** Layout written in fixed pixels (a hand-written composition that places elements at `left: 1500px`) is not re-blocked by a new size: it needs fractions of `stage()` or `pick()`, as the templates use. The adapter changes the size, never the layout.
