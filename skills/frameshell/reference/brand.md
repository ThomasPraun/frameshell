# Brand: capture, Figma frames, brand pictures in templates

The person's real brand, never a guess: logos, colours, fonts and product UI taken from their site or their Figma file, then used by motion templates as sharp pictures. Everything lands in `assets/brand/<id>/` and `brand.json` (written by Frameshell only; read it with `frameshell brand show`). Commands assume the session rule of [SKILL.md](../SKILL.md).

Order: capture or import, list the findings to the person, confirm, then build. Never invent product UI or redraw a logo: use the captured or imported files, or ask for the real ones.

## Capture from a site

When the person names their site ("make it look like acme.com"), capture it instead of guessing colours or redrawing a logo:

```sh
frameshell brand capture https://acme.com --sections "Pricing,Teams"
```

It opens the page in Frameshell's own headless Chrome (public addresses only, ports 80 and 443, no cookies or sign-in) and saves under `assets/brand/<id>/` the logo candidates from the header and nav, icons, the share image, `hero.png` and `page.png`; open-licensed fonts go to `assets/fonts/`. `brand.json` lists what was found: colours with their roles and the accent, fonts by use (each face with a note saying why it was or was not copied), `:root` variables, headings, buttons and video URLs.

`--sections` (optional, up to 12 texts, comma-separated) also crops the part of the page around each text at 3x into `section-<text>.png`: the smallest element at least 500 px wide that holds the text, found in a heading first. Use these crops for push-ins on real product UI instead of zooming into `page.png`. Name texts the page shows (a heading such as "Pricing"); `brand.json` `sections` says which element was cropped, or `not found` for a text no visible element holds.

1. **List what was found to the person before you use it.** Name the logo files, the accent and the fonts, and ask whether this is their brand and which logo is right.
2. **Credits fail until the person confirms.** Every captured file has a credits entry with its source URL and no licence, so `frameshell credits` fails on placed brand files. For the person's own brand, ask, then `frameshell credits set <file> --licence own`. For someone else's brand, do not use the files without their say ([credits.md](credits.md)).
3. **Fonts:** a face is copied only when the font file itself names OFL-1.1, Apache-2.0 or UFL; its credits entry carries that licence and the foundry. Google Fonts serves subsets without licence text, so they are listed but not copied: fetch the family from the google/fonts repository and import it with `--licence OFL-1.1 --source-url <repo URL> --author <foundry>`. Any other face is listed by name only, with the closest open font from Frameshell's curated table (`substitute` in `brand.json`, a `closest open font:` line in the output: family, licence, google/fonts folder). Tell the person their font was not copied and which open font stands in, then fetch that family from its folder and import it with its licence the same way. An icon font (by name, or because most of its characters sit in the Private Use Area) is never a text face, even under an open licence.
4. **Style:** capture never changes `style.json`. It prints suggested `frameshell style set` lines (colours, fonts, `brand.product`, `brand.url`, `brand.mustShow`); run the ones the person agrees to.
5. **A failed capture says so:** `Capture FAILED (little text)` means a login wall, a bot check or an empty app shell. Open `hero.png` to see what loaded, then ask the person for the logo and a screenshot. A local or staging page (`localhost`, a LAN address, port 3000) is refused: ask for screenshots or exported files.

## Figma frames

When the person has the product UI in Figma (or the app is behind a login), ask them to export the frames as SVG into one folder, then:

```sh
frameshell brand import-figma ~/Desktop/acme-figma
```

Each `.svg` is sanitised (scripts, foreign content, event handlers and external references removed; a file that declares entities or states no size is skipped) and saved under `assets/brand/<id>/`. The whole folder gets one scale, the project canvas width divided by the widest frame, and each frame's centred position: a button keeps the same size from screen to screen, and SVG stays sharp when the camera zooms into it. The frames have credits entries with no licence: ask, then `frameshell credits set <file> --licence own` for the person's own design. Nothing is fetched.

`frameshell brand show` prints everything captured and imported (files with their source, colours, accent, fonts, frames with scale and position). Read it before building anything branded.

## Brand pictures in templates

A motion template with a picture prop (`logo` of `logo-lockup`, `logo-sting` and `end-card`, `image` of `pip-card`, `screenshot` of `device-frame`, `picture` of `pull-back-reveal`, `image` of `freeze-cut`, `before` and `after` of `before-after`) takes a brand file at scaffold time:

```sh
frameshell hyperframes new closer --template logo-lockup --component assets/brand/acme-com/logo-1.svg
frameshell hyperframes new ba --template before-after --component before=acme-figma/old-home.svg --component after=acme-figma/home.svg
```

- The path is one `brand show` prints (`assets/brand/` may be left out); only pictures `brand.json` lists are taken: captured SVG and PNG files, section crops and Figma frames, never a font. A template with two pictures needs `<prop>=` in front.
- The file is copied into the composition (`brand/<id>/<file>`) and becomes the prop's default, since a composition loads nothing outside its folder. A later capture does not reach it: scaffold again, or copy the new file in and `clip set --props`.
- Prefer SVG (a logo, a Figma frame) for anything the camera zooms into; a PNG crop blurs once the zoom passes its own pixels.
- `frameshell credits` checks placed assets, not files inside a composition, so the scaffold reminds you while the source has no licence: confirm with the person, then `frameshell credits set <source path> --licence own`.
- A Figma frame is fitted into the template's own box. The output also prints its place at the folder's one scale on this canvas (`scale`, `x`, `y`), for a composition written by hand that shows the whole screen at the size the other frames of the folder share.
