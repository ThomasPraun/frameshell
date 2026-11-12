import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AppDirs, type DaemonConnection, ErrorCode, type EventParams, connectToDaemon } from "@frameshell/protocol";
import { CONFIG_JOURNAL, type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// Project-config changes in review mode (ADR 0036 slice 2): an agent's format change waits in its transaction's
// proposal like a timeline change; `desktop/…` connections are the person (`ui`).

let daemon: Daemon | undefined;
const connections: DaemonConnection[] = [];
afterEach(async () => {
  for (const conn of connections.splice(0)) conn.close();
  await daemon?.close();
  daemon = undefined;
});

async function setup() {
  const dirs: AppDirs = { dataDir: tempDir(), configDir: tempDir() };
  const socketPath = uniqueSocketPath();
  daemon = await startDaemon({ socketPath, dirs, idleTimeoutMs: Infinity, txIdleGapMs: 60_000 });
  const connect = async (client: string, session?: string) => {
    const conn = await connectToDaemon(daemon!.socketPath, { client, agent: null, session });
    connections.push(conn);
    return conn;
  };
  let ui = await connect("desktop/test");
  const dir = join(tempDir(), "talk");
  await ui.request("project.init", { dir });
  await ui.request("review.set", { cwd: dir, enabled: true });
  const events: EventParams<"proposal.changed">[] = [];
  await ui.request("events.subscribe", { cwd: dir, events: ["proposal.changed"] });
  ui.on("proposal.changed", (params) => events.push(params));
  const agent = await connect("cli/test", "term-1");
  const configPath = join(dir, "frameshell.json");
  const read = () => readFileSync(configPath, "utf8");
  const journal = () =>
    existsSync(join(dir, CONFIG_JOURNAL))
      ? readFileSync(join(dir, CONFIG_JOURNAL), "utf8")
          .split(/\r?\n/)
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
  const ids = async (conn: DaemonConnection, view?: "current" | "proposal") =>
    (await conn.request("format.list", { cwd: dir, ...(view ? { view } : {}) })).formats.map((format) => format.id);
  const restart = async () => {
    for (const conn of connections.splice(0)) conn.close();
    await daemon!.close();
    daemon = await startDaemon({ socketPath, dirs, idleTimeoutMs: Infinity, txIdleGapMs: 60_000 });
    ui = await connect("desktop/test");
    return ui;
  };
  return { dir, ui: () => ui, agent, connect, read, journal, ids, events, restart, configPath };
}

const NINE_SIXTEEN = { id: "9x16", width: 1080, height: 1920, index: 1 };

describe("format changes in review mode", () => {
  it("holds an agent's format change in its proposal until the person accepts it, then journals and reverts it", async () => {
    const { dir, ui, agent, read, journal, ids, events } = await setup();
    const before = read();
    const begun = await agent.request("tx.begin", { label: "Vertical cut" });
    const added = await agent.request("format.add", { cwd: dir, id: "9x16" });
    expect(added).toMatchObject({ tx: begun.tx, proposal: begun.tx, undo: { method: "format.remove" } });
    expect(added.formats.map((format) => format.id)).toEqual(["16x9", "9x16"]);
    expect(read()).toBe(before);
    expect(journal()).toEqual([]);
    // The author reads its own version; the person, the file, until they look at After.
    expect(await ids(agent)).toEqual(["16x9", "9x16"]);
    expect(await ids(ui())).toEqual(["16x9"]);
    expect(await ids(ui(), "proposal")).toEqual(["16x9", "9x16"]);
    expect((await agent.request("format.list", { cwd: dir })).proposal).toEqual({ tx: begun.tx, state: "building" });

    await agent.request("tx.commit", {});
    const status = await ui().request("proposal.status", { cwd: dir });
    expect(status.proposal).toMatchObject({ tx: begun.tx, state: "ready", operations: 1, timelines: [], config: [{ doc: "project", key: "format:9x16", before: null, after: NINE_SIXTEEN }] });
    expect(await ui().request("proposal.diff", { cwd: dir })).toEqual({
      tx: begun.tx,
      timelines: [],
      config: [{ doc: "project", key: "format:9x16", before: null, after: NINE_SIXTEEN }],
    });
    expect(events.at(-1)).toMatchObject({ state: "ready", config: [{ key: "format:9x16" }] });
    await expect(agent.request("proposal.accept", { cwd: dir, tx: begun.tx })).rejects.toMatchObject({ data: { reason: "forbidden" } });

    const accepted = await ui().request("proposal.accept", { cwd: dir, tx: begun.tx });
    expect(accepted).toMatchObject({ tx: begun.tx, operations: [], config: [{ id: added.op, op: "format.add", tx: begun.tx, author: "cli:term-1", touched: ["format:9x16"] }] });
    expect(journal()).toMatchObject([{ id: added.op, op: "format.add", tx: begun.tx, txLabel: "Vertical cut", proposal: begun.tx, undo: { method: "format.remove" } }]);
    expect(await ids(ui())).toEqual(["16x9", "9x16"]);
    const history = await agent.request("history", { cwd: dir, timeline: "main" });
    expect(history.transactions).toMatchObject([{ tx: begun.tx, operations: [{ id: added.op, doc: "project" }] }]);
    expect(history.proposals).toMatchObject([{ tx: begun.tx, outcome: "accepted", timelines: [], config: ["project"] }]);

    // Reverting it is a change too: in review mode it waits as the agent's next proposal.
    const reverted = await agent.request("revert", { cwd: dir, timeline: "main", target: begun.tx });
    expect(reverted.config).toMatchObject([{ op: "revert", touched: ["format:9x16"] }]);
    expect(await ids(ui())).toEqual(["16x9", "9x16"]);
    const undo = (await ui().request("proposal.status", { cwd: dir })).proposal!;
    expect(undo.config).toMatchObject([{ key: "format:9x16", before: NINE_SIXTEEN, after: null }]);
    await ui().request("proposal.accept", { cwd: dir, tx: undo.tx });
    expect(read()).toBe(before);
  });

  it("makes one proposal of a transaction mixing a timeline and a format change; rejecting it applies neither", async () => {
    const { dir, ui, agent, read, journal } = await setup();
    const timeline = readFileSync(join(dir, "timelines", "main.json"), "utf8");
    const config = read();
    const begun = await agent.request("tx.begin", { label: "Square edit" });
    await agent.request("track.add", { cwd: dir, kind: "video", name: "Square" });
    await agent.request("format.add", { cwd: dir, id: "1x1" });
    await agent.request("tx.commit", {});
    expect((await ui().request("proposal.status", { cwd: dir })).proposal).toMatchObject({ tx: begun.tx, operations: 2, timelines: ["main"], config: [{ key: "format:1x1" }] });
    await ui().request("proposal.reject", { cwd: dir, tx: begun.tx });
    expect([read(), readFileSync(join(dir, "timelines", "main.json"), "utf8"), journal()]).toEqual([config, timeline, []]);
    expect(await agent.request("proposal.wait", { cwd: dir, timeout: 1 })).toMatchObject({ outcome: "rejected", tx: begun.tx });
  });

  it("rebases on the person's change of other formats and goes stale on the same one", async () => {
    const { dir, ui, agent, ids } = await setup();
    const first = await agent.request("tx.begin", { label: "Vertical" });
    await agent.request("format.add", { cwd: dir, id: "9x16" });
    await agent.request("tx.commit", {});
    // The person adds another format meanwhile: no shared key, so the proposal replays on it, at the position it chose.
    await ui().request("format.add", { cwd: dir, id: "1x1" });
    expect((await ui().request("proposal.status", { cwd: dir })).proposal).toMatchObject({ tx: first.tx, state: "ready" });
    expect(await ids(ui(), "proposal")).toEqual(["16x9", "9x16", "1x1"]);
    await ui().request("proposal.accept", { cwd: dir, tx: first.tx });
    expect(await ids(ui())).toEqual(["16x9", "9x16", "1x1"]);

    const second = await agent.request("tx.begin", { label: "Portrait" });
    await agent.request("format.add", { cwd: dir, id: "4x5" });
    await agent.request("tx.commit", {});
    await ui().request("format.add", { cwd: dir, id: "4x5" });
    expect((await ui().request("proposal.status", { cwd: dir })).proposal).toBeNull();
    expect(await agent.request("proposal.wait", { cwd: dir, timeout: 1 })).toMatchObject({ outcome: "stale", tx: second.tx, conflicts: ["format:4x5"] });
    expect(await ids(ui())).toEqual(["16x9", "9x16", "1x1", "4x5"]);
  });

  it("keeps an open format proposal across a daemon restart", async () => {
    const { dir, agent, ids, restart } = await setup();
    const begun = await agent.request("tx.begin", { label: "Vertical" });
    await agent.request("format.add", { cwd: dir, id: "9x16" });
    await agent.request("tx.commit", {});
    const ui = await restart();
    expect((await ui.request("proposal.status", { cwd: dir })).proposal).toMatchObject({ tx: begun.tx, state: "ready", config: [{ key: "format:9x16" }] });
    await ui.request("proposal.accept", { cwd: dir, tx: begun.tx });
    expect(await ids(ui)).toEqual(["16x9", "9x16"]);
  });

  it("proposes the undo of a format change that reached the file before review mode, on tx abort", async () => {
    const { dir, ui, agent, ids } = await setup();
    await ui().request("review.set", { cwd: dir, enabled: false });
    const begun = await agent.request("tx.begin", { label: "Square" });
    await agent.request("format.add", { cwd: dir, id: "1x1" });
    await ui().request("review.set", { cwd: dir, enabled: true });
    const aborted = await agent.request("tx.abort", {});
    expect(aborted).toMatchObject({ tx: begun.tx, reverted: [], config: [], proposal: { state: "ready" } });
    expect(await ids(ui())).toEqual(["16x9", "1x1"]);
    const undo = (await ui().request("proposal.status", { cwd: dir })).proposal!;
    expect(undo).toMatchObject({ tx: aborted.proposal!.tx, label: 'Abort "Square"', config: [{ key: "format:1x1", after: null }] });
    await ui().request("proposal.accept", { cwd: dir, tx: undo.tx });
    expect(await ids(ui())).toEqual(["16x9"]);
  });

  it("drops a building format proposal on tx abort", async () => {
    const { dir, ui, agent, read } = await setup();
    const before = read();
    await agent.request("tx.begin", { label: "Try" });
    await agent.request("format.add", { cwd: dir, id: "9x16" });
    expect(await agent.request("tx.abort", {})).toMatchObject({ reverted: [], config: [], proposal: null });
    expect((await ui().request("proposal.status", { cwd: dir })).proposal).toBeNull();
    expect(read()).toBe(before);
  });
});

describe("file.write of frameshell.json (ADR 0036 decision 5)", () => {
  it("journals a formats change as a file.write operation that revert undoes", async () => {
    const { dir, ui, agent, configPath, read, journal, ids } = await setup();
    await ui().request("review.set", { cwd: dir, enabled: false });
    const before = read();
    const config = JSON.parse(before) as Record<string, unknown>;
    const content = `${JSON.stringify({ ...config, formats: [{ id: "16x9", width: 1920, height: 1080 }, { id: "9x16", width: 1080, height: 1920 }] }, null, 2)}\n`;
    await agent.request("file.write", { path: configPath, content });
    expect(read()).toBe(content);
    const [entry] = journal();
    expect(entry).toMatchObject({ op: "file.write", args: { path: "frameshell.json" }, author: "cli:term-1", patch: [{ key: "format:9x16", before: null }] });
    // A write that leaves formats alone journals nothing.
    await agent.request("file.write", { path: configPath, content: JSON.stringify({ ...(JSON.parse(content) as object), name: "Talk" }) });
    expect(journal()).toHaveLength(1);
    await agent.request("revert", { cwd: dir, timeline: "main", target: entry!.id as string });
    expect(await ids(ui())).toEqual(["16x9"]);
    expect(JSON.parse(read())).toMatchObject({ name: "Talk" });
  });

  it("in review mode holds the formats change and writes the other keys at once", async () => {
    const { dir, ui, agent, configPath, read, journal, ids } = await setup();
    const config = JSON.parse(read()) as Record<string, unknown>;
    const content = JSON.stringify({ ...config, name: "Talk", formats: [{ id: "16x9", width: 1920, height: 1080 }, { id: "1x1", width: 1080, height: 1080 }] });
    await agent.request("tx.begin", { label: "Square" });
    await agent.request("file.write", { path: configPath, content });
    await agent.request("tx.commit", {});
    expect(JSON.parse(read())).toMatchObject({ name: "Talk" });
    expect(JSON.parse(read())).not.toHaveProperty("formats");
    expect(journal()).toEqual([]);
    const proposal = (await ui().request("proposal.status", { cwd: dir })).proposal!;
    expect(proposal.config).toMatchObject([{ key: "format:1x1", before: null }]);
    await ui().request("proposal.accept", { cwd: dir, tx: proposal.tx });
    expect(await ids(ui())).toEqual(["16x9", "1x1"]);
    expect(journal()).toMatchObject([{ op: "file.write", proposal: proposal.tx }]);
  });

  it("refuses an agent's style.json write in review mode, and takes the person's", async () => {
    const { dir, ui, agent } = await setup();
    const path = join(dir, "style.json");
    const content = `${JSON.stringify({ schemaVersion: 1 })}\n`;
    await expect(agent.request("file.write", { path, content })).rejects.toMatchObject({ code: ErrorCode.ProposalState, data: { reason: "forbidden" } });
    expect(existsSync(path)).toBe(false);
    await ui().request("file.write", { path, content });
    expect(readFileSync(path, "utf8")).toBe(content);
  });
});
