import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
import { TEMPLATES, createHyperframesAdapter, newComposition } from "../src/index.js";

// Opt-in like render-real (FRAMESHELL_TEST_REAL_HYPERFRAMES=1): the templates of #466 in managed Chrome. Live pages at the
// four formats check the per-format layout and cold-vs-reseek determinism; one real render per template checks alpha and speed.
const execFileAsync = promisify(execFile);
const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "frameshell-templates-real-")));
const binaries = () => {
  const dir = process.env["FRAMESHELL_TEST_BINARIES_DIR"] || fileURLToPath(new URL("../../../.cache/test-binaries", import.meta.url));
  return new BinaryManager({ dataDir: dir, configDir: dir });
};

/** The four built-in formats (ADR 0027) at a small size with the same aspect ratio. */
const FORMATS = { "16x9": [480, 270], "1x1": [360, 360], "4x5": [288, 360], "9x16": [270, 480] } as const;

async function scaffold(template: string, width: number, height: number): Promise<string> {
  const dir = tempDir();
  writeFileSync(join(dir, "frameshell.json"), JSON.stringify({ resolution: { width, height } }));
  await newComposition.run({ args: ["spot", "--template", template], cwd: dir, project: { dir } });
  return dir;
}

const clip = { id: "c_spot", source: "compositions/hyperframes/spot/index.html" };

describe.runIf(process.env["FRAMESHELL_TEST_REAL_HYPERFRAMES"] === "1")("motion templates (real HyperFrames)", () => {
  describe.each(TEMPLATES.map((t) => [t.id, t.overlay] as const))("%s", (template, overlay) => {
    it(
      "lays out inside the frame in every format and paints the same frames cold and after a reseek (≤ 2/255)",
      async () => {
        const manager = binaries();
        const [chrome, ffmpeg] = await Promise.all([manager.ensure("chrome-headless-shell"), manager.ensure("ffmpeg")]);
        const browser = await puppeteer.launch({ executablePath: chrome });
        const scratch = tempDir();
        let n = 0;
        try {
          for (const [format, [width, height]] of Object.entries(FORMATS)) {
            const dir = await scaffold(template, width, height);
            const adapter = createHyperframesAdapter({ projectDir: dir });
            const live = await adapter.livePreview!(clip, { projectDir: dir, fps: 30, width, height, ensureBinary: (name) => manager.ensure(name) });
            const server = createServer((request, response) => {
              const path = posix.join(live.root, decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname));
              readFile(join(dir, ...path.split("/"))).then(
                (body) => {
                  const html = path === live.entry;
                  response.writeHead(200, { "content-type": html ? "text/html" : "text/javascript" });
                  response.end(html ? body.toString("utf8").replace(/<head>/i, () => `<head><script>${live.head}</script>`) : body);
                },
                () => response.writeHead(404).end(),
              );
            });
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${posix.basename(live.entry)}`;
            const errors: string[] = [];
            /** RGBA bytes of the page at `t`, seeking through the live bridge. */
            const frame = async (page: Awaited<ReturnType<typeof browser.newPage>>, t: number) => {
              await page.evaluate(`window.frameshellLive.seek(${t})`);
              const file = join(scratch, `${n++}.png`);
              writeFileSync(file, await page.screenshot({ type: "png", omitBackground: true }));
              const { stdout } = await execFileAsync(ffmpeg, ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], {
                encoding: "buffer",
                maxBuffer: 1 << 26,
              });
              return stdout;
            };
            const open = async () => {
              const page = await browser.newPage();
              page.on("pageerror", (error) => errors.push(String(error)));
              await page.setViewport({ width, height });
              await page.goto(url);
              await page.evaluate("window.frameshellLive.ready");
              return page;
            };
            try {
              const times = [0.45, 0.9, 1.6, 2.4];
              const cold: Buffer[] = [];
              for (const t of times) {
                const page = await open();
                cold.push(await frame(page, t));
                await page.close();
              }
              const page = await open();
              let worst = 0;
              for (const [i, t] of times.entries()) {
                await frame(page, times[(i + 2) % times.length]!);
                const again = await frame(page, t);
                for (let b = 0; b < again.length; b++) worst = Math.max(worst, Math.abs(again[b]! - cold[i]![b]!));
              }
              expect(errors, format).toEqual([]);
              expect(worst, format).toBeLessThanOrEqual(2);
              // Something is drawn, it moves, and (once settled) it stays inside the frame margin.
              const settled = cold[3]!;
              let minX: number = width;
              let minY: number = height;
              let maxX = 0;
              let maxY = 0;
              let drawn = 0;
              for (let p = 0; p < settled.length; p += 4) {
                if (settled[p + 3]! < 200) continue;
                const x = (p / 4) % width;
                const y = Math.floor(p / 4 / width);
                drawn++;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
              }
              expect(drawn, format).toBeGreaterThan(width * height * 0.002);
              expect(cold[0]!.equals(cold[3]!), format).toBe(false);
              // An overlay leaves most of the frame unpainted (over footage) and keeps inside it with a margin.
              if (overlay) {
                expect(drawn, format).toBeLessThan(width * height * 0.5);
                expect(minX, format).toBeGreaterThan(width * 0.03);
                expect(maxX, format).toBeLessThan(width * 0.97);
                expect(minY, format).toBeGreaterThan(height * 0.03);
                expect(maxY, format).toBeLessThan(height * 0.97);
              }
              // Before the first bubble is due (default delay 0.4 s) the chat bubble paints nothing, typing dots included.
              if (template === "chat-bubble") {
                const early = await frame(page, 0.2);
                let stray = 0;
                for (let p = 3; p < early.length; p += 4) if (early[p]! > 8) stray++;
                expect(stray, format).toBe(0);
              }
              await page.close();
            } finally {
              server.close();
            }
          }
        } finally {
          await browser.close();
        }
      },
      600_000,
    );

    it(
      "renders without the 45 s timeline wait, with alpha for an overlay",
      async () => {
        const dir = await scaffold(template, 480, 270);
        const manager = binaries();
        const ffmpeg = await manager.ensure("ffmpeg");
        const adapter = createHyperframesAdapter({ projectDir: dir });
        const started = performance.now();
        const rendered = await adapter.render(clip, {
          projectDir: dir,
          outDir: tempDir(),
          fps: 30,
          width: 480,
          height: 270,
          signal: new AbortController().signal,
          ensureBinary: (name) => manager.ensure(name),
          progress: () => {},
        });
        expect(performance.now() - started).toBeLessThan(40_000);
        const { stdout } = await execFileAsync(
          ffmpeg,
          ["-v", "error", "-c:v", "libvpx-vp9", "-ss", "1.5", "-i", rendered.file, "-frames:v", "1", "-vf", "format=rgba", "-f", "rawvideo", "-"],
          { encoding: "buffer", maxBuffer: 1 << 26 },
        );
        let opaque = 0;
        let clear = 0;
        for (let p = 3; p < stdout.length; p += 4) {
          if (stdout[p]! > 200) opaque++;
          else if (stdout[p]! < 128) clear++;
        }
        expect(opaque).toBeGreaterThan(480 * 270 * 0.002);
        if (overlay) expect(clear).toBeGreaterThan(480 * 270 * 0.5);
        else expect(opaque).toBeGreaterThan(480 * 270 * 0.9);
      },
      600_000,
    );
  });

  // A wrong `clip set --props` never breaks the picture (ADR 0033): a paragraph with no word left falls back to the default one.
  it.each(["", "   "])("paints cursor-text-select with the text prop %j and no page error", async (text) => {
    const manager = binaries();
    const chrome = await manager.ensure("chrome-headless-shell");
    const dir = await scaffold("cursor-text-select", 480, 270);
    const file = join(dir, "compositions/hyperframes/spot/index.html");
    const html = readFileSync(file, "utf8");
    expect(html).toContain("Editing a video should feel like editing a document.");
    writeFileSync(file, html.replace('"default":"Editing a video should feel like editing a document."', `"default":${JSON.stringify(text)}`));
    const adapter = createHyperframesAdapter({ projectDir: dir });
    const live = await adapter.livePreview!(clip, { projectDir: dir, fps: 30, width: 480, height: 270, ensureBinary: (name) => manager.ensure(name) });
    const server = createServer((request, response) => {
      const path = posix.join(live.root, decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname));
      readFile(join(dir, ...path.split("/"))).then(
        (body) => {
          const page = path === live.entry;
          response.writeHead(200, { "content-type": page ? "text/html" : "text/javascript" });
          response.end(page ? body.toString("utf8").replace(/<head>/i, () => `<head><script>${live.head}</script>`) : body);
        },
        () => response.writeHead(404).end(),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const browser = await puppeteer.launch({ executablePath: chrome });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.setViewport({ width: 480, height: 270 });
      await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/${posix.basename(live.entry)}`);
      await page.evaluate("window.frameshellLive.ready");
      for (const t of [0.5, 2, 4]) await page.evaluate(`window.frameshellLive.seek(${t})`);
      expect(errors).toEqual([]);
      expect(await page.evaluate("document.querySelectorAll('#block .w').length")).toBeGreaterThan(0);
    } finally {
      await browser.close();
      server.close();
    }
  }, 120_000);
});
