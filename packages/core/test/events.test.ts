import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DaemonConnection,
  ErrorCode,
  type EventParams,
  connectToDaemon,
} from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { rawSession, tempDir, uniqueSocketPath } from "./helpers.js";

// Seam under test: a real daemon over its socket, driven by the typed client
// (`events.subscribe` + `DaemonConnection.on`), as the app and MCP server use it.

let daemon: Daemon | undefined;
const connections: DaemonConnection[] = [];
afterEach(async () => {
  for (const conn of connections.splice(0)) conn.close();
  await daemon?.close();
  daemon = undefined;
});

async function connect(client: string, session?: string): Promise<DaemonConnection> {
  const conn = await connectToDaemon(daemon!.socketPath, { client, session });
  connections.push(conn);
  return conn;
}

async function project(conn: DaemonConnection): Promise<string> {
  const dir = join(tempDir(), "talk");
  await conn.request("project.init", { dir });
  return dir;
}

/** Collects notifications and resolves once `count` arrived. */
function collect(conn: DaemonConnection, count = 1) {
  const seen: EventParams<"timeline.changed">[] = [];
  let done!: () => void;
  const arrived = new Promise<void>((resolve) => (done = resolve));
  conn.on("timeline.changed", (params) => {
    seen.push(params);
    if (seen.length === count) done();
  });
  return { seen, arrived };
}

describe("timeline.changed notifications", () => {
  it("reach a subscribed connection when another client edits the timeline", async () => {
    daemon = await startDaemon({ socketPath: uniqueSocketPath() });
    const app = await connect("desktop/test");
    const cli = await connect("cli/test", "term-1");
    const dir = await project(cli);

    await expect(app.request("events.subscribe", { cwd: dir, events: ["timeline.changed"] })).resolves.toEqual({
      dir,
      events: ["timeline.changed"],
    });
    const { seen, arrived } = collect(app);
    const result = await cli.request("track.add", { cwd: dir, kind: "video", name: "Camera" });
    await arrived;

    expect(seen).toEqual([
      {
        project: dir,
        timeline: "main",
        revision: result.revision,
        author: "cli:term-1",
        changes: result.changes,
      },
    ]);
  });

  it("are not sent to connections that did not subscribe, or subscribed to another project", async () => {
    daemon = await startDaemon({ socketPath: uniqueSocketPath() });
    const other = await connect("desktop/other");
    const quiet = await connect("cli/quiet");
    const cli = await connect("cli/test");
    const dir = await project(cli);
    const otherDir = await project(cli);
    await other.request("events.subscribe", { cwd: otherDir, events: ["timeline.changed"] });
    const toOther = collect(other);
    const toQuiet = collect(quiet);

    await cli.request("track.add", { cwd: dir, kind: "video" });
    // A later event on the other project proves earlier ones would have arrived first.
    await cli.request("track.add", { cwd: otherDir, kind: "audio" });
    await toOther.arrived;

    expect(toOther.seen.map((event) => event.project)).toEqual([otherDir]);
    expect(toQuiet.seen).toEqual([]);
  });

  it("stop after events.unsubscribe", async () => {
    daemon = await startDaemon({ socketPath: uniqueSocketPath() });
    const app = await connect("desktop/test");
    const cli = await connect("cli/test");
    const dir = await project(cli);
    const nested = join(dir, "timelines");
    await app.request("events.subscribe", { cwd: nested, events: ["timeline.changed"] });
    await expect(app.request("events.unsubscribe", { cwd: dir, events: ["timeline.changed"] })).resolves.toEqual({
      dir,
      events: [],
    });
    const { seen } = collect(app);

    await cli.request("track.add", { cwd: dir, kind: "video" });
    // Round trip on the same connection: any notification sent before it has been read.
    await app.request("track.list", { cwd: dir });
    expect(seen).toEqual([]);
  });

  it("carry the author `ui` for edits from the app itself", async () => {
    daemon = await startDaemon({ socketPath: uniqueSocketPath() });
    const app = await connect("desktop/test");
    const dir = await project(app);
    await app.request("events.subscribe", { cwd: dir, events: ["timeline.changed"] });
    const { seen, arrived } = collect(app);

    await app.request("track.add", { cwd: dir, kind: "audio" });
    await arrived;
    expect(seen[0]).toMatchObject({ author: "ui", revision: 1 });
  });

  it("are not sent for a refused operation", async () => {
    daemon = await startDaemon({ socketPath: uniqueSocketPath() });
    const app = await connect("desktop/test");
    const dir = await project(app);
    await app.request("events.subscribe", { cwd: dir, events: ["timeline.changed"] });
    const { seen } = collect(app);

    await expect(app.request("track.remove", { cwd: dir, track: "t_nope" })).rejects.toMatchObject({
      code: ErrorCode.TrackNotFound,
    });
    await app.request("track.list", { cwd: dir });
    expect(seen).toEqual([]);
  });

  it("refuses unknown event names and directories outside any project", async () => {
    daemon = await startDaemon({ socketPath: uniqueSocketPath() });
    const session = await rawSession(daemon.socketPath);
    const dir = tempDir();
    const unknown = await session.call("events.subscribe", { cwd: dir, events: ["job.nope"] });
    expect(unknown.error?.code).toBe(ErrorCode.InvalidParams);
    const outside = await session.call("events.subscribe", { cwd: dir, events: ["timeline.changed"] });
    expect(outside.error?.code).toBe(ErrorCode.ProjectNotFound);
    session.close();
  });
});
