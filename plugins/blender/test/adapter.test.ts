import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { AdapterGcContext } from "@frameshell/plugin-api";
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
      expect(inputs[2]).toBe(".frameshell/blender/range/0-500ms.json");
      expect(inputs[3]).toMatch(/^\.frameshell\/blender\/[0-9a-f]{16}-[0-9a-f]{8}\/deps\.json$/);
      expect(inputs.slice(4)).toEqual(["scenes/lib.blend", "tex.png", inputs[3]!.replace(/deps\.json$/, "outside.json")]);
      expect(JSON.parse(readFileSync(join(project, inputs[3]!), "utf8"))).toEqual({ blend: SOURCE, paths: ["scenes/lib.blend", "tex.png"], outside: 1 });
      expect(JSON.parse(readFileSync(join(project, inputs[1]!), "utf8"))).toEqual({ blender: "4.5.3" });
    });

    it("put libraries outside the project into the key by content, never by path, and warn on the render", async () => {
      const elsewhere = tempDir();
      const lib = join(elsewhere, "a-props.blend");
      writeFileSync(lib, "BLENDERlib-v1");
      const missing = join(elsewhere, "z-gone.png");
      writeBlend(project, SOURCE, { fps: 10, links: [lib, missing] });
      const blender = adapter();
      const before = await blender.inputs!(clip(), inputsContext(project, stub.path));
      const outside = before.at(-1)!;
      expect(outside).toMatch(/^\.frameshell\/blender\/[0-9a-f]{16}-[0-9a-f]{8}\/outside\.json$/);
      const text = readFileSync(join(project, outside), "utf8");
      expect(JSON.parse(text)).toEqual({ outside: [{ sha256: expect.stringMatching(/^[0-9a-f]{16}$/), bytes: 13 }, { missing: true }] });
      // No absolute path of the outside files lands in a project file.
      for (const file of [outside, before[3]!]) expect(readFileSync(join(project, file), "utf8")).not.toContain(elsewhere.split(/[\\/]/).at(-1)!);

      // Editing the library changes the input's content (so the key) on the next check; Blender lists the .blend once.
      writeFileSync(lib, "BLENDERlib-v2-longer");
      await blender.inputs!(clip(), inputsContext(project, stub.path));
      expect(readFileSync(join(project, outside), "utf8")).not.toBe(text);
      expect(stub.runs("deps.py")).toHaveLength(1);
      // A restart does not know the outside paths (never written): it lists the .blend again, once.
      await adapter().inputs!(clip(), inputsContext(project, stub.path));
      expect(stub.runs("deps.py")).toHaveLength(2);

      const warnings: string[] = [];
      const { ctx } = renderContext(project, stub.path, { warn: (message) => warnings.push(message) });
      await blender.render(clip(), ctx);
      expect(warnings).toEqual([
        `blender clip c1: scenes/intro.blend loads 2 files from outside the project (${lib}, ${missing}); their content is in the render key, ` +
          "but Frameshell does not watch them: copy them into the project and relink to re-render on every change.",
      ]);
    });

    it("re-list a .blend whose listing an older plugin wrote, which did not count outside files", async () => {
      const blender = adapter();
      const inputs = await blender.inputs!(clip(), inputsContext(project, stub.path));
      writeFileSync(join(project, inputs[3]!), `${JSON.stringify({ blend: SOURCE, paths: [] })}\n`);
      await adapter().inputs!(clip(), inputsContext(project, stub.path));
      expect(stub.runs("deps.py")).toHaveLength(2);
      expect(JSON.parse(readFileSync(join(project, inputs[3]!), "utf8"))).toEqual({ blend: SOURCE, paths: [], outside: 0 });
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

    it("keep one listing file per .blend path: an identical copy elsewhere neither shares nor rewrites it, so no clip re-renders for it", async () => {
      const copy = "copy/intro.blend";
      writeFileSync(join(project, "tex.png"), "png");
      writeBlend(project, SOURCE, { fps: 10, links: ["//../tex.png"] });
      writeBlend(project, copy, { fps: 10, links: ["//../tex.png"] });
      // Same bytes? The model is the same, so the hash is too; the links resolve against each file's own folder.
      const blender = adapter();
      const first = await blender.inputs!(clip(), inputsContext(project, stub.path));
      const second = await blender.inputs!(clip({ source: copy }), inputsContext(project, stub.path));
      expect(second[3]).not.toBe(first[3]);
      const firstText = readFileSync(join(project, first[3]!), "utf8");
      await blender.inputs!(clip({ source: copy }), inputsContext(project, stub.path));
      await adapter().inputs!(clip({ source: copy }), inputsContext(project, stub.path));
      expect(readFileSync(join(project, first[3]!), "utf8")).toBe(firstText);
      expect(JSON.parse(firstText)).toMatchObject({ blend: SOURCE });
      expect(JSON.parse(readFileSync(join(project, second[3]!), "utf8"))).toMatchObject({ blend: copy });
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

    it("put the part rendered (its start and its end) in the key, and nothing of the clip's placement", async () => {
      const blender = adapter();
      const short = await blender.inputs!(clip({ duration: 1 }), inputsContext(project, stub.path));
      const moved = await blender.inputs!(clip({ duration: 1, start: 30 }), inputsContext(project, stub.path));
      const longer = await blender.inputs!(clip({ duration: 2 }), inputsContext(project, stub.path));
      const trimmedIn = await blender.inputs!(clip({ duration: 1, in: 1 }), inputsContext(project, stub.path));
      expect(moved).toEqual(short);
      expect(short[2]).toBe(".frameshell/blender/range/0-1000ms.json");
      expect(longer[2]).toBe(".frameshell/blender/range/0-2000ms.json");
      // A head trim changes what is rendered (the head is not), so it re-renders.
      expect(trimmedIn[2]).toBe(".frameshell/blender/range/1000-2000ms.json");
      const sameEndOtherStart = await blender.inputs!(clip({ duration: 0.5, in: 1.5 }), inputsContext(project, stub.path));
      expect(sameEndOtherStart[2]).toBe(".frameshell/blender/range/1500-2000ms.json");
      expect(JSON.parse(readFileSync(join(project, trimmedIn[2]!), "utf8"))).toEqual({ inMs: 1000, endMs: 2000 });
    });

    it("refuse a Blender outside 4.5 LTS and 5.x, one that is missing, and a host without the inputs context", async () => {
      stub.configure({ version: "4.2.9" });
      await expect(adapter().inputs!(clip(), inputsContext(project, stub.path))).rejects.toThrow(/Blender 4\.2\.9 at .* is outside the supported range \(4\.5 LTS and 5\.x\).*binaries\.blender/);
      await expect(adapter().inputs!(clip(), inputsContext(project, join(tempDir(), "blender")))).rejects.toThrow(/Blender not found at .*Fix `binaries\.blender`/);
      const missing = { ...inputsContext(project, stub.path), ensureBinary: async () => Promise.reject(new Error("Blender is not installed, or Frameshell was not told where it is.")) };
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
      expect(JSON.parse(run![9]!)).toEqual({ scene: "Scene", camera: "Camera", width: 64, height: 36, fps: 10, startFrame: 0, frames: 5, outDir: join(ctx.outDir, "frames"), quality: "draft" });
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

    it("renders only the clip's part, frames in*fps up to (in + duration)*fps, and pads the head transparent so file time is composition time", async () => {
      writeBlend(project, SOURCE, { fps: 20 });
      const { ctx, progress } = renderContext(project, stub.path, { fps: 20 });
      await adapter().render(clip({ in: 0.25, duration: 0.5 }), ctx);
      expect(JSON.parse(stub.runs("render.py")[0]![9]!)).toMatchObject({ fps: 20, startFrame: 5, frames: 10 });
      // Scene frames 6 to 15: the head (1 to 5) is not drawn.
      expect(stub.sceneFrames()).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      const size = { width: 64, height: 36 };
      const rgba = await decodeRgba(join(ctx.outDir, "render.webm"));
      expect(rgba.length / (size.width * size.height * 4)).toBe(15);
      for (let frame = 0; frame < 15; frame++) {
        expect(alphaAt(rgba, size, frame, 2, 2), `corner of frame ${frame}`).toBe(0);
        // Panel: transparent in the padded head, drawn from the first frame of the window.
        const panel = alphaAt(rgba, size, frame, 24, 18);
        if (frame < 5) expect(panel, `panel of frame ${frame}`).toBe(0);
        else expect(panel, `panel of frame ${frame}`).toBeGreaterThanOrEqual(149);
      }
      // Progress counts the window's frames: the `Fra:` lines start at scene frame 6, and still end at the render's share.
      const rendering = progress.filter((update) => update.message === "Rendering").map((update) => update.fraction);
      expect(rendering[0]).toBeLessThan(0.2);
      expect(Math.max(...rendering)).toBeCloseTo(0.9);
    });

    it("pads the head at the exact NTSC rate, and reruns are byte-identical with and without a head", async () => {
      writeBlend(project, SOURCE, { fps: 29.97003, frameStart: 1, frameEnd: 100 });
      const ntsc = renderContext(project, stub.path, { fps: 30000 / 1001 });
      const result = await adapter().render(clip({ in: 0.2, duration: 0.2 }), ntsc.ctx);
      // in 0.2 s is frame 6 (5.994 plus the 1e-3 slack, floored), end frame 12: a window of 6 after a head of 6.
      expect(JSON.parse(stub.runs("render.py")[0]![9]!)).toMatchObject({ startFrame: 5, frames: 7 });
      expect((await decodeRgba(result.file)).length / (64 * 36 * 4)).toBe(12);

      writeBlend(project, SOURCE, { fps: 10, frameStart: 1, frameEnd: 100 });
      for (const extra of [{ duration: 0.3 }, { in: 0.2, duration: 0.3 }]) {
        const first = await adapter().render(clip(extra), renderContext(project, stub.path).ctx);
        const again = await adapter().render(clip(extra), renderContext(project, stub.path).ctx);
        expect(readFileSync(again.file).equals(readFileSync(first.file))).toBe(true);
      }
    });

    it("asks for exactly the frames of an end snapped to the frame grid, and a scene whose last frame is the clip's end renders", async () => {
      // 2/30 s at 30 fps is 2 frames, from frame 1 to frame 2: the scene's own last frame.
      writeBlend(project, SOURCE, { fps: 30, frameStart: 1, frameEnd: 2 });
      const { ctx } = renderContext(project, stub.path, { fps: 30 });
      await adapter().render(clip({ duration: 2 / 30 }), ctx);
      expect(JSON.parse(stub.runs("render.py")[0]![9]!)).toMatchObject({ fps: 30, frames: 2 });
      expect((await decodeRgba(join(ctx.outDir, "render.webm"))).length / (64 * 36 * 4)).toBe(2);

      writeBlend(project, SOURCE, { fps: 60, frameStart: 1, frameEnd: 121 });
      const sixty = renderContext(project, stub.path, { fps: 60 });
      await adapter().render(clip({ duration: 121 / 60 }), sixty.ctx);
      expect(JSON.parse(stub.runs("render.py")[1]![9]!)).toMatchObject({ fps: 60, frames: 121 });
    });

    it("accepts a scene at 29.97 fps for a project at 30000/1001, and encodes it at the exact rate", async () => {
      writeBlend(project, SOURCE, { fps: 29.97003, frameStart: 1, frameEnd: 100 });
      const { ctx } = renderContext(project, stub.path, { fps: 30000 / 1001 });
      const result = await adapter().render(clip({ duration: 0.2 }), ctx);
      expect(JSON.parse(stub.runs("render.py")[0]![9]!)).toMatchObject({ frames: 6 });
      expect((await decodeRgba(result.file)).length / (64 * 36 * 4)).toBe(6);
    });

    it("reports progress from Blender's `Fra:` lines too", async () => {
      const { ctx, progress } = renderContext(project, stub.path);
      await adapter().render(clip(), ctx);
      const rendering = progress.filter((update) => update.message === "Rendering").map((update) => update.fraction);
      // Two reports per frame (the `Fra:` line, then the frame event), at most 0.9 until the encode.
      expect(rendering.length).toBeGreaterThanOrEqual(5);
      expect(Math.max(...rendering)).toBeCloseTo(0.9);
    });

    it("time-remaps a scene at another frame rate: each project frame shows the scene at the same second", async () => {
      // A 24 fps scene in a 30 fps project: frame k shows scene frame 1 + k * 24/30.
      writeBlend(project, SOURCE, { fps: 24, frameStart: 1, frameEnd: 100 });
      const { ctx } = renderContext(project, stub.path, { fps: 30 });
      const result = await adapter().render(clip({ duration: 0.2 }), ctx);
      expect(JSON.parse(stub.runs("render.py")[0]![9]!)).toMatchObject({ fps: 30, frames: 6 });
      expect(stub.sceneFrames()).toEqual([1, 1.8, 2.6, 3.4, 4.2, 5]);
      expect((await decodeRgba(result.file)).length / (64 * 36 * 4)).toBe(6);

      // 60 fps scene in a 30 fps project: every other scene frame.
      writeBlend(project, SOURCE, { fps: 60, frameStart: 0, frameEnd: 100 });
      await adapter().render(clip({ duration: 0.1 }), renderContext(project, stub.path, { fps: 30 }).ctx);
      expect(stub.sceneFrames().slice(6)).toEqual([0, 2, 4]);
    });

    it("refuses a remapped clip that runs past the scene's end, naming both rates", async () => {
      writeBlend(project, SOURCE, { fps: 24, frameStart: 1, frameEnd: 4 });
      await expect(adapter().render(clip({ duration: 0.2 }), renderContext(project, stub.path, { fps: 30 }).ctx)).rejects.toThrow(
        /needs scene frames 1 to 5 \(the scene runs at 24 fps, the project at 30\) but scene "Scene" of scenes\/intro\.blend ends at frame 4 \(4 frames\)/,
      );
    });

    it("refuses a clip longer than the scene, a missing scene and a missing camera, each with the fix", async () => {
      writeBlend(project, SOURCE, { fps: 10, frameStart: 1, frameEnd: 3, scenes: ["Scene", "Alt"], cameras: ["Camera"] });
      await expect(adapter().render(clip(), renderContext(project, stub.path).ctx)).rejects.toThrow(
        /needs scene frames 1 to 5 but scene "Scene" of scenes\/intro\.blend ends at frame 3 \(3 frames\)\. Raise its End frame or shorten the clip/,
      );
      writeBlend(project, SOURCE, { fps: 10, scenes: ["Scene", "Alt"] });
      await expect(adapter().render(clip({ props: { scene: "Nope" } }), renderContext(project, stub.path).ctx)).rejects.toThrow(/no scene "Nope"\. Its scenes: Scene, Alt\. Set props\.scene/);
      await expect(adapter().render(clip({ props: { camera: "Nope" } }), renderContext(project, stub.path).ctx)).rejects.toThrow(/no camera object "Nope"\. Its cameras: Camera\./);
      writeBlend(project, SOURCE, { fps: 10, cameras: [] });
      await expect(adapter().render(clip(), renderContext(project, stub.path).ctx)).rejects.toThrow(/has no active camera\. Set one in Blender/);
    });

    it("counts the frames written against the window, not the clip's end", async () => {
      stub.configure({ skipLast: true });
      await expect(adapter().render(clip({ in: 0.2, duration: 0.3 }), renderContext(project, stub.path).ctx)).rejects.toThrow(/Blender wrote 2 of 3 frames of scenes\/intro\.blend/);
    });

    it("refuses a window that runs past the scene's end even when its head is not rendered", async () => {
      writeBlend(project, SOURCE, { fps: 10, frameStart: 1, frameEnd: 4 });
      await expect(adapter().render(clip({ in: 0.2, duration: 0.3 }), renderContext(project, stub.path).ctx)).rejects.toThrow(
        /needs scene frames 1 to 5 but scene "Scene" of scenes\/intro\.blend ends at frame 4 \(4 frames\)/,
      );
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

    it("kills Blender itself, not just a launcher script that started it, when the render is canceled", async () => {
      stub = stubBlender({ hangAfter: 1 }, { keepWrapper: true });
      const { ctx, controller, progress } = renderContext(project, stub.path);
      const settled = adapter()
        .render(clip(), ctx)
        .then(
          () => "resolved",
          (error: Error) => error.name,
        );
      for (let waited = 0; !progress.some((update) => update.message === "Rendering") && waited < 5000; waited += 20) await new Promise((r) => setTimeout(r, 20));
      const pid = stub.pid();
      expect(() => process.kill(pid, 0)).not.toThrow();
      controller.abort();
      expect(await settled).toBe("AbortError");
      for (let waited = 0; waited < 3000; waited += 50) {
        try {
          process.kill(pid, 0);
        } catch {
          return;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`Blender process ${pid} still runs after its launcher was killed`);
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

  describe("gc and stop", () => {
    const STATE = join(".frameshell", "blender");
    /** Context for `gc` that counts every file as old enough to go, with `inputs` as the clips' current inputs. */
    const gcContext = (inputs: string[], overrides: Partial<AdapterGcContext> = {}): AdapterGcContext => ({
      projectDir: project,
      inputs: new Set(inputs),
      dryRun: false,
      keepNewerThan: Date.now() + 60_000,
      signal: new AbortController().signal,
      ...overrides,
    });
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    it("keeps the listing, length and version of the current clip, deletes those of older saves and lengths, and keeps finals.json", async () => {
      const blender = adapter();
      const old = await blender.inputs!(clip({ duration: 1 }), inputsContext(project, stub.path));
      writeBlend(project, SOURCE, { fps: 10, frameStart: 1, frameEnd: 2000 });
      const current = await blender.inputs!(clip(), inputsContext(project, stub.path));
      writeFileSync(join(project, STATE, "finals.json"), "{}");
      expect(current[3]).not.toBe(old[3]);

      const removed = await blender.gc!(gcContext(current));
      expect(removed.map((entry) => entry.path)).toEqual([old[3]!.replace(/deps\.json$/, ""), old[2]!]);
      for (const kept of [...current.slice(1), `${STATE.replaceAll("\\", "/")}/finals.json`]) expect(existsSync(join(project, kept))).toBe(true);
      expect(existsSync(join(project, old[3]!))).toBe(false);
      expect(existsSync(join(project, old[2]!))).toBe(false);
      // Nothing is left to delete.
      expect(await blender.gc!(gcContext(current))).toEqual([]);
    });

    it("lists a .blend saved back to a version whose listing was deleted, instead of returning a path to a missing file", async () => {
      const blender = adapter();
      const first = await blender.inputs!(clip(), inputsContext(project, stub.path));
      writeBlend(project, SOURCE, { fps: 10, frameStart: 1, frameEnd: 2000 });
      const second = await blender.inputs!(clip(), inputsContext(project, stub.path));
      await blender.gc!(gcContext(second));
      expect(existsSync(join(project, first[3]!))).toBe(false);
      writeBlend(project, SOURCE, { fps: 10, frameStart: 1, frameEnd: 100 });
      const reverted = await blender.inputs!(clip(), inputsContext(project, stub.path));
      expect(reverted).toEqual(first);
      expect(existsSync(join(project, reverted[3]!))).toBe(true);
      expect(stub.runs("deps.py")).toHaveLength(3);
    });

    it("keeps the files of a clip still in use at another length or format, and honours dryRun and keepNewerThan", async () => {
      const blender = adapter();
      const short = await blender.inputs!(clip({ duration: 1 }), inputsContext(project, stub.path));
      const long = await blender.inputs!(clip({ id: "c2", duration: 2 }), inputsContext(project, stub.path));
      // Both clips are current: the union names both range files.
      expect(await blender.gc!(gcContext([...short, ...long]))).toEqual([]);
      const dry = await blender.gc!(gcContext(long, { dryRun: true }));
      expect(dry.map((entry) => entry.path)).toEqual([short[2]!]);
      expect(existsSync(join(project, short[2]!))).toBe(true);
      expect(await blender.gc!(gcContext(long, { keepNewerThan: Date.now() - 3_600_000 }))).toEqual([]);
      expect((await blender.gc!(gcContext(long))).map((entry) => entry.path)).toEqual([short[2]!]);
    });

    it("recognises the key markers an older plugin wrote (<endMs>ms.json) and deletes them when no clip names them", async () => {
      const blender = adapter();
      const current = await blender.inputs!(clip(), inputsContext(project, stub.path));
      writeFileSync(join(project, STATE, "range", "500ms.json"), "{}");
      const removed = await blender.gc!(gcContext(current));
      expect(removed.map((entry) => entry.path)).toEqual([".frameshell/blender/range/500ms.json"]);
      expect(existsSync(join(project, current[2]!))).toBe(true);
    });

    it("kills the Blender that lists a .blend's files when the host stops, rejects, and lists again on the next check", async () => {
      stub.configure({ hangDeps: true });
      const stopping = new AbortController();
      const blender = adapter();
      const settled = Promise.resolve(blender.inputs!(clip(), inputsContext(project, stub.path, stopping.signal))).then(
        () => "resolved",
        (error: Error) => error.name,
      );
      for (let waited = 0; stub.runs("deps.py").length === 0 && waited < 5000; waited += 20) await new Promise((r) => setTimeout(r, 20));
      for (let waited = 0; !existsSync(join(stub.dir, "pid")) && waited < 5000; waited += 20) await new Promise((r) => setTimeout(r, 20));
      const pid = stub.pid();
      expect(alive(pid)).toBe(true);
      stopping.abort();
      expect(await settled).toBe("AbortError");
      for (let waited = 0; alive(pid) && waited < 3000; waited += 50) await new Promise((r) => setTimeout(r, 50));
      expect(alive(pid)).toBe(false);
      // The aborted listing was not remembered, and left no file: the next check lists again.
      stub.configure({});
      const inputs = await blender.inputs!(clip(), inputsContext(project, stub.path));
      expect(existsSync(join(project, inputs[3]!))).toBe(true);
      expect(stub.runs("deps.py")).toHaveLength(2);
    });

    it("starts no listing for a host that already stopped", async () => {
      const stopped = new AbortController();
      stopped.abort();
      await expect(adapter().inputs!(clip(), inputsContext(project, stub.path, stopped.signal))).rejects.toThrow();
      expect(stub.runs("deps.py")).toEqual([]);
    });
  });

  describe("finals", () => {
    const estimate = (blender: ReturnType<typeof adapter>, fps = 10, width = 1000, height = 1000) =>
      blender.finals!.estimate(clip({ duration: 2 }), { projectDir: project, fps, width, height });

    it("render the draft when the host asks for it or names no tier, and the final with Cycles when it asks for the final", async () => {
      for (const tier of ["draft", undefined] as const) {
        await adapter().render(clip(), renderContext(project, stub.path, tier ? { tier } : {}).ctx);
        expect(JSON.parse(stub.runs("render.py").at(-1)![9]!)).toMatchObject({ quality: "draft" });
      }
      const { ctx, progress } = renderContext(project, stub.path, { tier: "final" });
      const result = await adapter().render(clip(), ctx);
      expect(JSON.parse(stub.runs("render.py").at(-1)![9]!)).toMatchObject({ quality: "final", frames: 5 });
      expect(progress.map((update) => update.message)).toContain("Rendering the final (Cycles)");
      expect(alphaAt(await decodeRgba(result.file), { width: 64, height: 36 }, 0, 2, 2)).toBe(0);
    });

    it("estimate the window only: a clip trimmed at the head costs the frames it draws, not the ones before it", async () => {
      // Frames 10 to 20 at 10 fps: a window of 10 frames, against 20 untrimmed.
      const format = { projectDir: project, fps: 10, width: 1000, height: 1000 };
      expect(await adapter().finals!.estimate(clip({ in: 1, duration: 1 }), format)).toBe(10 + 10 * 5);
      expect(await adapter().finals!.estimate(clip({ duration: 2 }), format)).toBe(10 + 20 * 5);
      expect(await adapter().finals!.estimate(clip({ in: 1, duration: 2 }), format)).toBe(10 + 20 * 5);
    });

    it("estimate frames x megapixels x 5 s plus start-up before any final ran here, then the rate this .blend's last final took", async () => {
      // 2 s at 10 fps = 20 frames of 1 megapixel.
      expect(await estimate(adapter())).toBe(10 + 20 * 5);
      expect(await estimate(adapter(), 10, 2000, 1000)).toBe(10 + 20 * 2 * 5);
      expect(existsSync(join(project, ".frameshell", "blender", "finals.json"))).toBe(false);

      await adapter().render(clip(), renderContext(project, stub.path, { tier: "final" }).ctx);
      const measured = JSON.parse(readFileSync(join(project, ".frameshell", "blender", "finals.json"), "utf8")) as { sources: Record<string, number>; last: number };
      expect(measured.sources[SOURCE]).toBeGreaterThan(0);
      expect(measured.last).toBe(measured.sources[SOURCE]);
      // A new adapter (a daemon restart) reads it back.
      expect(await estimate(adapter())).toBeCloseTo(10 + 20 * measured.sources[SOURCE]!, 3);
      // Another .blend of the project takes the last rate measured.
      writeBlend(project, "scenes/other.blend", { fps: 10 });
      const other = await adapter().finals!.estimate({ ...clip({ duration: 2 }), source: "scenes/other.blend" }, { projectDir: project, fps: 10, width: 1000, height: 1000 });
      expect(other).toBeCloseTo(10 + 20 * measured.last, 3);
    });

    it("measure the rate from the frames after the first, which also pays for start-up and kernel compiles", async () => {
      // 5 frames at 64x36: a 600 s first frame (Metal kernels), then 2 s each.
      stub.configure({ frameSeconds: [600, 2, 2, 2, 2] });
      await adapter().render(clip(), renderContext(project, stub.path, { tier: "final" }).ctx);
      const measured = JSON.parse(readFileSync(join(project, ".frameshell", "blender", "finals.json"), "utf8")) as { sources: Record<string, number> };
      expect(measured.sources[SOURCE]).toBeCloseTo(2 / ((64 * 36) / 1e6), 2);
    });

    it("render a still final as the host narrows it, frame k alone after k transparent frames, keyed by its own range, estimated as one frame", async () => {
      // The host's copy of a clip for the final of composition frame 7 at 10 fps (ADR 0035).
      const still = clip({ in: 7 / 10, duration: 1 / 10 });
      const format = { projectDir: project, fps: 10, width: 1000, height: 1000 };
      expect(await adapter().finals!.estimate(still, format)).toBe(10 + 1 * 5);
      const inputs = await adapter().inputs!(still, inputsContext(project, stub.path));
      expect(inputs[2]).toBe(".frameshell/blender/range/700-800ms.json");
      const { ctx } = renderContext(project, stub.path, { tier: "final" });
      await adapter().render(still, ctx);
      expect(JSON.parse(stub.runs("render.py").at(-1)![9]!)).toMatchObject({ quality: "final", startFrame: 7, frames: 1 });
      expect(stub.sceneFrames()).toEqual([8]);
      const size = { width: 64, height: 36 };
      const rgba = await decodeRgba(join(ctx.outDir, "render.webm"));
      expect(rgba.length / (size.width * size.height * 4)).toBe(8);
      for (let frame = 0; frame < 8; frame++) {
        const panel = alphaAt(rgba, size, frame, 24, 18);
        if (frame < 7) expect(panel, `panel of frame ${frame}`).toBe(0);
        else expect(panel, `panel of frame ${frame}`).toBeGreaterThanOrEqual(149);
      }
    });

    it("do not record a final of one frame, whose time is mostly start-up", async () => {
      await adapter().render(clip({ duration: 0.1 }), renderContext(project, stub.path, { tier: "final" }).ctx);
      expect(existsSync(join(project, ".frameshell", "blender", "finals.json"))).toBe(false);
    });

    it("do not measure drafts, and never estimate a clip without a .blend source", async () => {
      await adapter().render(clip(), renderContext(project, stub.path, { tier: "draft" }).ctx);
      expect(existsSync(join(project, ".frameshell", "blender", "finals.json"))).toBe(false);
      await expect(Promise.resolve().then(() => adapter().finals!.estimate({ id: "c1", duration: 1 }, { projectDir: project, fps: 10, width: 64, height: 36 }))).rejects.toThrow(/needs `source`/);
    });
  });
});
