# Copyright 2026 Frameshell contributors
# SPDX-License-Identifier: Apache-2.0
#
# Run by the @frameshell/blender adapter inside the user's Blender, never by anyone else:
#   blender -b --factory-startup -Y <file.blend> --python-exit-code 1 -P render.py -- '<json>'
# Renders `frames` frames of the scene, from its first frame, to RGBA PNGs `frame_000000.png`... in `outDir`
# (draft quality: EEVEE, or Workbench). It reads only the JSON request, prints `FRAMESHELL <json>` lines the
# adapter parses, and never saves the .blend. Apache-2.0 is GPL-3.0-compatible, as blender.org asks of bpy scripts.
# Written against Blender 4.5 LTS and 5.x (ADR 0035); the checks below are what changed between them.

import json
import os
import sys

import bpy


def emit(**event):
    print("FRAMESHELL " + json.dumps(event), flush=True)


def refuse(code, **detail):
    emit(event="error", code=code, **detail)
    sys.exit(2)


def choose_engine(scene):
    """EEVEE under whichever id this Blender has (`BLENDER_EEVEE_NEXT` in 4.2-4.x, `BLENDER_EEVEE` from 5.0), else Workbench."""
    for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "BLENDER_WORKBENCH"):
        try:
            scene.render.engine = engine
        except TypeError:
            continue
        return engine
    refuse("engine", message="this Blender has neither EEVEE nor Workbench")


def main():
    request = json.loads(sys.argv[sys.argv.index("--") + 1])

    scene_name = request.get("scene")
    if scene_name is None:
        scene = bpy.context.scene
    else:
        scene = bpy.data.scenes.get(scene_name)
        if scene is None:
            refuse("scene", scene=scene_name, scenes=[s.name for s in bpy.data.scenes])

    scene_fps = scene.render.fps / scene.render.fps_base
    if abs(scene_fps - request["fps"]) > 0.001:
        refuse("fps", scene=scene.name, sceneFps=scene_fps, projectFps=request["fps"])

    camera_name = request.get("camera")
    if camera_name is not None:
        camera = bpy.data.objects.get(camera_name)
        if camera is None or camera.type != "CAMERA":
            refuse("camera", camera=camera_name, cameras=sorted(o.name for o in scene.objects if o.type == "CAMERA"))
        scene.camera = camera
    elif scene.camera is None:
        refuse("camera", camera=None, scene=scene.name, cameras=sorted(o.name for o in scene.objects if o.type == "CAMERA"))

    first = scene.frame_start
    frames = request["frames"]
    if first + frames - 1 > scene.frame_end:
        refuse("range", scene=scene.name, frameStart=first, frameEnd=scene.frame_end, frames=frames)

    engine = choose_engine(scene)
    render = scene.render
    render.resolution_x = request["width"]
    render.resolution_y = request["height"]
    render.resolution_percentage = 100
    render.film_transparent = True
    render.image_settings.file_format = "PNG"
    render.image_settings.color_mode = "RGBA"
    render.image_settings.color_depth = "8"
    render.use_file_extension = True
    render.use_overwrite = True
    if engine != "BLENDER_WORKBENCH":
        scene.eevee.taa_render_samples = 16

    out_dir = request["outDir"]
    os.makedirs(out_dir, exist_ok=True)
    emit(event="start", frameStart=first, frames=frames, engine=engine)
    for index in range(frames):
        scene.frame_set(first + index)
        render.filepath = os.path.join(out_dir, "frame_%06d" % index)
        bpy.ops.render.render(write_still=True, scene=scene.name)
        emit(event="frame", index=index)


main()
