import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createBlenderAdapter, scriptPath } from "../src/index.js";
import { alphaAt, decodeRgba, inputsContext, renderContext, stubBlender, tempDir, writeBlend } from "./stub.js";

// The adapter runs a POSIX shell wrapper over a Node stub of Blender: not on Windows. The pure parts (props, range,
// versions, scripts) are in blender.test.ts and run everywhere.
describe.skipIf(process.platform === "win32")("blender adapter with a stand-in Blender", () => {
  const SOURCE = "scenes/intro.blend";
  let project: string;
  let stub: ReturnType<typeof stubBlender>;
  const adapter = () => createBlenderAdapter({ projectDir: project });
  const clip = (extra: Record<string, unknown> = {}) => ({ id: "c1", type: "blender", source: SOURCE, start: 0, duration: 0.5, ...extra });

  beforeEach(() => {
    project = tempDir();
    stub = stubBlender();
    writeBlend(project, SOURCE, { fps: 10, frameStart: 1, frameEnd: 100 });
  });

  describe("inputs", () => {
    it("are the .blend, the Blender version, the length rendered and the listing of in-project files it loads", async () => {
      writeFileSync(join(project, "tex.png"), "png");
      writeBlend(project, SOURCE, { fps: 10, links: ["//../tex.png", "/outside/elsewhere.png", join(project, "scenes", "lib.blend")] });
      const inputs = await adapter().inputs!(clip(), inputsContext(project, stub.path));
      expect(inputs.slice(0, 2)).toEqual([SOURCE, ".frameshell/blender/version/4.5.3.json"]);
      expect(inputs[2]).toBe(".frameshell/blender/range/500ms.json");
      expect(inputs[3]).toMatch(/^\.frameshell\/blender\/[0-9a-f]{16}\/deps\.json$/);
      expect(inputs.slice(4)).toEqual(["scenes/lib.blend", "tex.png"]);
      expect(JSON.parse(readFileSync(join(project, inputs[3]!), "utf8"))).toEqual({ blend: SOURCE, paths: ["scenes/lib.blend", "tex.png"] });
      expect(JSON.parse(readFileSync(join(project, inputs[1]!), "utf8"))).toEqual({ blender: "4.5.3" });
    });

    it("run Blender's file listing once per .blend content, and its version once per executable, not on every key check", async () => {
      const blender = adapter();
      for (let i = 0; i < 3; i++) await blender.inputs!(clip(), inputsContext(project, stub.path));
      expect(stub.runs("deps.py")).toHaveLength(1);
      expect(stub.calls().filter((argv) => argv.includes("--version"))).toHaveLength(1);
      // A new adapter (daemon restart) reads the listing from `.frameshell/blender`.
      await adapter().inputs!(clip(), inputsContext(project, stub.path));
      expect(stub.runs("deps.py")).toHaveLength(1);
    });

    it("list the files again when the .blend changed, and the link set follows it", async () => {
      const blender = adapter();
      writeFileSync(join(project, "a.png"), "a");
      writeFileSync(join(project, "b.png"), "b");
      writeBlend(project, SOURCE, { links: ["//../a.png"] });
      expect((await blender.inputs!(clip(), inputsContext(project, stub.path))).slice(4)).toEqual(["a.png"]);
      writeBlend(project, SOURCE, { links: ["//../a.png", "//../b.png"] });
      expect((await blender.inputs!(clip(), inputsContext(project, stub.path))).slice(4)).toEqual(["a.png", "b.png"]);
      expect(stub.runs("deps.py")).toHaveLength(2);
    });

    it("put the Blender version in the key: an upgrade changes the version input, so every clip renders again", async () => {
      const blender = adapter();
      const before = await blender.inputs!(clip(), inputsContext(project, stub.path));
      stub.configure({ version: "5.0.1" });
      // The executable "changed": a different mtime, as an upgrade in place leaves.
      utimesSync(stub.path, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
      const after = await blender.inputs!(clip(), inputsContext(project, stub.path));
      expect(before[1]).toBe(".frameshell/blender/version/4.5.3.json");
      expect(after[1]).toBe(".frameshell/blender/version/5.0.1.json");
      expect(readFileSync(join(project, after[1]!), "utf8")).not.toBe(readFileSync(join(project, before[1]!), "utf8"));
    });

    it("put the length rendered in the key, and nothing of the clip's placement", async () => {
      const blender = adapter();
      const short = await blender.inputs!(clip({ duration: 1 }), inputsContext(project, stub.path));
      const moved = await blender.inputs!(clip({ duration: 1, start: 30 }), inputsContext(project, stub.path));
      const longer = await blender.inputs!(clip({ duration: 2 }), inputsContext(project, stub.path));
      const trimmedIn = await blender.inputs!(clip({ duration: 1, in: 1 }), inputsContext(project, stub.path));
      expect(moved).toEqual(short);
      expect(short[2]).toBe(".frameshell/blender/range/1000ms.json");
      expect(longer[2]).toBe(".frameshell/blender/range/2000ms.json");
      expect(trimmedIn[2]).toBe(".frameshell/blender/range/2000ms.json");
    });

    it("refuse a Blender outside 4.5 LTS and 5.x, one that is missing, and a host without the inputs context", async () => {
      stub.configure({ version: "4.2.9" });
      await expect(adapter().inputs!(clip(), inputsContext(project, stub.path))).rejects.toThrow(/Blender 4\.2\.9 at .* is outside the supported range \(4\.5 LTS and 5\.x\).*binaries\.blender/);
      await expect(adapter().inputs!(clip(), inputsContext(project, join(tempDir(), "blender")))).rejects.toThrow(/Blender not found at .*Fix `binaries\.blender`/);
      const missing = { projectDir: project, ensureBinary: async () => Promise.reject(new Error("Blender is not installed, or Frameshell was not told where it is.")) };
      await expect(adapter().inputs!(clip(), missing)).rejects.toThrow(/not installed/);
      await expect(adapter().inputs!(clip())).rejects.toThrow(/too old for the blender plugin/);
    });

    it("refuse a .blend that is missing or not a finished Blender file (a save in progress), until it is", async () => {
      await expect(adapter().inputs!(clip({ source: "scenes/nope.blend" }), inputsContext(project, stub.path))).rejects.toThrow(/scenes\/nope\.blend does not exist/);
      writeFileSync(join(project, "scenes", "intro.blend"), "");
      await expect(adapter().inputs!(clip(), inputsContext(project, stub.path))).rejects.toThrow(/not a finished Blender file/);
      writeBlend(project, SOURCE, { fps: 10 });
      await expect(adapter().inputs!(clip(), inputsContext(project, stub.path))).resolves.toBeDefined();
    });

    it("name a Blender that cannot read the file, and do not remember the failure", async () => {
      writeFileSync(join(project, "scenes", "intro.blend"), "BLENDER{not json");
      const blender = adapter();
      await expect(blender.inputs!(clip(), inputsContext(project, stub.path))).rejects.toThrow(/could not read scenes\/intro\.blend|SyntaxError|JSON/);
      writeBlend(project, SOURCE, { fps: 10 });
      await expect(blender.inputs!(clip(), inputsContext(project, stub.path))).resolves.toBeDefined();
    });
  });

  describe("render", () => {
    it("runs one factory-startup, no-autoexec Blender on the shipped script, then encodes VP9 with alpha: 0 / 153 / 255 at three pixels", async () => {
      const { ctx, progress } = renderContext(project, stub.path);
      const result = await adapter().render(clip({ props: { scene: "Scene", camera: "Camera" } }), ctx);
      expect(result.hasAlpha).toBe(true);
      expect(result.file).toBe(join(ctx.outDir, "render.webm"));

      const [run] = stub.runs("render.py");
      const blend = join(project, "scenes", "intro.blend");
      expect(run!.slice(0, 9)).toEqual(["-b", "--factory-startup", "-Y", blend, "--python-exit-code", "1", "-P", scriptPath("render.py"), "--"]);
      expect(JSON.parse(run![9]!)).toEqual({ scene: "Scene", camera: "Camera", width: 64, height: 36, fps: 10, frames: 5, outDir: join(ctx.outDir, "frames"), quality: "draft" });
      expect(stub.runs("render.py")).toHaveLength(1);

      const size = { width: 64, height: 36 };
      const rgba = await decodeRgba(result.file);
      const frames = rgba.length / (size.width * size.height * 4);
      expect(frames).toBe(5);
      for (const frame of [0, frames - 1]) {
        expect(alphaAt(rgba, size, frame, 2, 2)).toBe(0);
        expect(alphaAt(rgba, size, frame, 24, 18)).toBeGreaterThanOrEqual(149);
        expect(alphaAt(rgba, size, frame, 24, 18)).toBeLessThanOrEqual(157);
        expect(alphaAt(rgba, size, frame, 48, 18)).toBeGreaterThanOrEqual(251);
      }

      const fractions = progress.map((update) => update.fraction);
      expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
      expect(fractions[0]).toBe(0);
      expect(fractions.at(-1)).toBe(1);
      expect(progress.map((update) => update.message)).toEqual(expect.arrayContaining(["Starting Blender 4.5.3", "Rendering", "Encoding", "Done"]));
    });

    it("renders up to the end of the clip's part: in + duration, at the project fps, from the scene's first frame", async () => {
      writeBlend(project, SOURCE, { fps: 20 });
      const { ctx } = renderContext(project, stub.path, { fps: 20 });
      await adapter().render(clip({ in: 0.25, duration: 0.5 }), ctx);
      expect(JSON.parse(stub.runs("render.py")[0]![9]!)).toMatchObject({ fps: 20, frames: 15 });
      const frames = (await decodeRgba(join(ctx.outDir, "render.webm"))).length / (64 * 36 * 4);
      expect(frames).toBe(15);
    });

    it("reports progress from Blender's `Fra:` lines too", async () => {
      const { ctx, progress } = renderContext(project, stub.path);
      await adapter().render(clip(), ctx);
      const rendering = progress.filter((update) => update.message === "Rendering").map((update) => update.fraction);
      // Two reports per frame (the `Fra:` line, then the frame event), at most 0.9 until the encode.
      expect(rendering.length).toBeGreaterThanOrEqual(5);
      expect(Math.max(...rendering)).toBeCloseTo(0.9);
    });

    it("refuses a scene at another frame rate with how to fix it, and renders nothing", async () => {
      writeBlend(project, SOURCE, { fps: 24 });
      const { ctx } = renderContext(project, stub.path, { fps: 30 });
      await expect(adapter().render(clip(), ctx)).rejects.toThrow(
        /blender clip c1: scene "Scene" of scenes\/intro\.blend runs at 24 fps but the project runs at 30 fps\. Set the scene's frame rate to 30.*never remapped/,
      );
      expect(existsSync(join(ctx.outDir, "render.webm"))).toBe(false);
    });

    it("refuses a clip longer than the scene, a missing scene and a missing camera, each with the fix", async () => {
      writeBlend(project, SOURCE, { fps: 10, frameStart: 1, frameEnd: 3, scenes: ["Scene", "Alt"], cameras: ["Camera"] });
      await expect(adapter().render(clip(), renderContext(project, stub.path).ctx)).rejects.toThrow(
        /needs 5 frames from the scene's first frame \(1\) but scene "Scene" of scenes\/intro\.blend ends at frame 3 \(3 frames\)\. Raise its End frame or shorten the clip/,
      );
      writeBlend(project, SOURCE, { fps: 10, scenes: ["Scene", "Alt"] });
      await expect(adapter().render(clip({ props: { scene: "Nope" } }), renderContext(project, stub.path).ctx)).rejects.toThrow(/no scene "Nope"\. Its scenes: Scene, Alt\. Set props\.scene/);
      await expect(adapter().render(clip({ props: { camera: "Nope" } }), renderContext(project, stub.path).ctx)).rejects.toThrow(/no camera object "Nope"\. Its cameras: Camera\./);
      writeBlend(project, SOURCE, { fps: 10, cameras: [] });
      await expect(adapter().render(clip(), renderContext(project, stub.path).ctx)).rejects.toThrow(/has no active camera\. Set one in Blender/);
    });

    it("fails with Blender's own output when it crashes, and when it writes fewer frames than asked", async () => {
      stub.configure({ crash: true });
      await expect(adapter().render(clip(), renderContext(project, stub.path).ctx)).rejects.toThrow(/Blender exited with code 1:[\s\S]*RuntimeError: stub crash/);
      stub.configure({ skipLast: true });
      await expect(adapter().render(clip(), renderContext(project, stub.path).ctx)).rejects.toThrow(/Blender wrote 4 of 5 frames of scenes\/intro\.blend/);
    });

    it("kills Blender when the render is canceled, and rejects", async () => {
      stub.configure({ hangAfter: 1 });
      const { ctx, controller, progress } = renderContext(project, stub.path);
      const rendering = adapter().render(clip(), ctx);
      const settled = rendering.then(
        () => "resolved",
        (error: Error) => error.name,
      );
      for (let waited = 0; !progress.some((update) => update.message === "Rendering") && waited < 5000; waited += 20) await new Promise((r) => setTimeout(r, 20));
      expect(progress.some((update) => update.message === "Rendering")).toBe(true);
      controller.abort();
      expect(await settled).toBe("AbortError");
      const pid = stub.pid();
      for (let waited = 0; waited < 3000; waited += 50) {
        try {
          process.kill(pid, 0);
        } catch {
          return;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`Blender process ${pid} still runs after the render was canceled`);
    });

    it("does not start Blender for a render already canceled", async () => {
      const { ctx, controller } = renderContext(project, stub.path);
      controller.abort();
      await expect(adapter().render(clip(), ctx)).rejects.toThrow();
      expect(stub.runs("render.py")).toEqual([]);
    });

    it("refuses a Blender outside the supported range before rendering", async () => {
      stub.configure({ version: "3.6.0" });
      await expect(adapter().render(clip(), renderContext(project, stub.path).ctx)).rejects.toThrow(/outside the supported range/);
      expect(stub.runs("render.py")).toEqual([]);
    });
  });
});
