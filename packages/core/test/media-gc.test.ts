import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AssetInfo, type DaemonConnection, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { TEMP_MIN_AGE_MS, sweep } from "../src/gc.js";
import { JobQueue } from "../src/jobs/queue.js";
import { energyCacheKey } from "../src/media/energy-store.js";
import { MediaService } from "../src/media/service.js";
import { MediaStore } from "../src/media/store.js";
import { audioCacheKey } from "../src/transcripts/transcriber.js";
import { ProjectRegistry } from "../src/projects.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeClip } from "./media-fixtures.js";
import { testBinaryManager } from "./media-tools.js";

const MEDIA_TIMEOUT = 120_000;
const DAY_MS = 24 * 60 * 60_000;

/** Write `content` at project-relative `rel`, creating its folder; `ageMs` back-dates its mtime. */
function plant(root: string, rel: string, content = "x", ageMs = 0): string {
  const path = join(root, ...rel.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  if (ageMs > 0) age(path, ageMs);
  return path;
}

function age(path: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
}

/** Every derived file of cache key `key` as ingest names them (a real key has one proxy: `.mp4`, or `.webm` with alpha). */
function plantOutputs(root: string, key: string, ageMs = 0): string[] {
  const rels = [
    `.frameshell/proxies/${key}.json`,
    `.frameshell/proxies/${key}.mp4`,
    `.frameshell/proxies/${key}.webm`,
    `.frameshell/proxies/${key}.pcm`,
    `.frameshell/waveforms/${key}.json`,
    `.frameshell/thumbs/${key}/0001.jpg`,
  ];
  for (const rel of rels) plant(root, rel, "x", ageMs);
  if (ageMs > 0) age(join(root, ".frameshell", "thumbs", key), ageMs);
  return rels;
}

describe("sweep", () => {
  const classify = (name: string) =>
    name.endsWith(".tmp") ? ({ kind: "temp", key: null } as const) : /^k\d\./.test(name) ? ({ kind: "proxy", key: name.slice(0, 2) } as const) : null;

  it("deletes entries of unkept keys and old temps; keeps kept keys, young temps, unknown names, symlinks and claimed keys", async () => {
    const root = tempDir();
    const dir = ".frameshell/proxies";
    plant(root, `${dir}/k1.mp4`, "12345");
    plant(root, `${dir}/k2.mp4`);
    plant(root, `${dir}/k3.mp4`);
    plant(root, `${dir}/old.tmp`, "x", TEMP_MIN_AGE_MS + 60_000);
    plant(root, `${dir}/young.tmp`);
    plant(root, `${dir}/README.txt`);
    const outside = plant(root, "assets/keep.mp4");
    if (process.platform !== "win32") symlinkSync(outside, join(root, ".frameshell", "proxies", "k4.mp4"));

    const options = {
      root,
      dir,
      classify,
      keep: (key: string) => key === "k2",
      temps: true,
      claim: async (key: string) => (key === "k3" ? null : () => {}),
    };
    const listed = await sweep({ ...options, dryRun: true });
    expect(listed).toEqual([
      { path: `${dir}/k1.mp4`, kind: "proxy", bytes: 5 },
      { path: `${dir}/old.tmp`, kind: "temp", bytes: 1 },
    ]);
    expect(existsSync(join(root, dir, "k1.mp4"))).toBe(true);

    expect(await sweep({ ...options, dryRun: false })).toEqual(listed);
    for (const name of ["k2.mp4", "k3.mp4", "young.tmp", "README.txt"]) expect(existsSync(join(root, dir, name))).toBe(true);
    expect(existsSync(join(root, dir, "k1.mp4"))).toBe(false);
    expect(existsSync(join(root, dir, "old.tmp"))).toBe(false);
    expect(existsSync(outside)).toBe(true);
  });

  it("keeps temps while jobs run, and keyed entries newer than the floor", async () => {
    const root = tempDir();
    const dir = ".frameshell/proxies";
    plant(root, `${dir}/old.tmp`, "x", TEMP_MIN_AGE_MS + 60_000);
    plant(root, `${dir}/k1.mp4`, "x", 2 * DAY_MS);
    plant(root, `${dir}/k2.mp4`);
    const removed = await sweep({ root, dir, classify, keep: () => false, temps: false, dryRun: false, keepNewerThan: Date.now() - DAY_MS });
    expect(removed.map((entry) => entry.path)).toEqual([`${dir}/k1.mp4`]);
  });

  it("finds nothing in a missing directory", async () => {
    expect(await sweep({ root: tempDir(), dir: ".frameshell/thumbs", classify, keep: () => false, temps: true, dryRun: false })).toEqual([]);
  });
});

describe("MediaService.gc", () => {
  const services: MediaService[] = [];
  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
  });

  async function setup(gcOnAttach = false) {
    const root = tempDir();
    await new ProjectRegistry().init(root);
    const media = new MediaService({ binaries: testBinaryManager(), jobs: new JobQueue(), watch: false, gcOnAttach });
    services.push(media);
    return { root, media, store: new MediaStore(root) };
  }

  it("keys by the media index: keeps outputs of every current file, deletes the rest, forgets vanished files", async () => {
    const { root, media, store } = await setup();
    plant(root, "assets/take.wav", "take one");
    const hash = await store.hash("assets/take.wav");
    const current = plantOutputs(root, store.key(hash, 30));
    plant(root, `.frameshell/energy/${energyCacheKey(hash)}.f32`, "1234");
    // Same content at another fps, an older recipe, and a file that is gone (still in the index).
    const otherFps = plantOutputs(root, store.key(hash, 25));
    const oldRecipe = plantOutputs(root, store.key(hash, 30).replace(/-r\d+$/, "-r1"));
    await store.remember("assets/gone.wav", { size: 1, mtimeMs: 1, hash: `sha256:${"ab".repeat(32)}` });
    const gone = plantOutputs(root, store.key(`sha256:${"ab".repeat(32)}`, 30));
    plant(root, `.frameshell/energy/${energyCacheKey(`sha256:${"ab".repeat(32)}`)}.f32`);
    plant(root, `.frameshell/energy/${energyCacheKey(hash).replace(/-e\d+$/, "-e0")}.f32`);
    plant(root, ".frameshell/history/main.jsonl", "{}");

    const report = await media.gc(root, { dryRun: false, temps: true, hashUnknown: true });
    const removed = report.removed.map((entry) => entry.path);
    const thumbsDir = (rels: string[]) => rels.map((rel) => rel.replace(/0001\.jpg$/, ""));
    expect(removed.sort()).toEqual(
      [
        ...thumbsDir(otherFps),
        ...thumbsDir(oldRecipe),
        ...thumbsDir(gone),
        `.frameshell/energy/${energyCacheKey(`sha256:${"ab".repeat(32)}`)}.f32`,
        `.frameshell/energy/${energyCacheKey(hash).replace(/-e\d+$/, "-e0")}.f32`,
      ].sort(),
    );
    expect(report.forgotten).toEqual(["assets/gone.wav"]);
    expect(report.skipped).toEqual([]);
    for (const rel of current) expect(existsSync(join(root, rel))).toBe(true);
    expect(existsSync(join(root, ".frameshell", "energy", `${energyCacheKey(hash)}.f32`))).toBe(true);
    expect(existsSync(join(root, "assets", "take.wav"))).toBe(true);
    expect(existsSync(join(root, ".frameshell", "history", "main.jsonl"))).toBe(true);
    expect(await new MediaStore(root).indexedPaths()).toEqual(["assets/take.wav"]);
  });

  it("deletes transcription WAVs of content no file has and verify leftovers, unless a transcription runs", async () => {
    const { root, media, store } = await setup();
    plant(root, "assets/take.wav", "take one");
    const hash = await store.hash("assets/take.wav");
    const gone = `sha256:${"ab".repeat(32)}`;
    const current = [`.frameshell/cache/audio/${audioCacheKey(hash)}-sidecar.wav`, `.frameshell/cache/audio/${audioCacheKey(hash)}-asset.wav`];
    for (const rel of current) plant(root, rel);
    const stale = [
      `.frameshell/cache/audio/${audioCacheKey(gone)}-sidecar.wav`,
      `.frameshell/cache/audio/${audioCacheKey(hash)}-asset.wav.123.tmp.wav`,
      ".frameshell/cache/verify/0123456789ab.wav",
      ".frameshell/cache/verify/window-0123456789ab.wav",
      ".frameshell/cache/transcribe/window-0123456789ab.wav",
    ];
    plant(root, stale[0]!);
    for (const rel of stale.slice(1)) plant(root, rel, "x", TEMP_MIN_AGE_MS + 60_000);
    const young = plant(root, ".frameshell/cache/verify/ba9876543210.wav");
    const foreign = plant(root, ".frameshell/cache/audio/notes.txt");
    const foreignWindow = plant(root, ".frameshell/cache/transcribe/notes.txt", "x", TEMP_MIN_AGE_MS + 60_000);

    const busy = await media.gc(root, { dryRun: false, temps: true, hashUnknown: true, transcribing: true });
    expect(busy.removed).toEqual([]);
    expect(busy.skipped).toEqual([{ area: "audio", reason: expect.stringContaining("transcription") }]);
    for (const rel of stale) expect(existsSync(join(root, rel))).toBe(true);

    const report = await media.gc(root, { dryRun: false, temps: true, hashUnknown: true });
    expect(report.removed.map((entry) => [entry.path, entry.kind])).toEqual(
      [
        [stale[0], "audio"],
        [stale[1], "temp"],
        [stale[2], "temp"],
        [stale[3], "temp"],
        [stale[4], "temp"],
      ].sort(),
    );
    for (const rel of stale) expect(existsSync(join(root, rel))).toBe(false);
    for (const rel of current) expect(existsSync(join(root, rel))).toBe(true);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(foreignWindow)).toBe(true);
  });

  it("without hashing, keeps all derived media while a file's content is unknown", async () => {
    const { root, media, store } = await setup();
    const orphan = plantOutputs(root, store.key(`sha256:${"cd".repeat(32)}`, 30));
    plant(root, "assets/new.wav", "never hashed");

    const lazy = await media.gc(root, { dryRun: false, temps: true, hashUnknown: false });
    expect(lazy.removed).toEqual([]);
    expect(lazy.skipped).toEqual([{ area: "media", reason: expect.stringContaining("1 file(s) not hashed yet") }]);
    for (const rel of orphan) expect(existsSync(join(root, rel))).toBe(true);

    const dry = await media.gc(root, { dryRun: true, temps: true, hashUnknown: true });
    expect(dry.removed).toHaveLength(orphan.length);
    for (const rel of orphan) expect(existsSync(join(root, rel))).toBe(true);
  });

  it("sweeps old unused derived media when a project is attached, never recent ones", async () => {
    const { root, media, store } = await setup(true);
    plant(root, "assets/take.wav", "take one");
    const hash = await store.hash("assets/take.wav");
    const current = plantOutputs(root, store.key(hash, 30), 30 * DAY_MS);
    const stale = plantOutputs(root, store.key(`sha256:${"ef".repeat(32)}`, 30), 30 * DAY_MS);
    const recent = plantOutputs(root, store.key(`sha256:${"12".repeat(32)}`, 30));
    media.attach(root);
    for (const deadline = Date.now() + 10_000; existsSync(join(root, stale[0]!)); ) {
      if (Date.now() > deadline) throw new Error("attach never swept");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const rel of stale) expect(existsSync(join(root, rel))).toBe(false);
    for (const rel of [...current, ...recent]) expect(existsSync(join(root, rel))).toBe(true);
  });
});

describe("gc through the daemon", () => {
  let daemon: Daemon;
  let conn: DaemonConnection;
  afterEach(async () => {
    conn?.close();
    await daemon?.close();
  });

  it(
    "deletes derived media of deleted and changed assets and keeps what current assets use",
    async () => {
      daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
      conn = await connectToDaemon(daemon.socketPath, { client: "test" });
      const project = tempDir();
      await conn.request("project.init", { dir: project });
      const sources = tempDir();
      await makeClip(join(sources, "a.mp4"));
      await makeClip(join(sources, "b.mp4"), { width: 160, height: 120 });
      await makeClip(join(sources, "a2.mp4"), { durationS: 2 });

      const ready = async (path: string, not?: string | null): Promise<AssetInfo> => {
        for (const deadline = Date.now() + 90_000; ; ) {
          const asset = (await conn.request("asset.list", { cwd: project })).assets.find((a) => a.path === path);
          if (asset?.state === "ready" && asset.hash !== not) return asset;
          if (asset?.state === "failed" || Date.now() > deadline) throw new Error(`${path}: ${JSON.stringify(asset)}`);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      };
      await conn.request("asset.import", { cwd: project, files: [join(sources, "a.mp4"), join(sources, "b.mp4")] });
      const oldA = await ready("assets/a.mp4");
      const b = await ready("assets/b.mp4");
      // b deleted, a replaced by other content: the watcher ingests the new a.
      rmSync(join(project, "assets", "b.mp4"));
      writeFileSync(join(project, "assets", "a.mp4"), readFileSync(join(sources, "a2.mp4")));
      const newA = await ready("assets/a.mp4", oldA.hash);
      for (;;) {
        const { jobs } = await conn.request("job.list", { cwd: project, active: true });
        if (jobs.length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      plant(project, ".frameshell/cache/clips/0123456789abcdef0123456789abcdef.webm");
      plant(project, ".frameshell/cache/clips/0123456789abcdef0123456789abcdef.json", "{}");

      const derived = (asset: AssetInfo) => [asset.proxy!, asset.sidecar!.path, asset.waveform!.path, `${asset.thumbnails!.dir}/`, asset.proxy!.replace(/\.mp4$/, ".json")];
      const dry = await conn.request("gc", { cwd: project, dryRun: true });
      expect(dry).toMatchObject({ dir: project, dryRun: true, skipped: [] });
      expect(dry.removed.map((entry) => entry.path).sort()).toEqual(
        [
          ...derived(oldA),
          ...derived(b),
          ".frameshell/cache/clips/0123456789abcdef0123456789abcdef.json",
          ".frameshell/cache/clips/0123456789abcdef0123456789abcdef.webm",
        ].sort(),
      );
      expect(dry.bytes).toBe(dry.removed.reduce((sum, entry) => sum + entry.bytes, 0));
      expect(dry.bytes).toBeGreaterThan(0);
      for (const entry of dry.removed) expect(existsSync(join(project, entry.path))).toBe(true);

      const done = await conn.request("gc", { cwd: project });
      expect(done.removed).toEqual(dry.removed);
      for (const entry of done.removed) expect(existsSync(join(project, entry.path))).toBe(false);
      expect(await ready("assets/a.mp4")).toEqual(newA);
      for (const rel of derived(newA)) expect(existsSync(join(project, rel))).toBe(true);
      expect(existsSync(join(project, "assets", "a.mp4"))).toBe(true);
      expect((await conn.request("gc", { cwd: project })).removed).toEqual([]);
    },
    MEDIA_TIMEOUT,
  );
});
