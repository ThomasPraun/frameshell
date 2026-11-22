# Batch variants

One finished edit, many files: the same video in other languages, for other products, in other sizes. `frameshell batch` patches a template timeline once per data row, in memory, and renders each row as an ordinary `render`. Commands assume the session rule of [SKILL.md](../SKILL.md).

## When to batch

- **Batch:** the edit is done and what changes is data: a title or price per product, the voiceover and captions per language, a different clip in the same slot, every format of the project.
- **Do not batch:** the rows would need different timing, different cuts or a different structure. A swapped file keeps the clip's in, out and placement, so a longer take does not make the video longer. Build those one by one, or fix the template first.
- **Never a way to mass-produce episodes.** YouTube demonetises repetitive, mass-produced content. A series, a channel's weekly show or "one video per topic" needs its own story, voice and visuals each time. Batch is for variants of one piece (sizes, languages, product rows), not for one template filled N times. When the request is the second kind, say so before building it and offer to make each video properly.

## The batch file

`launch.batch.json` (JSON Schema `batch.json`):

```json
{
  "schemaVersion": 1,
  "template": "main",
  "slots": { "title": "c_8f2a1b.props.title", "voice": "c_3d9e04.asset" },
  "rows": [
    { "id": "en", "title": "Launch day" },
    { "id": "es", "title": "Día de lanzamiento", "voice": "assets/voiceover/es/all.wav" }
  ],
  "formats": ["16x9", "9x16"]
}
```

- `template` is a timeline of the project (default `main`); a single generated clip is a timeline holding that one clip.
- A slot is `<clipId>.props.<dot.path>` (written over an adapter clip's props, checked by its props schema like `clip set`), `<clipId>.props` (the prop named like the slot: `"title": "c_8f2a1b.props"` is `c_8f2a1b.props.title`, so a template's declared props become slot names without repeating them) or `<clipId>.asset` (a media clip's file swapped). Read the ids with `frameshell timeline show`. Slots reach top-level clips only, not `elements`, nested timelines or per-format props. When the clip's composition declares its props (a HyperFrames `data-composition-variables` list), a props slot naming another prop fails the row with `reason: "unknown prop"` and the declared names, in `--dry-run` too (a typo such as `titel` never renders the default); a composition that declares none takes any prop.
- A third slot kind, `voiceover`, places a script's takes per row (see Per-language rows below). A file has at most one.
- A row is its `id` (lowercase letters, digits and `-`, unique: it names the file) plus one value per slot. A slot a row leaves out keeps the template's value. Rows are written in the file (`rows`) or read from a CSV file next to it (`"csv": "launch.csv"`, relative to the batch file; give one, not both).
- Every row x format is checked before anything renders; a bad row fails the call naming its `row` and `slot`. Check with `--dry-run`.

```sh
frameshell batch launch.batch.json --dry-run
frameshell batch launch.batch.json
```

Rows render one at a time into `exports/launch/<row>.mp4` (`<row>-<format>.mp4` with formats), and `exports/launch/manifest.json` keeps each row x format's `status`, `output`, `error` and timings. Nothing is written to `timelines/`, so no history entry and no review proposal for a batch.

## Rows from a CSV file

For many rows or rows from a spreadsheet, write them as CSV and name the file in the batch file instead of `rows`:

```
id,title,price:number,voiceover
en,Launch day,9.5,scripts/launch-en.md
es,Día de lanzamiento,9.5,scripts/launch-es.md
```

```json
{ "schemaVersion": 1, "slots": { "title": "c_8f2a1b.props.title", "price": "c_8f2a1b.props.price", "voiceover": "voiceover" }, "csv": "launch.csv" }
```

- The header is `id` and slot names, in any order; a slot with no column keeps the template's value for every row, and an empty cell leaves that slot to the template for that row (so a text prop cannot be set to an empty string). The delimiter is the comma, `;` or tab the header uses (Spanish spreadsheets export `;`); quoted cells may hold the delimiter, quotes doubled and line breaks.
- A cell is read by the slot's type: a props slot takes the type of the value the template clip already has at that path (a number stays a number, `true`/`false`/`yes`/`no`/`1`/`0` for a boolean, a list or object as JSON); asset and voiceover cells are paths. A prop the template does not have is text unless the header says `price:number`, `:boolean`, `:json` or `:text`, which also overrides the template.
- Every wrong cell is reported at once with its line and column (`line 4, column price: expected a number, got "x"`), the first 20 and a count of the rest; fix them and run `--dry-run` again.
- Edit the CSV and re-run: a row whose cells changed renders again by itself (see Re-run a row).

## Re-run a row

Read the manifest, then render only what needs it:

```sh
frameshell batch launch.batch.json --failed            # rows not done: failed, canceled, or left running by a stopped daemon
frameshell batch launch.batch.json --rows es,fr        # these rows
frameshell batch launch.batch.json --rows en..fr       # from en to fr, in the file's order
frameshell batch launch.batch.json --rows es --force   # again although it is done
```

- Without `--force`, a chosen row whose renders are all `done` with the files still in place is skipped and listed as skipped, unless its data changed: each manifest entry keeps a `hash` of the row's cells, the slots and the template timeline's content, and a `done` row whose hash differs renders again by itself, listed as `changed` (so an edited row, CSV cell, slot or template needs no `--force`). A manifest from before hashes counts as unchanged, and so does a swapped file edited in place under the same name or an edit to `preset`/`quality`: pass `--force` (or `--rows <id> --force`) for those.
- Only the chosen rows are checked and rendered, so a bad row elsewhere does not block the re-run. The other rows keep their manifest entries.
- `--failed` needs the manifest of this batch file; `--failed --rows ...` re-runs the failed ones among those rows.

## Stop a batch

```sh
frameshell batch cancel launch.batch.json     # from another terminal; Ctrl-C in the running `batch` asks the same
```

No further row is queued, the render of the row in progress is canceled, and the manifest says `"state": "canceled"` with those rows `canceled` (rows already `done` keep their files). Re-run what is left with `--failed`. It fails when no batch is rendering into that `out`.

MCP: `batch_render` takes `file`, `out`, `formats`, `rows` (an array of ids or `first..last`), `failed`, `force`, `review`, `dryRun`, `yes` (only after the person agreed to wait for Blender finals estimated over 5 minutes in all: without it the call fails with ConfirmationRequired; the CLI flag is `--yes`). `batch_cancel` takes `file` and `out`.

## Review each row

```sh
frameshell batch launch.batch.json --review
```

Each rendered file is reviewed as `frameshell review --file` does (metrics only, one at a time while the next row renders; slower, so off by default). The manifest entry gets `review`: `verdict` (`fail` when `requirements.json` fails, `warn` for craft warnings such as `static` or `peak`, else `pass`), `warnings`, `failed`, `checks` and the `run` whose `.frameshell/review/<run>/metrics.json` holds the detail. The manifest says `running` until the last review ended; the command exits 1 when a render failed or a verdict is `fail`.

- A failed render has no review; a review that cannot run (no ffmpeg) leaves the render `done` and the entry's review `error`.
- A row skipped as done is reviewed too when its entry has no finished review, so `--review` on a finished batch only reviews. Re-reviewing after an edit needs `--force`.
- Clip-specific requirements (`clip.appearsBy`...) are skipped on a file; the per-row export check against the preset is made only for a batch without `quality` (a draft differs by design) and plans the template, not the row.
- A `fail` row is the one to look at: open `.frameshell/review/<run>/metrics.json`, or `frameshell review --file <output>` with sheets.

## Per-language rows

One row per language, swapping the voiceover file and setting the texts:

- **One take or mix per language:** the voice slot is the `asset` of the voiceover clip; the new file must be at least as long as the clip's out and have an audio stream.
- **A script per language (phrase clips):** a `voiceover` slot (`"voiceover": "voiceover"`) takes the script of the row, `"scripts/launch-es.md"`, or `{ "script": "scripts/launch-es.md", "lines": ["hook-1"], "at": { "hook-2": "hook" }, "tempo": { "hook-1.2": 1.1 }, "start": 0.5, "gap": 0.4, "track": "t_a", "replace": true }` with the arguments of `voiceover place` (see [voiceover.md](voiceover.md)). Each row gets the phrase clips `voiceover place` would put on the template, in memory, with its planner and rules: phrases at the spacing of the take, anchors in script order, no overlap, the 12 ms fades, tempo. The voice goes on the template's audio track named `Voiceover` (or `track`), made when absent, and starts after what is already there (or at `start`/`at`, and then must not overlap it): leave the template without a voiceover of its own, or pass `replace` to swap the clips that play the same takes.
- Make the takes first with [voiceover.md](voiceover.md) (`voiceover generate` per script, under `assets/voiceover/<script>/`); batch **never calls `voiceover.generate`**, so it never spends money, and a line with no take fails the row naming it. Missing takes are made and confirmed with the person before the batch.
- **Before the batch, check each language's texts fit.** A German or Spanish line is often a third longer than the English one and breaks out of its button or past the frame. Per generated clip with text slots, `frameshell clip text-fit <clip> --props '{"title":"…","cta":"…"}'` with each row's values: exit 1 names the element, its text and how many pixels it passes by. Nothing is written; shorten the text with the person or widen the box (template props, `clip set --elements`) before rendering. Words on a canvas or in SVG (3D titles) are not measured: judge those in `frame` stills.
- When a subtitle track follows the voiceover's track, each language's file (or each take) needs its transcript first (`frameshell transcribe <asset>`); the row fails naming the file without one.
- A longer take in another language does not stretch the picture, but placed phrases do lengthen the video when the voice runs past the template: the row's warnings say so (`The voiceover makes the video 14.2 s long, 2.2 s longer than the template's 12 s`). Tell the person which rows are longer, and shorten the text or lengthen the template first.
- On-screen text is an adapter clip's prop: a text slot per language. Render one row first (`--rows es`) and look at it with `frameshell review --file exports/<batch>/es.mp4` before the rest.
- Every file a row swaps in goes through the credits check like any placed asset: the manifest entry carries the warnings, and `frameshell credits` lists what lacks a source.
