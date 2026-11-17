import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBlenderAdapter } from "../src/index.js";
import { alphaAt, decodeRgba, inputsContext, renderContext, tempDir } from "./stub.js";

// Opt-in: renders a scene made on the spot with a real Blender (4.5 LTS or 5.x) and the managed ffmpeg. Run with
// FRAMESHELL_TEST_BLENDER=/path/to/blender pnpm test. Blender is never downloaded: without the variable, skipped.
// ADR 0035's Evidence section has what it measured (Blender 5.2.3 LTS, macOS).
const BLENDER = process.env["FRAMESHELL_TEST_BLENDER"];

/** Ortho camera over a 4-unit-wide frame: a 60 % white panel left of centre, an opaque red dot right of it, nothing in the corners. */
const SCENE = `
import sys
import bpy

out = sys.argv[sys.argv.index("--") + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 10
scene.render.fps_base = 1
scene.frame_start = 1
scene.frame_end = 20

camera_data = bpy.data.cameras.new("Camera")
camera_data.type = "ORTHO"
camera_data.ortho_scale = 4.0
camera = bpy.data.objects.new("Camera", camera_data)
scene.collection.objects.link(camera)
camera.location = (0, 0, 5)
scene.camera = camera


def plane(name, x, half, color, alpha):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([(-half, -half, 0), (half, -half, 0), (half, half, 0), (-half, half, 0)], [], [(0, 1, 2, 3)])
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    obj.location = (x, 0, 0)
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Color"].default_value = color
    if alpha < 1:
        clear = nodes.new("ShaderNodeBsdfTransparent")
        mix = nodes.new("ShaderNodeMixShader")
        mix.inputs[0].default_value = alpha
        material.node_tree.links.new(clear.outputs[0], mix.inputs[1])
        material.node_tree.links.new(emission.outputs[0], mix.inputs[2])
        material.node_tree.links.new(mix.outputs[0], output.inputs["Surface"])
    else:
        material.node_tree.links.new(emission.outputs[0], output.inputs["Surface"])
    # Blended, not dithered (dithered is noisy at 16 samples). 5.2 takes both; the legacy one maps to BLENDED.
    for attribute, value in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
        try:
            setattr(material, attribute, value)
        except (AttributeError, TypeError):
            pass
    mesh.materials.append(material)


plane("Panel", -0.8, 0.6, (1, 1, 1, 1), 0.6)
plane("Dot", 1.2, 0.3, (1, 0, 0, 1), 1.0)
bpy.ops.wm.save_as_mainfile(filepath=out)
`;

/**
 * A 24 fps scene whose red dot slides from x = -1.5 at frame 1 to x = 1.5 at frame 25 (one second), plus two files
 * outside the project: an image, and a library whose object has a scripted driver that writes `marker` if it ever runs.
 */
const REMAP_SCENE = `
import sys
import bpy

out, library, image_path, marker = sys.argv[sys.argv.index("--") + 1:]

bpy.ops.wm.read_factory_settings(use_empty=True)
trap = bpy.data.objects.new("Trap", None)
bpy.context.scene.collection.objects.link(trap)
driver = trap.driver_add("location", 0).driver
driver.type = "SCRIPTED"
driver.expression = "__import__('pathlib').Path(%r).write_text('ran') and 0" % marker
bpy.ops.wm.save_as_mainfile(filepath=library)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 24
scene.render.fps_base = 1
scene.frame_start = 1
scene.frame_end = 48
camera_data = bpy.data.cameras.new("Camera")
camera_data.type = "ORTHO"
camera_data.ortho_scale = 4.0
camera = bpy.data.objects.new("Camera", camera_data)
scene.collection.objects.link(camera)
camera.location = (0, 0, 5)
scene.camera = camera

mesh = bpy.data.meshes.new("Dot")
mesh.from_pydata([(-0.1, -0.1, 0), (0.1, -0.1, 0), (0.1, 0.1, 0), (-0.1, 0.1, 0)], [], [(0, 1, 2, 3)])
dot = bpy.data.objects.new("Dot", mesh)
scene.collection.objects.link(dot)
material = bpy.data.materials.new("Dot")
material.use_nodes = True
nodes = material.node_tree.nodes
nodes.clear()
emission = nodes.new("ShaderNodeEmission")
emission.inputs["Color"].default_value = (1, 0, 0, 1)
material.node_tree.links.new(emission.outputs[0], nodes.new("ShaderNodeOutputMaterial").inputs["Surface"])
mesh.materials.append(material)
# Linear keys, set before inserting them: Action.fcurves is gone in 5.0.
bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
for frame, x in ((1, -1.5), (25, 1.5)):
    dot.location = (x, 0, 0)
    dot.keyframe_insert("location", index=0, frame=frame)

image = bpy.data.images.new("Outside", 4, 4)
image.filepath_raw = image_path
image.file_format = "PNG"
image.save()
image.use_fake_user = True

with bpy.data.libraries.load(library, link=True) as (source, target):
    target.objects = ["Trap"]
for linked in target.objects:
    scene.collection.objects.link(linked)
bpy.ops.wm.save_as_mainfile(filepath=out)
`;

/** A project with `scene.blend` (see {@link REMAP_SCENE}) and, outside it, its library and image; `marker` is the file the trap driver writes, removed. */
function remapProject() {
  const project = tempDir();
  const elsewhere = tempDir();
  const library = join(elsewhere, "library.blend");
  const image = join(elsewhere, "outside.png");
  const marker = join(elsewhere, "driver-ran.txt");
  writeFileSync(join(project, "make-scene.py"), REMAP_SCENE);
  execFileSync(BLENDER!, ["-b", "--factory-startup", "-P", join(project, "make-scene.py"), "--", join(project, "scene.blend"), library, image, marker], { stdio: "pipe" });
  rmSync(marker, { force: true });
  return { project, elsewhere, marker };
}

describe.skipIf(!BLENDER)("blender adapter with a real Blender", () => {
  // Positive control for the next test: with auto-exec on and a frame evaluated, the same driver does write its file,
  // so "marker absent" under -Y is not just "the driver never got evaluated". Written on a machine with no Blender:
  // if this fails, the trap does not fire here and the next test proves nothing, so fix the trap first.
  it("control: the trap driver of the outside library does run with auto-exec on and a frame evaluated", () => {
    const { project, marker } = remapProject();
    writeFileSync(join(project, "evaluate.py"), "import bpy\nbpy.context.scene.frame_set(2)\nbpy.context.view_layer.update()\n");
    execFileSync(BLENDER!, ["-b", "--factory-startup", "--enable-autoexec", join(project, "scene.blend"), "--python-exit-code", "1", "-P", join(project, "evaluate.py")], { stdio: "pipe" });
    expect(existsSync(marker), "the trap driver did not run even with auto-exec on").toBe(true);
  }, 120_000);

  it("time-remaps a 24 fps scene into a 30 fps project, keys and warns on outside files, and runs no driver of an outside library", async () => {
    const { project, elsewhere, marker } = remapProject();

    const adapter = createBlenderAdapter({ projectDir: project });
    const clip = { id: "c1", type: "blender", source: "scene.blend", start: 0, duration: 1 };
    const inputs = await adapter.inputs!(clip, inputsContext(project, BLENDER!));
    expect(inputs.at(-1)).toMatch(/\/outside\.json$/);
    const outside = readFileSync(join(project, inputs.at(-1)!), "utf8");
    expect((JSON.parse(outside) as { outside: unknown[] }).outside).toHaveLength(2);
    expect(outside).not.toContain(basename(elsewhere));

    const size = { width: 320, height: 180 };
    const warnings: string[] = [];
    const { ctx } = renderContext(project, BLENDER!, { fps: 30, ...size, warn: (message) => warnings.push(message) });
    const result = await adapter.render(clip, ctx);
    expect(warnings).toEqual([expect.stringMatching(/loads 2 files from outside the project \(.*library\.blend, .*outside\.png\)/)]);
    expect(existsSync(marker)).toBe(false);

    const rgba = await decodeRgba(result.file);
    expect(rgba.length / (size.width * size.height * 4)).toBe(30);
    // Project frame k shows scene frame 1 + 0.8k: x = -1.5 + 3 * 0.8k / 24, 80 px per unit around x = 160.
    // Frame 6 is scene frame 5.8, a subframe: x = -0.9 (88 px); a render that dropped the subframe would show 80 px.
    for (const [frame, expected] of [[0, 40], [6, 88], [15, 160]] as const) {
      const row = Array.from({ length: size.width }, (_, x) => alphaAt(rgba, size, frame, x, 90));
      const lit = row.flatMap((alpha, x) => (alpha > 128 ? [x] : []));
      const centre = (lit[0]! + lit.at(-1)!) / 2;
      expect(Math.abs(centre - expected), `frame ${frame}`).toBeLessThanOrEqual(3);
    }
  }, 240_000);

  it("renders a transparent scene to VP9 with alpha: 0 / ~153 / 255 at corner, panel and dot, one frame per project frame, same bytes on a rerun", async () => {
    const project = tempDir();
    writeFileSync(join(project, "make-scene.py"), SCENE);
    execFileSync(BLENDER!, ["-b", "--factory-startup", "-P", join(project, "make-scene.py"), "--", join(project, "scene.blend")], { stdio: "pipe" });

    const adapter = createBlenderAdapter({ projectDir: project });
    const clip = { id: "c1", type: "blender", source: "scene.blend", start: 0, duration: 1 };
    const inputs = await adapter.inputs!(clip, inputsContext(project, BLENDER!));
    expect(inputs[0]).toBe("scene.blend");
    expect(inputs[1]).toMatch(/^\.frameshell\/blender\/version\/(4\.5|5\.\d+)(\.\d+)?\.json$/);
    expect(JSON.parse(readFileSync(join(project, inputs[3]!), "utf8"))).toEqual({ blend: "scene.blend", paths: [], outside: 0 });

    const size = { width: 320, height: 180 };
    const { ctx } = renderContext(project, BLENDER!, { fps: 10, ...size });
    const result = await adapter.render(clip, ctx);
    expect(result.hasAlpha).toBe(true);
    const rgba = await decodeRgba(result.file);
    expect(rgba.length / (size.width * size.height * 4)).toBe(10);
    for (const frame of [0, 9]) {
      expect(alphaAt(rgba, size, frame, 4, 4)).toBe(0);
      expect(Math.abs(alphaAt(rgba, size, frame, 96, 90) - 153)).toBeLessThanOrEqual(12);
      expect(alphaAt(rgba, size, frame, 256, 90)).toBeGreaterThanOrEqual(250);
    }

    const again = await adapter.render(clip, renderContext(project, BLENDER!, { fps: 10, ...size }).ctx);
    expect(readFileSync(again.file).equals(readFileSync(result.file))).toBe(true);
  }, 240_000);

  it("renders only the window of a clip with in > 0: transparent head, first drawn frame at the in point, one frame per project frame", async () => {
    const { project } = remapProject();
    const adapter = createBlenderAdapter({ projectDir: project });
    // Scene at 24 fps, dot at x = -1.5 + 3 * (frame - 1) / 24. In project terms (30 fps) the clip shows seconds 0.5 to 1:
    // project frames 15 to 29, scene frames 13 to 24.2 (the dot from x = 0 on).
    const clip = { id: "c1", type: "blender", source: "scene.blend", start: 0, in: 0.5, duration: 0.5 };
    const size = { width: 320, height: 180 };
    const { ctx } = renderContext(project, BLENDER!, { fps: 30, ...size });
    const result = await adapter.render(clip, ctx);
    const rgba = await decodeRgba(result.file);
    expect(rgba.length / (size.width * size.height * 4)).toBe(30);
    const litAt = (frame: number) => Array.from({ length: size.width }, (_, x) => alphaAt(rgba, size, frame, x, 90)).flatMap((alpha, x) => (alpha > 128 ? [x] : []));
    // The padded head draws nothing.
    for (const frame of [0, 7, 14]) expect(litAt(frame), `head frame ${frame}`).toEqual([]);
    // Project frame 15 shows scene frame 13: x = 0 (160 px); the last frame, 29, scene frame 24.2: x = 1.4 (272 px).
    for (const [frame, expected] of [[15, 160], [29, 272]] as const) {
      const lit = litAt(frame);
      expect(lit.length, `frame ${frame}`).toBeGreaterThan(0);
      expect(Math.abs((lit[0]! + lit.at(-1)!) / 2 - expected), `frame ${frame}`).toBeLessThanOrEqual(3);
    }
  }, 240_000);

  it("renders the final with Cycles: same alpha at corner, panel and dot, same bytes on a rerun (fixed seed), and records its time", async () => {
    const project = tempDir();
    writeFileSync(join(project, "make-scene.py"), SCENE);
    execFileSync(BLENDER!, ["-b", "--factory-startup", "-P", join(project, "make-scene.py"), "--", join(project, "scene.blend")], { stdio: "pipe" });
    const adapter = createBlenderAdapter({ projectDir: project });
    const clip = { id: "c1", type: "blender", source: "scene.blend", start: 0, duration: 1 };
    const size = { width: 320, height: 180 };
    const { ctx, progress } = renderContext(project, BLENDER!, { fps: 10, ...size, tier: "final" });
    const result = await adapter.render(clip, ctx);
    expect(progress.map((update) => update.message)).toContain("Rendering the final (Cycles)");
    const rgba = await decodeRgba(result.file);
    expect(rgba.length / (size.width * size.height * 4)).toBe(10);
    for (const frame of [0, 9]) {
      expect(alphaAt(rgba, size, frame, 4, 4)).toBe(0);
      expect(Math.abs(alphaAt(rgba, size, frame, 96, 90) - 153)).toBeLessThanOrEqual(12);
      expect(alphaAt(rgba, size, frame, 256, 90)).toBeGreaterThanOrEqual(250);
    }
    const measured = JSON.parse(readFileSync(join(project, ".frameshell", "blender", "finals.json"), "utf8")) as { sources: Record<string, number> };
    expect(measured.sources["scene.blend"]).toBeGreaterThan(0);

    const again = await adapter.render(clip, renderContext(project, BLENDER!, { fps: 10, ...size, tier: "final" }).ctx);
    expect(readFileSync(again.file).equals(readFileSync(result.file))).toBe(true);
  }, 600_000);
});
