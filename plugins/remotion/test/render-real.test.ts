import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import puppeteer, { type Page } from "puppeteer-core";
import { describe, expect, it } from "vitest";
import { BinaryManager } from "@frameshell/core";
import type { LivePage, RenderProgress } from "@frameshell/plugin-api";
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

/**
 * Serves a live page as the app's `frameshell-live://` handler does (the
 * project's files under `live.root`, byte ranges for media, CORS `*`, `head`
 * then `probe` injected after `<head>`), plus `/parent`: a green page that
 * frames it with `sandbox="allow-scripts"`, as the app does, and collects the
 * frame's messages in `window.replies`.
 */
async function serveLive(project: string, live: LivePage, probe: string, size: { width: number; height: number }) {
  const parent = `<body style="margin:0;background:#00ff00"><iframe id="live" sandbox="allow-scripts" src="/${posix.basename(live.entry)}" width="${size.width}" height="${size.height}" style="border:0;display:block"></iframe>
    <script>window.replies = []; addEventListener("message", function (e) { replies.push(e.data); });</script></body>`;
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".mp4": "video/mp4", ".webm": "video/webm" };
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://x").pathname;
    if (path === "/parent") return void response.writeHead(200, { "content-type": "text/html" }).end(parent);
    const file = posix.join(live.root, decodeURIComponent(path));
    readFile(join(project, ...file.split("/"))).then(
      (body) => {
        const headers = { "content-type": types[posix.extname(file)] ?? "application/octet-stream", "access-control-allow-origin": "*", "accept-ranges": "bytes" };
        if (file === live.entry) {
          return void response.writeHead(200, headers).end(body.toString("utf8").replace(/<head>/i, () => `<head><script>${live.head}</script><script>${probe}</script>`));
        }
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
        if (!range) return void response.writeHead(200, headers).end(body);
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
        const part = body.subarray(start, end + 1);
        response.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${body.length}`, "content-length": part.length }).end(part);
      },
      () => response.writeHead(404).end(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/parent`, close: () => server.close() };
}

/** RGBA of pixel (x, y) of the page's viewport, read back through a PNG screenshot. */
async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  const shot = await page.screenshot({ type: "png", clip: { x, y, width: 1, height: 1 }, encoding: "base64" });
  return (await page.evaluate(`new Promise((resolve) => {
    const image = new Image();
    image.onload = () => { const c = document.createElement("canvas"); c.width = 1; c.height = 1; const g = c.getContext("2d"); g.drawImage(image, 0, 0); resolve(Array.from(g.getImageData(0, 0, 1, 1).data)); };
    image.src = "data:image/png;base64,${shot}";
  })`)) as number[];
}

/** Posts `seconds` to the live frame and returns the probe's reply; the probe seeks, then replies. */
async function seekLive(page: Page, seconds: number): Promise<Record<string, unknown>> {
  const count = (await page.evaluate("window.replies.length")) as number;
  await page.evaluate(`document.getElementById("live").contentWindow.postMessage(${seconds}, "*")`);
  await page.waitForFunction(`window.replies.length > ${count}`, { timeout: 60_000 });
  return (await page.evaluate("window.replies[window.replies.length - 1]")) as Record<string, unknown>;
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
    "moves and scales an element in the render when the host passes elementCss, and renders as before without it (ADR 0021)",
    async () => {
      const project = tempDir();
      writeFileSync(join(project, "frameshell.json"), JSON.stringify({ fps: 30, resolution: { width: 320, height: 180 } }));
      await newComposition.run({ args: ["swatch", "--duration", "0.2"], cwd: project, project: { dir: project } });
      const root = join(project, "compositions", "remotion");
      symlinkSync(pluginModules, join(root, "node_modules"), "junction");
      writeFileSync(join(root, "src", "Swatch.tsx"), 'export const Swatch = () => <div id="box" style={{ position: "absolute", left: 0, top: 0, width: 80, height: 45, background: "rgb(255,0,0)" }} />;\n');
      const manager = binaries();
      const ffmpeg = await manager.ensure("ffmpeg");
      const adapter = createRemotionAdapter({ projectDir: project });
      try {
        const clip = { id: "c_swatch", source: "compositions/remotion/src/index.ts", props: { composition: "swatch" } };
        const render = (elementCss?: string) =>
          adapter.render(clip, {
            projectDir: project,
            outDir: tempDir(),
            fps: 30,
            width: 320,
            height: 180,
            signal: new AbortController().signal,
            ensureBinary: (name) => manager.ensure(name),
            progress: () => {},
            ...(elementCss ? { elementCss } : {}),
          });
        const alpha = async (file: string, x: number, y: number) => {
          const { stdout: raw } = await execFileAsync(
            ffmpeg,
            ["-v", "error", "-c:v", "libvpx-vp9", "-i", file, "-frames:v", "1", "-vf", `format=rgba,crop=1:1:${x}:${y}`, "-f", "rawvideo", "-"],
            { encoding: "buffer" },
          );
          return raw[3]!;
        };
        const plain = await render();
        expect({ origin: await alpha(plain.file, 10, 20), moved: await alpha(plain.file, 150, 20) }).toEqual({ origin: 255, moved: 0 });
        // Moved 80 px right, then scaled 2 about its centre: the box covers x 40..200, y -22..68.
        const adjusted = await render("#box { translate: 80px 0 !important; scale: 2 !important; }");
        expect({ origin: await alpha(adjusted.file, 10, 20), moved: await alpha(adjusted.file, 150, 20) }).toEqual({ origin: 0, moved: 255 });
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
      const browser = await puppeteer.launch({ executablePath: chrome });
      let close = () => {};
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
        // Green parent: a transparent page shows it.
        const served = await serveLive(project, live, probe, { width: 320, height: 180 });
        close = served.close;
        const page = await browser.newPage();
        await page.setViewport({ width: 320, height: 180 });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        await page.goto(served.url);
        const at = async (seconds: number) => {
          const reply = (await seekLive(page, seconds)) as { opacity?: number | null; error?: string };
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
        expect(await pixel(page, 300, 10)).toEqual([0, 255, 0, 255]);
      } finally {
        await browser.close();
        close();
        adapter.close();
      }
    },
    600_000,
  );
  it(
    "plays media live as the render shows it: <Video>, <OffthreadVideo> (frames decoded in the page), alpha, and Date props",
    async () => {
      const project = tempDir();
      writeFileSync(join(project, "frameshell.json"), JSON.stringify({ fps: 30, resolution: { width: 320, height: 180 } }));
      await newComposition.run({ args: ["card", "--duration", "1"], cwd: project, project: { dir: project } });
      const root = join(project, "compositions", "remotion");
      symlinkSync(pluginModules, join(root, "node_modules"), "junction");
      const manager = binaries();
      const ffmpeg = await manager.ensure("ffmpeg");
      const chrome = await manager.ensure("chrome-headless-shell");
      mkdirSync(join(root, "public"));
      // 2 s at 160x90: red for the first second, blue for the next.
      await execFileAsync(ffmpeg, [
        ...["-v", "error", "-f", "lavfi", "-i", "color=red:s=160x90:r=30:d=1", "-f", "lavfi", "-i", "color=blue:s=160x90:r=30:d=1"],
        ...["-filter_complex", "[0][1]concat=n=2:v=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(root, "public", "clip.mp4")],
      ]);
      // VP9 with alpha: a white square, opaque on its left half, clear on its right half.
      await execFileAsync(ffmpeg, [
        ...["-v", "error", "-f", "lavfi", "-i", "color=white@1:s=160x90:r=30:d=1,format=rgba,geq=r=255:g=255:b=255:a='if(lt(X,80),255,0)'"],
        ...["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", join(root, "public", "alpha.webm")],
      ]);
      writeFileSync(
        join(root, "src", "Media.tsx"),
        `import { AbsoluteFill, OffthreadVideo, Video, staticFile } from "remotion";
export const Media = ({ when, kind }: { when: Date; kind: string }) => (
  <AbsoluteFill>
    <div id="when">{String(when.getTime())}</div>
    {kind === "video" ? <Video src={staticFile("clip.mp4")} style={{ width: 160, height: 90 }} /> : <OffthreadVideo src={staticFile("clip.mp4")} style={{ width: 160, height: 90 }} />}
    <OffthreadVideo transparent src={staticFile("alpha.webm")} style={{ position: "absolute", left: 160, top: 90, width: 160, height: 90 }} />
  </AbsoluteFill>
);
`,
      );
      writeFileSync(
        join(root, "src", "Root.tsx"),
        `import { Composition } from "remotion";
import { Media } from "./Media";
export const Root = () => (
  <Composition id="media" component={Media} durationInFrames={60} fps={30} width={320} height={180} defaultProps={{ when: new Date(1700000000000), kind: "offthread" }} />
);
`,
      );
      const adapter = createRemotionAdapter({ projectDir: project });
      const browser = await puppeteer.launch({ executablePath: chrome });
      const closers: (() => void)[] = [];
      try {
        for (const kind of ["offthread", "video"]) {
          const live = await adapter.livePreview!(
            { id: "c_media", source: "compositions/remotion/src/index.ts", props: { composition: "media", inputProps: { kind } } },
            { projectDir: project, fps: 30, width: 320, height: 180, ensureBinary: (name) => manager.ensure(name) },
          );
          const probe = `window.addEventListener("message", function (event) {
            window.frameshellLive.ready.then(function () { return window.frameshellLive.seek(event.data); }).then(function () {
              var when = document.getElementById("when");
              parent.postMessage({ when: when ? when.textContent : null }, "*");
            }, function (error) { parent.postMessage({ error: String(error) }, "*"); });
          });`;
          const served = await serveLive(project, live, probe, { width: 320, height: 180 });
          closers.push(served.close);
          const page = await browser.newPage();
          await page.setViewport({ width: 320, height: 180 });
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(String(error)));
          await page.goto(served.url);
          const color = async () => {
            const [r = 0, g = 0, b = 0] = await pixel(page, 80, 45);
            return r > 200 && g < 60 && b < 60 ? "red" : b > 200 && r < 60 && g < 60 ? "blue" : `rgb(${r}, ${g}, ${b})`;
          };
          // The Date default prop survives serialization: the composition calls getTime() on it.
          expect(await seekLive(page, 0.2)).toEqual({ when: "1700000000000" });
          expect({ kind, color: await color() }).toEqual({ kind, color: "red" });
          expect(await seekLive(page, 1.5)).toEqual({ when: "1700000000000" });
          expect({ kind, color: await color() }).toEqual({ kind, color: "blue" });
          // The transparent video keeps its alpha: white where opaque, the parent's green where clear.
          const [r = 0, g = 0, b = 0] = await pixel(page, 200, 135);
          expect(Math.min(r, g, b)).toBeGreaterThan(230);
          expect(await pixel(page, 280, 135)).toEqual([0, 255, 0, 255]);
          expect(errors).toEqual([]);
          await page.close();
        }
      } finally {
        await browser.close();
        for (const close of closers) close();
        adapter.close();
      }
    },
    600_000,
  );
});
