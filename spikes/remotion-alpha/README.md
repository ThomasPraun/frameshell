# Spike: Remotion headless render with alpha (PROTOTYPE, throwaway)

Ticket #136, part of #135. Answers: can the `@frameshell/remotion` adapter bundle a Remotion project that imports
React code from outside it, render it with Frameshell's managed Chrome to VP9 WebM with alpha, and key the render
cache on the bundle? Decision and numbers: [`docs/adr/0009-remotion-render-and-bundle-key.md`](../../docs/adr/0009-remotion-render-and-bundle-key.md).

Not part of any pnpm workspace. Remotion is loaded from `remotion/node_modules` with `createRequire`, the way the
adapter loads it from the user's project. ffmpeg/ffprobe for checks come from `.cache/test-binaries` (run
`pnpm test` once in the repo), Chrome from Frameshell's managed install (`frameshell doctor --install`).
Override with `FFMPEG`, `FFPROBE`, `CHROME`.

## Layout

| Path | What |
|---|---|
| `remotion/` | The Remotion project: `Card` composition, 8 s, 2560x1440, 30 fps, no background, `rgba(…, 0.6)` panel, opaque dot |
| `web/` | Stands in for a web app outside the Remotion project, with its own React install. `Panel.tsx` uses hooks |
| `src/bundle.mjs` | Bundle determinism, external edit, file dependencies, which React copy is bundled |
| `src/render.mjs` | `selectComposition` + `renderMedia` (vp9, png, yuva420p) at a given format; `--fast` adds libvpx flags through `ffmpegOverride` |
| `src/split.mjs` | Capture (`renderFrames`) vs VP9 encode time, three libvpx settings |
| `src/check.mjs` | Alpha in Chromium `<video>` (managed Chrome, repo's playwright-core) and ffmpeg overlay frames to `out/` |
| `src/common.mjs` | Paths, Remotion loading, probe and alpha helpers |

## Reproduce

```sh
(cd remotion && npm install --ignore-scripts) && (cd web && npm install --ignore-scripts)
node src/bundle.mjs
node src/render.mjs                    # 2560x1440 30 fps, Remotion's default VP9 settings
node src/render.mjs 2560 1440 30 --fast
node src/render.mjs 1920 1080 25 --fast  # format override
node src/split.mjs
node src/check.mjs
```
