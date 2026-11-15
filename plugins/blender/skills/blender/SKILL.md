---
name: blender
description: Place a Blender scene on the Frameshell timeline as a `blender` clip, rendered with the person's own Blender to VP9 WebM with alpha. Use when a video needs a 3D scene, product shot or animated 3D title over or between footage.
---

# Blender clips

A `blender` clip is a frame range of a `.blend` file in the project, rendered in the background by the person's own Blender (never downloaded by Frameshell) and layered like any generated clip. Frameshell only renders: edit the `.blend` yourself (for example through your own Blender tooling), save it, and the clip re-renders. Every clip has two renders, both with a transparent background: a draft (EEVEE, or Workbench) made in the background for the preview, and a final (Cycles) made only when a final export needs it. A fuller playbook comes later.

## Steps

1. Check Blender is set up: `frameshell doctor` lists `blender` with its version. Not installed: ask the person to set `binaries.blender` to their Blender executable (4.5 LTS or any 5.x) in `frameshell.json` or the global config.
2. Put the scene's frame rate at the project's (Output properties, Frame Rate), and give the scene a camera. A scene at another frame rate is refused with that fix.
3. Add the clip on a video track:
   `frameshell clip add <track> --type blender --source scenes/intro.blend --start <s> --duration <s>`
   `source` is the `.blend`, inside the project. Optional `--props '{"scene":"Scene","camera":"Camera"}'`; nothing else goes in `props` (no `quality`: draft or final is the export's choice), and no scripts run.
4. Wait for the draft: `clip.renders` (MCP `clip_renders`) until the clip's `state` is `ready`. `failed` carries the fix (wrong fps, a clip longer than the scene, a missing camera). Then check with `frame_capture` / `frameshell frame --at <s>`, which show the draft (with a warning) until the final exists. `final.state` stays `waiting` until an export asks for the final.
5. Review rounds: `frameshell render --quality draft` uses the drafts, with a warning per Blender clip. Never deliver that file as the finished film.
6. Delivery: `frameshell render --quality final` (or no `--quality`) renders each Cycles final first (80 samples, denoised, the GPU when Blender finds one) and waits for it. Finals take minutes to an hour: about 6-7 s a frame at 1600x900 on a fast laptop. When the finals still to render are estimated over 5 minutes in all, the export fails with `ConfirmationRequired` (`error.data.finals` has each clip's estimate in seconds, `seconds` the total) and nothing is queued. Tell the person the estimate, and re-run with `--yes` (MCP `render` with `yes: true`) only after they agree to wait. Cached finals never ask again; editing the `.blend` makes a new final due.

## Rules

- The clip plays the scene from its first frame: composition time 0 is the scene's start frame. `in` and `duration` select the part shown, and the scene must be at least `in + duration` long.
- Drafts are not final art: do not present them as the finished look. Judge light, materials and noise on a final.
- Estimates start at 5 s per frame and megapixel; after each final they use the rate that `.blend` took on this machine.
- One render runs at a time: a long final holds back other generated clips and exports until it ends. `frameshell job cancel <id>` stops it.
- The Blender version is part of the render key: upgrading Blender re-renders every Blender clip.
