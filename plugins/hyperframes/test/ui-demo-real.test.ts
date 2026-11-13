import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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
import { createHyperframesAdapter, newComposition } from "../src/index.js";

// Opt-in like templates-real (FRAMESHELL_TEST_REAL_HYPERFRAMES=1): the UI demo templates (#466, #549) in managed Chrome.
// A page is seeked frame by frame at 30 fps and its elements are read, so each "same frame" is checked on what is painted.
const FPS = 30;
const execFileAsync = promisify(execFile);
const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "frameshell-ui-demo-")));
const binaries = () => {
  const dir = process.env["FRAMESHELL_TEST_BINARIES_DIR"] || fileURLToPath(new URL("../../../.cache/test-binaries", import.meta.url));
  return new BinaryManager({ dataDir: dir, configDir: dir });
};
const clip = { id: "c_spot", source: "compositions/hyperframes/spot/index.html" };

/** A live page of `template` at 480x270 with `props` (what `clip set --props` would give) and a way to read it at a time. */
async function open(template: string, props: Record<string, unknown>, duration?: number) {
  const manager = binaries();
  const chrome = await manager.ensure("chrome-headless-shell");
  const dir = tempDir();
  writeFileSync(join(dir, "frameshell.json"), JSON.stringify({ resolution: { width: 480, height: 270 } }));
  await newComposition.run({ args: ["spot", "--template", template, ...(duration ? ["--duration", String(duration)] : [])], cwd: dir, project: { dir } });
  const adapter = createHyperframesAdapter({ projectDir: dir });
  const live = await adapter.livePreview!(clip, { projectDir: dir, fps: FPS, width: 480, height: 270, ensureBinary: (name) => manager.ensure(name) });
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
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setViewport({ width: 480, height: 270 });
  await page.evaluateOnNewDocument(`window.__hfVariables = ${JSON.stringify(props)};`);
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/${posix.basename(live.entry)}`);
  await page.evaluate("window.frameshellLive.ready");
  const length = Number(await page.evaluate("document.querySelector('[data-composition-id]').getAttribute('data-duration')"));
  return {
    errors,
    length,
    /** Seeks to frame `f` and returns what `read` (page code, an expression) evaluates to there. */
    at: async <T>(f: number, read: string): Promise<T> => {
      await page.evaluate(`window.frameshellLive.seek(${f / FPS})`);
      return (await page.evaluate(read)) as T;
    },
    /** PNG of the page at frame `f`. */
    shot: async (f: number): Promise<Buffer> => {
      await page.evaluate(`window.frameshellLive.seek(${f / FPS})`);
      return Buffer.from(await page.screenshot({ type: "png" }));
    },
    close: async () => {
      await browser.close();
      server.close();
    },
  };
}

type Page = Awaited<ReturnType<typeof open>>;

/** The largest difference of one channel (of 255) between two PNGs of the same size. */
async function worstDifference(a: Buffer, b: Buffer): Promise<number> {
  const ffmpeg = await binaries().ensure("ffmpeg");
  const dir = tempDir();
  const raw = async (png: Buffer, name: string) => {
    writeFileSync(join(dir, name), png);
    const { stdout } = await execFileAsync(ffmpeg, ["-v", "error", "-i", join(dir, name), "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { encoding: "buffer", maxBuffer: 1 << 26 });
    return stdout;
  };
  const [x, y] = [await raw(a, "a.png"), await raw(b, "b.png")];
  let worst = 0;
  for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(x[i]! - y[i]!));
  return worst;
}

/** The page-code expression for the opacity of `selector`. */
const opacity = (selector: string) => `Number(document.querySelector(${JSON.stringify(selector)}).style.opacity)`;
/** The page-code expression for the x scale of `selector`'s transform (`scale(x, y)`). */
const scaleX = (selector: string) => `Number(/scale\\(([-\\d.]+),/.exec(document.querySelector(${JSON.stringify(selector)}).style.transform)[1])`;

/** First frame from `from` up to the end whose reading is true; -1 when none. */
async function firstFrame(page: Page, read: string, test: (value: number) => boolean, from = 0): Promise<number> {
  for (let f = from; f < page.length * FPS; f++) if (test(await page.at<number>(f, read))) return f;
  return -1;
}

/** The frames where the ripple of the cursor starts (opacity goes from nothing to something). */
async function rippleStarts(page: Page): Promise<number[]> {
  const starts: number[] = [];
  let before = 0;
  for (let f = 0; f < page.length * FPS; f++) {
    const now = await page.at<number>(f, opacity("#ripple"));
    if (now > 0 && before === 0) starts.push(f);
    before = now;
  }
  return starts;
}

describe.runIf(process.env["FRAMESHELL_TEST_REAL_HYPERFRAMES"] === "1")("UI demo templates (real HyperFrames)", () => {
  it(
    "cursor-click: the ripple and the confirmation start on the click's frame, with the camera still or following",
    async () => {
      const frames: number[] = [];
      for (const camera of ["still", "follow"]) {
        const page = await open("cursor-click", { camera });
        try {
          const ripple = await firstFrame(page, opacity("#ripple"), (v) => v > 0);
          const toast = await firstFrame(page, opacity("#toast"), (v) => v > 0);
          expect(ripple, camera).toBeGreaterThan(0);
          expect(toast, camera).toBe(ripple);
          frames.push(ripple);
          expect(page.errors).toEqual([]);
        } finally {
          await page.close();
        }
      }
      expect(frames[1]).toBe(frames[0]);
    },
    120_000,
  );

  it.each(["typing-field", "comment-box"])(
    "%s: the progress line, the dimmed ring and the ripple start on the press's frame, cursor on and off",
    async (template) => {
      for (const cursor of ["on", "off"]) {
        const page = await open(template, { cursor });
        try {
          const progress = await firstFrame(page, opacity("#progress"), (v) => v > 0);
          const ring = await firstFrame(page, opacity("#ring"), (v) => v < 1, 20);
          expect(progress, cursor).toBeGreaterThan(0);
          // The ring dims by 0.6 x an ease that rounds to nothing at the very first frame: it may show a frame later.
          expect([progress, progress + 1], cursor).toContain(ring);
          if (cursor === "on") expect(await firstFrame(page, opacity("#ripple"), (v) => v > 0), cursor).toBe(progress);
          expect(page.errors).toEqual([]);
        } finally {
          await page.close();
        }
      }
    },
    180_000,
  );

  it.each(["on", "off"])(
    "app-window: the highlight sweep, the dimming and the ripple start on the click's frame (cursor %s)",
    async (cursor) => {
      const page = await open("app-window", { cursor, select: 2 });
      try {
        const wash = await firstFrame(page, scaleX("#rows .row:nth-child(2) .hl"), (v) => v > 0);
        const dimmed = await firstFrame(page, opacity("#rows .row:nth-child(4) .cells"), (v) => v < 1, 30);
        expect(wash).toBeGreaterThan(0);
        expect(dimmed).toBe(wash);
        if (cursor === "on") expect(await firstFrame(page, opacity("#ripple"), (v) => v > 0)).toBe(wash);
        expect(page.errors).toEqual([]);
      } finally {
        await page.close();
      }
    },
    120_000,
  );

  it.each(["on", "off"])(
    "app-window copy-paste: the slot lights up on the second click's frame and the paste, its chip and the filled row share one (cursor %s)",
    async (cursor) => {
      const page = await open("app-window", { cursor, select: 2, then: "copy-paste", camera: "follow" }, 7);
      try {
        const first = await firstFrame(page, scaleX("#rows .row:nth-child(2) .hl"), (v) => v > 0);
        const copy = await firstFrame(page, opacity("#kbd-copy"), (v) => v > 0);
        const slot = await firstFrame(page, opacity(".slot-on"), (v) => v > 0);
        const chip = await firstFrame(page, opacity("#kbd-paste"), (v) => v > 0);
        const filled = await firstFrame(page, opacity("#rows .row:last-child .cells"), (v) => v > 0);
        const sweep = await firstFrame(page, scaleX("#rows .row:last-child .hl"), (v) => v > 0);
        // The copy comes half a second (15 frames) after the click, the paste 0.45 s (13 or 14 frames) after the slot.
        expect(copy - first).toBeGreaterThanOrEqual(14);
        expect(copy - first).toBeLessThanOrEqual(16);
        expect(slot).toBeGreaterThan(copy);
        expect(chip).toBeGreaterThan(slot);
        expect(chip - slot).toBeGreaterThanOrEqual(13);
        expect(chip - slot).toBeLessThanOrEqual(15);
        expect(filled).toBe(chip);
        expect(sweep).toBe(chip);
        if (cursor === "on") expect((await rippleStarts(page))[1]).toBe(slot);
        expect(page.errors).toEqual([]);
      } finally {
        await page.close();
      }
    },
    240_000,
  );

  // The timing guard: a long text, a high speed or a short duration never push the beat past the clip.
  it.each([
    ["cursor-click", { hesitate: 1 }, 2.4, "#toast"],
    ["cursor-drag-drop", { hesitate: 1 }, 3.2, "#done"],
    ["cursor-marquee", { hesitate: 1 }, 3.2, "#badge"],
    ["typing-field", { text: "x".repeat(80), speed: 6, runTime: 3 }, 4, "#done"],
    ["comment-box", { text: "word ".repeat(14), speed: 6, runTime: 3 }, 4, "#done"],
  ] as const)(
    "%s still shows the reaction before the exit when the clip is short (%j, %s s)",
    async (template, props, duration, reaction) => {
      const page = await open(template, props, duration);
      try {
        expect(await page.at<number>(Math.floor((duration - 0.6) * FPS), opacity(reaction))).toBeGreaterThan(0.95);
        expect(page.errors).toEqual([]);
      } finally {
        await page.close();
      }
    },
    120_000,
  );

  // The render plays the frames in order. The follow camera scales the whole scene by a changing amount, and Chrome keeps
  // an earlier raster of a scaled layer for a while, so a scrub through the live preview may differ from a cold paint by
  // the edge pixels of a scaled shape; two plays of the same frames in order must agree.
  it.each([
    ["cursor-click", { camera: "follow" }],
    ["app-window", { camera: "follow", then: "copy-paste" }],
  ] as const)(
    "%s paints the same frames on two plays in order (%j)",
    async (template, props) => {
      const frames = [20, 40, 60, 80, 100, 120];
      const play = async () => {
        const page = await open(template, props, 6);
        try {
          const shots: Buffer[] = [];
          for (const f of frames) shots.push(await page.shot(f));
          return shots;
        } finally {
          await page.close();
        }
      };
      const [first, second] = [await play(), await play()];
      for (const [i, f] of frames.entries()) expect(await worstDifference(first[i]!, second[i]!), `frame ${f}`).toBeLessThanOrEqual(2);
    },
    180_000,
  );

  it("cursor-text-select shows its action pill before the exit in a short clip", async () => {
    const page = await open("cursor-text-select", { text: "word ".repeat(23).trim(), select: "word word word" }, 2.8);
    try {
      expect(await page.at<number>(Math.floor(2.2 * FPS), opacity("#pill"))).toBeGreaterThan(0.95);
      expect(page.errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 120_000);
});
