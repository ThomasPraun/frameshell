import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AppDirs, type DaemonConnection, connectToDaemon } from "@frameshell/protocol";
import { CONFIG_JOURNAL, type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// Hand edits of frameshell.json formats and of style.json (ADR 0036 slice 5): the daemon's watcher turns them into
// config operations of author `file`, journaled at once or held by review mode. The edit is a plain write to the file.

let daemon: Daemon | undefined;
const connections: DaemonConnection[] = [];
afterEach(async () => {
  for (const conn of connections.splice(0)) conn.close();
  await daemon?.close();
  daemon = undefined;
});

const WIDE = { id: "16x9", width: 1920, height: 1080 };
const VERTICAL = { id: "9x16", width: 1080, height: 1920 };

async function setup() {
  const dirs: AppDirs = { dataDir: tempDir(), configDir: tempDir() };
  const socketPath = uniqueSocketPath();
  const start = () => startDaemon({ socketPath, dirs, idleTimeoutMs: Infinity, txIdleGapMs: 60_000 });
  daemon = await start();
  const connect = async (client: string, session?: string) => {
    const conn = await connectToDaemon(daemon!.socketPath, { client, agent: null, session });
    connections.push(conn);
    return conn;
  };
  let ui = await connect("desktop/test");
  const dir = join(tempDir(), "talk");
  await ui.request("project.init", { dir });
  const heads = ["project", "style"].map((doc) => join(dir, ".frameshell", "history", `project.config.${doc}.head.json`));
  /** Wait until the watcher has seen both documents once: an edit then has a state to be diffed against. */
  const watching = () => until(() => heads.every((head) => existsSync(head)), "the first sight");
  await watching();
  const configPath = join(dir, "frameshell.json");
  const stylePath = join(dir, "style.json");
  const readConfig = () => JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const withFormats = (formats: unknown[]) => writeFileSync(configPath, `${JSON.stringify({ ...readConfig(), formats }, null, 2)}\n`);
  const journal = () =>
    existsSync(join(dir, CONFIG_JOURNAL))
      ? readFileSync(join(dir, CONFIG_JOURNAL), "utf8")
          .split(/\r?\n/)
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
  const ids = async (conn: DaemonConnection, view?: "current" | "proposal") =>
    (await conn.request("format.list", { cwd: dir, ...(view ? { view } : {}) })).formats.map((format) => format.id);
  const restart = async (between?: () => void) => {
    for (const conn of connections.splice(0)) conn.close();
    await daemon!.close();
    between?.();
    daemon = await start();
    ui = await connect("desktop/test");
    await ui.request("format.list", { cwd: dir });
    return ui;
  };
  return { dir, ui: () => ui, connect, watching, configPath, stylePath, readConfig, withFormats, journal, ids, restart };
}

/** Wait until `check` holds; the watcher reports a write after it settled. */
async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; ) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("hand edits of config files, review mode off", () => {
  it("journals an edit of formats as a file.edit operation by `file`, left in the file, that revert undoes", async () => {
    const { dir, ui, withFormats, readConfig, journal, ids } = await setup();
    withFormats([WIDE, VERTICAL]);
    await until(() => journal().length === 1, "the journaled edit");
    const [entry] = journal();
    expect(entry).toMatchObject({ op: "file.edit", args: { path: "frameshell.json" }, author: "file", doc: "project", patch: [{ key: "format:9x16", before: null }] });
    expect(readConfig()["formats"]).toEqual([WIDE, VERTICAL]);
    const history = await ui().request("history", { cwd: dir, timeline: "main" });
    expect(history.transactions).toMatchObject([{ tx: entry!["tx"], operations: [{ id: entry!["id"], op: "file.edit", doc: "project", author: "file" }] }]);

    await ui().request("revert", { cwd: dir, timeline: "main", target: entry!["id"] as string });
    expect(await ids(ui())).toEqual(["16x9"]);
    // The revert's own write is no edit.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(journal()).toHaveLength(2);
  });

  it("journals a new style.json by value, and leaves the daemon's own writes and other keys alone", async () => {
    const { dir, ui, stylePath, configPath, readConfig, journal } = await setup();
    writeFileSync(stylePath, `${JSON.stringify({ schemaVersion: 1, platforms: ["instagram-reels"] })}\n`);
    await until(() => journal().length === 1, "the journaled style edit");
    expect(journal()[0]).toMatchObject({ op: "file.edit", args: { path: "style.json" }, author: "file", doc: "style", patch: [{ key: "style:platforms", before: null, after: ["instagram-reels"] }] });

    await ui().request("style.set", { cwd: dir, path: "platforms", value: ["tiktok"] });
    expect(journal()).toHaveLength(2);
    // A key no config document covers changes no state.
    writeFileSync(configPath, `${JSON.stringify({ ...readConfig(), name: "Talk" }, null, 2)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(journal()).toHaveLength(2);
  });

  it("ignores a file that does not validate until its next valid edit", async () => {
    const { stylePath, journal } = await setup();
    writeFileSync(stylePath, "{ not json");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(journal()).toEqual([]);
    writeFileSync(stylePath, `${JSON.stringify({ schemaVersion: 1, platforms: ["tiktok"] })}\n`);
    await until(() => journal().length === 1, "the journaled edit");
    expect(journal()[0]).toMatchObject({ doc: "style", patch: [{ key: "style:platforms" }] });
  });

  it("catches up an edit made while no daemon ran", async () => {
    const { dir, ui, restart, configPath, readConfig, journal } = await setup();
    await ui().request("format.add", { cwd: dir, id: "1x1" });
    const restarted = await restart(() => writeFileSync(configPath, `${JSON.stringify({ ...readConfig(), formats: [WIDE, { id: "1x1", width: 1080, height: 1080 }, VERTICAL] }, null, 2)}\n`));
    await restarted.request("format.list", { cwd: dir });
    await until(() => journal().length === 2, "the catch-up");
    expect(journal()[1]).toMatchObject({ op: "file.edit", author: "file", patch: [{ key: "format:9x16", before: null }] });
  });
});

describe("hand edits of config files in review mode", () => {
  it("holds a formats edit in a proposal of `file`, puts the formats back, and applies it on accept", async () => {
    const { dir, ui, withFormats, readConfig, journal, ids } = await setup();
    await ui().request("review.set", { cwd: dir, enabled: true });
    withFormats([WIDE, VERTICAL]);
    await until(async () => (await ui().request("proposal.status", { cwd: dir })).proposal !== null, "the proposal");
    const proposal = (await ui().request("proposal.status", { cwd: dir })).proposal!;
    expect(proposal).toMatchObject({ state: "ready", author: "file", config: [{ doc: "project", key: "format:9x16", before: null }] });
    await until(() => readConfig()["formats"] === undefined, "the formats put back");
    expect(journal()).toEqual([]);
    expect(await ids(ui(), "proposal")).toEqual(["16x9", "9x16"]);

    await ui().request("proposal.accept", { cwd: dir, tx: proposal.tx });
    expect(await ids(ui())).toEqual(["16x9", "9x16"]);
    expect(journal()).toMatchObject([{ op: "file.edit", author: "file", proposal: proposal.tx }]);
  });

  it("holds a style edit; rejecting puts the file as it was", async () => {
    const { dir, ui, stylePath, journal } = await setup();
    const original = `${JSON.stringify({ schemaVersion: 1, platforms: ["tiktok"] })}\n`;
    writeFileSync(stylePath, original);
    await until(() => journal().length === 1, "the first style edit");
    await ui().request("review.set", { cwd: dir, enabled: true });
    writeFileSync(stylePath, `${JSON.stringify({ schemaVersion: 1, platforms: ["tiktok", "youtube-shorts"] })}\n`);
    await until(async () => (await ui().request("proposal.status", { cwd: dir })).proposal !== null, "the proposal");
    const proposal = (await ui().request("proposal.status", { cwd: dir })).proposal!;
    expect(proposal.config).toMatchObject([{ doc: "style", key: "style:platforms", after: ["tiktok", "youtube-shorts"] }]);
    await until(() => (JSON.parse(readFileSync(stylePath, "utf8")) as { platforms: string[] }).platforms.length === 1, "the style put back");
    await ui().request("proposal.reject", { cwd: dir, tx: proposal.tx });
    expect(JSON.parse(readFileSync(stylePath, "utf8"))).toMatchObject({ platforms: ["tiktok"] });
    expect(journal()).toHaveLength(1);
  });

  it("does not take in an edit while another proposal is open: it goes back and a copy is kept under .frameshell/rejected", async () => {
    const { dir, ui, connect, withFormats, readConfig, ids } = await setup();
    await ui().request("review.set", { cwd: dir, enabled: true });
    const agent = await connect("cli/test", "term-1");
    await agent.request("tx.begin", { label: "Square" });
    await agent.request("format.add", { cwd: dir, id: "1x1" });
    await agent.request("tx.commit", {});
    withFormats([WIDE, VERTICAL]);
    await until(() => readConfig()["formats"] === undefined, "the formats put back");
    const kept = () => (existsSync(join(dir, ".frameshell", "rejected")) ? readdirSync(join(dir, ".frameshell", "rejected")) : []);
    await until(() => kept().some((name) => name.endsWith("-frameshell.json")), "the kept copy");
    expect(await ids(ui())).toEqual(["16x9"]);
    expect(JSON.parse(readFileSync(join(dir, ".frameshell", "rejected", kept()[0]!), "utf8"))).toMatchObject({ formats: [WIDE, VERTICAL] });
  });
});
