# @frameshell/blender

Official [Frameshell](https://github.com/ThomasPraun/frameshell) clip adapter for [Blender](https://www.blender.org) scenes. It renders a frame range of a `.blend` file with your own Blender, in the background, to VP9 WebM with alpha, so a 3D scene becomes a `blender` clip on the timeline (ADR 0035). Editing the `.blend` re-renders that clip only.

```sh
frameshell plugin install @frameshell/blender
# Tell Frameshell where your Blender is, once (4.5 LTS or any 5.x):
#   "binaries": { "blender": "/Applications/Blender.app/Contents/MacOS/Blender" }   in frameshell.json or the global config.json
frameshell clip add <track> --type blender --source scenes/intro.blend --start 0 --duration 4
```

`source` is a `.blend` inside the project. Optional `props`: `scene` and `camera` (default: the file's current scene and its active camera) and `quality` (`draft`, the only one in this version). The frame range is the clip's own `in` and duration, counted from the scene's first frame at the project's frame rate: a scene at another frame rate is refused with the fix, never remapped. Install pins the exact version in the project's `frameshell.json` and links the plugin's agent skill into `.claude/skills/`. Usage for agents: [`skills/blender/SKILL.md`](skills/blender/SKILL.md).

## Your Blender, your licence

Frameshell never downloads, bundles or redistributes Blender: it is GPL and about 300 MB, and your own install keeps the version your `.blend` files were made with. `frameshell doctor` reports the version it finds and whether it is in the supported range. Blender runs once per render as a separate process: `blender -b --factory-startup -Y <file.blend> -P render.py`, so none of your add-ons or preferences load, scripts embedded in the file never auto-run, and no socket opens. The plugin runs only its own scripts with JSON arguments; it never runs Python from a clip. Renders belong to you, as blender.org says.

[`python/render.py`](python/render.py) and [`python/deps.py`](python/deps.py) run inside Blender and use its `bpy` module. They are Apache-2.0, which is compatible with the GPL-3.0 that blender.org asks of published `bpy` scripts. That is our reading, not legal advice.

The frames Blender writes are encoded by the ffmpeg Frameshell manages (see `docs/binaries.md`), never by Blender's own encoder.

The plugin runs inside the Frameshell daemon with full Node access, like every plugin: a project's plugins load only after you trust the project.

Licence: Apache-2.0.
