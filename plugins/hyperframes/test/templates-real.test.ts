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
    // A light leak is about a second long, clear at both ends and see-through at its peak: it is judged at its own times, by any visible pixel, and may leave the frame.
    const leak = template === "light-leak";
    const solid = leak ? 16 : 200;
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
              const times = leak ? [0.2, 0.45, 0.7, 0.55] : [0.45, 0.9, 1.6, 2.4];
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
                if (settled[p + 3]! < solid) continue;
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
              if (overlay) expect(drawn, format).toBeLessThan(width * height * 0.5);
              if (overlay && !leak) {
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
          ["-v", "error", "-c:v", "libvpx-vp9", "-ss", three || leak ? "0.5" : "1.5", "-i", rendered.file, "-frames:v", "1", "-vf", "format=rgba", "-f", "rawvideo", "-"],
          { encoding: "buffer", maxBuffer: 1 << 26 },
        );
        let opaque = 0;
        let clear = 0;
        let seen = 0;
        for (let p = 3; p < stdout.length; p += 4) {
          if (stdout[p]! > 200) opaque++;
          else if (stdout[p]! < 128) clear++;
          if (stdout[p]! > 8) seen++;
        }
        // The light leak crests at its middle (0.5 s of its 1 s) and is see-through there: some of the frame is lit, most of it is clear.
        if (leak) {
          expect(seen).toBeGreaterThan(480 * 270 * 0.005);
          expect(seen).toBeLessThan(480 * 270 * 0.7);
          return;
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
    const visibleShown = String.raw`cols.filter(function (c) { return Number(c.slot.style.opacity || 1) > 0.5; }).map(function (c) { var m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(c.strip.style.transform); return Math.round(-Number(m[2]) / row) - 10; }).join("")`;
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
        // What is on show is exactly the end text: columns it has no digit for are gone, not zeros.
        expect(await page.evaluate(visibleShown)).toBe(end.replace(/^0+(?=\d)/, ""));
      });
    }, 120_000);

    it("number-wheel to a value with fewer digits ends on exactly the end text: blank columns and no separator left of its first digit", async () => {
      await inPage("number-wheel", { from: 1500, to: 20, grouping: "comma" }, undefined, async (page) => {
        await seek(page, 0.2);
        expect(await page.evaluate(visibleShown)).toBe("1500");
        expect(await page.evaluate("Number(seps[0].cell.style.opacity || 1)")).toBe(1);
        await seek(page, 3);
        expect(await page.evaluate(visibleShown)).toBe("20");
        expect(await page.evaluate("Number(seps[0].cell.style.opacity)")).toBe(0);
      });
      await inPage("number-wheel", { from: 12500, to: 5, grouping: "comma" }, undefined, async (page) => {
        await seek(page, 3);
        expect(await page.evaluate(visibleShown)).toBe("5");
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
      // A fractional `laps` from `clip set --props` still ends exactly on the target, and a two-item reel gets a filler.
      await inPage("slot-roll", { items: "a|b|c|d|e", target: "d", laps: 2.5 }, undefined, async (page) => {
        await seek(page, 3);
        expect(await page.evaluate(onBand)).toEqual(["d"]);
      });
      await inPage("slot-roll", { items: "a|b", target: "b" }, undefined, async (page) => {
        expect(await page.evaluate("items.length")).toBe(3);
        await seek(page, 3);
        expect(await page.evaluate(onBand)).toEqual(["b"]);
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

    // The brand and overlay group (TP3): what each page leaves on screen at the start, at its peak and at its end.
    type LivePage = Parameters<Parameters<typeof inPage>[3]>[0];
    /** RGBA bytes of the page at `t`, transparent where the page paints nothing. */
    const rgbaAt = async (page: LivePage, dir: string, t: number): Promise<Buffer> => {
      await seek(page, t);
      const ffmpeg = await binaries().ensure("ffmpeg");
      const file = join(dir, `${t}.png`);
      writeFileSync(file, await page.screenshot({ type: "png", omitBackground: true }));
      const { stdout } = await execFileAsync(ffmpeg, ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { encoding: "buffer", maxBuffer: 1 << 26 });
      return stdout;
    };
    const alphaSum = (rgba: Buffer) => {
      let sum = 0;
      for (let p = 3; p < rgba.length; p += 4) sum += rgba[p]!;
      return sum;
    };
    const style = (id: string, property: string) => `document.getElementById('${id}').style.${property}`;
    const translateOf = (id: string, axis: 1 | 2 = 1) => `Number(/translate\\(([-\\d.]+)px, ([-\\d.]+)px/.exec(document.getElementById('${id}').style.transform)[${axis}])`;
    const scaleXOf = (selector: string) => `Array.from(document.querySelectorAll('${selector}')).map(function (e) { return Number(/scale\\(([-\\d.]+)/.exec(e.style.transform)[1]); })`;

    it("light-leak is clear at its first and last frame, crests in the middle, and one seed paints one frame", async () => {
      const dir = tempDir();
      const shots: Record<string, Buffer> = {};
      for (const [key, seed] of [["a1", "a"], ["b", "b"], ["a2", "a"]] as const) {
        await inPage("light-leak", { seed }, undefined, async (page) => {
          if (key === "a1") {
            const sums: number[] = [];
            for (const t of [0, 0.15, 0.5, 0.85, 1]) sums.push(alphaSum(await rgbaAt(page, dir, t)));
            const [first, early, peak, late, last] = sums as [number, number, number, number, number];
            expect(first).toBe(0);
            expect(last).toBe(0);
            expect(early).toBeGreaterThan(0);
            expect(late).toBeGreaterThan(0);
            expect(peak).toBeGreaterThan(early);
            expect(peak).toBeGreaterThan(late);
          }
          shots[key] = await rgbaAt(page, dir, 0.5);
        });
      }
      expect(shots["a1"]!.equals(shots["a2"]!)).toBe(true);
      expect(shots["a1"]!.equals(shots["b"]!)).toBe(false);
    }, 240_000);

    it("light-leak at full strength and size still leaves part of the frame clear, never opaque or white, and its hue prop turns the colour", async () => {
      const dir = tempDir();
      const strongest = (rgba: Buffer) => {
        let best = 0;
        let at = 0;
        let lit = 0;
        for (let p = 3; p < rgba.length; p += 4) {
          if (rgba[p]! > 8) lit++;
          if (rgba[p]! > best) {
            best = rgba[p]!;
            at = p - 3;
          }
        }
        return { alpha: best, red: rgba[at]!, blue: rgba[at + 2]!, lit: lit / (rgba.length / 4) };
      };
      const hues: ReturnType<typeof strongest>[] = [];
      for (const hue of [0, 180]) {
        await inPage("light-leak", { intensity: 1, size: 1.6, hue, peak: 0.5 }, undefined, async (page) => {
          hues.push(strongest(await rgbaAt(page, dir, 0.5)));
        });
      }
      for (const found of hues) {
        expect(found.alpha).toBeLessThan(220);
        expect(found.lit).toBeLessThan(0.8);
      }
      // The default tint is orange (red over blue); half a turn of hue makes it blue over red.
      expect(hues[0]!.red).toBeGreaterThan(hues[0]!.blue);
      expect(hues[1]!.blue).toBeGreaterThan(hues[1]!.red);
    }, 240_000);

    it("light-leak crests where `peak` says", async () => {
      const dir = tempDir();
      await inPage("light-leak", { peak: 0.25 }, undefined, async (page) => {
        const early = alphaSum(await rgbaAt(page, dir, 0.25));
        expect(early).toBeGreaterThan(alphaSum(await rgbaAt(page, dir, 0.6)));
        expect(early).toBeGreaterThan(alphaSum(await rgbaAt(page, dir, 0.1)));
      });
    }, 120_000);

    it("logo-sting with no logo and no name shows a bullet monogram and no name row; a late landing is pulled in before the exit", async () => {
      await inPage("logo-sting", { name: "", logo: "", popAt: 2 }, 2, async (page) => {
        expect(await page.evaluate(style("logo", "display"))).toBe("none");
        expect(await page.evaluate(style("mono", "display"))).not.toBe("none");
        expect(await page.evaluate("document.getElementById('mono').textContent")).toBe("•");
        expect(await page.evaluate("document.getElementById('name').parentNode.style.display")).toBe("none");
        // 2 s clip: the logo lands at 2 - 0.3 - 1.2 = 0.5 s, not at the asked 2 s.
        await seek(page, 0.45);
        expect(await page.evaluate(opacityOf("mark"))).toBe(0);
        await seek(page, 1.65);
        expect(await page.evaluate(opacityOf("mark"))).toBeGreaterThan(0.99);
        // The ring and the band have come and gone by then.
        expect(await page.evaluate(opacityOf("ring"))).toBe(0);
        expect(await page.evaluate(opacityOf("sweep"))).toBe(0);
      });
    }, 120_000);

    it("logo-sting takes its monogram from the name, shows the ring and the band on the way and the name rising through its mask", async () => {
      await inPage("logo-sting", { name: "acme", popAt: 0.25 }, undefined, async (page) => {
        expect(await page.evaluate("document.getElementById('mono').textContent")).toBe("A");
        await seek(page, 0.1);
        expect(await page.evaluate(opacityOf("mark"))).toBe(0);
        await seek(page, 0.5);
        expect(await page.evaluate(opacityOf("ring"))).toBeGreaterThan(0.1);
        // The band crosses between 0.75 and 1.35 s.
        await seek(page, 1);
        expect(await page.evaluate(opacityOf("sweep"))).toBe(1);
        // The name starts 0.25 s after the logo: still on its way up at 0.55 s, in place at 1.6 s.
        await seek(page, 0.55);
        expect((await page.evaluate(translateOf("name", 2))) as number).toBeGreaterThan(1);
        await seek(page, 1.6);
        expect(await page.evaluate(opacityOf("sweep"))).toBe(0);
        expect(await page.evaluate(opacityOf("name"))).toBeGreaterThan(0.99);
        expect(Math.abs((await page.evaluate(translateOf("name", 2))) as number)).toBeLessThan(1);
      });
    }, 120_000);

    it.each([["top-left", false, false], ["bottom-right", true, true]] as const)("pip-card in the %s corner stays inside the frame once it has landed; an empty caption hides the chip", async (corner, right, bottom) => {
      await inPage("pip-card", { corner, caption: "" }, undefined, async (page) => {
        await seek(page, 3);
        const box = (await page.evaluate("(function () { var r = document.getElementById('card').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; })()")) as number[];
        const [left, top, rightEdge, bottomEdge] = box as [number, number, number, number];
        expect(left).toBeGreaterThan(480 * 0.03);
        expect(rightEdge).toBeLessThan(480 * 0.97);
        expect(top).toBeGreaterThan(270 * 0.03);
        expect(bottomEdge).toBeLessThan(270 * 0.97);
        expect(left < 240).toBe(!right);
        expect(top < 135).toBe(!bottom);
        expect(await page.evaluate(style("chip", "display"))).toBe("none");
      });
    }, 120_000);

    it("pip-card slides in from its own edge and a late card is pulled in so it has landed before the exit", async () => {
      await inPage("pip-card", { enterAt: 3, corner: "bottom-right" }, 2, async (page) => {
        // 2 s clip: it lands at 2 - 0.3 - 0.7 = 1 s, not at the asked 3 s.
        await seek(page, 0.95);
        expect(await page.evaluate(opacityOf("card"))).toBe(0);
        await seek(page, 1.1);
        // On the way in it is still to the right of where it ends (the card sits in the right corner).
        const away = (await page.evaluate(translateOf("card"))) as number;
        expect(away).toBeGreaterThan(5);
        await seek(page, 1.65);
        expect(await page.evaluate(opacityOf("card"))).toBeGreaterThan(0.99);
        expect(Math.abs((await page.evaluate(translateOf("card"))) as number)).toBeLessThan(3);
      });
    }, 120_000);

    it("work-cards reads title:status lines, shows at most five, hides the chip of a line with no status and starts cards one after another", async () => {
      await inPage("work-cards", { items: "One:Running|Two|Three:Queued|Four|Five|Six|Seven" }, undefined, async (page) => {
        expect(await page.evaluate("document.querySelectorAll('.card').length")).toBe(5);
        expect(await page.evaluate("Array.from(document.querySelectorAll('.title')).map(function (e) { return e.textContent; })")).toEqual(["One", "Two", "Three", "Four", "Five"]);
        expect(await page.evaluate("Array.from(document.querySelectorAll('.status')).map(function (e) { return e.style.display === 'none' ? '' : e.textContent; })")).toEqual(["Running", "", "Queued", "", ""]);
        // With the defaults the first card lands at 0.3 s and the second at 0.8 s.
        await seek(page, 0.25);
        expect(await page.evaluate("Array.from(document.querySelectorAll('.card')).map(function (e) { return Number(e.style.opacity); })")).toEqual([0, 0, 0, 0, 0]);
        await seek(page, 0.6);
        const opacity = (await page.evaluate("Array.from(document.querySelectorAll('.card')).map(function (e) { return Number(e.style.opacity); })")) as number[];
        expect(opacity[0]).toBeGreaterThan(0.9);
        expect(opacity[1]).toBe(0);
      });
    }, 120_000);

    it("work-cards fills every started bar to one shared amount, never a card that has not started, and ends full before the exit", async () => {
      await inPage("work-cards", {}, undefined, async (page) => {
        // Cards start at 0.55, 1.05 and 1.55 s (landing + 0.25); the shared progress starts at 1.2 s.
        await seek(page, 1.4);
        const mid = (await page.evaluate(scaleXOf(".fill"))) as number[];
        expect(mid[0]).toBeGreaterThan(0);
        expect(mid[0]).toBeCloseTo(mid[1]!, 3);
        expect(mid[2]).toBe(0);
        await seek(page, 2.4);
        const later = (await page.evaluate(scaleXOf(".fill"))) as number[];
        expect(later[0]).toBeGreaterThan(mid[0]!);
        expect(later[0]).toBeCloseTo(later[1]!, 3);
        expect(later[0]).toBeCloseTo(later[2]!, 3);
        await seek(page, 3.9);
        expect(((await page.evaluate(scaleXOf(".fill"))) as number[]).every((fill) => fill > 0.999)).toBe(true);
      });
    }, 120_000);

    it("work-cards pulls its cards and its progress in on a clip too short for the asked timing", async () => {
      await inPage("work-cards", { startAt: 2, gap: 2, progressAt: 5, progressTime: 5 }, 2.5, async (page) => {
        await seek(page, 2.1);
        expect(((await page.evaluate(scaleXOf(".fill"))) as number[]).every((fill) => fill > 0.999)).toBe(true);
        expect(((await page.evaluate("Array.from(document.querySelectorAll('.card')).map(function (e) { return Number(e.style.opacity); })")) as number[]).every((value) => value > 0.99)).toBe(true);
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
