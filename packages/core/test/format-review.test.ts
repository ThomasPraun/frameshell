import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AppDirs, type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, FORMAT_JOURNAL, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// Format changes (ADR 0027) are not history operations or proposals yet: `revert` names their undo call, and review
// mode leaves them to the person in the app (`desktop/…` = `ui`; `cli/test` = an agent).

let daemon: Daemon | undefined;
const connections: DaemonConnection[] = [];
afterEach(async () => {
  for (const conn of connections.splice(0)) conn.close();
  await daemon?.close();
  daemon = undefined;
});

async function setup() {
  const dirs: AppDirs = { dataDir: tempDir(), configDir: tempDir() };
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs, idleTimeoutMs: Infinity });
  const connect = async (client: string) => {
    const conn = await connectToDaemon(daemon!.socketPath, { client, agent: null });
    connections.push(conn);
    return conn;
  };
  const ui = await connect("desktop/test");
  const agent = await connect("cli/test");
  const dir = join(tempDir(), "talk");
  await ui.request("project.init", { dir });
  return { dir, ui, agent };
}

describe("format changes outside history and review", () => {
  it("refuses revert of a format change's op id and names its undo call", async () => {
    const { dir, agent } = await setup();
    const added = await agent.request("format.add", { cwd: dir, id: "9x16" });
    const journal = readFileSync(join(dir, FORMAT_JOURNAL), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(journal).toMatchObject([{ id: added.op, undo: { method: "format.remove", params: { id: "9x16" } } }]);
    await expect(agent.request("revert", { cwd: dir, timeline: "main", target: added.op })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining("`frameshell format remove 9x16`"),
      data: { op: "revert", reason: "format change", field: "target" },
    });
    const removed = await agent.request("format.remove", { cwd: dir, id: "9x16" });
    await expect(agent.request("revert", { cwd: dir, timeline: "main", target: removed.op })).rejects.toMatchObject({
      message: expect.stringContaining("`frameshell format add 9x16 --size 1080x1920 --index 1`"),
    });
  });

  it("leaves format changes to the person while review mode is on", async () => {
    const { dir, ui, agent } = await setup();
    await agent.request("format.add", { cwd: dir, id: "1x1" });
    await ui.request("review.set", { cwd: dir, enabled: true });
    const before = readFileSync(join(dir, "frameshell.json"), "utf8");
    for (const call of [agent.request("format.add", { cwd: dir, id: "9x16" }), agent.request("format.remove", { cwd: dir, id: "1x1" })]) {
      await expect(call).rejects.toMatchObject({ code: ErrorCode.ProposalState, data: { tx: null, reason: "forbidden" } });
    }
    expect(readFileSync(join(dir, "frameshell.json"), "utf8")).toBe(before);
    expect((await ui.request("format.add", { cwd: dir, id: "9x16" })).formats.map((format) => format.id)).toEqual(["16x9", "1x1", "9x16"]);
    await ui.request("review.set", { cwd: dir, enabled: false });
    expect((await agent.request("format.remove", { cwd: dir, id: "9x16" })).formats.map((format) => format.id)).toEqual(["16x9", "1x1"]);
  });
});
