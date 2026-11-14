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

## Brand capture

When the person names their site ("make it look like acme.com"), capture it instead of guessing colours or redrawing a logo:

```sh
frameshell brand capture https://acme.com
```

It opens the page in Frameshell's own headless Chrome (public addresses only, ports 80 and 443, no cookies or sign-in) and saves under `assets/brand/<id>/` the logo candidates from the header and nav, icons, the share image, `hero.png` and `page.png`; open-licensed fonts go to `assets/fonts/`. `brand.json` lists what was found: colours with their roles and the accent, fonts by use (each face with a note saying why it was or was not copied), `:root` variables, headings, buttons and video URLs.

1. **List what was found to the person before you use it.** Name the logo files, the accent and the fonts, and ask whether this is their brand and which logo is right. Never invent product UI or redraw a logo: use the captured files, or ask for the real ones.
2. **Credits fail until the person confirms.** Every captured file has a credits entry with its source URL and no licence, so `frameshell credits` fails on placed brand files. For the person's own brand, ask, then `frameshell credits set <file> --licence own`. For someone else's brand, do not use the files without their say.
3. **Fonts:** a face is copied only when the font file itself names OFL-1.1, Apache-2.0 or UFL; its credits entry carries that licence and the foundry. Google Fonts serves subsets without licence text, so they are listed but not copied: fetch the family from the google/fonts repository and import it with `--licence OFL-1.1 --source-url <repo URL> --author <foundry>`. Any other face is listed by name only: pick an open font close to it and say so.
4. **Style:** capture never changes `style.json`. It prints suggested `frameshell style set` lines (colours, fonts, `brand.product`, `brand.url`, `brand.mustShow`); run the ones the person agrees to.
5. **A failed capture says so:** `Capture FAILED (little text)` means a login wall, a bot check or an empty app shell. Open `hero.png` to see what loaded, then ask the person for the logo and a screenshot. A local or staging page (`localhost`, a LAN address, port 3000) is refused: ask for screenshots or exported files.
