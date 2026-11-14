import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DaemonConnection, ErrorCode, RpcError, connectToDaemon } from "@frameshell/protocol";
import { parseBrandManifest } from "@frameshell/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIGMA_LIMITS, fitFrames, readFigmaFolder } from "../src/brand/figma.js";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { testBinaryManager } from "./media-tools.js";

// Seams under test: reading a folder of Figma SVG exports (ADR 0044 decision 10) and `brand.importFigma` /
// `brand.show` over the wire. Every fixture is a tiny synthetic SVG written per test.

function frame(width: number, height: number, body = `<rect width="${width}" height="${height}" fill="#FF5A1F"/>`): string {
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

function folder(files: Record<string, string>): string {
  const dir = join(tempDir(), "Acme Figma");
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

describe("readFigmaFolder", () => {
  it("reads .svg files in name order, slugs their names and says what it skipped", async () => {
    const dir = folder({
      "Screen 10.svg": frame(1440, 900),
      "Screen 2.svg": frame(1440, 900),
      "screen-2.SVG": frame(375, 812),
      "notes.txt": "hi",
      ".hidden.svg": frame(1, 1),
      "doctype.svg": `<!DOCTYPE svg [<!ENTITY a "a">]><svg viewBox="0 0 1 1"/>`,
      "sizeless.svg": `<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`,
    });
    mkdirSync(join(dir, "nested.svg"));
    const { frames, warnings } = await readFigmaFolder(dir);
    expect(frames.map((one) => [one.name, one.file])).toEqual([
      ["Screen 2.svg", "screen-2.svg"],
      ["Screen 10.svg", "screen-10.svg"],
      ["screen-2.SVG", "screen-2-2.svg"],
    ]);
    expect(warnings).toEqual([
      "doctype.svg was skipped: it has a DTD.",
      "sizeless.svg was skipped: it states no size (width and height in px, or a viewBox), so it cannot be placed.",
      "1 file that is not .svg was skipped.",
    ]);
  });

  it("stops at the file count and size caps", async () => {
    const dir = folder({ "a.svg": frame(10, 10), "b.svg": frame(10, 10, `<desc>${"x".repeat(400)}</desc>`), "c.svg": frame(10, 10), "d.svg": frame(10, 10) });
    const capped = await readFigmaFolder(dir, { ...FIGMA_LIMITS, files: 3, fileBytes: 300 });
    expect(capped.frames.map((one) => one.name)).toEqual(["a.svg", "c.svg"]);
    expect(capped.warnings).toEqual(["b.svg was skipped: larger than 0 MB.", "d.svg and the files after it were skipped: an import reads at most 3 SVG files."]);
    const total = await readFigmaFolder(dir, { ...FIGMA_LIMITS, totalBytes: 300 });
    expect(total.frames.map((one) => one.name)).toEqual(["a.svg"]);
    expect(total.warnings[0]).toMatch(/^b\.svg and the files after it were skipped: the folder's SVG files pass/);
  });
});

describe("fitFrames", () => {
  it("scales every frame by canvas width / widest frame and centres each", () => {
    const fit = fitFrames([{ width: 1440, height: 1024 }, { width: 375, height: 812 }], { width: 1920, height: 1080 });
    expect(fit.reference).toBe(1440);
    expect(fit.scale).toBeCloseTo(4 / 3, 10);
    // 1440x1024 → 1920x1365.333: centred vertically, so its top is above the canvas.
    expect(fit.places).toEqual([
      { x: 0, y: -142.667 },
      { x: 710, y: -1.333 },
    ]);
  });
});

describe("brand.importFigma and brand.show", () => {
  let daemon: Daemon;
  let conn: DaemonConnection;
  let project: string;

  beforeAll(async () => {
    daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs: { dataDir: tempDir(), configDir: tempDir() }, binaries: testBinaryManager(), idleTimeoutMs: Infinity });
    conn = await connectToDaemon(daemon.socketPath, { client: "test" });
    project = tempDir();
    await conn.request("project.init", { dir: project });
  });

  afterAll(async () => {
    conn.close();
    await daemon.close();
  });

  it("shows an empty brand before anything ran", async () => {
    expect(await conn.request("brand.show", { cwd: project })).toMatchObject({ manifest: "brand.json", exists: false, captures: [], imports: [] });
  });

  it("imports sanitised frames with one scale, records brand.json and credits without a licence", async () => {
    const dir = folder({
      "Home.svg": frame(1440, 1024, `<rect width="10" height="10" onclick="alert(1)"/><script>alert(2)</script><image href="https://evil.test/a.png" width="1" height="1"/>`),
      "Mobile.svg": frame(375, 812),
    });
    const result = await conn.request("brand.importFigma", { cwd: project, dir });
    const entry = result.import;
    expect(entry).toMatchObject({ id: "acme-figma", kind: "figma", source: dir, canvas: { width: 1920, height: 1080 }, reference: 1440, warnings: [] });
    expect(entry.frames.map((one) => [one.path, one.name, one.origin, one.x, one.y])).toEqual([
      ["assets/brand/acme-figma/home.svg", "Home.svg", "imported", 0, -142.667],
      ["assets/brand/acme-figma/mobile.svg", "Mobile.svg", "imported", 710, -1.333],
    ]);
    expect(entry.frames[0]!.removed).toEqual(["1 event handler", "1 script element", "1 external reference"]);
    const home = readFileSync(join(project, "assets/brand/acme-figma/home.svg"), "utf8");
    expect(home).not.toMatch(/script|onclick|evil\.test/);
    expect(home).toBe('<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="1024" viewBox="0 0 1440 1024" fill="none"><rect width="10" height="10"/></svg>');

    const manifest = parseBrandManifest(JSON.parse(readFileSync(join(project, "brand.json"), "utf8")));
    expect(manifest.ok && manifest.value.imports).toEqual([entry]);
    const credits = JSON.parse(readFileSync(join(project, "credits.json"), "utf8")) as { assets: { asset: string; title?: string; licence?: string }[] };
    expect(credits.assets.map((one) => [one.asset, one.title, one.licence])).toEqual([
      ["assets/brand/acme-figma/home.svg", "Home", undefined],
      ["assets/brand/acme-figma/mobile.svg", "Mobile", undefined],
    ]);

    const shown = await conn.request("brand.show", { cwd: project });
    expect(shown).toMatchObject({ exists: true, captures: [], imports: [entry] });
  });

  it("gives a second import of the same folder its own id and keeps the folder project-relative when inside", async () => {
    const inside = join(project, "design", "Acme Figma");
    mkdirSync(inside, { recursive: true });
    writeFileSync(join(inside, "one.svg"), frame(1440, 900));
    const result = await conn.request("brand.importFigma", { cwd: join(project, "design"), dir: "Acme Figma" });
    expect(result.import).toMatchObject({ id: "acme-figma-2", source: "design/Acme Figma" });
    expect((await conn.request("brand.show", { cwd: project })).imports.map((one) => one.id)).toEqual(["acme-figma", "acme-figma-2"]);
  });

  it("refuses a folder with no usable frame, and a path that is not a folder", async () => {
    const empty = await conn.request("brand.importFigma", { cwd: project, dir: folder({ "bad.svg": "<svg><g></svg>", "x.png": "x" }) }).catch((caught: unknown) => caught);
    expect(empty).toBeInstanceOf(RpcError);
    expect((empty as RpcError).code).toBe(ErrorCode.InvalidOperation);
    expect((empty as RpcError).data).toMatchObject({ reason: "no-frames" });
    expect((empty as RpcError).message).toMatch(/bad\.svg was skipped: it is not well-formed XML/);
    const missing = await conn.request("brand.importFigma", { cwd: project, dir: join(project, "nope") }).catch((caught: unknown) => caught);
    expect((missing as RpcError).code).toBe(ErrorCode.AssetNotFound);
  });

  it("fails brand.show on a broken brand.json", async () => {
    const other = tempDir();
    await conn.request("project.init", { dir: other });
    writeFileSync(join(other, "brand.json"), "{}");
    const error = await conn.request("brand.show", { cwd: other }).catch((caught: unknown) => caught);
    expect((error as RpcError).code).toBe(ErrorCode.InvalidProjectFile);
  });
});
