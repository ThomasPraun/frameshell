---
status: accepted
---

# Remotion clips: the user's Remotion renders VP9-alpha WebM; the bundle is the cache input

The `@frameshell/remotion` adapter (#135) loads `@remotion/bundler` and `@remotion/renderer` from the user's Remotion project, never from the plugin. That way versions match the user's code and webpack config, and the Apache-licensed plugin never depends on Remotion, which needs a paid licence for companies with more than 3 people (SPEC §13). React code may live outside the Frameshell project, for example in the user's web app. The adapter bundles the entry into `.frameshell/` and returns the bundle files from `inputs()`, so the render cache key follows any source change wherever the source lives. Renders use `renderMedia` with `codec: "vp9"`, `imageFormat: "png"`, `pixelFormat: "yuva420p"`, the managed chrome-headless-shell as `browserExecutable`, and multithreaded libvpx flags injected through `ffmpegOverride`. The result is the same file format as ADR 0002, so the preview, the export and `render() → { file, hasAlpha: true }` stay unchanged.

## Evidence

Spike code: `spikes/remotion-alpha/` (see its README). Composition: 8 s, 2560x1440, 30 fps, no background, one `rgba(…, 0.6)` panel imported from a sibling "web app" package with its own React install and hooks, and one opaque dot. Same geometry as ADR 0002.

Setup: Apple M3, 8 cores, 8 GB RAM, macOS 26.3, Node 22, Remotion 4.0.527 (released 2026-09-22), managed chrome-headless-shell 154.0.8037.57, managed ffmpeg 9.0.2 for checks. Single runs, warm unless noted.

| Question | Result |
|---|---|
| Alpha | `alpha_mode=1`, `yuv420p` reported (VP9 alpha, as in ADR 0002); libvpx decode at t = 3 s gives 0 / 154 / 255 (corner / panel / dot) |
| Chromium `<video>` | Plays at 2560x1440; canvas readback at 3 s gives 0 / 154 / 255 |
| ffmpeg overlay | `-c:v libvpx-vp9` input, `overlay=format=auto` on `testsrc2`: footage shows through, panel translucent, text and dot opaque (frames at 0.1, 3, 7.5 s) |
| Managed Chrome | `selectComposition` and `renderMedia` run with `browserExecutable` = managed chrome-headless-shell, `chromeMode: "headless-shell"`. Remotion downloads no browser |
| Format override | Spreading `{ width, height, fps, durationInFrames }` over the selected composition renders 1920x1080 at 25 fps (200 frames, 8 s) and 1280x720. The composition reads them from `useVideoConfig()` |
| Bundle determinism | Cold (webpack cache cleared), warm and uncached bundles are byte-identical. The output directory path is not embedded |
| Edit outside the project | Changing `web/src/Panel.tsx` changes `bundle.js` and its map only; restoring the file restores the original bytes |
| Dependency list | webpack `compilation.fileDependencies` (via `webpackOverride`) lists 291 entries, including `web/src/Panel.tsx`; it also holds directories and resolution probes, so files must be filtered |
| React copies | The bundle takes React from the Remotion project even for `web/` code that has its own `node_modules/react`: Remotion's webpack config aliases it. Hooks work |

Timing (8 s at 2560x1440 unless noted):

| Step | Time |
|---|---|
| Bundle cold / warm (webpack cache) / external edit | 3.0 s / 0.55 s / 0.7 s |
| `selectComposition` | 0.5–2.6 s |
| `renderMedia`, Remotion's VP9 defaults | 66.3 s (8.3x real time); concurrency 4 or 8: 62.7 / 63.5 s |
| Same at 1920x1080, 25 fps | 38.1 s |
| PNG capture alone (`renderFrames`) | 3.8 s |
| VP9 encode of those PNGs: libvpx defaults / `-row-mt 1 -threads 8 -deadline good -cpu-used 4` / realtime, cpu-used 8 | 10.4 / 3.7 / 1.8 s (0.12 / 0.15 / 0.27 MB) |
| `renderMedia` with `ffmpegOverride` adding `-row-mt 1 -threads 8 -deadline good -cpu-used 4` | **13.4 s (1.7x real time)**, same alpha |

Remotion stitches PNGs with single-threaded libvpx at its default speed; that encode, not Chrome, is the bottleneck. For comparison, HyperFrames renders the same geometry in about 22 s (ADR 0002).

Not measured: Linux and Windows; heavy compositions (real app UIs, images, `<OffthreadVideo>`), where capture will cost more than on this simple card; compositions with audio; Remotion's own ffmpeg (from `@remotion/compositor-*`) against the managed one. No licence warning was printed without a `licenseKey`.

## Considered options

- **Plugin pins its own Remotion.** More reproducible, but clashes with the user's Remotion version and makes Remotion a dependency of the plugin. Rejected.
- **Hash source files instead of the bundle.** The inputs contract only takes project-relative files, and code outside the project would never change the key. A file list from webpack would also miss resolved packages. Rejected: the bundle is the exact code that runs.
- **Extend `inputs()` to absolute paths outside the project.** Changes the API and the hashing in core, and puts outside paths into cache keys. Not needed, since the bundle already covers outside code.
- **Render PNGs with `renderFrames` and encode with the managed ffmpeg.** About as fast as the `ffmpegOverride` route, but it re-implements Remotion's stitching (audio, frame ranges). Kept in reserve.

## Consequences

- **Adapter (#135)**: resolve `@remotion/bundler` and `@remotion/renderer` from the composition's project (the nearest `package.json` above `source` that depends on `remotion`); fail with an install hint when they are missing. Clip `source` = the entry file (`registerRoot`), composition id in `props`, the rest of `props` = `inputProps`.
- **Cache key**: `inputs()` bundles to `.frameshell/remotion/<entry hash>/` (ignored by the watcher, so bundling never triggers a refresh) and returns the bundle's files. The adapter remembers the bundle's file dependencies with their mtimes and re-bundles only when one changed.
- **Re-render on outside edits**: the project watcher never sees files outside the project. Add an optional, additive plugin API hook that lets an adapter ask the host to refresh renders; the adapter calls it when a dependency changes. `apiVersion` stays `"1"`.
- **Render**: `selectComposition` once, override `width`, `height`, `fps` and `durationInFrames` (same seconds) to the project format, `renderMedia` with vp9, png, yuva420p, `muted: true`, managed Chrome, and the libvpx flags above through `ffmpegOverride`. Output always has alpha (`hasAlpha: true`).
- **Audio**: clip renders are video-only (the adapter contract carries no audio), so a composition's `<Audio>` is dropped. Voice and music go on audio tracks as `media` clips. The skill says so.
- **Licence**: README and skill state that Remotion's licence is the user's; the plugin never sets a `licenseKey`.

## Addendum: the project's `remotion.config.ts`

Remotion's CLI applies `remotion.config.ts`, but the programmatic `bundle()` and `renderMedia()` the adapter calls do not. Without it, a project's webpack override (Tailwind via `@remotion/tailwind-v4`, aliases) is lost and its components render unstyled. The adapter therefore loads the config with the project's own `@remotion/cli`: `loadConfigFile` from `dist/load-config.js`, then `ConfigInternals` (`getWebpackOverrideFn`, `getBundlerOverrideFn`) and the renderer's `glOption`. These are internals, checked present in 4.0.500 and 4.0.527, and a missing one fails with a clear error. `CliInternals.loadConfig` is avoided on purpose: on a config error it calls `process.exit(1)`, which would stop the daemon. Loads are serialized per CLI copy and reset its config state first, since that state is module-global.

Applied: the webpack and bundler overrides (the project's override runs first, then the dependency recorder) and the OpenGL renderer (`chromiumOptions.gl`). Ignored: output settings (codec, image format, CRF, pixel format), which Frameshell fixes for alpha. The config file is a bundle dependency, and its content is folded into the bundle directory name, so editing it re-renders even when the bundle bytes stay the same. Checked by an opt-in real test: Tailwind v4 classes render, and `setChromiumOpenGlRenderer` is read back.
