---
status: accepted
---

# Asset provenance and a credits ledger

A video made with an agent pulls in third-party material (textures, sounds, fonts, music). A CC BY file needs a credit in the video description, and an agent that forgets where a file came from leaves the person with a legal risk and no way to know. Part of the reels and motion epic (#451), ticket #484.

## Decision

1. **A ledger at the project root, `credits.json`** (`schemaVersion`, `assets[]`): per asset the project-relative path, the content hash (`sha256:<hex>`, as `asset.list` reports it), and optional `sourceUrl` (http or https), `licence`, `author`, `title`, an explicit `credit` line, and the day it was written. At most one entry per asset. It sits beside `people.json`, not inside `assets/`: the media watcher ingests every file under `assets/`, and the ledger is a project file the daemon alone writes.
2. **It is written when provenance is given**, never guessed: `asset.import` with `sourceUrl`, `licence`, `author`, `title` or `credit` records each imported file; `credits.set` records or completes an entry for a file already in `assets/`. Fields left out keep their value while the file's content is unchanged and start over when it changed. A plain import writes nothing, so a project of the person's own footage never gets a ledger.
3. **A verdict is derived, never stored.** `credits.check` reads every timeline (clips, multicam angles and mics) and judges each placed asset: `unrecorded`, `no-licence`, `no-credit`, `changed` (content differs from the recorded hash), `missing`, or `ok`. **Unverified never counts as a pass**: no entry, an absent or `unknown` licence, and changed content all fail. CC0, public domain, `own` and Unlicense need no credit; every other licence text, including ones Frameshell does not know, needs a credit line, which needs an author or an explicit `credit`. The CLI `frameshell credits` exits 1 on any failure and prints the credit block for the description.
4. **The credit line is built on demand** from title, author, licence (with the Creative Commons deed link) and source, so it cannot go stale; an explicit `credit` replaces it.
5. **Export warns, only quietly.** `render` adds one warning naming placed assets with no verified provenance, but only in a project whose ledger already holds an entry. A project of its own footage is not nagged on every export. The warning reads entries, not files, so a render never waits on hashing; `credits.check` is the gate and also compares content.
6. **The skill carries the habits**: prefer CC0, never use an asset without a licence, read the first bytes of every download (an HTML page means a refusal), record the source in the same step as the import.

## Considered options

- **`assets/CREDITS.json`**: rejected, the asset watcher would ingest it as media.
- **A field per asset in the timeline**: rejected, the same file placed twice or on several timelines would repeat it, and moving a clip must not move legal facts.
- **Warn on every unrecorded asset in every project**: rejected, camera footage would drown the one warning that matters. The gate is `credits`.
- **Storing a pass/fail in the file**: rejected, a file that changed or a licence table that grew would leave a stale pass.

## Consequences

- New daemon methods `credits.set` and `credits.check` and new optional params and a `provenance` result field on `asset.import`: protocol 71. MCP tools `credits_set`, `credits_check` follow from the registry; the CLI gains `credits`, `credits set` and the `import` flags; the skill gets `reference/credits.md`.
- `credits.json` is a new published schema (`packages/schema/json-schema/credits.json`).
- Not done here: asset-fetching plugins calling `credits.set` themselves, the review (#457) warning, fonts and files that generated clips read from `compositions/` (the ledger covers what timelines place from `assets/`).
