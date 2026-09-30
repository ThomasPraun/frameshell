import { join } from "node:path";
import { type AppDirs, type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// Seam under test: the daemon over its socket. A replay is the same request sent again with the same
// `idempotencyKey`, on the same or a new connection, as a client retrying after a lost reply does.

let daemon: Daemon | undefined;
const connections: DaemonConnection[] = [];
afterEach(async () => {
  for (const conn of connections.splice(0)) conn.close();
  await daemon?.close();
  daemon = undefined;
});

async function setup() {
  const dirs: AppDirs = { dataDir: tempDir(), configDir: tempDir() };
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs });
  const connect = async (client: string, session?: string) => {
    const conn = await connectToDaemon(daemon!.socketPath, { client, session });
    connections.push(conn);
    return conn;
  };
  const dir = join(tempDir(), "talk");
  const admin = await connect("cli/test");
  await admin.request("project.init", { dir });
  const history = async () =>
    (await admin.request("history", { cwd: dir, timeline: "main" })).transactions.flatMap((tx) => tx.operations.map((op) => op.op));
  return { dir, connect, admin, history };
}

describe("idempotent mutating requests", () => {
  it("applies a replayed operation once, on a new connection, and returns the first result", async () => {
    const { dir, connect, history } = await setup();
    const key = "retry-0123456789";
    const first = await (await connect("desktop/test")).request("track.add", { cwd: dir, kind: "video" }, { idempotencyKey: key });
    const replay = await (await connect("desktop/test")).request("track.add", { cwd: dir, kind: "video" }, { idempotencyKey: key });
    expect(replay).toEqual(first);
    expect(await history()).toEqual(["track.add"]);
  });

  it("answers a replay that arrives while the first request still runs with the same result", async () => {
    const { dir, connect, history } = await setup();
    const app = await connect("desktop/test");
    const key = "inflight-0123456789";
    const [a, b] = await Promise.all([
      app.request("track.add", { cwd: dir, kind: "audio" }, { idempotencyKey: key }),
      app.request("track.add", { cwd: dir, kind: "audio" }, { idempotencyKey: key }),
    ]);
    expect(b).toEqual(a);
    expect(await history()).toEqual(["track.add"]);
  });

  it("applies distinct keys, and requests without a key, every time", async () => {
    const { dir, connect, history } = await setup();
    const app = await connect("desktop/test");
    await app.request("track.add", { cwd: dir, kind: "video" }, { idempotencyKey: "one-0123456789" });
    await app.request("track.add", { cwd: dir, kind: "video" }, { idempotencyKey: "two-0123456789" });
    await app.request("track.add", { cwd: dir, kind: "video" });
    await app.request("track.add", { cwd: dir, kind: "video" });
    expect(await history()).toEqual(["track.add", "track.add", "track.add", "track.add"]);
  });

  it("keeps keys per author: another session's same key is its own change", async () => {
    const { dir, connect, history } = await setup();
    const key = "shared-0123456789";
    await (await connect("cli/test", "agent")).request("track.add", { cwd: dir, kind: "video" }, { idempotencyKey: key });
    await (await connect("desktop/test")).request("track.add", { cwd: dir, kind: "video" }, { idempotencyKey: key });
    expect(await history()).toEqual(["track.add", "track.add"]);
  });

  it("refuses a key reused for a different request, applying nothing", async () => {
    const { dir, connect, history } = await setup();
    const app = await connect("desktop/test");
    const key = "reused-0123456789";
    await app.request("track.add", { cwd: dir, kind: "video" }, { idempotencyKey: key });
    await expect(app.request("track.add", { cwd: dir, kind: "audio" }, { idempotencyKey: key })).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringMatching(/idempotencyKey/),
    });
    expect(await history()).toEqual(["track.add"]);
  });

  it("forgets a request that failed, so a retry with its key runs again", async () => {
    const { connect, admin } = await setup();
    const app = await connect("desktop/test");
    const later = join(tempDir(), "later");
    const request = () => app.request("track.add", { cwd: later, kind: "video" }, { idempotencyKey: "failed-0123456789" });
    await expect(request()).rejects.toMatchObject({ code: ErrorCode.ProjectNotFound });
    await admin.request("project.init", { dir: later });
    expect((await request()).operation.op).toBe("track.add");
  });

  it("replays tx.commit: a retried commit reports the transaction it closed instead of failing", async () => {
    const { dir, connect } = await setup();
    const app = await connect("desktop/test");
    await app.request("tx.begin", { label: "batch" });
    await app.request("track.add", { cwd: dir, kind: "video" });
    const commit = await app.request("tx.commit", {}, { idempotencyKey: "commit-0123456789" });
    expect(await app.request("tx.commit", {}, { idempotencyKey: "commit-0123456789" })).toEqual(commit);
    await expect(app.request("tx.commit", {})).rejects.toMatchObject({ code: ErrorCode.TransactionState });
  });
});
