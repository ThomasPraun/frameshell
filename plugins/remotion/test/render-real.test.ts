import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import puppeteer from "puppeteer-core";
import { describe, expect, it } from "vitest";
import { BinaryManager } from "@frameshell/core";
import type { RenderProgress } from "@frameshell/plugin-api";
import { createRemotionAdapter, loadProjectConfig, newComposition } from "../src/index.js";

// Opt-in: bundles and renders a scaffolded composition for real, with the Remotion this package installs as
// devDependencies (standing in for the user's project) and the managed headless Chrome and ffmpeg, kept under
// .cache/test-binaries. Run with FRAMESHELL_TEST_REAL_REMOTION=1 pnpm test. The live preview test loads the bundle
// page in that same Chrome, inside a sandboxed frame like the app's.
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

  it(
    "plays the live page in a sandboxed frame: composition mode, the clip's title, frames on seek, transparent around (ADR 0010)",
    async () => {
      const project = tempDir();
      writeFileSync(join(project, "frameshell.json"), JSON.stringify({ fps: 30, resolution: { width: 320, height: 180 } }));
      await newComposition.run({ args: ["card", "--duration", "1"], cwd: project, project: { dir: project } });
      symlinkSync(pluginModules, join(project, "compositions", "remotion", "node_modules"), "junction");
      const manager = binaries();
      const chrome = await manager.ensure("chrome-headless-shell");
      const adapter = createRemotionAdapter({ projectDir: project });
      const server = createServer();
      const browser = await puppeteer.launch({ executablePath: chrome });
      try {
        const live = await adapter.livePreview!(
          { id: "c_card", source: "compositions/remotion/src/index.ts", props: { composition: "card", inputProps: { title: "Launch" } } },
          { projectDir: project, fps: 30, width: 320, height: 180, ensureBinary: (name) => manager.ensure(name) },
        );
        // Test probe after `head`, standing in for the app's bridge: seeks on the parent's message, replies with the title's state.
        const probe = `window.addEventListener("message", function (event) {
          window.frameshellLive.ready.then(function () { return window.frameshellLive.seek(event.data); }).then(function () {
            var title = Array.prototype.find.call(document.querySelectorAll("div"), function (d) { return d.children.length === 0 && d.textContent === "Launch"; });
            parent.postMessage({ seconds: event.data, opacity: title ? Number(getComputedStyle(title).opacity) : null }, "*");
          }, function (error) { parent.postMessage({ error: String(error) }, "*"); });
        });`;
        // The parent page: green, so a transparent page shows it; the frame is sandboxed without same-origin, as in the app.
        const parent = `<body style="margin:0;background:#00ff00"><iframe id="live" sandbox="allow-scripts" src="/${posix.basename(live.entry)}" width="320" height="180" style="border:0;display:block"></iframe>
          <script>window.replies = []; addEventListener("message", function (e) { replies.push(e.data); });</script></body>`;
        server.on("request", (request, response) => {
          const path = new URL(request.url ?? "/", "http://x").pathname;
          if (path === "/parent") return void response.writeHead(200, { "content-type": "text/html" }).end(parent);
          const file = posix.join(live.root, decodeURIComponent(path));
          readFile(join(project, ...file.split("/"))).then(
            (body) => {
              const html = file === live.entry;
              const type = html ? "text/html" : file.endsWith(".js") ? "text/javascript" : "application/octet-stream";
              response.writeHead(200, { "content-type": type, "access-control-allow-origin": "*" });
              response.end(html ? body.toString("utf8").replace(/<head>/i, () => `<head><script>${live.head}</script><script>${probe}</script>`) : body);
            },
            () => response.writeHead(404).end(),
          );
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const page = await browser.newPage();
        await page.setViewport({ width: 320, height: 180 });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/parent`);
        const at = async (seconds: number) => {
          const count = (await page.evaluate("window.replies.length")) as number;
          await page.evaluate(`document.getElementById("live").contentWindow.postMessage(${seconds}, "*")`);
          await page.waitForFunction(`window.replies.length > ${count}`, { timeout: 60_000 });
          const reply = (await page.evaluate("window.replies[window.replies.length - 1]")) as { seconds?: number; opacity?: number | null; error?: string };
          expect(reply.error).toBeUndefined();
          return { opacity: reply.opacity, pixels: Buffer.from(await page.screenshot({ type: "png" })) };
        };
        const entering = await at(0.1);
        const shown = await at(0.4);
        const leaving = await at(0.95);
        expect(errors).toEqual([]);
        // The card springs in, then fades out over the last 0.5 s, on the composition clock.
        expect(entering.opacity).toBeGreaterThan(0);
        expect(entering.opacity!).toBeLessThan(shown.opacity!);
        expect(leaving.opacity!).toBeLessThan(shown.opacity!);
        expect(entering.pixels.equals(shown.pixels)).toBe(false);
        // Transparent around the card, as in the render: the parent's green shows through at the top right.
        const clip = await page.screenshot({ type: "png", clip: { x: 300, y: 10, width: 1, height: 1 }, encoding: "base64" });
        const green = (await page.evaluate(`new Promise((resolve) => {
          const image = new Image();
          image.onload = () => { const c = document.createElement("canvas"); c.width = 1; c.height = 1; const g = c.getContext("2d"); g.drawImage(image, 0, 0); resolve(Array.from(g.getImageData(0, 0, 1, 1).data)); };
          image.src = "data:image/png;base64,${clip}";
        })`)) as number[];
        expect(green).toEqual([0, 255, 0, 255]);
      } finally {
        await browser.close();
        server.close();
        adapter.close();
      }
    },
    600_000,
  );
});
