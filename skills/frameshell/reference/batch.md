# Batch variants

One finished edit, many files: the same video in other languages, for other products, in other sizes. `frameshell batch` patches a template timeline once per data row, in memory, and renders each row as an ordinary `render`. Commands assume the session rule of [SKILL.md](../SKILL.md).

## When to batch

- **Batch:** the edit is done and what changes is data: a title or price per product, the voiceover and captions per language, a different clip in the same slot, every format of the project.
- **Do not batch:** the rows would need different timing, different cuts or a different structure. A swapped file keeps the clip's in, out and placement, so a longer take does not make the video longer. Build those one by one, or fix the template first.
- **Never a way to mass-produce episodes.** YouTube demonetises repetitive, mass-produced content. A series, a channel's weekly show or "one video per topic" needs its own story, voice and visuals each time. Batch is for variants of one piece (sizes, languages, product rows), not for one template filled N times. When the request is the second kind, say so before building it and offer to make each video properly.

## The batch file

`launch.batch.json` (JSON Schema `batch.json`; JSON only, no CSV):

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
- A slot is `<clipId>.props.<dot.path>` (written over an adapter clip's props, checked by its props schema like `clip set`) or `<clipId>.asset` (a media clip's file swapped). Read the ids with `frameshell timeline show`. Slots reach top-level clips only, not `elements`, nested timelines or per-format props.
- A row is its `id` (lowercase letters, digits and `-`, unique: it names the file) plus one value per slot. A slot a row leaves out keeps the template's value.
- Every row x format is checked before anything renders; a bad row fails the call naming its `row` and `slot`. Check with `--dry-run`.

```sh
frameshell batch launch.batch.json --dry-run
frameshell batch launch.batch.json
```

Rows render one at a time into `exports/launch/<row>.mp4` (`<row>-<format>.mp4` with formats), and `exports/launch/manifest.json` keeps each row x format's `status`, `output`, `error` and timings. Nothing is written to `timelines/`, so no history entry and no review proposal for a batch.

## Re-run a row

Read the manifest, then render only what needs it:

```sh
frameshell batch launch.batch.json --failed            # rows not done: failed, canceled, or left running by a stopped daemon
frameshell batch launch.batch.json --rows es,fr        # these rows
frameshell batch launch.batch.json --rows en..fr       # from en to fr, in the file's order
frameshell batch launch.batch.json --rows es --force   # again although it is done
```

- Without `--force`, a chosen row whose renders are all `done` with the files still in place is skipped and listed as skipped. After editing a row or the template, pass `--force` (or `--rows <id> --force`): the manifest does not know the data changed.
- Only the chosen rows are checked and rendered, so a bad row elsewhere does not block the re-run. The other rows keep their manifest entries.
- `--failed` needs the manifest of this batch file; `--failed --rows ...` re-runs the failed ones among those rows.

MCP: `batch_render` takes `file`, `out`, `formats`, `rows` (an array of ids or `first..last`), `failed`, `force`, `dryRun`.

## Per-language rows

One row per language, swapping the voiceover file and setting the texts:

- The voice slot is the `asset` of the voiceover clip; the new file must be at least as long as the clip's out and have an audio stream. Make the takes first with [voiceover.md](voiceover.md) (one take or mix per language under `assets/voiceover/`); batch **never calls `voiceover.generate`**, so it never spends money. Missing takes are made and confirmed with the person before the batch.
- When a subtitle track follows the voiceover's track, each language's file needs its transcript first (`frameshell transcribe <asset>`); the row fails naming the file without one. A longer take in another language does not stretch the video: tell the person which rows are too long and shorten the text or the template first.
- On-screen text is an adapter clip's prop: a text slot per language. Render one row first (`--rows es`) and look at it with `frameshell review --file exports/<batch>/es.mp4` before the rest.
- Every file a row swaps in goes through the credits check like any placed asset: the manifest entry carries the warnings, and `frameshell credits` lists what lacks a source.
