import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginApi, RenderContext, RenderProgress } from "@frameshell/plugin-api";
import { parsePluginManifest } from "@frameshell/schema";
import {
  BUNDLE_DIR,
  NO_CONFIG,
  type RemotionProjectConfig,
  type RemotionComposition,
  type RemotionModules,
  type RemotionRenderer,
  type WebpackConfig,
  activate,
  createRemotionAdapter,
  fastVp9,
  fitToProject,
  propsSchema,
} from "../src/index.js";

function tempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "frameshell-remotion-test-")));
}

const SOURCE = "compositions/remotion/src/index.ts";
let project: string;
/** A "web app" outside the project whose file the composition imports. */
let web: string;
let closers: (() => void)[] = [];

beforeEach(() => {
  project = tempDir();
  web = tempDir();
  const src = join(project, "compositions", "remotion", "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(project, "compositions", "remotion", "package.json"), JSON.stringify({ dependencies: { remotion: "4.0.527" } }));
  writeFileSync(join(src, "index.ts"), "registerRoot(Root)");
  writeFileSync(join(web, "Panel.tsx"), "export const Panel = 1");
  writeFileSync(join(project, "frameshell.json"), JSON.stringify({ fps: 30, resolution: { width: 2560, height: 1440 } }));
});

afterEach(() => {
  for (const close of closers) close();
  closers = [];
});

/**
 * Fake Remotion: `bundle` writes `index.html` plus a `bundle.js` made of the
 * entry and the outside file, and reports both through the webpack plugin
 * the adapter adds, as webpack's `fileDependencies` would.
 */
function fakeRemotion(
  compositions: RemotionComposition[] = [{ id: "Intro", width: 1920, height: 1080, fps: 30, durationInFrames: 240 }],
  config: (root: string) => RemotionProjectConfig = () => NO_CONFIG,
) {
  const calls = { bundle: 0, roots: [] as string[], select: [] as unknown[], render: [] as Record<string, unknown>[], canceled: 0, webpack: [] as WebpackConfig[] };
  const renderer: RemotionRenderer = {
    async selectComposition(options) {
      calls.select.push(options);
      const found = compositions.find((c) => c.id === options.id);
      if (!found) throw new Error(`Could not find composition with ID ${options.id}`);
      return found;
    },
    getCompositions: async () => compositions,
    async renderMedia(options) {
      calls.render.push(options as unknown as Record<string, unknown>);
      options.onProgress({ progress: 0.5 });
      writeFileSync(options.outputLocation, "webm-bytes");
      options.onProgress({ progress: 1 });
      return {};
    },
    makeCancelSignal: () => ({ cancelSignal: "signal", cancel: () => calls.canceled++ }),
  };
  const load = async (root: string): Promise<RemotionModules> => {
    calls.roots.push(root);
    return {
      root,
      version: "4.0.527",
      renderer,
      config: config(root),
      bundler: {
        async bundle({ entryPoint, outDir, webpackOverride, onProgress }) {
          calls.bundle++;
          const deps = [entryPoint, join(web, "Panel.tsx"), web];
          const missing = [join(web, "missing.tsx")];
          const webpack = await webpackOverride!({ plugins: [] } as WebpackConfig);
          calls.webpack.push(webpack);
          for (const plugin of (webpack.plugins as { apply?(compiler: unknown): void }[]).filter((p) => p.apply)) {
            plugin.apply!(
{ hooks: { done: { tap: (_: string, fn: (stats: unknown) => void) => fn({ compilation: { fileDependencies: new Set(deps), missingDependencies: new Set(missing) } }) } } });
          }
          onProgress?.(100);
          mkdirSync(outDir, { recursive: true });
          writeFileSync(join(outDir, "index.html"), "<html></html>");
          writeFileSync(join(outDir, "bundle.js"), deps.filter((d) => existsSync(d) && d !== web).map((d) => readFileSync(d, "utf8")).join("\n"));
          return outDir;
        },
      },
    };
  };
  return { load, calls };
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

function adapter(load: ReturnType<typeof fakeRemotion>["load"], refreshRenders?: () => void) {
  const created = createRemotionAdapter({ projectDir: project, loadRemotion: load, ...(refreshRenders ? { refreshRenders } : {}) });
  closers.push(() => created.close());
  return created;
}

/** Bump a file's mtime past any filesystem timestamp granularity. */
function touch(file: string, content: string): void {
  writeFileSync(file, content);
  const later = new Date(Date.now() + 5_000);
  utimesSync(file, later, later);
}

describe("remotion props", () => {
  const validate = (value: unknown) => propsSchema["~standard"].validate(value) as { issues?: { message: string }[] };

  it("takes a composition id and optional JSON input props", () => {
    expect(validate({ composition: "Intro" }).issues).toBeUndefined();
    expect(validate({ composition: "intro-card", inputProps: { title: "Launch", items: [1, 2], nested: { on: true } } }).issues).toBeUndefined();
  });

  it("refuses a missing or invalid composition, non-JSON input props, and props outside inputProps", () => {
    expect(validate({}).issues?.[0]?.message).toMatch(/composition must be the id/);
    expect(validate({ composition: "has space" }).issues).toHaveLength(1);
    expect(validate({ composition: "Intro", inputProps: [1] }).issues?.[0]?.message).toMatch(/plain JSON object/);
    expect(validate({ composition: "Intro", inputProps: { when: new Date() } }).issues).toHaveLength(1);
    expect(validate({ composition: "Intro", title: "Launch" }).issues?.[0]?.message).toMatch(/unknown prop title: composition props go inside inputProps/);
    expect(validate("Intro").issues).toHaveLength(1);
  });
});

describe("fitting a composition to the project", () => {
  const comp = { id: "Intro", width: 1920, height: 1080, fps: 30, durationInFrames: 240 };

  it("scales a same-aspect composition and converts its length to project frames", () => {
    expect(fitToProject(comp, { fps: 25, width: 2560, height: 1440 })).toEqual({ composition: { ...comp, fps: 25, durationInFrames: 200 }, scale: 4 / 3 });
    expect(fitToProject(comp, { fps: 30, width: 1920, height: 1080 })).toEqual({ composition: comp, scale: 1 });
  });

  it("renders another aspect at the project size, unscaled", () => {
    expect(fitToProject(comp, { fps: 30, width: 1080, height: 1920 })).toEqual({ composition: { ...comp, width: 1080, height: 1920 }, scale: 1 });
  });
});

describe("fast VP9 stitching", () => {
  it("adds multithreaded libvpx flags right before the output path", () => {
    const out = fastVp9(["-i", "frames/%03d.png", "-c:v", "libvpx-vp9", "-y", "/out/render.webm"]);
    expect(out.slice(0, 5)).toEqual(["-i", "frames/%03d.png", "-c:v", "libvpx-vp9", "-y"]);
    expect(out.at(-1)).toBe("/out/render.webm");
    expect(out.slice(5, -1)).toEqual(["-row-mt", "1", "-threads", expect.stringMatching(/^\d+$/), "-deadline", "good", "-cpu-used", "4"]);
  });
});

describe("remotion adapter inputs", () => {
  it("keys a clip by its bundle under .frameshell/remotion, bundling once while nothing changes", async () => {
    const { load, calls } = fakeRemotion();
    const remotion = adapter(load);
    const [first] = await remotion.inputs!({ id: "c_1", source: SOURCE });
    expect(first).toMatch(new RegExp(`^${BUNDLE_DIR}/[0-9a-f]{16}/[0-9a-f]{32}/index\\.html$`));
    expect(existsSync(join(project, ...first!.split("/")))).toBe(true);
    expect(await remotion.inputs!({ id: "c_2", source: SOURCE })).toEqual([first]);
    expect(calls.bundle).toBe(1);
    expect(calls.roots).toEqual([join(project, "compositions", "remotion")]);
  });

  it("gives a new key when a file outside the project changes, and the old key back when it is restored", async () => {
    const { load, calls } = fakeRemotion();
    const remotion = adapter(load);
    const [before] = await remotion.inputs!({ id: "c_1", source: SOURCE });
    touch(join(web, "Panel.tsx"), "export const Panel = 2");
    const [edited] = await remotion.inputs!({ id: "c_1", source: SOURCE });
    expect(edited).not.toBe(before);
    touch(join(web, "Panel.tsx"), "export const Panel = 1");
    expect(await remotion.inputs!({ id: "c_1", source: SOURCE })).toEqual([before]);
    expect(calls.bundle).toBe(3);
  });

  it("re-bundles when a file webpack missed appears", async () => {
    const { load, calls } = fakeRemotion();
    const remotion = adapter(load);
    await remotion.inputs!({ id: "c_1", source: SOURCE });
    writeFileSync(join(web, "missing.tsx"), "now here");
    await remotion.inputs!({ id: "c_1", source: SOURCE });
    expect(calls.bundle).toBe(2);
  });

  it("keeps a few bundles per entry and drops older ones", async () => {
    const { load } = fakeRemotion();
    const remotion = adapter(load);
    for (let i = 0; i < 6; i++) {
      touch(join(web, "Panel.tsx"), `export const Panel = ${i}`);
      await remotion.inputs!({ id: "c_1", source: SOURCE });
    }
    const [entryDir] = readdirSync(join(project, ...BUNDLE_DIR.split("/")));
    expect(readdirSync(join(project, ...BUNDLE_DIR.split("/"), entryDir!))).toHaveLength(3);
  });

  it("asks the host to refresh when a watched file outside the project changes", { timeout: 15_000 }, async () => {
    const { load } = fakeRemotion();
    let refreshed = 0;
    const remotion = adapter(load, () => refreshed++);
    await remotion.inputs!({ id: "c_1", source: SOURCE });
    // FSEvents (macOS) drops events from just after a watch starts: keep editing until one lands.
    const deadline = Date.now() + 10_000;
    for (let i = 0; refreshed === 0 && Date.now() < deadline; i++) {
      writeFileSync(join(web, "Panel.tsx"), `export const Panel = ${i + 3}`);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    expect(refreshed).toBeGreaterThan(0);
  });

  it("fails with the fix when source is missing, absolute, not a file, or outside any Remotion project", async () => {
    const { load } = fakeRemotion();
    const remotion = adapter(load);
    await expect(remotion.inputs!({ id: "c_1" })).rejects.toThrow(/needs `source`: the Remotion entry file/);
    await expect(remotion.inputs!({ id: "c_1", source: "/abs/index.ts" })).rejects.toThrow(/relative to the project/);
    await expect(remotion.inputs!({ id: "c_1", source: "compositions\\remotion\\src\\index.ts" })).rejects.toThrow(/relative to the project/);
    await expect(remotion.inputs!({ id: "c_1", source: "compositions/remotion/src/nope.ts" })).rejects.toThrow(/does not exist/);
    writeFileSync(join(web, "index.ts"), "registerRoot(Root)");
    const outside = relative(project, join(web, "index.ts")).split(sep).join("/");
    await expect(remotion.inputs!({ id: "c_1", source: outside })).rejects.toThrow(/not inside a Remotion project/);
  });
});

describe("remotion.config of the Remotion project", () => {
  const configFile = () => join(project, "compositions", "remotion", "remotion.config.ts");

  it("applies the project's webpack override before recording dependencies, so overridden loaders count", async () => {
    const tailwind = { tailwind: true };
    const { load, calls } = fakeRemotion(undefined, () => ({
      ...NO_CONFIG,
      file: configFile(),
      webpackOverride: async (webpack) => ({ ...webpack, plugins: [...(webpack.plugins ?? []), tailwind] }),
    }));
    writeFileSync(configFile(), "Config.overrideWebpackConfig(enableTailwind)");
    await adapter(load).inputs!({ id: "c_1", source: SOURCE });
    expect(calls.webpack[0]?.plugins?.[0]).toBe(tailwind);
    expect(calls.webpack[0]?.plugins).toHaveLength(2);
  });

  it("re-bundles and re-keys when the config file appears or changes, even if the bundle is the same", async () => {
    const { load, calls } = fakeRemotion(undefined, () => (existsSync(configFile()) ? { ...NO_CONFIG, file: configFile() } : NO_CONFIG));
    const remotion = adapter(load);
    const [none] = await remotion.inputs!({ id: "c_1", source: SOURCE });
    writeFileSync(configFile(), 'Config.setChromiumOpenGlRenderer("angle")');
    const [angle] = await remotion.inputs!({ id: "c_1", source: SOURCE });
    touch(configFile(), 'Config.setChromiumOpenGlRenderer("swangle")');
    const [swangle] = await remotion.inputs!({ id: "c_1", source: SOURCE });
    expect(new Set([none, angle, swangle]).size).toBe(3);
    expect(calls.bundle).toBe(3);
  });

  it("renders with the project's OpenGL renderer", async () => {
    const { load, calls } = fakeRemotion(undefined, () => ({ ...NO_CONFIG, file: configFile(), gl: "angle" }));
    writeFileSync(configFile(), 'Config.setChromiumOpenGlRenderer("angle")');
    await adapter(load).render({ id: "c_1", source: SOURCE, props: { composition: "Intro" } }, context(tempDir()).ctx);
    expect(calls.select).toEqual([expect.objectContaining({ chromiumOptions: { gl: "angle" } })]);
    expect(calls.render[0]).toMatchObject({ chromiumOptions: { gl: "angle" } });
  });
});

describe("remotion adapter render", () => {
  it("renders the named composition with the managed Chrome, scaled to the project, to VP9 WebM with alpha", async () => {
    const { load, calls } = fakeRemotion();
    const remotion = adapter(load);
    const outDir = tempDir();
    const { ctx, progress, binaries } = context(outDir);
    const result = await remotion.render({ id: "c_1", source: SOURCE, props: { composition: "Intro", inputProps: { title: "Hola" } } }, ctx);

    expect(result).toEqual({ file: join(outDir, "render.webm"), hasAlpha: true });
    expect(binaries).toEqual(["chrome-headless-shell"]);
    expect(calls.select).toEqual([
      expect.objectContaining({ id: "Intro", inputProps: { title: "Hola" }, browserExecutable: "/managed/chrome-headless-shell", chromeMode: "headless-shell" }),
    ]);
    const [options] = calls.render;
    expect(options).toMatchObject({
      codec: "vp9",
      imageFormat: "png",
      pixelFormat: "yuva420p",
      muted: true,
      scale: 4 / 3,
      inputProps: { title: "Hola" },
      browserExecutable: "/managed/chrome-headless-shell",
      composition: { id: "Intro", width: 1920, height: 1080, fps: 30, durationInFrames: 240 },
      cancelSignal: "signal",
    });
    const override = options!["ffmpegOverride"] as (info: { type: string; args: string[] }) => string[];
    expect(override({ type: "stitcher", args: ["-y", "out.webm"] })).toContain("-row-mt");
    expect(override({ type: "pre-stitcher", args: ["-y", "out.webm"] })).toEqual(["-y", "out.webm"]);
    expect(progress.at(-1)).toEqual({ fraction: 1, message: "Done" });
    expect(progress.every((p, i) => i === 0 || p.fraction >= progress[i - 1]!.fraction)).toBe(true);
  });

  it("names the entry's compositions when props.composition is not one of them", async () => {
    const { load } = fakeRemotion([
      { id: "Intro", width: 1920, height: 1080, fps: 30, durationInFrames: 30 },
      { id: "Outro", width: 1920, height: 1080, fps: 30, durationInFrames: 30 },
    ]);
    const remotion = adapter(load);
    await expect(remotion.render({ id: "c_1", source: SOURCE, props: { composition: "Middle" } }, context(tempDir()).ctx)).rejects.toThrow(
      'the entry has no composition "Middle". Its compositions: Intro, Outro.',
    );
  });

  it("cancels Remotion when the daemon aborts the render", async () => {
    const { load, calls } = fakeRemotion();
    const remotion = adapter(load);
    const { ctx, controller } = context(tempDir());
    controller.abort();
    await remotion.render({ id: "c_1", source: SOURCE, props: { composition: "Intro" } }, ctx);
    expect(calls.canceled).toBe(1);
  });

  it("needs props naming the composition", async () => {
    const { load } = fakeRemotion();
    await expect(adapter(load).render({ id: "c_1", source: SOURCE }, context(tempDir()).ctx)).rejects.toThrow(/needs props naming its composition/);
  });
});

describe("remotion plugin", () => {
  it("registers exactly what its manifest declares, with the host's refresh hook", async () => {
    const manifest = parsePluginManifest(JSON.parse(readFileSync(new URL("../frameshell-plugin.json", import.meta.url), "utf8")));
    expect(manifest.ok).toBe(true);
    const types: string[] = [];
    const commands: string[] = [];
    let refreshed = 0;
    const api = {
      apiVersion: "1",
      plugin: { name: "@frameshell/remotion", version: "0.1.0", dir: "/plugin" },
      project: { dir: project },
      registerClipType: (a: { type: string; close?: () => void }) => {
        types.push(a.type);
        closers.push(() => a.close?.());
      },
      registerCommand: (name: string) => commands.push(name),
      registerExportPreset: () => {},
      registerTranscriptionProvider: () => {},
      refreshRenders: () => refreshed++,
    } as unknown as PluginApi;
    activate(api);
    if (!manifest.ok) return;
    expect(types).toEqual(manifest.value.contributes.clipTypes);
    expect(commands).toEqual(manifest.value.contributes.commands);
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string; dependencies?: object };
    expect(manifest.value.version).toBe(pkg.version);
    // ADR 0009: Remotion comes from the user's project, never from the plugin.
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});
