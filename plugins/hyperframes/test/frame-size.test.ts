import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sameAspect as schemaSameAspect } from "@frameshell/schema";
import { declaredSize, sameAspect, sizeEntry } from "../src/frame-size.js";
import { newComposition } from "../src/index.js";

const page = (root: string, head = '<meta name="viewport" content="width=1920, height=1080" />') =>
  `<!doctype html>\n<html data-composition-variables='[]'>\n<head>\n${head}\n<style>html, body { width: 1920px; height: 1080px; }</style>\n</head>\n<body>\n${root}\n</body>\n</html>\n`;

describe("sizeEntry", () => {
  it("lays a 16:9 entry out at 9:16 by the root's size alone; the rest of the file stays as written", () => {
    const html = page('<div id="stage" data-composition-id="intro" data-width="1920" data-height="1080" data-duration="5"></div>');
    const out = sizeEntry(html, { width: 1080, height: 1920 });
    expect(out).toBe(html.replace('data-width="1920" data-height="1080"', 'data-width="1080" data-height="1920"'));
    expect(declaredSize(out)).toEqual({ width: 1080, height: 1920 });
  });

  it("leaves an entry of the same aspect byte-identical (the export scales the render), within 1 %", () => {
    const html = page("<div data-composition-id='a' data-width='1280' data-height='720'></div>");
    expect(sizeEntry(html, { width: 1920, height: 1080 })).toBe(html);
    expect(sizeEntry(html, { width: 1600, height: 900 })).toBe(html);
    expect(sizeEntry(page("<div data-composition-id='a' data-width='1366' data-height='768'></div>"), { width: 1920, height: 1080 })).toContain("1366");
  });

  it("leaves an entry without a sized root as it is", () => {
    const none = page("<div id=stage></div>");
    const unsized = page('<div data-composition-id="a" data-duration="3"></div>');
    expect(sizeEntry(none, { width: 1080, height: 1920 })).toBe(none);
    expect(sizeEntry(unsized, { width: 1080, height: 1920 })).toBe(unsized);
  });

  it("sizes only the first root outside scripts and comments, with any quoting; sub-compositions keep theirs", () => {
    const html = page(
      [
        "<!-- <div data-composition-id=\"old\" data-width=\"10\" data-height=\"10\"> -->",
        "<script>var t = '<div data-composition-id=\"fake\" data-width=\"10\" data-height=\"10\">';</script>",
        "<section class=root data-composition-id=main data-width=1920 data-height=1080>",
        '  <div data-composition-id="sub" data-width="1920" data-height="1080"></div>',
        "</section>",
      ].join("\n"),
    );
    const out = sizeEntry(html, { width: 1080, height: 1080 });
    expect(out).toContain('<section class=root data-composition-id=main data-width="1080" data-height="1080">');
    expect(out).toContain('<div data-composition-id="sub" data-width="1920" data-height="1080">');
    expect(out).toContain('data-composition-id="old" data-width="10"');
    expect(out).toContain(`'<div data-composition-id="fake" data-width="10" data-height="10">'`);
  });

  it("resizes the plain scaffold", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-frame-size-")));
    writeFileSync(join(dir, "frameshell.json"), JSON.stringify({ resolution: { width: 1920, height: 1080 } }));
    await newComposition.run({ args: ["card"], cwd: dir, project: { dir } });
    const html = readFileSync(join(dir, "compositions", "hyperframes", "card", "index.html"), "utf8");
    expect(declaredSize(html)).toEqual({ width: 1920, height: 1080 });
    expect(declaredSize(sizeEntry(html, { width: 1080, height: 1350 }))).toEqual({ width: 1080, height: 1350 });
  });
});

describe("sameAspect", () => {
  it("agrees with the schema's sameAspect, which the export uses", () => {
    const sizes = [
      [1920, 1080],
      [1366, 768],
      [1280, 720],
      [1600, 900],
      [1080, 1080],
      [1080, 1350],
      [1080, 1920],
      [1000, 1009],
      [1000, 1011],
    ].map(([width, height]) => ({ width: width!, height: height! }));
    for (const a of sizes) for (const b of sizes) expect(sameAspect(a, b), `${a.width}x${a.height} ${b.width}x${b.height}`).toBe(schemaSameAspect(a, b));
  });
});
