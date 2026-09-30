import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DaemonConnection,
  ErrorCode,
  type EventName,
  type EventParams,
  RpcError,
  connectToDaemon,
} from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// Seam under test: a real daemon over its socket with its real watcher. A
// direct edit is a plain write to `timelines/main.json`; outcomes are observed
// through `timeline.changed` / `timeline.rejected`, `history`, `status` and disk.

let daemon: Daemon | undefined;
const connections: DaemonConnection[] = [];
afterEach(async () => {
  for (const conn of connections.splice(0)) conn.close();
  await daemon?.close();
  daemon = undefined;
});

async function setup() {
  daemon = await startDaemon({ socketPath: uniqueSocketPath() });
  const conn = await connectToDaemon(daemon.socketPath, { client: "cli/test", session: "term-1" });
  connections.push(conn);
  const dir = join(tempDir(), "talk");
  await conn.request("project.init", { dir });
  await conn.request("events.subscribe", { cwd: dir, events: ["timeline.changed", "timeline.rejected"] });
  const file = join(dir, "timelines", "main.json");
  const read = () => JSON.parse(readFileSync(file, "utf8"));
  const edit = (change: (timeline: ReturnType<typeof read>) => void) => {
    const timeline = read();
    change(timeline);
    writeFileSync(file, JSON.stringify(timeline, null, 2));
  };
  const seen: { event: EventName; author?: string }[] = [];
  conn.on("timeline.changed", ({ author }) => seen.push({ event: "timeline.changed", author }));
  conn.on("timeline.rejected", () => seen.push({ event: "timeline.rejected" }));
  return { conn, dir, file, read, edit, seen };
}

/** Next notification `event` matching `where`. */
function next<E extends EventName>(conn: DaemonConnection, event: E, where: (params: EventParams<E>) => boolean = () => true) {
  return new Promise<EventParams<E>>((resolve) => {
    const off = conn.on(event, (params) => {
      if (!where(params)) return;
      off();
      resolve(params);
    });
  });
}

async function rejection(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("direct edits seen by the daemon's watcher", () => {
  it("journals an edit with the current revision as a `file` operation and emits timeline.changed", async () => {
    const { conn, dir, read, edit } = await setup();
    const added = await conn.request("track.add", { cwd: dir, kind: "video" });
    const changed = next(conn, "timeline.changed", (event) => event.author === "file");
    edit((timeline) => {
      timeline.tracks[0].name = "Camera";
    });

    const event = await changed;
    expect(event).toMatchObject({ project: dir, timeline: "main", revision: added.revision + 1, author: "file" });
    expect(event.changes.updated).toEqual(added.changes.added);
    expect(read()).toMatchObject({ revision: added.revision + 1, tracks: [{ name: "Camera" }] });
    const history = await conn.request("history", { cwd: dir, timeline: "main" });
    expect(history.transactions.map((tx) => tx.author)).toEqual(["cli:term-1", "file"]);
  });

  it("rejects a stale edit: restores the daemon's version, keeps the edit, emits timeline.rejected and lists it in status", async () => {
    const { conn, dir, file, edit } = await setup();
    await conn.request("track.add", { cwd: dir, kind: "video" });
    const daemonVersion = readFileSync(file, "utf8");
    const rejected = next(conn, "timeline.rejected");
    edit((timeline) => {
      timeline.revision = 0;
      timeline.tracks = [];
    });
    const incoming = readFileSync(file, "utf8");

    const event = await rejected;
    expect(event).toMatchObject({ project: dir, timeline: "main", reason: "stale", revision: 0, current: 1 });
    expect(event.preserved).toMatch(/^\.frameshell\/rejected\/.+-main\.json$/);
    expect(readFileSync(join(dir, event.preserved), "utf8")).toBe(incoming);
    expect(readFileSync(file, "utf8")).toBe(daemonVersion);

    const status = await conn.request("status", { cwd: dir });
    const { project: _project, ...listed } = event;
    expect(status.rejections).toEqual([listed]);
  });

  it("rejects invalid content with the schema error, same preservation", async () => {
    const { conn, dir, file, edit } = await setup();
    await conn.request("track.add", { cwd: dir, kind: "video" });
    const daemonVersion = readFileSync(file, "utf8");
    const rejected = next(conn, "timeline.rejected");
    edit((timeline) => {
      timeline.tracks[0].clips = [{ id: "c_x", type: "media", start: -1 }];
    });

    const event = await rejected;
    expect(event.reason).toBe("invalid");
    expect(event.message).toMatch(/tracks\.0\.clips\.0/);
    expect(existsSync(join(dir, event.preserved))).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(daemonVersion);
  });

  it("does not take the daemon's own atomic writes for direct edits", async () => {
    const { conn, dir, edit, seen } = await setup();
    for (let i = 0; i < 5; i++) await conn.request("track.add", { cwd: dir, kind: "audio" });
    // A real edit after the writes: once it is journaled, the watcher has seen every earlier write.
    const changed = next(conn, "timeline.changed", (event) => event.author === "file");
    edit((timeline) => {
      timeline.tracks[0].name = "Voice";
    });
    await changed;

    const history = await conn.request("history", { cwd: dir, timeline: "main" });
    expect(history.transactions.map((tx) => tx.author)).toEqual(["cli:term-1", "file"]);
    expect(history.transactions[0]!.operations).toHaveLength(5);
    expect(seen).toEqual([
      ...Array.from({ length: 5 }, () => ({ event: "timeline.changed", author: "cli:term-1" })),
      { event: "timeline.changed", author: "file" },
    ]);
    expect(readdirSync(join(dir, ".frameshell", "rejected"))).toEqual([]);
    expect((await conn.request("status", { cwd: dir })).rejections).toEqual([]);
  });
});

describe("file.write of a timeline", () => {
  it("is journaled as a `file` operation and bumps the revision", async () => {
    const { conn, dir, file, read } = await setup();
    const timeline = read();
    timeline.tracks.push({ id: "v1", kind: "video", name: "Camera", clips: [] });
    await conn.request("file.write", { path: file, content: JSON.stringify(timeline) });
    expect(read()).toMatchObject({ revision: 1, tracks: [{ id: "v1" }] });
    const history = await conn.request("history", { cwd: dir, timeline: "main" });
    expect(history.transactions).toMatchObject([{ author: "file", operations: [{ op: "timeline.patch", touched: ["v1"] }] }]);
  });

  it("is refused with StaleRevision when saved from an old copy", async () => {
    const { conn, dir, file, read } = await setup();
    const old = read();
    await conn.request("track.add", { cwd: dir, kind: "video" });
    const error = await rejection(conn.request("file.write", { path: file, content: JSON.stringify(old) }));
    expect(error.code).toBe(ErrorCode.StaleRevision);
    expect(error.message).toMatch(/revision 0.*revision 1/);
    expect(read().tracks).toHaveLength(1);
  });
});
