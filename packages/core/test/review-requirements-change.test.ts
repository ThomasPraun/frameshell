import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AppDirs, type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { parseRequirementsFile } from "@frameshell/schema";
import { CONFIG_JOURNAL, type Daemon, requirementsState, requirementsWritten, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// `requirements.json` as a config document (ADR 0036): `review.require`, `review.waive`, `file.write` and hand
// edits all go through the config journal, so history, revert, tx abort and review mode hold them.

let daemon: Daemon | undefined;
const connections: DaemonConnection[] = [];
afterEach(async () => {
  for (const conn of connections.splice(0)) conn.close();
  await daemon?.close();
  daemon = undefined;
});

async function setup(options: { review?: boolean } = {}) {
  const dirs: AppDirs = { dataDir: tempDir(), configDir: tempDir() };
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs, idleTimeoutMs: Infinity, txIdleGapMs: 60_000 });
  const connect = async (client: string, session?: string) => {
    const conn = await connectToDaemon(daemon!.socketPath, { client, agent: null, session });
    connections.push(conn);
    return conn;
  };
  const ui = await connect("desktop/test");
  const agent = await connect("cli/test", "term-1");
  const dir = join(tempDir(), "promo");
  await ui.request("project.init", { dir });
  if (options.review) await ui.request("review.set", { cwd: dir, enabled: true });
  const path = join(dir, "requirements.json");
  const file = () => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const journal = () =>
    existsSync(join(dir, CONFIG_JOURNAL))
      ? readFileSync(join(dir, CONFIG_JOURNAL), "utf8")
          .split(/\r?\n/)
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
  return { dir, path, file, journal, ui, agent };
}

/** Wait until `check` holds; the watcher reports a write after it settled. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; ) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const parsed = (raw: unknown) => {
  const result = parseRequirementsFile(raw);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

describe("requirements document", () => {
  it("keys film values, caption size, the fail list, each assertion of a clip and each waiver", () => {
    const raw = {
      schemaVersion: 1,
      film: { maxSeconds: 30, endCard: { minSeconds: 2 } },
      captions: { minSize: 0.03 },
      clips: [
        { clip: "c_title", appearsBy: 1, staysInFrame: true },
        { clip: "c_title", appearsBy: 2 },
      ],
      fail: ["static"],
      waivers: [
        { check: "static", reason: "a held title" },
        { check: "static", reason: "a second reason" },
        { check: "reading", clip: "c_title", reason: "one word" },
      ],
    };
    expect(requirementsState(parsed(raw))).toEqual({
      "requirements:film.maxSeconds": 30,
      "requirements:film.endCard": { minSeconds: 2 },
      "requirements:captions.minSize": 0.03,
      "requirements:fail": ["static"],
      // A repeated clip reads as its last value, a repeated waiver as its first, as `review` judges them.
      "requirements:clip:c_title.appearsBy": 2,
      "requirements:clip:c_title.staysInFrame": true,
      "requirements:waiver:static": "a held title",
      "requirements:waiver:reading:c_title": "one word",
    });
  });

  it("writes only the keys that changed and keeps the rest of the file as written", () => {
    const raw = { $schema: "x", schemaVersion: 1, film: { maxSeconds: 30 }, clips: [{ clip: "c_a", before: "c_b" }], waivers: [{ check: "static", reason: "held" }] };
    const { "requirements:waiver:static": _removed, ...kept } = requirementsState(parsed(raw));
    const state = { ...kept, "requirements:clip:c_a.staysInFrame": { margin: 0.05 }, "requirements:film.minSeconds": 10 };
    expect(requirementsWritten(raw, state)).toEqual({
      $schema: "x",
      schemaVersion: 1,
      film: { maxSeconds: 30, minSeconds: 10 },
      clips: [{ clip: "c_a", before: "c_b", staysInFrame: { margin: 0.05 } }],
    });
    expect(requirementsWritten(raw, {})).toBeNull();
  });

  it("loads a file written before staysInFrame and journaled writes, and leaves it untouched", () => {
    const old = { schemaVersion: 1, film: { maxStatic: 2 }, clips: [{ clip: "c_a", keepsMoving: { maxStatic: 1 } }], fail: ["reading"], waivers: [] };
    const state = requirementsState(parsed(old));
    expect(state).toEqual({ "requirements:film.maxStatic": 2, "requirements:clip:c_a.keepsMoving": { maxStatic: 1 }, "requirements:fail": ["reading"] });
    expect(requirementsWritten(old, state)).toEqual(old);
  });
});

describe("review.require and review.waive", () => {
  it("creates requirements.json, journals each change, lists it in history, and revert takes it back", async () => {
    const { dir, file, path, journal, agent } = await setup();
    const set = await agent.request("review.require", { cwd: dir, path: "film.maxSeconds", value: 30 });
    expect(set).toMatchObject({ path: "requirements.json", changes: [{ key: "film.maxSeconds", before: null, after: 30 }], proposal: null });
    expect(file()).toEqual({ $schema: "https://frameshell.dev/schema/v1/requirements.json", schemaVersion: 1, film: { maxSeconds: 30 } });
    const framed = await agent.request("review.require", { cwd: dir, clip: "c_title", path: "staysInFrame", value: { margin: 0.05 } });
    expect(framed.changes).toEqual([{ key: "clip:c_title.staysInFrame", before: null, after: { margin: 0.05 } }]);
    const waived = await agent.request("review.waive", { cwd: dir, check: "static", reason: "the end card holds on purpose" });
    expect(waived.changes).toEqual([{ key: "waiver:static", before: null, after: "the end card holds on purpose" }]);
    expect(file()).toMatchObject({ clips: [{ clip: "c_title", staysInFrame: { margin: 0.05 } }], waivers: [{ check: "static", reason: "the end card holds on purpose" }] });
    expect(journal()).toMatchObject([
      { id: set.op, op: "review.require", doc: "requirements", patch: [{ key: "requirements:film.maxSeconds", before: null, after: 30 }], undo: { method: "review.require", params: { path: "film.maxSeconds", value: null } } },
      { id: framed.op, op: "review.require", args: { clip: "c_title", path: "staysInFrame" } },
      { id: waived.op, op: "review.waive", undo: { method: "review.waive", params: { check: "static", reason: null } } },
    ]);
    const history = await agent.request("history", { cwd: dir, timeline: "main" });
    expect(history.transactions.flatMap((tx) => tx.operations)).toMatchObject([
      { id: set.op, doc: "requirements", touched: ["requirements:film.maxSeconds"] },
      { id: framed.op, doc: "requirements" },
      { id: waived.op, doc: "requirements" },
    ]);

    await agent.request("revert", { cwd: dir, timeline: "main", target: framed.op });
    expect(file()).toEqual({ $schema: "https://frameshell.dev/schema/v1/requirements.json", schemaVersion: 1, film: { maxSeconds: 30 }, waivers: [{ check: "static", reason: "the end card holds on purpose" }] });
    await agent.request("review.waive", { cwd: dir, check: "static", reason: null });
    await agent.request("revert", { cwd: dir, timeline: "main", target: set.op });
    // The state is empty again: no file.
    expect(existsSync(path)).toBe(false);
  });

  it("tx abort undoes the requirements of the transaction", async () => {
    const { dir, path, agent } = await setup();
    await agent.request("tx.begin", { label: "Brief" });
    await agent.request("review.require", { cwd: dir, path: "fail", value: ["static", "reading"] });
    await agent.request("review.require", { cwd: dir, path: "captions.minSize", value: 0.026 });
    expect(existsSync(path)).toBe(true);
    const aborted = await agent.request("tx.abort", {});
    expect(aborted.config?.length).toBeGreaterThan(0);
    expect(existsSync(path)).toBe(false);
  });

  it("refuses an unknown path and an invalid value with the schema's message, changing nothing", async () => {
    const { dir, path, agent } = await setup();
    await expect(agent.request("review.require", { cwd: dir, path: "film.length", value: 3 })).rejects.toMatchObject({ code: ErrorCode.InvalidOperation, data: { reason: "path" } });
    await expect(agent.request("review.require", { cwd: dir, clip: "c_a", path: "film.maxSeconds", value: 3 })).rejects.toMatchObject({ data: { reason: "path" } });
    await expect(agent.request("review.require", { cwd: dir, clip: "c_a", path: "staysInFrame", value: { margin: 2 } })).rejects.toMatchObject({ code: ErrorCode.InvalidOperation, data: { reason: "value" } });
    expect(existsSync(path)).toBe(false);
  });

  it("journals a file.write of requirements.json and a hand edit of it as config operations", async () => {
    const { dir, path, journal, agent, file } = await setup();
    await agent.request("file.write", { path, content: JSON.stringify({ schemaVersion: 1, film: { maxSeconds: 20 } }) });
    expect(journal()).toMatchObject([{ op: "file.write", doc: "requirements", args: { path: "requirements.json" }, patch: [{ key: "requirements:film.maxSeconds", before: null, after: 20 }] }]);
    const head = join(dir, ".frameshell", "history", "project.config.requirements.head.json");
    await until(() => existsSync(head), "the head of requirements.json");
    writeFileSync(path, `${JSON.stringify({ ...file(), clips: [{ clip: "c_a", staysInFrame: true }] }, null, 2)}\n`);
    await until(() => journal().length === 2, "the journaled hand edit");
    expect(journal()[1]).toMatchObject({ op: "file.edit", author: "file", doc: "requirements", patch: [{ key: "requirements:clip:c_a.staysInFrame", before: null, after: true }] });
  });
});

describe("requirements in review mode", () => {
  it("holds an agent's requirement in its proposal until the person accepts it", async () => {
    const { dir, path, journal, ui, agent, file } = await setup({ review: true });
    const begun = await agent.request("tx.begin", { label: "Brief" });
    const set = await agent.request("review.require", { cwd: dir, clip: "c_title", path: "staysInFrame", value: true });
    expect(set).toMatchObject({ proposal: begun.tx, changes: [{ key: "clip:c_title.staysInFrame", after: true }] });
    expect(existsSync(path)).toBe(false);
    expect(journal()).toEqual([]);
    await agent.request("tx.commit", {});
    const status = await ui.request("proposal.status", { cwd: dir });
    expect(status.proposal).toMatchObject({ tx: begun.tx, state: "ready", config: [{ doc: "requirements", key: "requirements:clip:c_title.staysInFrame", before: null, after: true }] });

    await ui.request("proposal.accept", { cwd: dir, tx: begun.tx });
    expect(file()).toMatchObject({ clips: [{ clip: "c_title", staysInFrame: true }] });
    expect(journal()).toMatchObject([{ id: set.op, op: "review.require", doc: "requirements", proposal: begun.tx }]);
  });
});
