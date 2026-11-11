import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeClip } from "./media-fixtures.js";
import { testBinaryManager } from "./media-tools.js";

// Daemon wiring of the provenance ledger (ADR 0026) on tiny synthetic clips: import records, check judges, export warns.
const MEDIA_TIMEOUT = 120_000;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let footage: string;
const sha = (path: string) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
const ledger = () => JSON.parse(readFileSync(join(project, "credits.json"), "utf8")) as { assets: Record<string, unknown>[] };
const check = () => conn.request("credits.check", { cwd: project });

/** Appends a 0.5 s clip of `asset` to the first video track of `dir`. */
const nextStart = new Map<string, number>();
async function place(asset: string, dir = project): Promise<void> {
  const start = nextStart.get(dir) ?? 0;
  nextStart.set(dir, start + 0.5);
  const track = (await conn.request("track.list", { cwd: dir })).tracks.find((candidate) => candidate.kind === "video")?.id ?? (await conn.request("track.add", { cwd: dir, kind: "video" })).changes.added[0]!;
  await conn.request("clip.add", { cwd: dir, track, asset, start, in: 0, out: 0.5 });
}

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  footage = tempDir();
  await conn.request("project.init", { dir: project });
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

describe("asset.import provenance", () => {
  it("records source, licence, author and the content hash, and tells the CLI it did", async () => {
    const rain = join(footage, "rain.mp4");
    await makeClip(rain, { durationS: 0.5 });
    const plain = join(footage, "plain.mp4");
    await makeClip(plain, { durationS: 0.6 });

    const first = await conn.request("asset.import", { cwd: project, files: [plain] });
    expect(first.imported.map((entry) => entry.provenance)).toEqual([false]);
    expect(existsSync(join(project, "credits.json"))).toBe(false);

    const second = await conn.request("asset.import", {
      cwd: project,
      files: [rain],
      sourceUrl: "https://openverse.org/audio/9f2c",
      licence: "CC-BY-4.0",
      author: "Ana Pérez",
      title: "Rain",
    });
    expect(second.imported.map((entry) => [entry.asset, entry.provenance])).toEqual([["assets/rain.mp4", true]]);
    expect(ledger()).toMatchObject({
      schemaVersion: 1,
      assets: [
        {
          asset: "assets/rain.mp4",
          hash: sha(join(project, "assets", "rain.mp4")),
          sourceUrl: "https://openverse.org/audio/9f2c",
          licence: "CC-BY-4.0",
          author: "Ana Pérez",
          title: "Rain",
          addedAt: new Date().toISOString().slice(0, 10),
        },
      ],
    });
  }, MEDIA_TIMEOUT);

  it("refuses a source that is not an http(s) URL before copying anything", async () => {
    const stray = join(footage, "stray.mp4");
    await makeClip(stray, { durationS: 0.5 });
    await expect(conn.request("asset.import", { cwd: project, files: [stray], sourceUrl: "file:///etc/passwd" })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(existsSync(join(project, "assets", "stray.mp4"))).toBe(false);
  }, MEDIA_TIMEOUT);
});

describe("credits.check", () => {
  it("passes a project that places nothing", async () => {
    expect(await check()).toMatchObject({ ok: true, assets: [], credits: [], text: "" });
  });

  it("fails an asset with no entry, then each gap in an entry, and passes it once complete", async () => {
    await place("assets/plain.mp4");
    const unrecorded = await check();
    expect(unrecorded.ok).toBe(false);
    expect(unrecorded.assets).toMatchObject([{ asset: "assets/plain.mp4", used: ["main"], status: "unrecorded", licence: null, credit: null }]);
    expect(unrecorded.assets[0]!.problem).toContain("credits set assets/plain.mp4");

    await conn.request("credits.set", { cwd: project, asset: "assets/plain.mp4", sourceUrl: "https://pixabay.com/x" });
    expect((await check()).assets[0]).toMatchObject({ status: "no-licence" });

    await conn.request("credits.set", { cwd: project, asset: "assets/plain.mp4", licence: "unknown" });
    expect((await check()).assets[0]).toMatchObject({ status: "no-licence" });

    await conn.request("credits.set", { cwd: project, asset: "assets/plain.mp4", licence: "CC-BY-4.0" });
    expect(await check()).toMatchObject({ ok: false, assets: [{ status: "no-credit", licence: "CC-BY-4.0", credit: null }] });

    await conn.request("credits.set", { cwd: project, asset: "assets/plain.mp4", author: "Luis Gómez", title: "Plain" });
    const done = await check();
    expect(done.ok).toBe(true);
    const line = '"Plain" by Luis Gómez, CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/), https://pixabay.com/x';
    expect(done).toMatchObject({ assets: [{ status: "ok", credit: line, problem: null }], credits: [line], text: line });
  }, MEDIA_TIMEOUT);

  it("needs no credit for CC0 and own work, and lists every credit once", async () => {
    await place("assets/rain.mp4");
    await place("assets/rain.mp4");
    const result = await check();
    expect(result.ok).toBe(true);
    expect(result.assets.map((asset) => [asset.asset, asset.status])).toEqual([["assets/plain.mp4", "ok"], ["assets/rain.mp4", "ok"]]);
    expect(result.credits).toHaveLength(2);

    await conn.request("credits.set", { cwd: project, asset: "assets/rain.mp4", licence: "CC0" });
    const free = await check();
    expect(free.assets[1]).toMatchObject({ licence: "CC0-1.0", credit: null, status: "ok" });
    expect(free.credits).toHaveLength(1);
    await conn.request("credits.set", { cwd: project, asset: "assets/rain.mp4", licence: "own" });
    expect((await check()).assets[1]).toMatchObject({ licence: "own", credit: null, status: "ok" });
  }, MEDIA_TIMEOUT);

  it("does not trust an entry for content that changed since, nor a file that is gone", async () => {
    const before = ledger().assets.find((entry) => entry["asset"] === "assets/rain.mp4")!["hash"];
    rmSync(join(project, "assets", "rain.mp4")); // Imported files are read-only.
    await makeClip(join(project, "assets", "rain.mp4"), { durationS: 0.7 });
    const changed = await check();
    expect(changed.ok).toBe(false);
    expect(changed.assets[1]).toMatchObject({ asset: "assets/rain.mp4", status: "changed" });
    expect(changed.assets[1]!.problem).toContain("credits set assets/rain.mp4");

    // Recording again binds the entry to the new content.
    await conn.request("credits.set", { cwd: project, asset: "assets/rain.mp4", licence: "own" });
    expect(ledger().assets.find((entry) => entry["asset"] === "assets/rain.mp4")!["hash"]).not.toBe(before);
    expect((await check()).ok).toBe(true);

  }, MEDIA_TIMEOUT);

  it("keeps fields left out while the content is unchanged, and starts over when it changed", async () => {
    await conn.request("credits.set", { cwd: project, asset: "assets/plain.mp4", licence: "CC-BY-SA-4.0" });
    expect(ledger().assets.find((entry) => entry["asset"] === "assets/plain.mp4")).toMatchObject({ licence: "CC-BY-SA-4.0", author: "Luis Gómez", title: "Plain" });
    rmSync(join(project, "assets", "plain.mp4"));
    await makeClip(join(project, "assets", "plain.mp4"), { durationS: 0.8 });
    await conn.request("credits.set", { cwd: project, asset: "assets/plain.mp4", licence: "CC0-1.0" });
    expect(ledger().assets.find((entry) => entry["asset"] === "assets/plain.mp4")).not.toHaveProperty("author");
  }, MEDIA_TIMEOUT);

  it("accepts a cwd-relative or absolute asset path, and refuses files outside assets/ or missing", async () => {
    const entry = await conn.request("credits.set", { cwd: join(project, "assets"), asset: "plain.mp4", licence: "own" });
    expect(entry.entry.asset).toBe("assets/plain.mp4");
    await conn.request("credits.set", { cwd: project, asset: join(project, "assets", "plain.mp4"), licence: "own" });
    await expect(conn.request("credits.set", { cwd: project, asset: "assets/none.mp4", licence: "own" })).rejects.toMatchObject({ code: ErrorCode.AssetNotFound });
    await expect(conn.request("credits.set", { cwd: project, asset: "frameshell.json", licence: "own" })).rejects.toMatchObject({ code: ErrorCode.InvalidOperation });
  }, MEDIA_TIMEOUT);

  it("reports a placed file that is gone", async () => {
    const other = tempDir();
    await conn.request("project.init", { dir: other });
    await makeClip(join(other, "assets", "gone.mp4"), { durationS: 0.5 });
    await place("assets/gone.mp4", other);
    await conn.request("credits.set", { cwd: other, asset: "assets/gone.mp4", licence: "own" });
    rmSync(join(other, "assets", "gone.mp4"));
    expect(await conn.request("credits.check", { cwd: other })).toMatchObject({ ok: false, assets: [{ asset: "assets/gone.mp4", status: "missing" }] });
  }, MEDIA_TIMEOUT);

  it("refuses an invalid credits.json instead of passing", async () => {
    const path = join(project, "credits.json");
    const good = readFileSync(path, "utf8");
    writeFileSync(path, '{"schemaVersion":1,"assets":[{"asset":"exports/x.mp4"}]}');
    await expect(check()).rejects.toMatchObject({ code: ErrorCode.InvalidProjectFile });
    writeFileSync(path, good);
  });
});

describe("render warnings", () => {
  it("names placed assets without verified provenance once the project records any, and is quiet before", async () => {
    const quiet = tempDir();
    await conn.request("project.init", { dir: quiet });
    const clip = join(footage, "solo.mp4");
    await makeClip(clip, { durationS: 0.5 });
    const { imported } = await conn.request("asset.import", { cwd: quiet, files: [clip] });
    const track = (await conn.request("track.add", { cwd: quiet, kind: "video" })).changes.added[0]!;
    await conn.request("clip.add", { cwd: quiet, track, asset: imported[0]!.asset, start: 0, in: 0, out: 0.5 });
    const silent = await conn.request("render", { cwd: quiet });
    expect(silent.warnings.filter((warning) => warning.includes("provenance"))).toEqual([]);

    const other = join(footage, "other.mp4");
    await makeClip(other, { durationS: 0.5 });
    await conn.request("asset.import", { cwd: quiet, files: [other], licence: "CC0-1.0" });
    const warned = await conn.request("render", { cwd: quiet });
    expect(warned.warnings).toEqual([expect.stringContaining("assets/solo.mp4")]);
    expect(warned.warnings[0]).toContain("frameshell credits");

    await conn.request("credits.set", { cwd: quiet, asset: "assets/solo.mp4", licence: "own" });
    expect((await conn.request("render", { cwd: quiet })).warnings).toEqual([]);
  }, MEDIA_TIMEOUT);
});
