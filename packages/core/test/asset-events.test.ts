import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnection } from "node:net";
import {
  type DaemonConnection,
  type EventName,
  type EventParams,
  PROTOCOL_VERSION,
  connectToDaemon,
  readMessages,
  writeMessage,
} from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeClip } from "./media-fixtures.js";
import { testBinaryManager } from "./media-tools.js";

// Seam under test: a real daemon over its socket with real managed ffmpeg, observed only through
// `events.subscribe` notifications, the way the app and `frameshell import --wait` follow ingest.
const MEDIA_TIMEOUT = 120_000;

let daemon: Daemon;
let app: DaemonConnection;
let cli: DaemonConnection;
let project: string;

beforeEach(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  app = await connectToDaemon(daemon.socketPath, { client: "desktop/test" });
  cli = await connectToDaemon(daemon.socketPath, { client: "cli/test" });
  project = tempDir();
  await cli.request("project.init", { dir: project });
});
afterEach(async () => {
  app.close();
  cli.close();
  await daemon.close();
});

/** Every `event` notification `app` receives, and a wait for the first one matching `until`. */
function record<E extends EventName>(event: E) {
  const seen: EventParams<E>[] = [];
  const waiters: { until: (params: EventParams<E>) => boolean; resolve: (params: EventParams<E>) => void }[] = [];
  app.on(event, (params) => {
    seen.push(params);
    for (const waiter of [...waiters]) {
      if (!waiter.until(params)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(params);
    }
  });
  const next = (until: (params: EventParams<E>) => boolean) =>
    new Promise<EventParams<E>>((resolve) => {
      const already = seen.find(until);
      if (already) resolve(already);
      else waiters.push({ until, resolve });
    });
  return { seen, next };
}

/**
 * Resolve once the daemon's `assets/` watcher reports new files from OS events. macOS rebuilds its
 * shared FSEvents stream after each new directory watch and drops events meanwhile (#53): keep dropping
 * probe files. The first one shown may come from the initial scan; one written after it cannot.
 */
async function watcherLive(assets: ReturnType<typeof record<"asset.changed">>): Promise<void> {
  let n = 0;
  const drop = () => writeFileSync(join(project, "assets", `probe-${++n}.txt`), "live?\n");
  const probe = (path: string) => Number(/^assets\/probe-(\d+)\.txt$/.exec(path)?.[1] ?? 0);
  drop();
  const timer = setInterval(drop, 500);
  try {
    await assets.next((params) => probe(params.path) > 0);
    const scanned = n;
    await assets.next((params) => probe(params.path) > scanned);
  } finally {
    clearInterval(timer);
  }
}

describe("asset.changed and job.progress notifications", () => {
  it(
    "follow an import from queued to a ready asset with its waveform and thumbnails",
    async () => {
      await expect(app.request("events.subscribe", { cwd: project, events: ["asset.changed", "job.progress"] })).resolves.toEqual({
        dir: project,
        events: ["asset.changed", "job.progress"],
      });
      const assets = record("asset.changed");
      const jobs = record("job.progress");
      const source = join(tempDir(), "take.mp4");
      await makeClip(source, { durationS: 1 });

      const { imported } = await cli.request("asset.import", { cwd: project, files: [source] });
      const jobId = imported[0]!.job.id;
      const ready = await assets.next((params) => params.asset?.state === "ready");

      // The ready event carries exactly what `asset.list` reports: no re-read needed.
      const { assets: listed } = await app.request("asset.list", { cwd: project });
      expect(ready).toEqual({ project, path: "assets/take.mp4", asset: listed[0] });
      expect(ready.asset?.waveform).not.toBeNull();
      expect(ready.asset?.thumbnails?.count).toBeGreaterThan(0);
      expect(assets.seen[0]).toMatchObject({ project, path: "assets/take.mp4", asset: { state: "processing" } });

      const mine = jobs.seen.filter((params) => params.job.id === jobId);
      expect(mine.every((params) => params.project === project)).toBe(true);
      const states = mine.map((params) => params.job.state).filter((state, i, all) => state !== all[i - 1]);
      expect(states).toEqual(["queued", "running", "done"]);
      expect(mine.map((params) => params.job.step)).toContain("proxy");
      expect(mine.at(-1)!.job).toMatchObject({ state: "done", progress: 1, cached: false });
      const progress = mine.map((params) => params.job.progress);
      expect(progress).toEqual([...progress].sort((a, b) => a - b));
    },
    MEDIA_TIMEOUT,
  );

  it(
    "report a failed ingest with its error, and an asset deleted from assets/ as gone",
    async () => {
      await app.request("events.subscribe", { cwd: project, events: ["asset.changed"] });
      const assets = record("asset.changed");

      await watcherLive(assets);

      // Dropped straight into assets/: the watcher queues it, so its failure proves the watcher saw the file.
      writeFileSync(join(project, "assets", "notes.txt"), "not media at all\n");
      const failed = await assets.next((params) => params.path === "assets/notes.txt" && params.asset?.state === "failed");
      expect(failed).toMatchObject({ asset: { state: "failed", error: expect.stringContaining("notes.txt") } });

      rmSync(join(project, "assets", "notes.txt"));
      await expect(assets.next((params) => params.asset === null)).resolves.toEqual({ project, path: "assets/notes.txt", asset: null });
    },
    MEDIA_TIMEOUT,
  );

  it("reach a connection that subscribed by another spelling of the project", async () => {
    // Windows CI: tmpdir is `RUNNER~1`, the app subscribes with the long name. A junction stands in elsewhere.
    const alias = join(tempDir(), "alias");
    symlinkSync(project, alias, "junction");
    await app.request("events.subscribe", { cwd: project, events: ["asset.changed", "job.progress"] });
    const assets = record("asset.changed");
    const jobs = record("job.progress");
    writeFileSync(join(alias, "clip.txt"), "x");

    const { imported } = await cli.request("asset.import", { cwd: alias, files: [join(alias, "clip.txt")] });
    const done = await jobs.next((params) => params.job.id === imported[0]!.job.id && params.job.state === "failed");
    expect(done.project).toBe(project);
    await expect(assets.next((params) => params.asset?.state === "failed")).resolves.toMatchObject({
      project,
      path: "assets/clip.txt",
    });
  }, MEDIA_TIMEOUT);

  it("reach the subscriber before any reply that already shows their change", async () => {
    // `frameshell import --wait` prints each job event, then reads `job.list` for jobs it may have missed:
    // a reply overtaking older events made it print steps twice (#79). Raw lines keep the arrival order.
    const socket = createConnection(daemon.socketPath);
    await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));
    const arrived: { id?: number; method?: string; result?: unknown; params?: { job?: { id: string } } }[] = [];
    const replies = new Map<number, () => void>();
    readMessages(socket, (message) => {
      const line = message as (typeof arrived)[number];
      arrived.push(line);
      if (line.id !== undefined) replies.get(line.id)?.();
    });
    let nextId = 1;
    const call = (method: string, params: unknown) =>
      new Promise<number>((resolve) => {
        const id = nextId++;
        replies.set(id, () => resolve(id));
        writeMessage(socket, { jsonrpc: "2.0", id, method, params });
      });
    try {
      await call("handshake", { protocolVersion: PROTOCOL_VERSION, client: "cli/test" });
      await call("events.subscribe", { cwd: project, events: ["job.progress"] });
      writeFileSync(join(project, "clip.txt"), "x");

      const importId = await call("asset.import", { cwd: project, files: [join(project, "clip.txt")] });
      const reply = arrived.findIndex((line) => line.id === importId);
      const { imported } = arrived[reply]!.result as { imported: { job: { id: string } }[] };
      const jobEvent = arrived.findIndex((line) => line.method === "job.progress" && line.params?.job?.id === imported[0]!.job.id);
      expect(jobEvent).toBeGreaterThanOrEqual(0);
      expect(jobEvent).toBeLessThan(reply);
    } finally {
      socket.destroy();
    }
  });

  it("are only sent to connections subscribed to that event", async () => {
    await app.request("events.subscribe", { cwd: project, events: ["job.progress"] });
    await cli.request("events.subscribe", { cwd: project, events: ["asset.changed"] });
    const toApp = record("asset.changed");
    const jobs = record("job.progress");
    let toCli!: () => void;
    const cliSaw = new Promise<void>((resolve) => (toCli = resolve));
    cli.on("asset.changed", (params) => params.asset?.state === "failed" && toCli());
    writeFileSync(join(project, "clip.txt"), "x");

    await cli.request("asset.import", { cwd: project, files: [join(project, "clip.txt")] });
    await jobs.next((params) => params.job.state === "failed");
    await cliSaw;
    // Round trip on the same connection: had the app been sent the event with the CLI's, it would be here by now.
    await app.request("asset.list", { cwd: project });
    expect(toApp.seen).toEqual([]);
  }, MEDIA_TIMEOUT);
});
