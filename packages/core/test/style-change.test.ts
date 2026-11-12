import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AppDirs, type DaemonConnection, ErrorCode, type RpcError, connectToDaemon } from "@frameshell/protocol";
import { STYLE_PATHS } from "@frameshell/schema";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_JOURNAL, type Daemon, startDaemon, styleState, styleWritten } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// Seam under test: `style.set`, `style.apply`, `style.save`, `style.list` and `file.write` of style.json over the
// daemon socket (ADR 0028, ADR 0036): every change of style.json goes through the config journal.

let daemon: Daemon | undefined;
const connections: DaemonConnection[] = [];
afterEach(async () => {
  for (const conn of connections.splice(0)) conn.close();
  await daemon?.close();
  daemon = undefined;
});

async function setup() {
  const dirs: AppDirs = { dataDir: tempDir(), configDir: tempDir() };
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs, idleTimeoutMs: Infinity, txIdleGapMs: 60_000 });
  const connect = async (client: string, session?: string) => {
    const conn = await connectToDaemon(daemon!.socketPath, { client, agent: null, session });
    connections.push(conn);
    return conn;
  };
  const ui = await connect("desktop/test");
  const agent = await connect("cli/test", "term-1");
  const project = async (name: string) => {
    const dir = join(tempDir(), name);
    await ui.request("project.init", { dir });
    return dir;
  };
  const dir = await project("promo");
  const path = join(dir, "style.json");
  const file = () => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const journal = () =>
    existsSync(join(dir, CONFIG_JOURNAL))
      ? readFileSync(join(dir, CONFIG_JOURNAL), "utf8")
          .split(/\r?\n/)
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
  return { dirs, dir, path, file, journal, ui, agent, project, connect };
}

async function failure(call: Promise<unknown>): Promise<RpcError> {
  try {
    await call;
  } catch (error) {
    return error as RpcError;
  }
  throw new Error("expected the request to fail");
}

describe("style document", () => {
  it("keys every value by its path and writes only what changed", () => {
    expect(STYLE_PATHS).toContain("colors.accent");
    expect(STYLE_PATHS).toContain("motion.duration.quick");
    expect(STYLE_PATHS).toContain("fonts.display");
    expect(STYLE_PATHS).not.toContain("fonts.display.family");
    const raw = { $schema: "x", schemaVersion: 1, colors: { accent: "#ff3300", ink: null }, type: { hero: 220 } };
    expect(styleState(raw as never)).toEqual({ "style:colors.accent": "#ff3300", "style:type.hero": 220 });
    const next = styleWritten(raw, { "style:colors.accent": "#ff3300", "style:motion.personality": "calm" });
    // `$schema` and an explicit null stay; `type` emptied by the removal goes.
    expect(next).toEqual({ $schema: "x", schemaVersion: 1, colors: { accent: "#ff3300", ink: null }, motion: { personality: "calm" } });
    expect(styleWritten(raw, {})).toBeNull();
  });
});

describe("style.set", () => {
  it("creates style.json, journals the change, and revert removes the file again", async () => {
    const { dir, path, file, journal, agent } = await setup();
    const set = await agent.request("style.set", { cwd: dir, path: "colors.accent", value: "#FF5500" });
    expect(set).toMatchObject({ path: "style.json", changes: [{ path: "colors.accent", before: null, after: "#FF5500" }], proposal: null });
    expect(file()).toEqual({ $schema: "https://frameshell.dev/schema/v1/style.json", schemaVersion: 1, colors: { accent: "#FF5500" } });
    expect(journal()).toMatchObject([
      { id: set.op, op: "style.set", doc: "style", patch: [{ key: "style:colors.accent", before: null, after: "#FF5500" }], undo: { method: "style.set", params: { path: "colors.accent", value: null } } },
    ]);
    expect((await agent.request("style.show", { cwd: dir })).style?.colors.accent).toEqual({ value: "#FF5500", source: "file" });
    const history = await agent.request("history", { cwd: dir });
    expect(history.transactions.flatMap((tx) => tx.operations)).toMatchObject([{ id: set.op, doc: "style", touched: ["style:colors.accent"] }]);

    await agent.request("style.set", { cwd: dir, path: "type.hero", value: 240 });
    await agent.request("style.set", { cwd: dir, path: "type.hero", value: null });
    expect(file()).toEqual({ $schema: "https://frameshell.dev/schema/v1/style.json", schemaVersion: 1, colors: { accent: "#FF5500" } });

    await agent.request("revert", { cwd: dir, target: set.op });
    expect(existsSync(path)).toBe(false);
  });

  it("keeps the rest of a hand-written file and refuses unknown paths and invalid values", async () => {
    const { dir, path, file, journal, agent } = await setup();
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, notes: ["warm"], colors: { bg: "#000000" } }));
    await agent.request("style.set", { cwd: dir, path: "fonts.display", value: { family: "Archivo Black", weight: 900 } });
    expect(file()).toEqual({ schemaVersion: 1, notes: ["warm"], colors: { bg: "#000000" }, fonts: { display: { family: "Archivo Black", weight: 900 } } });

    const unknown = await failure(agent.request("style.set", { cwd: dir, path: "colors", value: "#000000" }));
    expect(unknown).toMatchObject({ code: ErrorCode.InvalidOperation, data: { reason: "path" } });
    const invalid = await failure(agent.request("style.set", { cwd: dir, path: "motion.duration.quick", value: 200 }));
    expect(invalid).toMatchObject({ code: ErrorCode.InvalidOperation, data: { reason: "value" } });
    expect(invalid.message).toContain("milliseconds");
    expect(journal()).toHaveLength(1);
  });
});

describe("user styles", () => {
  it("saves a project's style, lists it, and applies it to another project value by value or whole", async () => {
    const { dirs, dir, path, agent, project } = await setup();
    await agent.request("style.set", { cwd: dir, path: "colors.accent", value: "#ff5500" });
    await agent.request("style.set", { cwd: dir, path: "motion.personality", value: "premium" });
    const saved = await agent.request("style.save", { cwd: dir, name: "acme" });
    expect(saved).toMatchObject({ id: "acme", path: join(dirs.configDir, "styles", "acme.json"), replaced: false });
    expect(JSON.parse(readFileSync(saved.path, "utf8"))).toEqual(JSON.parse(readFileSync(path, "utf8")));
    expect(await agent.request("style.list", {})).toEqual({
      dir: join(dirs.configDir, "styles"),
      styles: [{ id: "acme", sha256: saved.sha256, personality: "premium", error: null }],
      personalities: ["playful", "premium", "corporate", "energetic", "calm"],
    });
    expect(await failure(agent.request("style.save", { cwd: dir, name: "acme" }))).toMatchObject({ data: { reason: "exists" } });
    expect(await failure(agent.request("style.save", { cwd: dir, name: "calm" }))).toMatchObject({ data: { reason: "personality" } });

    const other = await project("launch");
    await agent.request("style.set", { cwd: other, path: "colors.accent", value: "#00ff00" });
    await agent.request("style.set", { cwd: other, path: "type.hero", value: 180 });
    const merged = await agent.request("style.apply", { cwd: other, name: "acme" });
    expect(merged.changes).toEqual([
      { path: "from", before: null, after: { id: "acme", sha256: saved.sha256 } },
      { path: "colors.accent", before: "#00ff00", after: "#ff5500" },
      { path: "motion.personality", before: null, after: "premium" },
    ]);
    const shown = await agent.request("style.show", { cwd: other });
    expect(shown.style?.type.hero).toEqual({ value: 180, source: "file" });
    expect(shown.from).toEqual({ id: "acme", sha256: saved.sha256, status: "same" });

    // An edited user style reaches no project until applied again.
    writeFileSync(saved.path, JSON.stringify({ schemaVersion: 1, colors: { accent: "#123456" } }));
    expect((await agent.request("style.show", { cwd: other })).from?.status).toBe("changed");
    const replaced = await agent.request("style.apply", { cwd: other, name: "acme", replace: true });
    expect(replaced.changes.map((change) => change.path)).toEqual(["from", "colors.accent", "type.hero", "motion.personality"]);
    expect(JSON.parse(readFileSync(join(other, "style.json"), "utf8"))).toMatchObject({ colors: { accent: "#123456" } });
    expect(JSON.parse(readFileSync(join(other, "style.json"), "utf8"))).not.toHaveProperty("type");

    // A personality sets only the motion personality.
    const calm = await agent.request("style.apply", { cwd: other, name: "calm" });
    expect(calm.changes).toEqual([{ path: "motion.personality", before: null, after: "calm" }]);
    const missing = await failure(agent.request("style.apply", { cwd: other, name: "nope" }));
    expect(missing).toMatchObject({ code: ErrorCode.InvalidOperation, data: { reason: "not found", available: ["acme"] } });
  });

  it("refuses to apply an invalid user style", async () => {
    const { dirs, dir, agent } = await setup();
    mkdirSync(join(dirs.configDir, "styles"), { recursive: true });
    writeFileSync(join(dirs.configDir, "styles", "broken.json"), JSON.stringify({ schemaVersion: 1, colors: { accent: "red" } }));
    expect((await agent.request("style.list", {})).styles[0]).toMatchObject({ id: "broken", error: expect.stringContaining("colors.accent") });
    expect(await failure(agent.request("style.apply", { cwd: dir, name: "broken" }))).toMatchObject({ code: ErrorCode.InvalidGlobalConfig });
  });
});

describe("file.write of style.json", () => {
  it("journals a write that changes a value as file.write, and one that changes none not at all", async () => {
    const { path, journal, agent } = await setup();
    const content = `${JSON.stringify({ schemaVersion: 1, colors: { accent: "#ff5500" } }, null, 4)}\n`;
    await agent.request("file.write", { path, content });
    expect(readFileSync(path, "utf8")).toBe(content);
    expect(journal()).toMatchObject([{ op: "file.write", doc: "style", args: { path: "style.json" }, patch: [{ key: "style:colors.accent" }] }]);
    await agent.request("file.write", { path, content: JSON.stringify({ colors: { accent: "#ff5500" }, schemaVersion: 1 }) });
    expect(journal()).toHaveLength(1);
  });
});

describe("style changes in review mode", () => {
  it("hold an agent's style.set, style.apply and style.json write in its proposal until the person accepts", async () => {
    const { dir, path, journal, ui, agent } = await setup();
    await ui.request("review.set", { cwd: dir, enabled: true });
    const begun = await agent.request("tx.begin", { label: "House style" });
    const set = await agent.request("style.set", { cwd: dir, path: "colors.accent", value: "#ff5500" });
    expect(set).toMatchObject({ tx: begun.tx, proposal: begun.tx });
    const applied = await agent.request("style.apply", { cwd: dir, name: "energetic" });
    expect(applied.changes).toEqual([{ path: "motion.personality", before: null, after: "energetic" }]);
    await agent.request("file.write", { path, content: JSON.stringify({ schemaVersion: 1, colors: { accent: "#ff5500" }, banned: ["emoji"] }) });
    expect(existsSync(path)).toBe(false);
    expect(journal()).toEqual([]);
    // The author reads its own version; the person, the file, until they look at After.
    expect((await agent.request("style.show", { cwd: dir })).style?.colors.accent.value).toBe("#ff5500");
    expect((await ui.request("style.show", { cwd: dir })).style).toBeNull();
    const after = await ui.request("style.show", { cwd: dir, view: "proposal" });
    expect(after.style?.motion.personality.value).toBe("energetic");
    expect(after.style?.banned.value).toEqual(["emoji"]);

    await agent.request("tx.commit", {});
    const proposal = (await ui.request("proposal.status", { cwd: dir })).proposal!;
    expect(proposal.config.map((change) => change.key).sort()).toEqual(["style:banned", "style:colors.accent", "style:motion.personality"]);
    await ui.request("proposal.accept", { cwd: dir, tx: proposal.tx });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ colors: { accent: "#ff5500" }, motion: { personality: "energetic" }, banned: ["emoji"] });
    expect(journal().map((entry) => entry.op)).toEqual(["style.set", "style.apply", "file.write"]);

    // The person's own change applies at once.
    await ui.request("style.set", { cwd: dir, path: "colors.accent", value: "#000000" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ colors: { accent: "#000000" } });
  });
});
