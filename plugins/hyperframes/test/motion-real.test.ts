import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import puppeteer from "puppeteer-core";
import { describe, expect, it } from "vitest";
import { BinaryManager, ClipVerifier } from "@frameshell/core";
import { createHyperframesAdapter } from "../src/index.js";
import { MOTION_RUNTIME, MOTION_RUNTIME_FILE } from "../src/motion-runtime.js";

// Opt-in like render-real (FRAMESHELL_TEST_REAL_HYPERFRAMES=1): a composition painted by the motion runtime
// (ADR 0033), bound through window.__timelines with no data-no-timeline, rendered and played live in managed Chrome.
const execFileAsync = promisify(execFile);
const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "frameshell-motion-real-")));
const binaries = () => {
  const dir = process.env["FRAMESHELL_TEST_BINARIES_DIR"] || fileURLToPath(new URL("../../../.cache/test-binaries", import.meta.url));
  return new BinaryManager({ dataDir: dir, configDir: dir });
};

const DURATION = 1;

/**
 * Red #box springs 80 px right (playful, overshoots ~20 %) while it turns and fades in; three blue dots
 * follow a retargeted track, staggered. Rotation and fractional offsets make anti-aliasing part of every probe.
 */
const COMPOSITION = `<!doctype html>
<html>
  <head>
    <style>
      * { margin: 0; padding: 0; }
      html, body { width: 160px; height: 90px; overflow: hidden; }
      #stage { position: relative; width: 100%; height: 100%; }
      .clip { position: absolute; inset: 0; }
      #box { position: absolute; left: 10px; top: 25px; width: 40px; height: 40px; background: #ff0000; }
      .dot { position: absolute; top: 4px; width: 8px; height: 8px; border-radius: 50%; background: #0000ff; }
    </style>
    <script src="${MOTION_RUNTIME_FILE}"></script>
  </head>
  <body>
    <div id="stage" data-composition-id="motion" data-width="160" data-height="90" data-duration="${DURATION}">
      <div class="clip" data-start="0" data-duration="${DURATION}" data-track-index="0">
        <div id="box"></div>
        <div class="dot" style="left: 4px"></div><div class="dot" style="left: 16px"></div><div class="dot" style="left: 28px"></div>
      </div>
    </div>
    <script>
      var M = window.FrameshellMotion;
      var box = document.getElementById("box");
      var dots = document.querySelectorAll(".dot");
      var path = M.track("snappy", 0, [{ at: 0.1, to: 90 }, { at: 0.45, to: 40 }]);
      M.bind("motion", function (t) {
        M.write(box, { x: M.spring("playful", t, 0, 80), rotate: 12 * M.ease("enter", t), opacity: M.ease("enter", t / 0.3) });
        for (var i = 0; i < dots.length; i++) {
          M.write(dots[i], { x: path(t - M.stagger(i, dots.length, M.STAGGER_STEPS.items)).value, y: 0.37 * i });
        }
      });
    </script>
  </body>
</html>
`;

function project(): string {
  const dir = tempDir();
  const composition = join(dir, "compositions", "hyperframes", "motion");
  mkdirSync(composition, { recursive: true });
  writeFileSync(join(dir, "frameshell.json"), JSON.stringify({ resolution: { width: 160, height: 90 } }));
  writeFileSync(join(composition, "index.html"), COMPOSITION);
  writeFileSync(join(composition, MOTION_RUNTIME_FILE), MOTION_RUNTIME);
  return dir;
}

const clip = { id: "c_motion", source: "compositions/hyperframes/motion/index.html" };

describe.runIf(process.env["FRAMESHELL_TEST_REAL_HYPERFRAMES"] === "1")("motion runtime (real HyperFrames)", () => {
  it(
    "renders without the 45 s timeline wait; the spring moves and overshoots, and element CSS still moves the sprung element",
    async () => {
      const dir = project();
      const manager = binaries();
      const ffmpeg = await manager.ensure("ffmpeg");
      const adapter = createHyperframesAdapter({ projectDir: dir });
      const render = (elementCss?: string) =>
        adapter.render(clip, {
          projectDir: dir,
          outDir: tempDir(),
          fps: 30,
          width: 160,
          height: 90,
          signal: new AbortController().signal,
          ensureBinary: (name) => manager.ensure(name),
          progress: () => {},
          ...(elementCss ? { elementCss } : {}),
        });
      const started = performance.now();
      const plain = await render();
      // The producer's player timeout is 45 s: a binding it had to wait for would show here.
      expect(performance.now() - started).toBeLessThan(40_000);
      const moved = await render("#box { translate: 0px 30px !important; }");

      /** Centre of the red pixels at `t` seconds, decoded with libvpx (keeps alpha). */
      const red = async (file: string, t: number) => {
        const { stdout: raw } = await execFileAsync(
          ffmpeg,
          ["-v", "error", "-c:v", "libvpx-vp9", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "format=rgba", "-f", "rawvideo", "-"],
          { encoding: "buffer" },
        );
        let [n, sx, sy] = [0, 0, 0];
        for (let i = 0; i < raw.length; i += 4) {
          if (raw[i + 3]! > 128 && raw[i]! > 150 && raw[i + 1]! < 100 && raw[i + 2]! < 100) {
            n++;
            sx += (i / 4) % 160;
            sy += Math.floor(i / 4 / 160);
          }
        }
        return { n, x: sx / n, y: sy / n };
      };
      const early = await red(plain.file, 0.1);
      const peak = await red(plain.file, 0.3);
      const late = await red(plain.file, 0.9);
      // At rest the box centre is x 30, y 45; the spring carries it 80 px right, overshooting on the way.
      expect(early.x).toBeLessThan(peak.x);
      expect(late.x).toBeGreaterThan(100);
      expect(peak.x).toBeGreaterThan(late.x + 5);
      expect(late.y).toBeCloseTo(45, 0);
      // Element CSS (ADR 0021) composes with the runtime's transform: same x, 30 px lower (clipped at the bottom edge).
      const shifted = await red(moved.file, 0.9);
      expect(shifted.x).toBeCloseTo(late.x, 0);
      expect(shifted.y).toBeGreaterThan(late.y + 20);
    },
    600_000,
  );

  it(
    "paints the settling tail frame by frame as it paints each frame cold (no change too small for Chrome to repaint)",
    async () => {
      // Near rest the spring moves the box less than 1/80 px a frame: before the runtime wrote on a 1/32 px grid,
      // Chrome kept the older raster and frames 26 to 29 of a sequential render differed from cold by 8/255 (#501).
      const dir = project();
      const composition = join(dir, "compositions", "hyperframes", "motion");
      const server = createServer((request, response) => {
        const name = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname).replace(/^\//, "");
        readFile(join(composition, name)).then(
          (body) => response.writeHead(200, { "content-type": name.endsWith(".html") ? "text/html" : "text/javascript" }).end(body),
          () => response.writeHead(404).end(),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/index.html`;
      // Software compositing, as the producer runs Chrome by default.
      const browser = await puppeteer.launch({ executablePath: await binaries().ensure("chrome-headless-shell"), args: ["--disable-gpu-compositing"] });
      try {
        // The background is made transparent once per page, as the producer does: puppeteer's `omitBackground` sets it
        // around every capture, which repaints the whole page and hides the threshold.
        const open = async () => {
          const page = await browser.newPage();
          await page.setViewport({ width: 160, height: 90 });
          await page.goto(url);
          const cdp = await page.createCDPSession();
          await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
          const shot = async (t: number) => {
            await page.evaluate(`window.__timelines.motion.seek(${t})`);
            const { data } = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
            return data;
          };
          return { page, shot };
        };
        const sequential = await open();
        const differing: number[] = [];
        for (let frame = 0; frame < 30; frame++) {
          const warm = await sequential.shot(frame / 30);
          const cold = await open();
          if (warm !== (await cold.shot(frame / 30))) differing.push(frame);
          await cold.page.close();
        }
        expect(differing).toEqual([]);
      } finally {
        await browser.close();
        server.close();
      }
    },
    600_000,
  );

  it(
    "passes clip verify (the core determinism check) on the motion composition",
    async () => {
      const dir = project();
      const manager = binaries();
      const adapter = createHyperframesAdapter({ projectDir: dir });
      const timeline = { id: "main", revision: 1, tracks: [{ id: "v1", kind: "video", clips: [{ ...clip, type: "hyperframes", start: 0, in: 0, duration: DURATION }] }] };
      const verifier = new ClipVerifier({
        timeline: async () => ({ timeline: timeline as never, fps: 30 }),
        live: async (_root, _timeline, id) => ({
          ...(await adapter.livePreview!(clip, { projectDir: dir, fps: 30, width: 160, height: 90, ensureBinary: (name) => manager.ensure(name) })),
          clip: id,
          key: "k",
        }),
        resolution: async () => ({ width: 160, height: 90 }),
        chrome: () => manager.ensure("chrome-headless-shell"),
        ffmpeg: () => manager.ensure("ffmpeg"),
      });
      const result = await verifier.verify(dir, { timeline: "main", clip: "c_motion" });
      expect(result).toMatchObject({ ok: true, worst: null, warnings: [] });
      expect(result.probes).toHaveLength(12);
      expect(result.distinct).toBeGreaterThan(8);
    },
    600_000,
  );
});
