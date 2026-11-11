import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

describe.skipIf(!BLENDER)("blender adapter with a real Blender", () => {
  it("renders a transparent scene to VP9 with alpha: 0 / ~153 / 255 at corner, panel and dot, one frame per project frame, same bytes on a rerun", async () => {
    const project = tempDir();
    writeFileSync(join(project, "make-scene.py"), SCENE);
    execFileSync(BLENDER!, ["-b", "--factory-startup", "-P", join(project, "make-scene.py"), "--", join(project, "scene.blend")], { stdio: "pipe" });

    const adapter = createBlenderAdapter({ projectDir: project });
    const clip = { id: "c1", type: "blender", source: "scene.blend", start: 0, duration: 1 };
    const inputs = await adapter.inputs!(clip, inputsContext(project, BLENDER!));
    expect(inputs[0]).toBe("scene.blend");
    expect(inputs[1]).toMatch(/^\.frameshell\/blender\/version\/(4\.5|5\.\d+)(\.\d+)?\.json$/);
    expect(JSON.parse(readFileSync(join(project, inputs[3]!), "utf8"))).toEqual({ blend: "scene.blend", paths: [] });

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
});
