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
import { usesThree } from "../src/templates/index.js";

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

async function scaffold(template: string, width: number, height: number, duration?: number): Promise<string> {
  const dir = tempDir();
  writeFileSync(join(dir, "frameshell.json"), JSON.stringify({ resolution: { width, height } }));
  await newComposition.run({ args: ["spot", "--template", template, ...(duration === undefined ? [] : ["--duration", String(duration)])], cwd: dir, project: { dir } });
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
        // A 3D template renders on SwiftShader, one frame at a time (ADR 0042), so its time follows the machine's load: it gets a
        // 1 s clip and only a loose bound. The 45 s timeline wait is still caught by the 2D templates, which share `bind`.
        const three = usesThree(TEMPLATES.find((t) => t.id === template)!);
        const dir = await scaffold(template, 480, 270, three ? 1 : undefined);
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
        expect(performance.now() - started).toBeLessThan(three ? 120_000 : 40_000);
        const { stdout } = await execFileAsync(
          ffmpeg,
          ["-v", "error", "-c:v", "libvpx-vp9", "-ss", three ? "0.5" : "1.5", "-i", rendered.file, "-frames:v", "1", "-vf", "format=rgba", "-f", "rawvideo", "-"],
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

  // The templates read from the live page (#466): what the page leaves on screen once it has played, and where it is on the way.
  describe("templates in the live page", () => {
    /** Opens the scaffolded template with `props` in managed Chrome, hands the page to `check`, closes everything. */
    async function inPage(template: string, props: Record<string, unknown>, duration: number | undefined, check: (page: Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>["newPage"]>>) => Promise<void>) {
      const manager = binaries();
      const chrome = await manager.ensure("chrome-headless-shell");
      const dir = await scaffold(template, 480, 270, duration);
      const adapter = createHyperframesAdapter({ projectDir: dir });
      const live = await adapter.livePreview!({ ...clip, props }, { projectDir: dir, fps: 30, width: 480, height: 270, ensureBinary: (name) => manager.ensure(name) });
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
        await check(page);
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
        server.close();
      }
    }
    const seek = (page: { evaluate(code: string): Promise<unknown> }, t: number) => page.evaluate(`window.frameshellLive.seek(${t})`);
    const rowTexts = (page: { evaluate(code: string): Promise<unknown> }) => page.evaluate("Array.from(document.querySelectorAll('.tx')).map(function (e) { return e.textContent; })");

    it("code-typing has typed the whole snippet by the end, with an indent that arrives with its Enter, and shows none of it at the start", async () => {
      await inPage("code-typing", { code: "if (ok) {\n  run();\n}", speed: 30 }, undefined, async (page) => {
        await seek(page, 0.3);
        expect(await rowTexts(page)).toEqual(["", "", ""]);
        await seek(page, 5.5);
        expect(await rowTexts(page)).toEqual(["if (ok) {", "  run();", "}"]);
      });
    }, 120_000);

    it("code-typing waits after the named lines, and types faster in a clip too short for the code and the waits", async () => {
      await inPage("code-typing", { code: "ab\ncd", speed: 20, startAt: 0.5, pauses: "1", pauseTime: 1 }, undefined, async (page) => {
        const when = (await page.evaluate("when")) as number[];
        expect(when).toHaveLength(5);
        // a, b, Enter, c, d: the wait sits between the last character of line 1 and its Enter.
        expect(when[2]! - when[1]!).toBeGreaterThanOrEqual(1);
        expect(when[1]! - when[0]!).toBeLessThan(0.5);
        expect(when[4]! - when[3]!).toBeLessThan(0.5);
      });
      await inPage("code-typing", { code: "x".repeat(30), speed: 10 }, 2, async (page) => {
        const when = (await page.evaluate("when")) as number[];
        expect(when).toHaveLength(30);
        expect(when[29]!).toBeLessThan(2 - 0.3);
        await seek(page, 1.7);
        expect(await rowTexts(page)).toEqual(["x".repeat(30)]);
      });
    }, 180_000);

    it("code-diff lights each change in turn: nothing added before its turn, every row there after", async () => {
      await inPage("code-diff", { before: "a\nb\nc", after: "a\nB\nc\nd", changeAt: 1, lineGap: 0.5 }, undefined, async (page) => {
        const rows = (await page.evaluate("diff.map(function (d) { return d.k; })")) as string[];
        expect(rows).toEqual(["ctx", "del", "add", "ctx", "add"]);
        const added = async (t: number) => {
          await seek(page, t);
          return (await page.evaluate("Array.from(document.querySelectorAll('.ln')).map(function (r) { return Number(r.style.opacity); })")) as number[];
        };
        // Before the first change only the unchanged and the removed line show; the first added line is not yet there.
        expect((await added(0.8))[2]).toBe(0);
        expect((await added(0.8))[1]).toBeGreaterThan(0.99);
        // Its turn is 0.5 s after the removal, and the last addition 1 s after it.
        expect((await added(1.9))[2]).toBeGreaterThan(0.99);
        expect((await added(1.9))[4]).toBe(0);
        expect((await added(3.5)).every((opacity) => opacity > 0.99)).toBe(true);
      });
    }, 120_000);

    // With no line numbers the number cell takes no room: the caret, the strike-through and the text all start where the layout says.
    it.each(["on", "off"])("code-typing and code-diff keep text, caret and strike-through together with numbers %s", async (numbers) => {
      const gutter = "Array.from(document.querySelectorAll('.ln')).map(function (r) { return r.offsetLeft + r.querySelector('.tx').offsetLeft - (lay.pad + lay.gw + lay.sg); })";
      await inPage("code-typing", { code: "let a = 1;\nlet b = 2;", numbers, speed: 30 }, undefined, async (page) => {
        expect(((await page.evaluate(gutter)) as number[]).every((gap) => Math.abs(gap) < 0.5)).toBe(true);
        expect(Math.abs((await page.evaluate("document.querySelector('.no').offsetWidth - lay.gw")) as number)).toBeLessThan(1);
        // The longest line ends inside the window's right padding.
        const room = (await page.evaluate("document.querySelector('.ln').offsetWidth - (document.querySelector('.tx').offsetLeft + cols * lay.cw) - lay.pad")) as number;
        expect(room).toBeGreaterThanOrEqual(-0.5);
      });
      await inPage("code-diff", { before: "a\n  keep(b)\nc", after: "a\nc", numbers, changeAt: 0.5 }, undefined, async (page) => {
        expect(((await page.evaluate(gutter)) as number[]).every((gap) => Math.abs(gap) < 0.5)).toBe(true);
        // The strike-through starts at the first character of the removed line's text (two spaces in).
        const offset = (await page.evaluate("(function () { var row = document.querySelectorAll('.ln')[1]; return parseFloat(row.querySelector('.cut').style.left) - (row.offsetLeft + row.querySelector('.tx').offsetLeft + 2 * lay.cw); })()")) as number;
        expect(Math.abs(offset)).toBeLessThan(0.5);
      });
    }, 180_000);

    it("code-diff lights its last change before the exit even when the clip is too short for the asked timing", async () => {
      const before = Array.from({ length: 10 }, (_, i) => `old ${i}`).join("\n");
      const after = Array.from({ length: 10 }, (_, i) => `new ${i}`).join("\n");
      await inPage("code-diff", { before, after, changeAt: 1.2, lineGap: 0.5 }, 3, async (page) => {
        const turns = (await page.evaluate("turn")) as number[];
        expect(Math.max(...turns)).toBeLessThanOrEqual(3 - 0.3 - 0.4);
        await seek(page, 2.6);
        const opacities = (await page.evaluate("Array.from(document.querySelectorAll('.ln')).map(function (r) { return Number(r.style.opacity); })")) as number[];
        expect(opacities.every((opacity) => opacity > 0.99)).toBe(true);
      });
    }, 120_000);

    it("highlight quiet leaves strings and numbers in the plain colour while keywords stay coloured", async () => {
      await inPage("code-typing", { code: 'const n = 7 + "s";', highlight: "quiet", speed: 60 }, undefined, async (page) => {
        await seek(page, 5);
        const colorOf = (text: string) => page.evaluate(`Array.from(document.querySelectorAll('.tx span')).filter(function (e) { return e.textContent === ${JSON.stringify(text)}; }).map(function (e) { return getComputedStyle(e).color; })[0]`);
        const plain = await colorOf("n");
        expect(await colorOf("7")).toBe(plain);
        expect(await colorOf('"s"')).toBe(plain);
        expect(await colorOf("const")).not.toBe(plain);
      });
    }, 120_000);

    it("code-morph ends on the second snippet: every token of it in its place, none of the first's left", async () => {
      await inPage("code-morph", { before: "x = 1", after: "y = x" }, undefined, async (page) => {
        await seek(page, 4);
        const shown = (await page.evaluate(
          "Array.from(document.querySelectorAll('.tk')).filter(function (e) { return Number(e.style.opacity) > 0.99; }).map(function (e) { return e.textContent; }).sort()",
        )) as string[];
        expect(shown).toEqual(["=", "x", "y"]);
        await seek(page, 0.8);
        const first = (await page.evaluate(
          "Array.from(document.querySelectorAll('.tk')).filter(function (e) { return Number(e.style.opacity) > 0.99; }).map(function (e) { return e.textContent; }).sort()",
        )) as string[];
        expect(first).toEqual(["1", "=", "x"]);
      });
    }, 120_000);

    // The wheel, roll, tab and freeze templates: what the page shows at the start, mid-move and once it has settled.
    const digitsShown = String.raw`cols.map(function (c) { var m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(c.strip.style.transform); return Math.round(-Number(m[2]) / row) - 10; }).join("")`;

    it.each([
      ["up", { from: 0, to: 12840 }, "00000", "12840"],
      ["down", { from: 1500, to: 20 }, "1500", "0020"],
    ] as const)("number-wheel rolls %s from the start digits to exactly the end ones, and never moves the number while it rolls", async (_direction, props, start, end) => {
      await inPage("number-wheel", { ...props, grouping: "none" }, undefined, async (page) => {
        await seek(page, 0.2);
        expect(await page.evaluate(digitsShown)).toBe(start.padStart(end.length, "0"));
        const width = await page.evaluate("document.getElementById('line').offsetWidth");
        const slots = (await page.evaluate("Array.from(document.querySelectorAll('.slot')).map(function (s) { return s.offsetWidth; })")) as number[];
        expect(new Set(slots).size).toBe(1);
        let moved = false;
        for (const t of [0.8, 1.1, 1.4]) {
          await seek(page, t);
          moved ||= (await page.evaluate(digitsShown)) !== start.padStart(end.length, "0");
          expect(await page.evaluate("document.getElementById('line').offsetWidth")).toBe(width);
        }
        expect(moved).toBe(true);
        await seek(page, 3);
        expect(await page.evaluate(digitsShown)).toBe(end);
        expect(await page.evaluate("document.getElementById('line').offsetWidth")).toBe(width);
      });
    }, 120_000);

    it("number-wheel puts a separator between the digit slots and keeps leading zeros of a short start", async () => {
      await inPage("number-wheel", { from: 5, to: 1234567, grouping: "comma" }, undefined, async (page) => {
        await seek(page, 0.2);
        expect(await page.evaluate("document.getElementById('digits').textContent.replace(/\\d/g, '#').replace(/#{30}/g, '')")).toContain(",");
        expect(await page.evaluate(digitsShown)).toBe("0000005");
        await seek(page, 3);
        expect(await page.evaluate(digitsShown)).toBe("1234567");
      });
    }, 120_000);

    const onBand = "els.map(function (e, i) { return [i, Math.abs(Number(/translate\\([-\\d.]+px, ([-\\d.]+)px\\)/.exec(e.style.transform)[1]))]; }).filter(function (p) { return p[1] < 1; }).map(function (p) { return items[p[0]]; })";

    it("slot-roll starts on the first item, lands on the target and holds it on the band, and adds a target the reel does not have", async () => {
      await inPage("slot-roll", { items: "red|green|blue|gold", target: "blue" }, undefined, async (page) => {
        await seek(page, 0.2);
        expect(await page.evaluate(onBand)).toEqual(["red"]);
        await seek(page, 1.2);
        const mid = (await page.evaluate("els.map(function (e) { return Number(e.style.opacity); })")) as number[];
        expect(mid.some((opacity) => opacity > 0 && opacity < 1)).toBe(true);
        for (const t of [3, 3.5]) {
          await seek(page, t);
          expect(await page.evaluate(onBand)).toEqual(["blue"]);
        }
      });
      await inPage("slot-roll", { items: "1|2|3", target: "42", lead: "" }, undefined, async (page) => {
        expect(await page.evaluate("items.join('|')")).toBe("1|2|3|42");
        await seek(page, 3);
        expect(await page.evaluate(onBand)).toEqual(["42"]);
      });
      // A reel of one item still has something to spin past, and an empty reel and target never throw.
      await inPage("slot-roll", { items: "only", target: "" }, undefined, async (page) => {
        await seek(page, 3);
        expect(await page.evaluate(onBand)).toEqual(["only"]);
      });
      await inPage("slot-roll", { items: "", target: "" }, undefined, async (page) => {
        await seek(page, 3);
        expect(await page.evaluate(onBand)).toEqual(["..."]);
      });
    }, 240_000);

    const edges = "(function () { var i = document.getElementById('ind'); return [parseFloat(i.style.left), parseFloat(i.style.left) + parseFloat(i.style.width)]; })()";
    const tabBox = (index: number) => `(function () { var t = tabs[${index}]; return [t.offsetLeft, t.offsetLeft + t.offsetWidth]; })()`;

    it("tab-indicator sits on the first tab, stretches while it moves (the leading edge first), and ends exactly on the next tab", async () => {
      await inPage("tab-indicator", { tabs: "One|Two|Three", plan: "1@0|3@1.5", look: "pill" }, undefined, async (page) => {
        const near = (got: number[], want: number[]) => got.forEach((value, i) => expect(Math.abs(value - want[i]!)).toBeLessThan(0.6));
        await seek(page, 0.3);
        near((await page.evaluate(edges)) as number[], (await page.evaluate(tabBox(0))) as number[]);
        const first = (await page.evaluate(tabBox(0))) as number[];
        await seek(page, 1.58);
        const [left, right] = (await page.evaluate(edges)) as number[];
        expect(right! - left!).toBeGreaterThan((first[1]! - first[0]!) * 1.2);
        expect(right!).toBeGreaterThan(first[1]! + 2);
        expect(left!).toBeLessThan(right! - (first[1]! - first[0]!));
        await seek(page, 3.5);
        near((await page.evaluate(edges)) as number[], (await page.evaluate(tabBox(2))) as number[]);
        // The tab it rests on reads active: full opacity, the others dimmed.
        const opacities = (await page.evaluate("tabs.map(function (t) { return Number(t.style.opacity); })")) as number[];
        expect(opacities[2]).toBeGreaterThan(0.99);
        expect(opacities[0]).toBeLessThan(0.7);
      });
    }, 120_000);

    it("tab-indicator takes a tab by name, starts on tab 1 when no entry is at 0, and ignores an entry that names no tab", async () => {
      await inPage("tab-indicator", { tabs: "One|Two|Three", plan: "three@1.5|nope@2|9@2|x", look: "underline" }, undefined, async (page) => {
        await seek(page, 0.3);
        const start = (await page.evaluate(edges)) as number[];
        expect(Math.abs(start[0]! - ((await page.evaluate(tabBox(0))) as number[])[0]!)).toBeLessThan(0.6);
        await seek(page, 3.5);
        const end = (await page.evaluate(edges)) as number[];
        expect(Math.abs(end[1]! - ((await page.evaluate(tabBox(2))) as number[])[1]!)).toBeLessThan(0.6);
      });
    }, 120_000);

    const scaleOf = "Number(/scale\\(([-\\d.]+)/.exec(document.getElementById('pic').style.transform)[1])";
    const offsetOf = "Number(/translate\\(([-\\d.]+)px/.exec(document.getElementById('pic').style.transform)[1])";
    const opacityOf = (id: string) => `Number(document.getElementById('${id}').style.opacity)`;

    it("freeze-cut punches in and flashes exactly at the cut, then holds the picture still while the flash falls and the label pops", async () => {
      await inPage("freeze-cut", { cutAt: 1, punch: 1.3, flash: 1, flashTime: 0.2, label: "Right there" }, undefined, async (page) => {
        await seek(page, 0.95);
        const before = (await page.evaluate(scaleOf)) as number;
        expect(await page.evaluate(opacityOf("flash"))).toBe(0);
        expect(await page.evaluate(opacityOf("chip"))).toBe(0);
        // The picture was living before the cut: at two times it is at two scales.
        await seek(page, 0.5);
        expect((await page.evaluate(scaleOf)) as number).toBeLessThan(before);
        await seek(page, 1);
        expect(await page.evaluate(opacityOf("flash"))).toBeCloseTo(1, 2);
        await seek(page, 1.5);
        expect(await page.evaluate(opacityOf("flash"))).toBeLessThan(0.02);
        expect((await page.evaluate(scaleOf)) as number).toBeGreaterThan(before * 1.25);
        expect(await page.evaluate(opacityOf("chip"))).toBeGreaterThan(0.99);
        // Frozen: the sway stops where the cut found it.
        await seek(page, 1.2);
        const x = (await page.evaluate(offsetOf)) as number;
        await seek(page, 2);
        expect((await page.evaluate(offsetOf)) as number).toBe(x);
      });
    }, 120_000);

    it("freeze-cut with no label and no flash draws neither, and a late cut is pulled in", async () => {
      await inPage("freeze-cut", { label: "", flash: 0, cutAt: 4 }, 2, async (page) => {
        expect(await page.evaluate("document.getElementById('label').style.display")).toBe("none");
        for (const t of [0.4, 0.9, 1.2]) {
          await seek(page, t);
          expect(await page.evaluate(opacityOf("flash"))).toBe(0);
        }
        // 2 s clip: the cut is at 2 - 0.3 - 0.8 = 0.9 s, so the punch-in has landed by 1.4 s.
        await seek(page, 0.8);
        const before = (await page.evaluate(scaleOf)) as number;
        await seek(page, 1.4);
        expect((await page.evaluate(scaleOf)) as number).toBeGreaterThan(before * 1.1);
      });
    }, 120_000);
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
