import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { BinaryManager } from "@frameshell/core";
import type { RenderProgress } from "@frameshell/plugin-api";
import { createRemotionAdapter, loadProjectConfig, newComposition } from "../src/index.js";

// Opt-in: bundles and renders a scaffolded composition for real, with the Remotion this package installs as
// devDependencies (standing in for the user's project) and the managed headless Chrome and ffmpeg, kept under
// .cache/test-binaries. Run with FRAMESHELL_TEST_REAL_REMOTION=1 pnpm test.
const execFileAsync = promisify(execFile);
const pluginModules = fileURLToPath(new URL("../node_modules", import.meta.url));

function tempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "frameshell-remotion-real-")));
}

/** Same store as the core media tests (`FRAMESHELL_TEST_BINARIES_DIR` overrides). */
function binaries(): BinaryManager {
  const dir = process.env["FRAMESHELL_TEST_BINARIES_DIR"] || fileURLToPath(new URL("../../../.cache/test-binaries", import.meta.url));
  return new BinaryManager({ dataDir: dir, configDir: dir });
}

describe.runIf(process.env["FRAMESHELL_TEST_REAL_REMOTION"] === "1")("real Remotion render", () => {
  it(
    "renders the scaffold at the project format to VP9 WebM with alpha, and re-keys on a code edit",
    async () => {
      const project = tempDir();
      writeFileSync(join(project, "frameshell.json"), JSON.stringify({ fps: 30, resolution: { width: 320, height: 180 } }));
      await newComposition.run({ args: ["card", "--duration", "1"], cwd: project, project: { dir: project } });
      // The scaffold's package.json pins what this package installs; link instead of `npm install`.
      symlinkSync(pluginModules, join(project, "compositions", "remotion", "node_modules"), "junction");
      const manager = binaries();
      const ffmpeg = await manager.ensure("ffmpeg");
      const ffprobe = await manager.ensure("ffprobe");
      const adapter = createRemotionAdapter({ projectDir: project });
      try {
        const clip = { id: "c_card", source: "compositions/remotion/src/index.ts", props: { composition: "card", inputProps: { title: "Launch" } } };
        const [key] = await adapter.inputs!(clip);
        expect(await adapter.inputs!(clip)).toEqual([key]);
        const progress: RenderProgress[] = [];
        const result = await adapter.render(clip, {
          projectDir: project,
          outDir: tempDir(),
          fps: 30,
          width: 320,
          height: 180,
          signal: new AbortController().signal,
          ensureBinary: (name) => manager.ensure(name),
          progress: (update) => progress.push(update),
        });
        expect(result.hasAlpha).toBe(true);
        expect(progress.at(-1)?.fraction).toBe(1);

        const { stdout } = await execFileAsync(ffprobe, [
          ...["-v", "error", "-select_streams", "v:0", "-count_packets"],
          ...["-show_entries", "stream=codec_name,width,height,nb_read_packets:stream_tags=alpha_mode", "-of", "json", result.file],
        ]);
        const [stream] = (JSON.parse(stdout) as { streams: { codec_name: string; width: number; height: number; nb_read_packets: string; tags?: Record<string, string> }[] }).streams;
        expect(stream).toMatchObject({ codec_name: "vp9", width: 320, height: 180 });
        expect(stream!.tags?.["alpha_mode"] ?? stream!.tags?.["ALPHA_MODE"]).toBe("1");
        expect(Number(stream!.nb_read_packets)).toBe(30);

        /** Alpha 0..255 of pixel (x, y) at `t` seconds, decoded with libvpx (the native vp9 decoder drops alpha). */
        const alpha = async (t: number, x: number, y: number) => {
          const { stdout: raw } = await execFileAsync(
            ffmpeg,
            ["-v", "error", "-c:v", "libvpx-vp9", "-ss", String(t), "-i", result.file, "-frames:v", "1", "-vf", `crop=1:1:${x}:${y},format=rgba`, "-f", "rawvideo", "-"],
            { encoding: "buffer" },
          );
          return raw[3]!;
        };
        // Card: left 6% (19 px), bottom 10% (18 px), 0.72 opaque background; springs in, fades out over the last 0.5 s.
        expect(await alpha(0.4, 4, 4)).toBe(0);
        expect(await alpha(0.4, 30, 150)).toBeGreaterThan(150);

        // A code edit changes the bundle, so the key.
        const component = join(project, "compositions", "remotion", "src", "Card.tsx");
        writeFileSync(component, readFileSync(component, "utf8").replace("rgba(12, 18, 40, 0.72)", "rgba(200, 18, 40, 0.72)"));
        expect(await adapter.inputs!(clip)).not.toEqual([key]);
      } finally {
        adapter.close();
      }
    },
    600_000,
  );

  it(
    "applies the project's remotion.config.ts: Tailwind v4 through its webpack override, and its OpenGL renderer",
    async () => {
      const project = tempDir();
      writeFileSync(join(project, "frameshell.json"), JSON.stringify({ fps: 30, resolution: { width: 320, height: 180 } }));
      await newComposition.run({ args: ["swatch", "--duration", "0.2"], cwd: project, project: { dir: project } });
      const root = join(project, "compositions", "remotion");
      symlinkSync(pluginModules, join(root, "node_modules"), "junction");
      writeFileSync(
        join(root, "remotion.config.ts"),
        [
          'import { Config } from "@remotion/cli/config";',
          'import { enableTailwind } from "@remotion/tailwind-v4";',
          "Config.overrideWebpackConfig((config) => enableTailwind(config));",
          'Config.setChromiumOpenGlRenderer("swangle");',
          "",
        ].join("\n"),
      );
      writeFileSync(join(root, "src", "index.css"), '@import "tailwindcss";\n');
      // Only Tailwind can paint this: the class exists nowhere else.
      writeFileSync(
        join(root, "src", "Swatch.tsx"),
        'import "./index.css";\nexport const Swatch = () => <div className="absolute left-0 top-0 h-[90px] w-[160px] bg-[rgb(255,0,0)]" />;\n',
      );
      expect(await loadProjectConfig(root, null)).toMatchObject({ file: join(root, "remotion.config.ts"), gl: "swangle", bundlerOverride: null });

      const manager = binaries();
      const ffmpeg = await manager.ensure("ffmpeg");
      const adapter = createRemotionAdapter({ projectDir: project });
      try {
        const result = await adapter.render(
          { id: "c_swatch", source: "compositions/remotion/src/index.ts", props: { composition: "swatch" } },
          {
            projectDir: project,
            outDir: tempDir(),
            fps: 30,
            width: 320,
            height: 180,
            signal: new AbortController().signal,
            ensureBinary: (name) => manager.ensure(name),
            progress: () => {},
          },
        );
        const pixel = async (x: number, y: number) => {
          const { stdout: raw } = await execFileAsync(
            ffmpeg,
            ["-v", "error", "-c:v", "libvpx-vp9", "-i", result.file, "-frames:v", "1", "-vf", `format=rgba,crop=1:1:${x}:${y}`, "-f", "rawvideo", "-"],
            { encoding: "buffer" },
          );
          return [raw[0]!, raw[1]!, raw[2]!, raw[3]!];
        };
        const [r = 0, g = 0, b = 0, a = 0] = await pixel(40, 40);
        expect({ red: r > 200 && g < 60 && b < 60, opaque: a > 240 }).toEqual({ red: true, opaque: true });
        expect((await pixel(250, 150))[3]).toBe(0);
      } finally {
        adapter.close();
      }
    },
    600_000,
  );
});
