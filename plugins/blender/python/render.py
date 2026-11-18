# Copyright 2026 Frameshell contributors
# SPDX-License-Identifier: Apache-2.0
#
# Run by the @frameshell/blender adapter inside the user's Blender, never by anyone else:
#   blender -b --factory-startup -Y <file.blend> --python-exit-code 1 -P render.py -- '<json>'
# Renders `frames` frames at the project's rate, from project frame `startFrame` counted from the scene's first frame (a
# scene at another rate is sampled at the same seconds, through subframes), to RGBA PNGs `frame_000000.png`... in `outDir`,
# numbered from 0 for the window alone (the adapter pads the head before `startFrame`)
# (`quality` draft: EEVEE, or Workbench; final: Cycles). It reads only the JSON request, prints `FRAMESHELL <json>`
# lines the adapter parses, and never saves the .blend. Apache-2.0 is GPL-3.0-compatible, as blender.org asks of bpy scripts.
# Written against Blender 4.5 LTS and 5.x (ADR 0035); the checks below are what changed between them.
# Run on 5.2.3 LTS (macOS, headless EEVEE); 4.5 untested.

import json
import math
import os
import sys
import time

import bpy


def emit(**event):
    print("FRAMESHELL " + json.dumps(event), flush=True)


def refuse(code, **detail):
    emit(event="error", code=code, **detail)
    sys.exit(2)


# Scene frames closer than this to a whole frame are that frame: float error of the rate ratio, not a subframe.
EPSILON = 1e-6


def scene_times(scene_fps, project_fps):
    """Scene frames per project frame: 1 when the rates agree, else the time remap that keeps seconds (24 -> 30: 0.8).

    Each project frame then shows the scene at its own time, through `frame_set`'s subframe. Not Blender's Time
    Stretching (`frame_map_old`/`frame_map_new`): its whole numbers up to 900 cannot hold 24000/1001 against 30.
    """
    if abs(scene_fps - project_fps) <= 0.001:
        return 1.0
    return scene_fps / project_fps


def scene_frame(first, index, step):
    """Scene frame (with fraction) that project frame `index` shows: composition time 0 is the scene's first frame."""
    at = first + index * step
    nearest = round(at)
    return float(nearest) if abs(at - nearest) < EPSILON else at


def choose_engine(scene):
    """EEVEE under whichever id this Blender has (`BLENDER_EEVEE_NEXT` in 4.2-4.x, `BLENDER_EEVEE` from 5.0), else Workbench.

    An unknown id raises TypeError (5.2.3: `BLENDER_EEVEE_NEXT` not found in BLENDER_EEVEE, BLENDER_WORKBENCH, CYCLES).
    """
    for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "BLENDER_WORKBENCH"):
        try:
            scene.render.engine = engine
        except TypeError:
            continue
        return engine
    refuse("engine", message="this Blender has neither EEVEE nor Workbench")


def choose_device():
    """The first GPU backend Cycles finds (`OPTIX`, `CUDA`, `HIP`, `METAL`, `ONEAPI`), every device of it on; else `CPU`.

    `--factory-startup` leaves Cycles on the CPU, so the GPU is picked here. The device is not part of the render key
    (ADR 0035 decision 10). An id this Blender does not know raises TypeError.
    """
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
    except (KeyError, AttributeError):
        return "CPU"
    for kind in ("OPTIX", "CUDA", "HIP", "METAL", "ONEAPI"):
        try:
            prefs.compute_device_type = kind
        except TypeError:
            continue
        if hasattr(prefs, "refresh_devices"):
            prefs.refresh_devices()
        else:
            prefs.get_devices()
        if any(device.type == kind for device in prefs.devices):
            for device in prefs.devices:
                device.use = device.type == kind
            return kind
    try:
        prefs.compute_device_type = "NONE"
    except TypeError:
        pass
    return "CPU"


def use_cycles(scene):
    """Cycles as #482 measured it: 80 samples, adaptive threshold 0.02, OpenImageDenoise, 6 bounces, no caustics.

    A fixed seed keeps the noise pattern of every frame and rerun the same; persistent data keeps the scene loaded
    between frames. Returns the device.
    """
    scene.render.engine = "CYCLES"
    cycles = scene.cycles
    cycles.samples = 80
    cycles.use_adaptive_sampling = True
    cycles.adaptive_threshold = 0.02
    cycles.use_denoising = True
    try:
        cycles.denoiser = "OPENIMAGEDENOISE"
    except TypeError:
        pass
    cycles.seed = 0
    cycles.use_animated_seed = False
    cycles.max_bounces = 6
    cycles.caustics_reflective = False
    cycles.caustics_refractive = False
    scene.render.use_persistent_data = True
    device = choose_device()
    cycles.device = "CPU" if device == "CPU" else "GPU"
    return device


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
    step = scene_times(scene_fps, request["fps"])

    camera_name = request.get("camera")
    if camera_name is not None:
        camera = scene.objects.get(camera_name)
        if camera is None or camera.type != "CAMERA":
            refuse("camera", camera=camera_name, cameras=sorted(o.name for o in scene.objects if o.type == "CAMERA"))
        scene.camera = camera
    elif scene.camera is None:
        refuse("camera", camera=None, scene=scene.name, cameras=sorted(o.name for o in scene.objects if o.type == "CAMERA"))

    first = scene.frame_start
    start = request.get("startFrame", 0)
    frames = request["frames"]
    last = scene_frame(first, start + frames - 1, step)
    if last > scene.frame_end + EPSILON:
        refuse("range", scene=scene.name, frameStart=first, frameEnd=scene.frame_end, startFrame=start, frames=frames, lastFrame=round(last, 4), sceneFps=scene_fps)

    final = request.get("quality") == "final"
    device = use_cycles(scene) if final else None
    engine = "CYCLES" if final else choose_engine(scene)
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
    # No burn-in and no PNG metadata (Date, RenderTime, file path): a rerun then writes the same bytes.
    for name in dir(render):
        if name.startswith("use_stamp") and isinstance(getattr(render, name), bool):
            setattr(render, name, False)
    if engine not in ("BLENDER_WORKBENCH", "CYCLES"):
        scene.eevee.taa_render_samples = 16

    out_dir = request["outDir"]
    os.makedirs(out_dir, exist_ok=True)
    if device is None:
        emit(event="start", frameStart=first, frames=frames, engine=engine)
    else:
        emit(event="start", frameStart=first, frames=frames, engine=engine, device=device)
    for index in range(frames):
        at = scene_frame(first, start + index, step)
        whole = math.floor(at)
        scene.frame_set(whole, subframe=at - whole)
        render.filepath = os.path.join(out_dir, "frame_%06d" % index)
        started = time.monotonic()
        bpy.ops.render.render(write_still=True, scene=scene.name)
        emit(event="frame", index=index, seconds=round(time.monotonic() - started, 4), sceneFrame=round(at, 4))


main()
