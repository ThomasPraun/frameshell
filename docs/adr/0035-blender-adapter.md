---
status: accepted
---

# Blender clips: an official adapter renders a `.blend` range with the person's own Blender into the clip cache

#482 (epic #451, step 6 "3D and story shorts") asks for a clip type `blender`. An official plugin `plugins/blender` (`@frameshell/blender`) renders a frame range of a `.blend` file in the project with the person's own Blender, encodes the frames with the managed ffmpeg to VP9 with alpha (the ADR 0002 file format, so preview and export need nothing new), and caches the result like any generated clip. Blender is never downloaded, bundled or redistributed. The owner decided option A on 2026-11-10 (the ten points below, from the ticket's decision comment). Slice 1 of #482 implements the core lookup and a minimal draft-only adapter. The spike that fills **Evidence** needs a real Blender, which the build machine does not have: it is pending and listed below.

## Context

- Blender is GPL (GPL-3.0-or-later binaries, GPL-2.0-or-later source; blender.org/about/license) and about 300 MB. macOS ships it only as a `.dmg`, which the binary manager cannot extract (tar and zip only). The person usually has their own Blender already, because the agent edits the `.blend` through a Blender MCP while Frameshell only renders; a second, different Blender version saving the same file risks version-mismatch saves.
- #478 (decided 2026-11-10): never depend on an external tool's CLI for what core does. Blender has no in-process alternative, so a subprocess is the only route; every encode and probe still goes through the managed ffmpeg.
- The plugin API already supports what is needed (`ClipAdapter.render`, `RenderContext.ensureBinary`, `progress`, `signal`), except that `inputs(clip)` has no host services: the adapter cannot ask where Blender is, so it cannot put the Blender version or a `.blend` dependency listing into the key.
- `BinaryManager.#packageOf` threw `Unknown binary` for any tool not in the manifest, so `binaries.blender` could not work before Blender had a manifest entry. A package may have no builds (`ensure` then throws `BinaryUnavailable`) and `onDemand` keeps `doctor` from listing it as a problem.
- The clip queue has concurrency 1 (`daemon.ts`), which already means one GPU render at a time, and also that a long Blender render holds back every other generated clip and export.
- Cycles cannot draw offscreen; drafts use EEVEE or Workbench. bpy changes between releases: Principled BSDF sockets were renamed in 4.0, the EEVEE id is `BLENDER_EEVEE_NEXT` in 4.2-4.x (and `BLENDER_EEVEE` again from 5.0), `Action.fcurves` went away in 5.0.

## Decision

1. **Official plugin in this repo.** SPEC §13 ("official plugins limited to two") is amended once, to the plugins that ship today (`whisper-cpp`, `hyperframes`, `remotion`), Blender and `packages/motion` (ADR 0033). Anything else goes to a community plugin.
2. **The person's own Blender install**, never a managed download. Core gets a `blender` package in the manifest with no builds, `onDemand`, a `--version` probe and a `userInstall` description; `binaries.blender` (project or global) names the executable. `ensure` without an override fails with a message that says Blender is the person's own, which versions work, where to get it and the exact `binaries` line to add (not "no managed build"). `doctor` shows the version, says `not installed, set binaries.blender` in the CLI when there is none, and reports a problem only when a Blender that runs is out of range or an override points at nothing.
3. **Supported range: the current LTS (4.5) and every 5.x**, checked at the start of every key check and render, with a message naming the version, the range and `binaries.blender`. `supports` in the core manifest (for `doctor`) and `supportedBlender` in the plugin repeat the rule; a parity test checks they agree on every tested version.
4. **Draft by default; final only with `quality: "final"`.** In this slice `quality` accepts `draft` only (and is optional). A final estimated over 5 minutes will ask for confirmation, and export will warn when it contains draft renders: both come with finals (slice 2).
5. **No hard render cap:** progress and cancel (the render kills Blender on `signal`), plus the confirm in 4.
6. **One clip queue in v1:** a long final blocks other renders and exports; a second queue or priorities get their own ticket.
7. **Scene fps different from the project fps is refused** with a fix-it message (`Set the scene's frame rate to N … frames are never remapped`) until a time remap exists. The check runs inside Blender (`render.py`), before any frame renders.
8. **Props: `scene`, `camera`, `quality`, and nothing else.** No agent Python reaches Blender; the plugin runs only its own scripts with a JSON request. The `.blend` is the clip's `source` (as for the other adapters, and the one the job and `clip add --source` already name), so the props schema refuses a `file` prop and says so. There are no `frameStart`/`frameEnd` props: the frame range comes from the clip (below).
9. **`render.py` (bpy) is Apache-2.0**, which is compatible with GPL-3.0 as blender.org asks of published bpy scripts. That is our reading, not legal advice. The plugin README says so, and every shipped script carries the SPDX header.
10. **The device (GPU or CPU) is not in the cache key.** The cache is local.

From the review of the draft:

- **The Blender version is probed per key check and is part of the key.** The adapter asks `blender --version` (cached by the executable's size and mtime, so an upgrade is seen at once) and returns `.frameshell/blender/version/<version>.json` from `inputs()`. An upgrade changes the path and so the key: every Blender clip re-renders. The version is deliberately not stored in the per-`.blend` dependency cache, which would go stale on an upgrade.
- **The frame range is the clip's own.** Composition time 0 is the scene's first frame (`frame_start`); the render covers frames up to `in + duration` at the project fps (equal to the scene fps by 7), so file time t shows composition time t as the adapter contract requires. A clip longer than the scene is refused with the scene's end frame. Because the host's key ignores placement (`type`, `source`, `props`, `elements`, inputs, format), the length rendered travels as an input file, `.frameshell/blender/range/<ms>ms.json` (named by `in + duration` in milliseconds): changing `in` or `duration` re-renders a Blender clip, unlike other adapters. That is the price of rendering only what the clip plays instead of the whole scene. Rendering just `[in, in + duration)` and padding the start with transparent frames is possible later.
- **The watcher debounce stays the host's** (200 ms after the last file event). A `.blend` that is not a finished Blender file (empty, or no Blender magic bytes: `BLENDER`, gzip or zstd) is refused with "not a finished Blender file (it may still be saving)", which keeps the clip without a key until the next change. `.blend1` backups are never inputs.
- **Every run is `blender -b --factory-startup -Y <file> --python-exit-code 1 -P script -- <json>`:** no user add-ons or preferences, scripts embedded in the file never auto-run, no socket, a non-zero exit when the script raises (Blender exits 0 otherwise). Frame count is checked after the run.

## Plugin API: `inputs(clip, context?)`

`ClipAdapter.inputs` gets an optional second argument, `InputsContext { projectDir, ensureBinary }`, passed by `ClipRenderer` on every key check. Additive (like `refreshRenders`, ADR 0009): `PLUGIN_API_VERSION` stays `"1"`, existing adapters ignore it, and an adapter that needs it fails with "this Frameshell is too old" when it is absent. No protocol or schema change, no `PROTOCOL_VERSION` bump, no `gen:json-schema`.

## Design

- **Render:** `render.py` picks the scene (`props.scene` or the file's), checks fps, sets the camera (`props.camera` or the scene's active one), resolution at 100 % of the project size, `film_transparent`, PNG RGBA 8 bit, EEVEE (`BLENDER_EEVEE_NEXT` or `BLENDER_EEVEE`, found by trying; else Workbench) at 16 samples, then renders frame by frame to `frame_%06d.png` in a temp directory. It prints `FRAMESHELL <json>` lines (`start`, `frame`, structured `error`) the adapter parses, and the adapter also reads Blender's own `Fra:` lines for progress (0 to 0.9; the encode takes the rest).
- **Encode:** the managed ffmpeg, `libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -b:v 0 -crf 20 -row-mt 1 -threads N -deadline good -cpu-used 4` (the ADR 0009 speed flags and alpha settings; `-crf 20` is this adapter's own choice, not measured against Remotion's default), `-an`. The PNG sequence goes in at the project fps, NTSC rates (29.97, 23.976, 59.94) as the exact fraction (`30000/1001`). Result `{ file, hasAlpha: true }`. Frames on disk also leave room for a ProRes master later (ADR 0002 reserve).
- **Inputs:** the `.blend`; the version file; the range file; `.frameshell/blender/<blend hash>-<path hash>/deps.json`; and every in-project file from `bpy.utils.blend_paths(absolute=True, packed=False, local=False)` (libraries, images, caches). The listing runs Blender once per `.blend` content and project path and is read from `deps.json` afterwards, also after a daemon restart; relative links resolve against where the `.blend` sits, so the project path is part of the cache, and part of the listing file's name: identical copies at two paths each have their own file. Files outside the project are not tracked in this version. The listing has a 5 minute timeout and no cancel: stopping the daemon during it can leave that one Blender running until it ends.
- **Cancel:** `signal` sends SIGTERM to Blender's whole process group (`taskkill /T /F` on Windows) and SIGKILL to the group five seconds later, so a launcher script (snap, flatpak, a shell wrapper) as `binaries.blender` does not leave Blender running.
- **Camera:** `props.camera` must be an object of the chosen scene; the error lists that scene's cameras.
- **Left open (not decided here):** `.frameshell/blender/` (one listing per saved `.blend`, one range file per distinct length, version files) is not cleaned by `gc`; and keying on `in + duration` re-renders on any trim, including a shorter end the old render already covers (SPEC §6.5 documents the exception to "placement never re-renders"; the owner has not confirmed it, bucketing the length or keying on the scene's `frame_end` would avoid it).

## Evidence

**Not gathered: this ADR is accepted as a decision, but nothing in it has run in a real Blender.** `render.py` and `deps.py` have never run (EEVEE ids by version, `taa_render_samples`, `bpy.ops.render.render(scene=...)`, the `blend_paths` flags, alpha of a blended material and headless EEVEE are all untested). Before this merges, someone with Blender 4.5 LTS and 5.x runs `FRAMESHELL_TEST_BLENDER` and fills in at least alpha, engine ids, a draft timing and the `blend_paths` listing below; otherwise the owner accepts merging with Evidence deferred. The spike needs a real Blender (not installed on the build machine). Slice 1 was built and tested against a stand-in Blender script (`plugins/blender/test/fixtures/stub-blender.mjs`) that mimics the contract of `render.py` and `deps.py`; the stand-in checks the adapter's argument list, key inputs, refusals, progress, cancel and the ffmpeg alpha encode (0 / 153 / 255 read back through libvpx), not Blender itself. `plugins/blender/test/render-real.test.ts` is the opt-in real test (`FRAMESHELL_TEST_BLENDER=/path/to/blender pnpm test`); it was written but not run.

What the spike must measure, with the setup recorded as in ADR 0002 and 0009 (machine, OS, Blender version, GPU):

| Question | Method |
|---|---|
| Alpha | A scene with an empty corner, a 0.6 panel and an opaque dot at project size; decode with libvpx at t = 3 s; expect 0 / ~153 / 255. Settle which material property gives a blended (not dithered) panel in 4.5 and in 5.x (`surface_render_method` or `blend_method`) |
| Chromium `<video>` and ffmpeg overlay | The same file plays with alpha in Chromium and overlays correctly with `-c:v libvpx-vp9` |
| Engine ids | `BLENDER_EEVEE_NEXT` / `BLENDER_EEVEE` / `BLENDER_WORKBENCH` accepted by `choose_engine` on 4.5 LTS and the current 5.x; that `--factory-startup -Y` background EEVEE renders on macOS, Linux and Windows (a display or GL context may be needed headless) |
| Draft timing | Seconds per frame and total for 4 s at 30 fps at 1920x1080 and 2560x1440, EEVEE and Workbench, cold and warm, and the PNG sequence size on disk (draft estimate: 120 frames at 1080p RGBA ~0.5-1 GB, unmeasured) |
| Final timing | Cycles at 80 samples, 1600x900 and the project size (the ticket reports 6-7 s per frame on an M4 Pro); one render at a time per GPU; feeds the 5-minute confirm of slice 2 |
| `blend_paths` listing | The listing on a `.blend` with a linked library, packed and external images, a cache and an image sequence: what it returns, `absolute=True` on `//` paths, packed items with `packed=False`, a `.blend` outside the project dir |
| Byte stability | The same `.blend` rendered twice on one machine: identical PNGs and identical WebM bytes (EEVEE, and Cycles with a fixed seed) |
| `-Y` and drivers | That auto-run stays off for drivers and text blocks in the `.blend` and in a linked library outside the project (not verified) |
| Cancel | SIGTERM ends Blender and frees the GPU on each platform; how long |
| Listing cost | Blender start plus load time for `deps.py` on a large `.blend`, since it runs inside the key check |
| Blender's own VP9 | Whether Blender's FFmpeg output can write VP9 with alpha (not needed: avoided by encoding with the managed ffmpeg) |
| Platforms | Linux and Windows timings and executable paths |

## Considered options

- **A. Official plugin, the person's Blender, frames encoded by the managed ffmpeg. Chosen.**
- **B. Same adapter, managed Blender download.** Rejected: dmg extraction on macOS, about 300 MB per platform, re-pins per release, a mirror would redistribute GPL binaries, and a second Blender version could save the person's `.blend`. The reproducibility it buys is not needed because the cache is local.
- **C. Skill playbook only; the agent renders and imports the result as media.** Rejected as the main path: no cache key, the clip is not linked to its `.blend`, and renders would land in `assets/`, which is precious data. It remains what an agent can do today (SPEC §6.3 imports VP9 alpha).
- **D. Community plugin plus a generic user-tool hook in core.** Rejected: a plugin manifest change for one consumer, and the quality and security of the Blender integration would leave the repo. The generic part is the `userInstall` package field, which another external tool can use.
- **Let `ensureBinary` resolve an override for a tool no package ships.** Not done: `locate` still throws `Unknown binary` for names outside the manifest. Blender works because it now has a package; a plugin cannot invent tools.
- **Find Blender in standard install paths when no override is set.** Not in slice 1: `doctor` and `ensureBinary` must agree on one answer, so it belongs in core with the other lookup, in a later slice. The error message quotes the usual path per platform.

## Consequences

- **Core:** `BLENDER_PACKAGE` and `BLENDER_TOOL` in `packages/core/src/binaries/manifest.ts`, `BinaryPackage.userInstall`, `ensure` and `doctor` behaviour as in decision 2 and 3, the CLI doctor text. `OFFICIAL_ADAPTERS` (`plugins/host.ts`) names `@frameshell/blender` in the install hint.
- **Plugin API:** `InputsContext` as above.
- **New plugin** `plugins/blender` (`@frameshell/blender` 0.1.0): manifest, adapter, `python/render.py`, `python/deps.py`, a skill stub, README with the licence note; registered in the root `tsconfig.json`, the release workflow's plugin build and the npm plugin checks. The npm Trusted Publisher for the new package must be set up by the owner before its first release (`docs/release.md`).
- **Docs:** SPEC decision 31, §6.5, §8.2, §9, §12 and §13 (the scope risk amended once, a risk row for bpy churn and the shared queue), `docs/binaries.md` "Blender (your own install)", GLOSSARY, CHANGELOG, CLAUDE.md doc map.
- **No** `PROTOCOL_VERSION` bump, Zod model change, `gen:json-schema` or daemon method; `CACHE_LAYOUT_VERSION` unchanged. The skill of the core agent guide (`skills/frameshell/`) is untouched: the plugin ships its own.
- **Left for later slices of #482:** finals (Cycles, fixed seed, OIDN), the 5-minute confirm and the export warning for drafts (2); the skill playbook and look sheet (3); fps remap and libraries outside the project (4); standard-path discovery of Blender; a second clip queue or priorities (own ticket); rendering only the clip's window.

## Side effects

- **Reused:** the plugin API and host as they are (`registerClipType`, the clip job and cache, `.frameshell/` ignored by the watcher as for Remotion), `BinaryManager` and `runDoctor`, the managed ffmpeg and its VP9 flags (ADR 0009), `OFFICIAL_ADAPTERS`, the opt-in real-test pattern. **New, because nothing fits:** the `userInstall` field (a package with no builds already behaved, but its message said "no managed build"), the `inputs` context, the Blender subprocess runner (the Remotion plugin renders in-process; no shared helper exists across plugins, and plugins cannot import each other).
- **Can break:** `ClipRenderer` key checks now call `ensureBinary` for Blender clips on every refresh (a stat, and the global config read); a project with Blender clips and no Blender gets the clip's key error until `binaries.blender` is set. `tools()` now lists `blender` last, which the CLI doctor test pins. `inputs` for other adapters is unchanged (the extra argument is ignored).
- **Security:** the plugin runs only shipped scripts with JSON; `-Y` and `--factory-startup` keep embedded scripts and add-ons out. Whether drivers in linked libraries outside the project stay off under `-Y` is unverified (spike).
- **Shared queue:** unchanged (decision 6).
