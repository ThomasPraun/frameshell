import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { RenderContext, RenderProgress } from "@frameshell/plugin-api";
import { parsePluginManifest } from "@frameshell/schema";
import { type Producer, activate, createHyperframesAdapter, newComposition, propsSchema } from "../src/index.js";

function tempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "frameshell-hyperframes-test-")));
}

let project: string;
const SOURCE = "compositions/hyperframes/intro/index.html";

beforeEach(() => {
  project = tempDir();
  const dir = join(project, "compositions", "hyperframes", "intro");
  mkdirSync(join(dir, "img"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "gsap"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<html></html>");
  writeFileSync(join(dir, "gsap.min.js"), "gsap");
  writeFileSync(join(dir, "img", "logo.svg"), "<svg/>");
  writeFileSync(join(dir, ".DS_Store"), "junk");
  writeFileSync(join(dir, "node_modules", "gsap", "index.js"), "dep");
  writeFileSync(join(project, "frameshell.json"), JSON.stringify({ resolution: { width: 2560, height: 1440 } }));
});

/** Fake producer: records the job and where it rendered, reports progress, writes a file. */
function fakeProducer() {
  const calls: { config: unknown; projectDir: string; output: string; signal: AbortSignal | undefined; files: string[] }[] = [];
  const producer: Producer = {
    createRenderJob: (config) => ({ config }),
    async executeRenderJob(job, projectDir, output, onProgress, signal) {
      calls.push({ config: (job as { config: unknown }).config, projectDir, output, signal, files: readdirSync(projectDir, { recursive: true }) as string[] });
      await onProgress?.({ progress: 40 }, "Capturing frames");
      // The producer may write next to the entry: the adapter renders a copy, so this never touches the project.
      writeFileSync(join(projectDir, "scratch.tmp"), "x");
      writeFileSync(output, "webm-bytes");
      await onProgress?.({ progress: 100 }, "Done");
    },
  };
  return { producer, calls };
}

function context(outDir: string) {
  const progress: RenderProgress[] = [];
  const binaries: string[] = [];
  const controller = new AbortController();
  const ctx: RenderContext = {
    projectDir: project,
    outDir,
    fps: 30,
    width: 2560,
    height: 1440,
    signal: controller.signal,
    ensureBinary: async (name) => {
      binaries.push(name);
      return `/managed/${name}`;
    },
    progress: (update) => progress.push(update),
  };
  return { ctx, progress, binaries, controller };
}

describe("hyperframes adapter", () => {
  it("counts every file of the composition directory as a cache input, skipping dot files and node_modules", async () => {
    const adapter = createHyperframesAdapter({ projectDir: project, producer: async () => fakeProducer().producer });
    expect(await adapter.inputs!({ id: "c_1", source: SOURCE })).toEqual([
      "compositions/hyperframes/intro/gsap.min.js",
      "compositions/hyperframes/intro/img/logo.svg",
      "compositions/hyperframes/intro/index.html",
    ]);
    expect(await adapter.inputs!({ id: "c_1" })).toEqual([]);
    expect(await adapter.inputs!({ id: "c_1", source: "compositions/hyperframes/missing/index.html" })).toEqual([]);
  });

  it("renders in-process to VP9 WebM with alpha, with the managed binaries, props as composition variables", async () => {
    const { producer, calls } = fakeProducer();
    const adapter = createHyperframesAdapter({ projectDir: project, producer: async () => producer });
    const outDir = tempDir();
    const { ctx, progress, binaries, controller } = context(outDir);
    const result = await adapter.render({ id: "c_1", source: SOURCE, props: { title: "Launch" } }, ctx);

    expect(result).toEqual({ file: join(outDir, "render.webm"), hasAlpha: true });
    expect(readFileSync(result.file, "utf8")).toBe("webm-bytes");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.config).toEqual({ fps: 30, quality: "standard", format: "webm", entryFile: "index.html", variables: { title: "Launch" } });
    expect(call!.signal).toBe(controller.signal);
    // A copy of the composition inside the scratch dir; the project stays untouched.
    expect(call!.projectDir.startsWith(outDir)).toBe(true);
    expect(call!.files).toEqual(expect.arrayContaining(["index.html", "gsap.min.js", join("img", "logo.svg")]));
    expect(existsSync(join(project, "compositions", "hyperframes", "intro", "scratch.tmp"))).toBe(false);
    // ADR 0002: the producer runs the managed ffmpeg, ffprobe and headless Chrome.
    expect(binaries.sort()).toEqual(["chrome-headless-shell", "ffmpeg", "ffprobe"]);
    expect(process.env["HYPERFRAMES_FFMPEG_PATH"]).toBe("/managed/ffmpeg");
    expect(process.env["HYPERFRAMES_FFPROBE_PATH"]).toBe("/managed/ffprobe");
    expect(process.env["PRODUCER_HEADLESS_SHELL_PATH"]).toBe("/managed/chrome-headless-shell");
    expect(progress).toContainEqual({ fraction: 0.4, message: "Capturing frames" });
    expect(progress.at(-1)).toEqual({ fraction: 1, message: "Done" });
  });

  it("refuses a source outside the project: never lists, copies or renders foreign files", async () => {
    const outside = join(project, "..", `${basename(project)}-secret`);
    mkdirSync(outside);
    writeFileSync(join(outside, "index.html"), "<html></html>");
    writeFileSync(join(outside, "id_rsa"), "key");
    symlinkSync(outside, join(project, "compositions", "linked"), process.platform === "win32" ? "junction" : "dir");
    const { producer, calls } = fakeProducer();
    const adapter = createHyperframesAdapter({ projectDir: project, producer: async () => producer });
    const sources = [
      `../${basename(outside)}/index.html`,
      "compositions/../../x/index.html",
      "../../../../../../../../index.html",
      join(outside, "index.html").split("\\").join("/"),
      "C:/Users/index.html",
      "compositions\\..\\..\\x\\index.html",
      "compositions/linked/index.html",
    ];
    for (const source of sources) {
      await expect(adapter.inputs!({ id: "c_1", source }), source).rejects.toThrow(/outside the project/);
      const out = tempDir();
      await expect(adapter.render({ id: "c_1", source, duration: 2 }, context(out).ctx), source).rejects.toThrow(/outside the project/);
      expect(readdirSync(out), source).toEqual([]);
    }
    expect(calls).toEqual([]);
    // Normalizing inside the project stays allowed.
    expect(await adapter.inputs!({ id: "c_1", source: "compositions/x/../hyperframes/intro/index.html" })).toContain(
      "compositions/hyperframes/intro/index.html",
    );
  });

  it("refuses a clip without an HTML source, saying how to make one", async () => {
    const adapter = createHyperframesAdapter({ projectDir: project, producer: async () => fakeProducer().producer });
    const { ctx } = context(tempDir());
    await expect(adapter.render({ id: "c_9" }, ctx)).rejects.toThrow(/c_9 needs `source`.*frameshell hyperframes new/);
    await expect(adapter.render({ id: "c_9", source: "compositions/hyperframes/intro/logo.png" }, ctx)).rejects.toThrow(/HTML entry/);
  });

  it("accepts plain JSON props only", async () => {
    const validate = (value: unknown) => propsSchema["~standard"].validate(value);
    expect(await validate({ title: "Launch", colors: ["#fff"], n: 1, on: true })).toEqual({ value: { title: "Launch", colors: ["#fff"], n: 1, on: true } });
    expect(await validate("Launch")).toMatchObject({ issues: [{ message: expect.stringContaining("JSON object") }] });
    expect(await validate({ when: new Date(0) })).toMatchObject({ issues: [{ message: expect.stringContaining("plain JSON") }] });
  });
});

describe("plugin manifest", () => {
  it("declares exactly what activate registers, and ships its skill", async () => {
    const root = new URL("../", import.meta.url);
    const manifest = parsePluginManifest(JSON.parse(readFileSync(new URL("frameshell-plugin.json", root), "utf8")));
    if (!manifest.ok) throw new Error(manifest.error);
    const registered: string[] = [];
    activate({
      apiVersion: "1",
      plugin: { name: manifest.value.name, version: manifest.value.version, dir: "" },
      project: { dir: project },
      registerClipType: (adapter) => registered.push(`clip:${adapter.type}`),
      registerCommand: (name) => registered.push(`command:${name}`),
      registerExportPreset: () => {},
      registerTranscriptionProvider: () => {},
    });
    const { clipTypes, commands, skills } = manifest.value.contributes;
    expect(registered.sort()).toEqual([...clipTypes.map((t) => `clip:${t}`), ...commands.map((c) => `command:${c}`)].sort());
    for (const skill of skills) expect(existsSync(new URL(skill, root))).toBe(true);
  });
});

describe("frameshell hyperframes new", () => {
  it("scaffolds a transparent composition at the project resolution and prints the clip add command", async () => {
    const result = await newComposition.run({ args: ["outro", "--duration", "4"], cwd: project, project: { dir: project } });
    expect(result).toMatchObject({
      data: { source: "compositions/hyperframes/outro/index.html", width: 2560, height: 1440, duration: 4 },
      output: expect.stringContaining("--type hyperframes --source compositions/hyperframes/outro/index.html"),
    });
    const html = readFileSync(join(project, "compositions", "hyperframes", "outro", "index.html"), "utf8");
    expect(html).toContain('data-composition-id="outro" data-width="2560" data-height="1440" data-duration="4"');
    expect(html).toContain('data-duration="4"');
    expect(html).toContain("getVariables()");
  });

  it("never overwrites, and rejects bad names and flags", async () => {
    await expect(newComposition.run({ args: ["intro"], cwd: project, project: { dir: project } })).rejects.toThrow(/already exists/);
    expect(readFileSync(join(project, SOURCE), "utf8")).toBe("<html></html>");
    await expect(newComposition.run({ args: ["Intro Card"], cwd: project, project: { dir: project } })).rejects.toThrow(/usage/);
    await expect(newComposition.run({ args: ["x", "--duration", "0"], cwd: project, project: { dir: project } })).rejects.toThrow(/--duration/);
  });
});
