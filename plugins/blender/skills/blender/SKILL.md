---
name: blender
description: Place a Blender scene on the Frameshell timeline as a `blender` clip, rendered with the person's own Blender to VP9 WebM with alpha. Use when a video needs a 3D scene, product shot or animated 3D title over or between footage.
---

# Blender clips

A `blender` clip is a frame range of a `.blend` file in the project, rendered in the background by the person's own Blender (never downloaded by Frameshell) and layered like any generated clip. Frameshell only renders: edit the `.blend` yourself (for example through your own Blender tooling), save it, and the clip re-renders. This version renders drafts (EEVEE or Workbench, transparent background); finals and a fuller playbook come later.

## Steps

1. Check Blender is set up: `frameshell doctor` lists `blender` with its version. Not installed: ask the person to set `binaries.blender` to their Blender executable (4.5 LTS or any 5.x) in `frameshell.json` or the global config.
2. Put the scene's frame rate at the project's (Output properties, Frame Rate), and give the scene a camera. A scene at another frame rate is refused with that fix.
3. Add the clip on a video track:
   `frameshell clip add <track> --type blender --source scenes/intro.blend --start <s> --duration <s>`
   `source` is the `.blend`, inside the project. Optional `--props '{"scene":"Scene","camera":"Camera"}'`; nothing else goes in `props`, and no scripts run.
4. Wait for the render: `clip.renders` (MCP `clip_renders`) until the clip's `state` is `ready`. `failed` carries the fix (wrong fps, a clip longer than the scene, a missing camera). Then check with `frame_capture` / `frameshell frame --at <s>`.

## Rules

- The clip plays the scene from its first frame: composition time 0 is the scene's start frame. `in` and `duration` select the part shown, and the scene must be at least `in + duration` long.
- Drafts are not final art: do not present them as the finished look.
- The Blender version is part of the render key: upgrading Blender re-renders every Blender clip.
