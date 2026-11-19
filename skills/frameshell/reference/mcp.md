# MCP tools

`frameshell mcp` serves every daemon operation as a typed MCP tool, plus images and the app's UI state. Register it once per project (Claude Code: `claude mcp add frameshell -- frameshell mcp`); the tools act on the project the server started in (each takes an optional `cwd` for another one). A server started outside any project (Claude Desktop runs one for all projects) acts on the project open in the app window the user used last, and each result ends with `Project: <dir>`: check it is the project you mean, since it follows the user switching windows; pass that dir as `cwd` to stay on it. No window open: ask the user to open the project in Frameshell, or pass `cwd`.

## CLI or MCP

Both reach the same daemon, journal the same operations and take the same arguments (`clip.add` → `clip_add`, `--snap-window` → `snapWindow`). Pick per task:

- **MCP only:** seeing pixels (`frame_capture`, `frames_strip`, `review`, `analyze` and `analyze_diff` return the image itself), the app (`ui_state`, `ui_*`), `history_diff`, `clip_renders`, `asset_list`, `export_presets`. `job_list` and `job_cancel` have CLI twins (`job list`, `job cancel`).
- `brand_capture { url: "https://example.com", sections: ["Pricing"] }` is the job behind `frameshell brand capture` (`sections` = `--sections`): the same files, `brand.json`, credits entries and `style` suggestions; see [brand.md](brand.md#capture-from-a-site).
- `brand_import_figma { dir: "/Users/me/Desktop/acme-figma" }` is `frameshell brand import-figma`; `brand_show {}` returns `brand.json` (captures and imports) for `frameshell brand show`.
- **CLI:** loops over many operations from one shell call (dozens of `cut`s), and every environment where the MCP server is not registered.
- **One channel per transaction.** A transaction groups one session's operations: the CLI's session is `FRAMESHELL_SESSION`, the server's is its own. Begin, edit and commit through the same one.

Tool results mirror the CLI's `--json`. Mutating tools return `revision` and `operation.tx`; errors come back as `<ErrorCode>: <message>` plus `data` with the fix.

## Check what you built

Look after every change the viewer would see: an overlay, a transform, a title, a subtitle style, a cut in the middle of a gesture.

- `frame_capture { at: 12.5 }`: the composited frame at that timeline second, rendered by the export compiler, so it matches `render` (works with the app closed). `preset` renders at that preset's size; `projectFormat` (e.g. `9x16`, from `format_list`) shows the frame as that format of the project lays it out. `final: true` draws a Blender clip from a Cycles final of that one frame (`yes: true` only after the person agreed when it fails with ConfirmationRequired).
- `cover { text: "nunca" }`: a cover image (a frame with one big word over it) written to a file, not returned as an image; open `path` with your image tool. Same arguments as `frameshell cover`; `readability.readable: false` means the word is too small to read at thumbnail size.
- `export_otio { timeline: "main" }`: the timeline as an OpenTimelineIO `.otio` file for an editor, written to `exports/<timeline>.otio` (or `out`, which must end in `.otio`); read-only and derived. Same arguments as `frameshell export otio` (`absolutePaths: true` for `file://` media URLs). Generated and nested clips keep their slot as missing media, dissolves between butted clips are `Transition.1`, and the sound of video-track media clips is mirrored on one extra Audio track per video track (`<video track> sound`, linked by `clipId`); everything it leaves out (program tracks, subtitles, dips and fades, transition shapes, transforms, grades, audio effects, sound fades) or only keeps as metadata (clip gain) is named in `warnings`: pass those on to the person. An image project is refused. The app has File > Export OpenTimelineIO… for the person.
- `clip_renders { timeline: "main" }`: whether each generated clip's render is ready. Calling it moves the renders it reports to the front of the render queue (`job_list` shows `priority` and `position` of queued ones; a long render in progress is never interrupted, `job_cancel` stops it). Background renders cover only the primary format; `format: "9x16"` reports that format's renders and starts the missing ones (`render --formats` and `frame_capture` with `projectFormat` wait for them anyway).
- `frames_strip { from: 0, to: 30, count: 9 }`: one contact sheet of evenly spaced frames with each tile's time and clip. Use it to review a whole edit or find where a shot changes.
- `review { file: "exports/draft.mp4" }` (or no `file`: the timeline): the sheets of a whole film as images, labelled with times; see [critique.md](critique.md). `sheets` picks `contact`, `phone`, `motion`, `seam`, `safe` or `metrics` (the numbers: `metrics` in the result and `metrics.json`, with `sync`, `seam`, and with `file` + `preset` the `delivery` check; `loop: true` for a film that repeats; a project's `requirements.json` is judged into `metrics.requirements` and `metrics.waived`); `from`/`to` limit it. Without MCP: `frameshell review`, then open the PNGs it prints.
- `analyze { file: "references/reel.mp4" }`: measure a reference video (#471): contact and shots sheets as images, then the shot table, cuts per minute, palette, look, rhythm, cuts (jump cuts and punches), events, curve, ink, sync, loudness, tempo and `labels` (MEASURED, ESTIMATED or DECISION) as JSON; written to `.frameshell/analysis/<name>/`. See [reference-video.md](reference-video.md). Without MCP: `frameshell analyze <video>`.
- `analyze_diff { file: "exports/reel.mp4", reference: "references/reel.mp4" }`: compare our film with a reference (#471): the side-by-side sheet as an image, then the alignment, energy, SSIM and `labels` as JSON; written to `.frameshell/analysis/<name>/`. See [reference-video.md](reference-video.md). Without MCP: `frameshell analyze diff <film> <reference>`.
- Without MCP: `frameshell frame --at 12.5 --out /tmp/f.png`, then open the PNG with your image-reading tool.
- `inspect_point { at: 12.5, x: 0.71, y: 0.14 }` (or `unit: "pixel"` with project pixels): the clips under that point, topmost first, the one seen there (`target`), and in a generated clip the DOM element painting it, as the user's Pick tool reports it (`elements[0]`, then its ancestors). CLI: `frameshell inspect --at 12.5 --point 0.71,0.14`. `segment: true` (CLI `--segment`) on a photo of an image project also returns `segment` (see [image-projects.md](image-projects.md)).
- `clip_verify { timeline, clip, probes?, tolerance? }`: whether a generated (motion) clip paints the same picture cold and after a reseek, within 2/255 per channel; `ok` false names the worst time, pixel and element. CLI: `frameshell clip verify <clip>`.
- `grade_analyze { timeline, clip, at?, from?, to?, samples? }`: the levels of a media or generated clip's source picture (a generated clip: its cached draft render, made first when missing; refused with transparency or as a nested timeline, use `grade_compare`) (luma min, shadows, mean, highlights, max; saturation; warmth; tint) and a bounded correction `suggestion` in the fields of `clip_set` `grade` (exposure, temperature, tint, contrast, saturation; absolute numbers, a LUT stays), with a reason per number. Never applied: check the look with `frame_capture`, then `clip_set` with `grade`. CLI: `frameshell grade analyze <clip>`.
- `clip_compare { timeline, clip, looks, at?, out?, tileWidth?, projectFormat?, final?, yes? }`: one frame of a generated clip (`blender`, `hyperframes`, ...) under up to 11 `looks` (each `{ name?, props?, source? }`: `props` merged over the clip's own, `null` drops a key; `source` another project file, e.g. a copy of the `.blend`) next to the clip as it is, returned as one labelled sheet image; each tile's `flags` are the `clip set` flags that keep its props. A variant not rendered before is rendered first (a Blender clip: its draft); `final: true` draws each tile from a final of that frame instead (Cycles), with `yes: true` only after the person agreed when it fails with ConfirmationRequired. Never applied: keep one with `clip_set` `props`. CLI: `frameshell clip compare <clip> --look ...`.
- `grade_looks {}`: the built-in looks (`warm`, `cool`, `filmic`, `punchy`, `faded`, `mono`) with a summary and their five plain grade numbers each (no LUT files); keep one by passing its numbers to `clip_set` `grade`. CLI: `frameshell grade looks`, `clip set --grade-look <name>`.
- `grade_compare { timeline, clip, looks, at?, out?, tileWidth?, projectFormat? }`: one frame of a media, generated or nested timeline clip under up to 16 `looks` (each a whole `clip_set` `grade` plus an optional `name`; fields left out are neutral; `look: "warm"` starts a look from a built-in one, the fields given win) next to a neutral baseline and the clip's own grade, returned as one labelled sheet image; each tile's `flags` are the `clip set` flags that keep it. Never applied: keep one with `clip_set` `grade`. CLI: `frameshell grade compare <clip> --look ...`.

Done = you looked at a frame inside every changed visual element's time span and it shows what the user asked for.

## What the user sees: `ui_state`

References the person sent you with "Chat about this" while you run outside the app's terminals: `inbox_take` (see [selection.md](selection.md)); `inbox_wait` waits for the next one.

`ui_state` returns the app's playhead, whether it plays, the selection (`clips`, `words` as transcript + word id, a time `range`, the History entry marked, a preview `region` with the clips under it, the `points` picked with the Pick tool with the clip and element at each), the open editor tabs and the visible timeline span. Read it to resolve "this clip", "here", "these words" when the prompt has no `[frameshell]` line. `{ connected: false }` means no app window shows the project: ask the user instead.

## Take the user somewhere: `ui_*`

Navigation only; each returns `ui_state` after the move.

| Tool | Use |
|---|---|
| `ui_seek { at }` | Put the playhead on a moment you want them to watch: seconds, a marker (`hook+0.5`) or `beat:N` / `bar:N`, read on the timeline the app shows. |
| `ui_play` / `ui_pause` | Play from the playhead / stop. |
| `ui_select { clips?, words?, range? }` | Point at what you mean; replaces their selection. |
| `ui_select { person: { id, what? } }` | Show the user where someone speaks (`what: "onscreen"`: is on screen): their spans and words selected, as a click in the People panel does. `id` is the person id or exact name. |
| `ui_select { points: [{ at, x, y }] }` | Show the user the element you mean: each point is inspected as `inspect_point` does and outlined as a pick in their preview ("is this the box?"). |
| `ui_open_file { file }` | Open a script, composition or timeline in an editor tab. |
| `ui_show_tx_diff { target }` | Open History on your `tx_…`/`op_…` with its changes marked on the timeline: the way to walk them through an edit. |

They fail with `UiNotConnected` when no app window shows the project.

## Resources

Read-only views, same content as the CLI's `--json`: `frameshell://status`, `frameshell://timelines/{timeline}`, `frameshell://timelines/{timeline}/history`, `frameshell://transcripts/{file}`, `frameshell://scripts/{file}/outline`. Subscribed timeline resources update on every change from any client.
