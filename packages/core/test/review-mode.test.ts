import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AppDirs,
  type DaemonConnection,
  ErrorCode,
  type EventParams,
  RpcError,
  connectToDaemon,
} from "@frameshell/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// Seam under test: the daemon over its socket (ADR 0019). `desktop/…` is the person in the app (`ui`); `cli/test`
// connections are agents: without a session each change is its own transaction (a proposal ready at once), with a
// session `tx begin`/`commit` groups them. Operations are track edits, which need no media; outcomes are read from
// disk, `history`, `status`, `proposal.*` and `proposal.changed`.

const GAP_MS = 60_000;

let daemon: Daemon | undefined;
const connections: DaemonConnection[] = [];
afterEach(async () => {
  for (const conn of connections.splice(0)) conn.close();
  await daemon?.close();
  daemon = undefined;
});

async function setup(options: { review?: boolean } = {}) {
  const dirs: AppDirs = { dataDir: tempDir(), configDir: tempDir() };
  const socketPath = uniqueSocketPath();
  daemon = await startDaemon({ socketPath, dirs, txIdleGapMs: GAP_MS });
  const dir = join(tempDir(), "talk");
  const connect = async (client: string, session?: string) => {
    const conn = await connectToDaemon(daemon!.socketPath, { client, session, agent: null });
    connections.push(conn);
    return conn;
  };
  let ui = await connect("desktop/test");
  await ui.request("project.init", { dir });
  const file = join(dir, "timelines", "main.json");
  const journal = join(dir, ".frameshell", "history", "main.jsonl");
  const read = () => readFileSync(file, "utf8");
  const journalLines = () => (existsSync(journal) ? readFileSync(journal, "utf8").trim().split("\n").filter(Boolean) : []);
  const events: EventParams<"proposal.changed">[] = [];
  const watch = async (conn: DaemonConnection) => {
    await conn.request("events.subscribe", { cwd: dir, events: ["proposal.changed", "timeline.changed", "timeline.rejected"] });
    conn.on("proposal.changed", (params) => events.push(params));
  };
  await watch(ui);
  // Two tracks the person made before review mode: T1 for the agent, T2 for the person.
  const t1 = (await ui.request("track.add", { cwd: dir, kind: "video", name: "Camera" })).changes.added[0]!;
  const t2 = (await ui.request("track.add", { cwd: dir, kind: "audio", name: "Music" })).changes.added[0]!;
  if (options.review) await ui.request("review.set", { cwd: dir, enabled: true });
  const restart = async () => {
    for (const conn of connections.splice(0)) conn.close();
    await daemon!.close();
    daemon = await startDaemon({ socketPath, dirs, txIdleGapMs: GAP_MS });
    ui = await connect("desktop/test");
    await watch(ui);
    return ui;
  };
  return { dirs, dir, file, journal, read, journalLines, connect, ui: () => ui, t1, t2, events, restart };
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

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const names = (view: { tracks: { name: string | null }[] }) => view.tracks.map((track) => track.name);

describe("review mode off (default)", () => {
  it("leaves behaviour, files and journal as without review mode", async () => {
    const { dirs, dir, connect, journalLines, events, read } = await setup();
    const agent = await connect("cli/test");
    const added = await agent.request("track.add", { cwd: dir, kind: "video", name: "B-roll" });
    expect(added.revision).toBe(3);
    expect(JSON.parse(read()).tracks.map((track: { name: string }) => track.name)).toEqual(["Camera", "Music", "B-roll"]);
    const lines = journalLines().map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).not.toHaveProperty("proposal");
    expect(existsSync(join(dir, ".frameshell", "proposals"))).toBe(false);
    expect(existsSync(join(dirs.configDir, "review.json"))).toBe(false);
    expect(events).toEqual([]);
    const shown = await agent.request("timeline.show", { cwd: dir, timeline: "main" });
    expect(shown).toMatchObject({ view: "current", proposal: null, revision: 3 });
    expect((await agent.request("proposal.status", { cwd: dir })).enabled).toBe(false);
    expect((await agent.request("status", { cwd: dir })).review).toEqual({ enabled: false, proposal: null, decisions: [] });
    expect((await agent.request("history", { cwd: dir, timeline: "main" })).proposals).toEqual([]);
    expect(await agent.request("proposal.wait", { cwd: dir, timeout: 1 })).toMatchObject({ outcome: "none", tx: null });
  });
});

describe("review mode on: proposals (#315)", () => {
  it("keeps the file untouched; the author reads its own effects, everyone else the file", async () => {
    const { dir, connect, read, journalLines, ui, t1, events } = await setup({ review: true });
    const before = read();
    const journaled = journalLines();
    const agent = await connect("cli/test", "term-1");
    await agent.request("tx.begin", { label: "Rename camera" });
    const renamed = await agent.request("track.set", { cwd: dir, track: t1, name: "Wide" });
    expect(renamed).toMatchObject({ revision: 3, operation: { author: "cli:term-1", op: "track.set" } });
    await agent.request("track.add", { cwd: dir, kind: "video", name: "Close" });

    expect(read()).toBe(before);
    expect(journalLines()).toEqual(journaled);
    const own = await agent.request("timeline.show", { cwd: dir, timeline: "main" });
    expect(own).toMatchObject({ view: "proposal", proposal: { state: "building" }, revision: 4 });
    expect(names(own)).toEqual(["Wide", "Music", "Close"]);
    const theirs = await ui().request("timeline.show", { cwd: dir, timeline: "main" });
    expect(theirs).toMatchObject({ view: "current", revision: 2 });
    expect(names(theirs)).toEqual(["Camera", "Music"]);
    expect(names(await ui().request("track.list", { cwd: dir, timeline: "main", view: "proposal" }))).toEqual(["Wide", "Music", "Close"]);
    expect(names(await agent.request("timeline.show", { cwd: dir, timeline: "main", view: "current" }))).toEqual(["Camera", "Music"]);

    const status = await agent.request("proposal.status", { cwd: dir });
    expect(status).toMatchObject({
      enabled: true,
      proposal: { label: "Rename camera", author: "cli:term-1", state: "building", operations: 2, timelines: ["main"] },
    });
    const committed = await agent.request("tx.commit", {});
    expect(committed.proposal).toEqual({ tx: committed.tx, state: "ready" });
    expect((await ui().request("status", { cwd: dir })).review?.proposal).toMatchObject({ tx: committed.tx, state: "ready" });
    await until(() => events.some((event) => event.state === "ready"), "ready event");
    expect(events.map((event) => [event.state, event.operations])).toEqual([
      ["building", 1],
      ["building", 2],
      ["ready", 2],
    ]);
    expect(events[0]).toMatchObject({ project: dir, tx: committed.tx, label: "Rename camera", author: "cli:term-1", timelines: ["main"], conflicts: [] });
    const stored = JSON.parse(readFileSync(join(dir, ".frameshell", "proposals", `${committed.tx}.json`), "utf8"));
    expect(stored).toMatchObject({ tx: committed.tx, state: "ready", timelines: [{ timeline: "main", ops: [{ op: "track.set" }, { op: "track.add" }] }] });
  });

  it("refuses a second author, a new transaction and the author's next change once ready; the person still edits", async () => {
    const { dir, connect, ui, t1, t2, read } = await setup({ review: true });
    const agent = await connect("cli/test");
    const first = await agent.request("track.set", { cwd: dir, track: t1, name: "Wide" });
    const other = await connect("cli/test", "term-2");
    const refused = await rejection(other.request("track.set", { cwd: dir, track: t1, name: "Other" }));
    expect(refused.code).toBe(ErrorCode.ProposalPending);
    expect(refused.message).toContain(`A proposal is waiting for review (${first.operation.tx})`);
    expect(refused.message).toContain("frameshell proposal wait");
    expect(refused.data).toMatchObject({ tx: first.operation.tx, label: null, author: "cli", state: "ready" });
    expect((await rejection(other.request("tx.begin", { label: "x" }))).code).toBe(ErrorCode.ProposalPending);
    // No grouping without a session: the author's next change is a new transaction, refused while its proposal waits.
    expect((await rejection(agent.request("track.set", { cwd: dir, track: t1, name: "Again" }))).code).toBe(ErrorCode.ProposalPending);
    const person = await ui().request("track.set", { cwd: dir, track: t2, name: "Score" });
    expect(person.operation.author).toBe("ui");
    expect(JSON.parse(read()).tracks[1].name).toBe("Score");
  });

  it("refuses tx begin only for the project holding the proposal when cwd is given; without cwd, for any", async () => {
    const { dir, connect, t1 } = await setup({ review: true });
    const other = join(tempDir(), "other");
    const agent = await connect("cli/test");
    await agent.request("project.init", { dir: other });
    await agent.request("track.set", { cwd: dir, track: t1, name: "Wide" });
    const elsewhere = await connect("cli/test", "term-b");
    expect(await elsewhere.request("tx.begin", { label: "Other work", cwd: other })).toMatchObject({ label: "Other work" });
    await elsewhere.request("tx.abort", {});
    expect((await rejection(elsewhere.request("tx.begin", { label: "Here", cwd: dir }))).code).toBe(ErrorCode.ProposalPending);
    expect((await rejection(elsewhere.request("tx.begin", { label: "Anywhere" }))).code).toBe(ErrorCode.ProposalPending);
  });

  it("survives a daemon restart: rebuilt, still the author's view, still decidable", async () => {
    const { dir, connect, restart, t1, read } = await setup({ review: true });
    const agent = await connect("cli/test", "term-1");
    await agent.request("tx.begin", { label: "Rename" });
    await agent.request("track.set", { cwd: dir, track: t1, name: "Wide" });
    const before = read();

    const ui = await restart();
    // The explicit transaction is restored, so the proposal is still building.
    expect((await ui.request("proposal.status", { cwd: dir })).proposal).toMatchObject({ state: "building", operations: 1, label: "Rename" });
    const again = await connect("cli/test", "term-1");
    expect(names(await again.request("timeline.show", { cwd: dir, timeline: "main" }))).toEqual(["Wide", "Music"]);
    await again.request("track.add", { cwd: dir, kind: "video", name: "Close" });
    const { tx } = await again.request("tx.commit", {});
    expect(read()).toBe(before);

    await restart();
    const ui2 = await restart();
    expect((await ui2.request("proposal.status", { cwd: dir })).proposal).toMatchObject({ tx, state: "ready", operations: 2 });
    await ui2.request("proposal.accept", { cwd: dir, tx });
    expect(JSON.parse(read()).tracks.map((track: { name: string }) => track.name)).toEqual(["Wide", "Music", "Close"]);
  });

  it("lets only the app turn review mode on or off, stored per user outside the project", async () => {
    const { dirs, dir, connect, ui } = await setup();
    const agent = await connect("cli/test", "term-1");
    const refused = await rejection(agent.request("review.set", { cwd: dir, enabled: true }));
    expect(refused).toMatchObject({ code: ErrorCode.ProposalState, data: { reason: "forbidden" } });
    expect(await ui().request("review.set", { cwd: dir, enabled: true })).toEqual({ dir, enabled: true });
    const stored = JSON.parse(readFileSync(join(dirs.configDir, "review.json"), "utf8"));
    expect(Object.keys(stored.projects)).toHaveLength(1);
    expect(readFileSync(join(dir, "frameshell.json"), "utf8")).not.toContain("review");
    expect(existsSync(join(dir, ".frameshell", "proposals"))).toBe(false);
    expect((await agent.request("status", { cwd: dir })).review?.enabled).toBe(true);
    await ui().request("review.set", { cwd: dir, enabled: false });
    expect((await agent.request("proposal.status", { cwd: dir })).enabled).toBe(false);
  });
});

describe("accept, reject, wait (#316)", () => {
  it("accept journals the operations under their author, marked with the proposal; a single operation reverts after", async () => {
    const { dir, connect, ui, t1, read, journalLines } = await setup({ review: true });
    const agent = await connect("cli/test", "term-1");
    await agent.request("tx.begin", { label: "Rework" });
    const set = await agent.request("track.set", { cwd: dir, track: t1, name: "Wide" });
    const added = await agent.request("track.add", { cwd: dir, kind: "video", name: "Close" });
    const { tx } = await agent.request("tx.commit", {});
    const waiting = agent.request("proposal.wait", { cwd: dir });

    const accepted = await ui().request("proposal.accept", { cwd: dir, tx });
    expect(accepted.operations.map((op) => op.operation.id)).toEqual([set.operation.id, added.operation.id]);
    expect(await waiting).toEqual({ outcome: "accepted", tx, label: "Rework", author: "cli:term-1", conflicts: [], proposal: null });
    expect(JSON.parse(read()).tracks.map((track: { name: string }) => track.name)).toEqual(["Wide", "Music", "Close"]);
    const entries = journalLines().slice(-2).map((line) => JSON.parse(line));
    expect(entries).toMatchObject([
      { op: "track.set", author: "cli:term-1", tx, txLabel: "Rework", proposal: tx, revisionBefore: 2, revision: 3 },
      { op: "track.add", author: "cli:term-1", tx, txLabel: "Rework", proposal: tx, revisionBefore: 3, revision: 4 },
    ]);
    expect(existsSync(join(dir, ".frameshell", "proposals", `${tx}.json`))).toBe(false);
    const history = await ui().request("history", { cwd: dir, timeline: "main", since: tx });
    expect(history.proposals).toMatchObject([{ tx, outcome: "accepted" }]);

    // Partial acceptance = accept, then revert one operation.
    await ui().request("revert", { cwd: dir, timeline: "main", target: set.operation.id });
    expect(JSON.parse(read()).tracks.map((track: { name: string }) => track.name)).toEqual(["Camera", "Music", "Close"]);
    expect((await rejection(ui().request("proposal.accept", { cwd: dir, tx }))).data).toMatchObject({ reason: "decided" });
  });

  it("only the app accepts or rejects: an agent cannot approve itself", async () => {
    const { dir, connect, t1 } = await setup({ review: true });
    const agent = await connect("cli/test");
    const { operation } = await agent.request("track.set", { cwd: dir, track: t1, name: "Wide" });
    for (const method of ["proposal.accept", "proposal.reject"] as const) {
      const refused = await rejection(agent.request(method, { cwd: dir, tx: operation.tx }));
      expect(refused).toMatchObject({ code: ErrorCode.ProposalState, data: { tx: operation.tx, reason: "forbidden" } });
    }
    expect((await agent.request("proposal.status", { cwd: dir })).proposal).toMatchObject({ tx: operation.tx, state: "ready" });
  });

  it("reject journals nothing and keeps the proposal file; wait and history report it", async () => {
    const { dir, connect, ui, t1, read, journalLines } = await setup({ review: true });
    const agent = await connect("cli/test");
    const { operation } = await agent.request("track.set", { cwd: dir, track: t1, name: "Wide" });
    const before = read();
    const journaled = journalLines();
    const waiting = agent.request("proposal.wait", { cwd: dir, timeout: 30 });
    expect(await ui().request("proposal.reject", { cwd: dir, tx: operation.tx })).toEqual({ tx: operation.tx });
    expect(await waiting).toMatchObject({ outcome: "rejected", tx: operation.tx });
    expect(read()).toBe(before);
    expect(journalLines()).toEqual(journaled);
    const kept = JSON.parse(readFileSync(join(dir, ".frameshell", "proposals", `${operation.tx}.json`), "utf8"));
    expect(kept).toMatchObject({ state: "rejected", decidedAt: expect.any(String) });
    const decisions = readFileSync(join(dir, ".frameshell", "proposals", "decisions.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(decisions).toMatchObject([{ tx: operation.tx, outcome: "rejected", author: "cli", timelines: ["main"] }]);
    // An agent asking what became of its proposal: the tx never reached the journal, `history --since` still answers.
    const history = await agent.request("history", { cwd: dir, timeline: "main", since: operation.tx });
    expect(history).toMatchObject({ since: operation.tx, transactions: [], proposals: [{ tx: operation.tx, outcome: "rejected" }] });
    // Decided: a late wait returns it at once.
    expect(await agent.request("proposal.wait", { cwd: dir })).toMatchObject({ outcome: "rejected", tx: operation.tx });
    // The next change starts a new proposal.
    expect((await agent.request("track.set", { cwd: dir, track: t1, name: "Wide" })).operation.tx).not.toBe(operation.tx);
  });

  it("reject while building ends the transaction; the author's next change says why", async () => {
    const { dir, connect, ui, t1 } = await setup({ review: true });
    const agent = await connect("cli/test", "term-1");
    const { tx } = await agent.request("tx.begin", { label: "Rename" });
    await agent.request("track.set", { cwd: dir, track: t1, name: "Wide" });
    expect((await rejection(ui().request("proposal.accept", { cwd: dir, tx }))).data).toMatchObject({ reason: "building" });
    await ui().request("proposal.reject", { cwd: dir, tx });
    const told = await rejection(agent.request("track.set", { cwd: dir, track: t1, name: "Again" }));
    expect(told).toMatchObject({ code: ErrorCode.ProposalState, data: { tx, reason: "rejected" } });
    expect((await rejection(agent.request("tx.commit", {}))).code).toBe(ErrorCode.TransactionState);
  });

  it("a reject arriving while accept writes waits for it and finds the proposal decided", async () => {
    const { dir, connect, ui, read } = await setup({ review: true });
    const agent = await connect("cli/test", "term-1");
    await agent.request("tx.begin", { label: "Many tracks" });
    for (let n = 0; n < 20; n++) await agent.request("track.add", { cwd: dir, kind: "video", name: `V${n}` });
    const { tx } = await agent.request("tx.commit", {});
    const other = await connect("desktop/other");
    let rejected: Promise<RpcError | { tx: string }> | null = null;
    ui().on("timeline.changed", () => {
      rejected ??= other.request("proposal.reject", { cwd: dir, tx }).catch((error: RpcError) => error);
    });
    await ui().request("proposal.accept", { cwd: dir, tx });
    await until(() => rejected !== null, "the reject");
    expect(await rejected).toMatchObject({ code: ErrorCode.ProposalState, data: { reason: "decided" } });
    expect(JSON.parse(read()).tracks).toHaveLength(22);
    const decisions = readFileSync(join(dir, ".frameshell", "proposals", "decisions.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(decisions).toMatchObject([{ tx, outcome: "accepted" }]);
  });

  it("wait returns pending after its timeout", async () => {
    const { dir, connect, t1 } = await setup({ review: true });
    const agent = await connect("cli/test");
    const { operation } = await agent.request("track.set", { cwd: dir, track: t1, name: "Wide" });
    const started = Date.now();
    const waited = await agent.request("proposal.wait", { cwd: dir, timeout: 0.3 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(waited).toMatchObject({ outcome: "pending", tx: operation.tx, proposal: { tx: operation.tx, state: "ready" } });
  });

  it("tx abort drops a building proposal: nothing reached the file", async () => {
    const { dir, connect, t1, read, events } = await setup({ review: true });
    const agent = await connect("cli/test", "term-1");
    const before = read();
    const { tx } = await agent.request("tx.begin", { label: "Try" });
    await agent.request("track.set", { cwd: dir, track: t1, name: "Wide" });
    expect(await agent.request("tx.abort", {})).toMatchObject({ tx, reverted: [] });
    expect(read()).toBe(before);
    expect((await agent.request("proposal.status", { cwd: dir })).proposal).toBeNull();
    await until(() => events.some((event) => event.state === "aborted"), "aborted event");
    expect(await agent.request("proposal.wait", { cwd: dir })).toMatchObject({ outcome: "aborted", tx });
  });

  it("gc sweeps closed proposals decided more than 7 days ago and keeps newer ones", async () => {
    const { dir, connect, ui, t1 } = await setup({ review: true });
    const agent = await connect("cli/test");
    const old = (await agent.request("track.set", { cwd: dir, track: t1, name: "A" })).operation.tx;
    await ui().request("proposal.reject", { cwd: dir, tx: old });
    const recent = (await agent.request("track.set", { cwd: dir, track: t1, name: "B" })).operation.tx;
    await ui().request("proposal.reject", { cwd: dir, tx: recent });
    const open = (await agent.request("track.set", { cwd: dir, track: t1, name: "C" })).operation.tx;
    const proposals = join(dir, ".frameshell", "proposals");
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    utimesSync(join(proposals, `${old}.json`), eightDaysAgo, eightDaysAgo);
    utimesSync(join(proposals, `${open}.json`), eightDaysAgo, eightDaysAgo);

    const dry = await ui().request("gc", { cwd: dir, dryRun: true });
    expect(dry.removed.filter((entry) => entry.kind === "proposal").map((entry) => entry.path)).toEqual([`.frameshell/proposals/${old}.json`]);
    expect(existsSync(join(proposals, `${old}.json`))).toBe(true);
    await ui().request("gc", { cwd: dir });
    expect(readdirSync(proposals).sort()).toEqual(["decisions.jsonl", `${open}.json`, `${recent}.json`].sort());
  });
});

describe("rebase and stale (#317)", () => {
  it("rebases on the person's edit elsewhere: the proposal stays valid and accept applies it on top", async () => {
    const { dir, connect, ui, t1, t2, read, events } = await setup({ review: true });
    const agent = await connect("cli/test");
    const { operation } = await agent.request("track.set", { cwd: dir, track: t1, name: "Wide" });
    await ui().request("track.set", { cwd: dir, track: t2, name: "Score" });
    expect((await ui().request("proposal.status", { cwd: dir })).proposal).toMatchObject({ tx: operation.tx, state: "ready" });
    expect(names(await agent.request("timeline.show", { cwd: dir, timeline: "main" }))).toEqual(["Wide", "Score"]);
    await until(() => events.filter((event) => event.state === "ready").length >= 2, "rebase event");
    await ui().request("proposal.accept", { cwd: dir, tx: operation.tx });
    expect(JSON.parse(read()).tracks.map((track: { name: string }) => track.name)).toEqual(["Wide", "Score"]);
  });

  it("goes stale when the person changes the same track: closed unapplied, wait reports the conflicts", async () => {
    const { dir, connect, ui, t1, read } = await setup({ review: true });
    const agent = await connect("cli/test");
    const { operation } = await agent.request("track.set", { cwd: dir, track: t1, name: "Wide" });
    const waiting = agent.request("proposal.wait", { cwd: dir });
    await ui().request("track.set", { cwd: dir, track: t1, name: "Main" });
    expect(await waiting).toEqual({ outcome: "stale", tx: operation.tx, label: null, author: "cli", conflicts: [t1], proposal: null });
    expect(JSON.parse(read()).tracks[0].name).toBe("Main");
    expect((await ui().request("proposal.status", { cwd: dir })).decisions[0]).toMatchObject({ tx: operation.tx, outcome: "stale", conflicts: [t1] });
    expect((await rejection(ui().request("proposal.accept", { cwd: dir, tx: operation.tx }))).data).toMatchObject({ reason: "decided" });
  });

  it("a building proposal going stale ends its transaction; the author's next change says why", async () => {
    const { dir, connect, ui, t1 } = await setup({ review: true });
    const agent = await connect("cli/test", "term-1");
    const { tx } = await agent.request("tx.begin", { label: "Rename" });
    await agent.request("track.set", { cwd: dir, track: t1, name: "Wide" });
    await ui().request("track.remove", { cwd: dir, track: t1 });
    const told = await rejection(agent.request("track.add", { cwd: dir, kind: "video", name: "Close" }));
    expect(told).toMatchObject({ code: ErrorCode.ProposalState, data: { tx, reason: "stale", conflicts: expect.arrayContaining([t1]) } });
    expect((await rejection(agent.request("tx.commit", {}))).code).toBe(ErrorCode.TransactionState);
    // Told once: the next change is a new proposal.
    expect((await agent.request("track.add", { cwd: dir, kind: "video", name: "Close" })).operation.tx).not.toBe(tx);
  });
});

describe("direct file edits (#318)", () => {
  function edit(file: string, change: (timeline: { tracks: { name: string }[] }) => void) {
    const timeline = JSON.parse(readFileSync(file, "utf8"));
    change(timeline);
    writeFileSync(file, JSON.stringify(timeline, null, 2));
    return JSON.stringify(timeline, null, 2);
  }

  it("turns a valid edit into a ready proposal, restores the file, keeps the edit; accept applies it", async () => {
    const { dir, file, read, ui, events } = await setup({ review: true });
    const before = read();
    const text = edit(file, (timeline) => {
      timeline.tracks[0]!.name = "Edited";
    });
    await until(() => events.some((event) => event.author === "file" && event.state === "ready"), "file proposal");
    await until(() => read() === before, "file restored");
    const { proposal } = await ui().request("proposal.status", { cwd: dir });
    expect(proposal).toMatchObject({ label: "Edit timelines/main.json", author: "file", state: "ready", operations: 1 });
    const stored = JSON.parse(readFileSync(join(dir, ".frameshell", "proposals", `${proposal!.tx}.json`), "utf8"));
    expect(stored.edit).toEqual({ timeline: "main", text });
    expect(names(await ui().request("timeline.show", { cwd: dir, timeline: "main", view: "proposal" }))).toEqual(["Edited", "Music"]);

    const { operations } = await ui().request("proposal.accept", { cwd: dir, tx: proposal!.tx });
    expect(operations).toMatchObject([{ operation: { op: "timeline.patch", author: "file", tx: proposal!.tx } }]);
    expect(JSON.parse(read()).tracks[0].name).toBe("Edited");
  });

  it("rejects an edit arriving while another proposal is open, with reason proposal-pending", async () => {
    const { dir, file, read, connect, t1 } = await setup({ review: true });
    const watcher = await connect("cli/test", "watcher");
    await watcher.request("events.subscribe", { cwd: dir, events: ["timeline.rejected"] });
    const rejected = new Promise<EventParams<"timeline.rejected">>((resolve) => watcher.on("timeline.rejected", resolve));
    const agent = await connect("cli/test");
    await agent.request("track.set", { cwd: dir, track: t1, name: "Wide" });
    const before = read();
    edit(file, (timeline) => {
      timeline.tracks[1]!.name = "Edited";
    });
    const event = await rejected;
    expect(event).toMatchObject({ reason: "proposal-pending", timeline: "main" });
    expect(event.preserved).toMatch(/^\.frameshell\/rejected\/.+-main\.json$/);
    expect(JSON.parse(readFileSync(join(dir, event.preserved), "utf8")).tracks[1].name).toBe("Edited");
    await until(() => read() === before, "file restored");
    expect((await agent.request("status", { cwd: dir })).rejections[0]).toMatchObject({ reason: "proposal-pending" });
  });

  it("turns an edit made while no daemon ran into a proposal on the next open", async () => {
    const { dir, file, read, restart } = await setup({ review: true });
    await daemon!.close();
    const before = read();
    edit(file, (timeline) => {
      timeline.tracks[0]!.name = "Offline";
    });
    const ui = await restart();
    const shown = await ui.request("timeline.show", { cwd: dir, timeline: "main" });
    expect(names(shown)).toEqual(["Camera", "Music"]);
    expect(JSON.parse(read()).tracks[0].name).toBe("Camera");
    expect(JSON.parse(before).tracks[0].name).toBe("Camera");
    expect((await ui.request("proposal.status", { cwd: dir })).proposal).toMatchObject({ author: "file", state: "ready", label: "Edit timelines/main.json" });
  });
});
