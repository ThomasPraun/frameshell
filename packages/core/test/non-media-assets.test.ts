import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AssetInfo, type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { assetKindOf } from "../src/media/kind.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { testBinaryManager } from "./media-tools.js";

// Fonts and SVGs are files of the project, not footage (#520): ingest hashes them and builds nothing, so no ffmpeg runs here.
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
const FONT = Buffer.from("not a real font, only bytes");

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;

beforeEach(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
});
afterEach(async () => {
  conn.close();
  await daemon.close();
});

async function readyAsset(path: string): Promise<AssetInfo> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const asset = (await conn.request("asset.list", { cwd: project })).assets.find((a) => a.path === path);
    if (asset?.state === "ready" || asset?.state === "failed") return asset;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}: ${JSON.stringify(asset)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("assetKindOf", () => {
  it("classifies svg and font extensions, ignoring case", () => {
    expect(assetKindOf("assets/logo.svg")).toBe("svg");
    expect(assetKindOf("assets/LOGO.SVG")).toBe("svg");
    for (const ext of ["ttf", "otf", "woff", "woff2", "TTF"]) expect(assetKindOf(`assets/fonts/Inter.${ext}`)).toBe("font");
    for (const path of ["assets/a.mp4", "assets/a.png", "assets/a.wav", "assets/svg", "assets/a.svg.mp4"]) expect(assetKindOf(path)).toBe("media");
  });
});

describe("non-media assets", () => {
  it("imports a font and an SVG: content hash, a new kind, no derived media, no failed ingest", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "logo.svg"), SVG);
    writeFileSync(join(dir, "Inter.ttf"), FONT);
    const { imported } = await conn.request("asset.import", { cwd: project, files: [join(dir, "logo.svg"), join(dir, "Inter.ttf")] });
    expect(imported.map((entry) => entry.asset)).toEqual(["assets/logo.svg", "assets/Inter.ttf"]);

    const svg = await readyAsset("assets/logo.svg");
    const font = await readyAsset("assets/Inter.ttf");
    expect(svg).toMatchObject({
      kind: "svg",
      state: "ready",
      error: null,
      hash: `sha256:${createHash("sha256").update(SVG).digest("hex")}`,
      media: null,
      proxy: null,
      sidecar: null,
      waveform: null,
      thumbnails: null,
    });
    expect(font).toMatchObject({ kind: "font", state: "ready", error: null, hash: `sha256:${createHash("sha256").update(FONT).digest("hex")}`, media: null });

    const jobs = (await conn.request("job.list", { cwd: project })).jobs;
    expect(jobs.filter((job) => job.kind === "ingest").map((job) => job.state)).toEqual(["done", "done"]);
    // No proxy, sidecar, waveform, thumbnail or manifest was written.
    const derived = join(project, ".frameshell", "proxies");
    expect(existsSync(derived) ? readdirSync(derived) : []).toEqual([]);
  });

  it("ingests a font dropped straight into assets/fonts/ (watcher) without failing", async () => {
    mkdirSync(join(project, "assets", "fonts"), { recursive: true });
    writeFileSync(join(project, "assets", "fonts", "Display.woff2"), FONT);
    const font = await readyAsset("assets/fonts/Display.woff2");
    expect(font).toMatchObject({ kind: "font", state: "ready", error: null });
    expect(font.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("refuses them as media clips with a clear error and leaves the timeline alone", async () => {
    writeFileSync(join(project, "assets", "logo.svg"), SVG);
    writeFileSync(join(project, "assets", "Inter.otf"), FONT);
    const track = (await conn.request("track.add", { cwd: project, kind: "video", name: "V" })).changes.added[0]!;
    for (const [asset, what] of [
      ["assets/logo.svg", "an SVG file"],
      ["assets/Inter.otf", "a font file"],
    ] as const) {
      await expect(conn.request("clip.add", { cwd: project, track, asset, start: 0, duration: 2 })).rejects.toMatchObject({
        code: ErrorCode.InvalidOperation,
        message: expect.stringContaining(`${asset} is ${what}, not media`),
        data: { reason: "not media", field: "asset", path: asset },
      });
    }
    const shown = await conn.request("timeline.show", { cwd: project });
    expect(shown.tracks.flatMap((t) => t.clips)).toEqual([]);
  });
});
