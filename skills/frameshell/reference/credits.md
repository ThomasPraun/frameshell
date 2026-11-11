# Asset provenance and credits

A video made with an agent pulls in third-party material: textures, sounds, fonts, logos, music. A CC BY file needs a credit in the video description, and a file whose licence nobody wrote down is a legal risk for the person. `credits.json` at the project root is the ledger: for each outside asset the source URL, licence, author, title, the SHA-256 of the file and the day it was recorded. The credit line is built from it, never typed twice.

## Rules for fetching assets

1. **Prefer CC0 and public domain.** Pick a CC BY file only when no CC0 one fits, and say so to the person: it makes the video need a credit.
2. **Never use an asset without a licence.** If the page does not state one, do not use the file. "Free" and "royalty free" are not licences: ask the person.
3. **Check the first bytes of every download before importing.** A refusal, a login wall or a rate limit usually arrives as an HTML page saved under the file's name. `head -c 16 file` must show the format's signature (OggS for Ogg, ID3 for MP3, RIFF for WAV, PNG after a `\x89` byte, `ftyp` at byte 4 for MP4); a `<` or `<!DOCTYPE` means the download failed. Delete it and tell the person; do not retry through another route.
4. **Record where it came from in the same step as the import.** Copy the licence and author from the source page, not from memory.

## Import with provenance

```sh
frameshell import /tmp/rain.ogg --wait \
  --source-url https://openverse.org/audio/9f2c --licence CC-BY-4.0 --author "Ana Pérez" --title "Rain on a window"
frameshell credits set assets/old.ogg --licence CC0-1.0 --source-url https://polyhaven.com/a/rock    # a file already imported
frameshell credits set assets/talk.mp4 --licence own                                                  # the person's own footage
```

Give one source per `import` call: its flags apply to every file of the call. Flags left out of `credits set` keep their value while the file is unchanged; a file that changed starts a new entry.

Licence ids: `CC0-1.0`, `public-domain`, `own` need no credit. `CC-BY-4.0`, `CC-BY-SA-4.0`, `CC-BY-NC-4.0`… need one. Any other text (`Pixabay Content License`) is kept as written and treated as needing credit. Absent or `unknown` is unverified.

MCP: `asset_import` takes `sourceUrl`, `licence`, `author`, `title`, `credit`; `credits_set` and `credits_check` mirror the commands.

## Before you export or tell the person it is done

```sh
frameshell credits          # exit 0: every placed asset is cleared; exit 1: something is not
```

It reads every timeline and judges each placed asset (clips, multicam angles and mics) against the ledger. Statuses and the fix:

| Status | Meaning | Fix |
|---|---|---|
| `unrecorded` | No entry. | `credits set` with the real licence, or `--licence own` for the person's footage, or remove the clip. |
| `no-licence` | Entry without a licence, or `unknown`. | Find the licence at the source and record it; if you cannot, do not use the asset. |
| `no-credit` | The licence needs credit but there is no author. | `credits set <asset> --author <name>` (or `--credit "<line>"`). |
| `changed` | The file is not the one the entry was written for. | If it is still the same work, `credits set` again; if it is a different file, record its own source. |
| `missing` | A clip points at a file that is gone. | Import it again or remove the clip. |

Unverified never passes. Never edit `credits.json` to turn a failure green; fix the entry only with what the source states.

When it passes, paste the printed credit block into the video description (MCP `credits_check` returns it as `text`) and tell the person which assets need credit and why. `render` warns about placed assets with no verified provenance once the project records any, but only `credits` is the gate.
