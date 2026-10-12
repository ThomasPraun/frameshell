import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";
import type { LiveContext, RenderContext, RenderProgress } from "@frameshell/plugin-api";
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

  it("passes no variables without props, so the composition's declared defaults apply (#116)", async () => {
    const { producer, calls } = fakeProducer();
    const adapter = createHyperframesAdapter({ projectDir: project, producer: async () => producer });
    await adapter.render({ id: "c_1", source: SOURCE }, context(tempDir()).ctx);
    expect(calls[0]!.config).toMatchObject({ variables: {} });
  });

  it("refuses variables declared as an object, which HyperFrames ignores, and prints the array to use (#116)", async () => {
    const { producer, calls } = fakeProducer();
    const adapter = createHyperframesAdapter({ projectDir: project, producer: async () => producer });
    const dir = join(project, "compositions", "hyperframes", "intro");
    writeFileSync(join(dir, "index.html"), `<html data-composition-variables='{"title":"Orkestra","size":3}'></html>`);
    const out = tempDir();
    await expect(adapter.render({ id: "c_1", source: SOURCE }, context(out).ctx)).rejects.toThrow(
      `hyperframes clip c_1: ${SOURCE} declares data-composition-variables as an object, which HyperFrames ignores, so its defaults never apply. ` +
        `Declare an array of {id, type, label, default} instead: data-composition-variables='[{"id":"title","type":"string","label":"title","default":"Orkestra"},` +
        `{"id":"size","type":"number","label":"size","default":3}]'`,
    );
    // Any HTML file of the composition counts (sub-compositions); double-quoted values are entity-decoded.
    writeFileSync(join(dir, "index.html"), `<html data-composition-variables='[{"id":"title","type":"string","label":"Title","default":"Hi"}]'></html>`);
    writeFileSync(join(dir, "img", "part.html"), `<div data-composition-variables="{&quot;x&quot;:true}"></div>`);
    await expect(adapter.render({ id: "c_1", source: SOURCE }, context(out).ctx)).rejects.toThrow(
      /intro\/img\/part\.html declares .*'\[\{"id":"x","type":"boolean","label":"x","default":true\}\]'/,
    );
    expect(calls).toEqual([]);
    // Array declarations, and values the producer itself reports, render.
    writeFileSync(join(dir, "img", "part.html"), `<div data-composition-variables="not json"></div>`);
    await adapter.render({ id: "c_1", source: SOURCE }, context(tempDir()).ctx);
    expect(calls).toHaveLength(1);
  });

  it("accepts plain JSON props only", async () => {
    const validate = (value: unknown) => propsSchema["~standard"].validate(value);
    expect(await validate({ title: "Launch", colors: ["#fff"], n: 1, on: true })).toEqual({ value: { title: "Launch", colors: ["#fff"], n: 1, on: true } });
    expect(await validate("Launch")).toMatchObject({ issues: [{ message: expect.stringContaining("JSON object") }] });
    expect(await validate({ when: new Date(0) })).toMatchObject({ issues: [{ message: expect.stringContaining("plain JSON") }] });
  });
});

describe("hyperframes live preview (ADR 0010)", () => {
  const live: LiveContext = { projectDir: "", fps: 30, width: 2560, height: 1440, ensureBinary: async (name) => `/managed/${name}` };
  /** Stand-in runtime: binds a player that records seeks, as the HyperFrames runtime does once the timeline is bound. */
  const RUNTIME = "window.__renderReady = true; window.__player = { renderSeek: function (t) { window.seeks.push(t); } };";
  const adapter = (runtime = RUNTIME) => createHyperframesAdapter({ projectDir: project, producer: async () => fakeProducer().producer, runtime: async () => runtime });

  /** Runs `head` against a minimal page, as the host's `<script>` would, and returns that page's window. */
  function load(head: string, media: { muted: boolean }[] = [], extra: Record<string, unknown> = {}) {
    const listeners: Record<string, ((event: { target: unknown }) => void)[]> = {};
    const window: Record<string, unknown> = { seeks: [] as number[] };
    const document = {
      addEventListener: (type: string, listener: (event: { target: unknown }) => void) => (listeners[type] ??= []).push(listener),
      querySelectorAll: () => media,
    };
    window["window"] = window;
    window["setTimeout"] = setTimeout;
    runInNewContext(head, { window, document, setTimeout, Date, Promise, Number, Math, Error, ...extra });
    const page = window["frameshellLive"] as { ready: Promise<void>; seek(seconds: number): Promise<void>; describe(element: unknown): unknown };
    return { window, page, play: (target: unknown) => listeners["play"]?.forEach((listener) => listener({ target })) };
  }

  it("serves the composition directory with the source as entry, never writing to the project", async () => {
    const page = await adapter().livePreview!({ id: "c_1", source: SOURCE }, { ...live, projectDir: project });
    expect(page).toMatchObject({ root: "compositions/hyperframes/intro", entry: SOURCE });
    expect(readdirSync(join(project, "compositions", "hyperframes", "intro")).sort()).toEqual([".DS_Store", "gsap.min.js", "img", "index.html", "node_modules"]);
    // A composition at the project root is served from the root itself.
    writeFileSync(join(project, "card.html"), "<html></html>");
    expect(await adapter().livePreview!({ id: "c_2", source: "card.html" }, live)).toMatchObject({ root: ".", entry: "card.html" });
  });

  it("puts the clip's variables, the glue and the runtime in head, in that order", async () => {
    const { head } = await adapter().livePreview!({ id: "c_1", source: SOURCE, props: { title: "Launch" } }, live);
    const variables = head.indexOf("window.__hfVariables = ");
    const glue = head.indexOf("window.frameshellLive = ");
    expect(variables).toBe(0);
    expect(glue).toBeGreaterThan(variables);
    expect(head.endsWith(RUNTIME)).toBe(true);
    expect(load(head).window["__hfVariables"]).toEqual({ title: "Launch" });
  });

  it("sets no variables without props, as a render does, so the declared defaults apply (#116)", async () => {
    for (const props of [undefined, {}]) {
      const { head } = await adapter().livePreview!({ id: "c_1", source: SOURCE, ...(props ? { props } : {}) }, live);
      expect(head).not.toContain("__hfVariables");
    }
  });

  it("escapes props so no value can close the host's <script> or break the line", async () => {
    const title = "</script><script>alert(1)</script>\u2028\u2029";
    const { head } = await adapter().livePreview!({ id: "c_1", source: SOURCE, props: { title } }, live);
    expect(head).not.toMatch(/<\/script/i);
    expect(head).not.toMatch(/[\u2028\u2029]/);
    expect(load(head).window["__hfVariables"]).toEqual({ title });
  });

  it("refuses a runtime that would close the host's <script>", async () => {
    await expect(adapter("var s = '</SCRIPT>';").livePreview!({ id: "c_1", source: SOURCE }, live)).rejects.toThrow(/cannot be inlined/);
  });

  it("describes an element's file: its sub-composition host's, else the entry, project-relative (ADR 0011)", async () => {
    const { head } = await adapter().livePreview!({ id: "c_1", source: SOURCE }, { ...live, projectDir: project });
    const location = { pathname: "/index.html", href: "frameshell-live://t0k3n/index.html" };
    const { page } = load(head, [], { location, URL, decodeURIComponent });
    const host = { getAttribute: (name: string) => (name === "data-composition-src" ? "scenes/out%20ro.html" : null) };
    expect(page.describe({ closest: () => host })).toEqual({ source: "compositions/hyperframes/intro/scenes/out ro.html" });
    expect(page.describe({ closest: () => null })).toEqual({ source: SOURCE });
  });

  it("seeks with renderSeek once the runtime is ready, clamping bad times to 0 and keeping media muted", async () => {
    const { head } = await adapter().livePreview!({ id: "c_1", source: SOURCE }, live);
    const video = { muted: false };
    const { window, page, play } = load(head, [video]);
    await page.ready;
    await page.seek(1.5);
    await page.seek(-2);
    await page.seek(Number.NaN);
    expect(window["seeks"]).toEqual([1.5, 0, 0]);
    expect(video.muted).toBe(true);
    const audio = { muted: false };
    play(audio);
    expect(audio.muted).toBe(true);
  });

  it("waits for the runtime to bind the timeline before the first seek", async () => {
    const late = "setTimeout(function () { window.__player = { renderSeek: function (t) { window.seeks.push(t); } }; window.__renderReady = true; }, 40);";
    const { head } = await adapter(late).livePreview!({ id: "c_1", source: SOURCE }, live);
    const { window, page } = load(head);
    const seeking = page.seek(2);
    expect(window["seeks"]).toEqual([]);
    await seeking;
    expect(window["seeks"]).toEqual([2]);
  });

  it("refuses what render refuses: no HTML source, a source outside the project, object variable declarations", async () => {
    await expect(adapter().livePreview!({ id: "c_9" }, live)).rejects.toThrow(/c_9 needs `source`/);
    await expect(adapter().livePreview!({ id: "c_9", source: "../x/index.html" }, live)).rejects.toThrow(/outside the project/);
    writeFileSync(join(project, SOURCE), `<html data-composition-variables='{"title":"T"}'></html>`);
    await expect(adapter().livePreview!({ id: "c_9", source: SOURCE }, live)).rejects.toThrow(/declares data-composition-variables as an object/);
  });

  it("loads the HyperFrames runtime from @hyperframes/core by default", async () => {
    const real = createHyperframesAdapter({ projectDir: project, producer: async () => fakeProducer().producer });
    const { head } = await real.livePreview!({ id: "c_1", source: SOURCE }, live);
    expect(head).toContain("__hyperframes");
    expect(head).toContain("renderSeek");
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
      refreshRenders: () => {},
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
    // CSS animation only: data-no-timeline spares the producer's 45 s wait for a GSAP timeline.
    expect(html).toContain('data-composition-id="outro" data-width="2560" data-height="1440" data-duration="4" data-no-timeline>');
    expect(html).toContain('data-duration="4"');
    expect(html).toContain("getVariables()");
    // HyperFrames reads declared defaults only from an array of {id, type, label, default} (#116).
    const declared = /data-composition-variables='([^']*)'/.exec(html)?.[1];
    expect(JSON.parse(declared!)).toEqual([{ id: "title", type: "string", label: "Title", default: "Title" }]);
  });

  it("never overwrites, and rejects bad names and flags", async () => {
    await expect(newComposition.run({ args: ["intro"], cwd: project, project: { dir: project } })).rejects.toThrow(/already exists/);
    expect(readFileSync(join(project, SOURCE), "utf8")).toBe("<html></html>");
    await expect(newComposition.run({ args: ["Intro Card"], cwd: project, project: { dir: project } })).rejects.toThrow(/usage/);
    await expect(newComposition.run({ args: ["x", "--duration", "0"], cwd: project, project: { dir: project } })).rejects.toThrow(/--duration/);
  });
});
