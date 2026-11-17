import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, testBinaryManager } from "./media-tools.js";
import { CARD_PLUGIN, installLocalPlugin } from "./plugin-fixture.js";

// The `gc` hook of a clip adapter (ADR 0035 slice 5) through the daemon: the `gc-card` fixture type keeps one marker
// file per clip under `.frameshell/card-state/` and deletes the ones no clip names, as the Blender plugin does for its
// listings. The host's part is what is tested here: which inputs it gathers, and when it asks.
const TIMEOUT = 180_000;
const STATE = ".frameshell/card-state";
const HOUR = 3_600_000;

let daemon: Daemon;
let conn: DaemonConnection;

beforeAll(async () => {
  await mediaTools();
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
}, TIMEOUT);

afterAll(async () => {
  conn?.close();
  await daemon?.close();
});

/** A 64x36 project with the card plugin and an empty `compositions/cards/`, trusted unless `trusted` is false. */
async function cardProject(on: DaemonConnection = conn, trusted = true): Promise<string> {
  const dir = tempDir();
  await on.request("project.init", { dir });
  const configPath = join(dir, "frameshell.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  writeFileSync(configPath, JSON.stringify({ ...config, resolution: { width: 64, height: 36 } }));
  installLocalPlugin(dir, CARD_PLUGIN, "card-plugin");
  if (trusted) await on.request("project.trust", { cwd: dir, decision: "trust" });
  mkdirSync(join(dir, "compositions", "cards"), { recursive: true });
  return dir;
}

const card = (dir: string, name: string, value: Record<string, unknown>) => writeFileSync(join(dir, "compositions", "cards", `${name}.json`), JSON.stringify(value));

/** A marker file last written `ageMs` ago. */
function marker(dir: string, rel: string, ageMs = 2 * HOUR): void {
  const file = join(dir, ...rel.split("/"));
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "{}");
  const at = new Date(Date.now() - ageMs);
  utimesSync(file, at, at);
}

/** Every call of the fixture's `gc` hook in `dir`, in order. */
function hookCalls(dir: string): { inputs: string[]; dryRun: boolean; floor: number }[] {
  const log = join(dir, ".frameshell", "gc-calls.jsonl");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { inputs: string[]; dryRun: boolean; floor: number }) : [];
}

async function idle(dir: string, on: DaemonConnection = conn): Promise<void> {
  for (const deadline = Date.now() + 60_000; (await on.request("job.list", { cwd: dir, active: true })).jobs.length > 0; ) {
    if (Date.now() > deadline) throw new Error("jobs never settled");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const markers = (removed: { path: string }[]) => removed.filter((entry) => entry.path.startsWith(`${STATE}/`));

describe("adapter gc hook", () => {
  let dir = "";
  let track = "";

  beforeAll(async () => {
    dir = await cardProject();
    card(dir, "one", { color: "blue", seconds: 1, state: "a" });
    card(dir, "two", { color: "red", seconds: 1, state: "b" });
    await conn.request("format.add", { cwd: dir, id: "tall", width: 36, height: 64 });
    track = (await conn.request("track.add", { cwd: dir, kind: "video" })).changes.added[0]!;
    const one = (await conn.request("clip.add", { cwd: dir, track, type: "gc-card", source: "compositions/cards/one.json", start: 0, duration: 1 })).changes.added[0]!;
    // In the `tall` format this clip keeps another marker.
    await conn.request("clip.set", { cwd: dir, clip: one, format: "tall", props: { state: "t" } });
    // A second timeline, which `main` does not nest, with a clip of its own.
    const second = { schemaVersion: 1, id: "second", revision: 0, tracks: [{ id: "t_s", kind: "video", clips: [{ id: "c_g2", type: "gc-card", source: "compositions/cards/two.json", start: 0, duration: 1 }] }] };
    await conn.request("file.write", { path: join(dir, "timelines", "second.json"), content: JSON.stringify(second) });
    await idle(dir);
    for (const name of ["a", "b", "t", "c"]) marker(dir, `${STATE}/${name}.json`);
    marker(dir, `${STATE}/notes.txt`);
    // Written a moment ago: inside the host's grace, so kept although no clip names it.
    marker(dir, `${STATE}/fresh.json`, 1000);
  }, TIMEOUT);

  it(
    "gives the hook the union of the inputs of every timeline at every format, and reports what it deleted as `clip` entries",
    async () => {
      const dry = await conn.request("gc", { cwd: dir, dryRun: true });
      expect(markers(dry.removed)).toEqual([{ path: `${STATE}/c.json`, kind: "clip", bytes: 2 }]);
      expect(existsSync(join(dir, STATE, "c.json"))).toBe(true);
      const [call] = hookCalls(dir).slice(-1);
      expect(call).toMatchObject({
        dryRun: true,
        inputs: [`${STATE}/a.json`, `${STATE}/b.json`, `${STATE}/t.json`, "compositions/cards/one.json", "compositions/cards/two.json"],
      });
      // The floor is a moment before the call, not a timestamp of the future (which would keep nothing out of reach).
      expect(call!.floor).toBeLessThanOrEqual(Date.now());
      expect(call!.floor).toBeGreaterThan(Date.now() - 10 * 60_000);

      const real = await conn.request("gc", { cwd: dir });
      expect(markers(real.removed)).toEqual([{ path: `${STATE}/c.json`, kind: "clip", bytes: 2 }]);
      expect(real.skipped).toEqual([]);
      for (const kept of ["a", "b", "t", "fresh", "notes.txt"]) expect(existsSync(join(dir, STATE, kept.includes(".") ? kept : `${kept}.json`))).toBe(true);
      expect(existsSync(join(dir, STATE, "c.json"))).toBe(false);
      expect(markers((await conn.request("gc", { cwd: dir })).removed)).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "does not ask the hook, or delete anything, when a timeline cannot be read",
    async () => {
      marker(dir, `${STATE}/c.json`);
      const calls = hookCalls(dir).length;
      writeFileSync(join(dir, "timelines", "broken.json"), "{");
      try {
        const gc = await conn.request("gc", { cwd: dir });
        expect(gc.skipped).toEqual(expect.arrayContaining([{ area: "clips", reason: expect.stringContaining("timelines/broken.json could not be read") }]));
        expect(markers(gc.removed)).toEqual([]);
      } finally {
        rmSync(join(dir, "timelines", "broken.json"));
      }
      expect(hookCalls(dir)).toHaveLength(calls);
      expect(existsSync(join(dir, STATE, "c.json"))).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "does not ask the hook while a clip render runs, as for the render cache",
    async () => {
      card(dir, "slow", { color: "green", seconds: 1, delayMs: 3000 });
      const calls = hookCalls(dir).length;
      const slow = (await conn.request("clip.add", { cwd: dir, track, type: "gc-card", source: "compositions/cards/slow.json", start: 5, duration: 1 })).changes.added[0]!;
      try {
        for (const deadline = Date.now() + 10_000; (await conn.request("job.list", { cwd: dir, active: true })).jobs.length === 0; ) {
          if (Date.now() > deadline) throw new Error("the slow render never started");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const gc = await conn.request("gc", { cwd: dir });
        expect(gc.skipped).toEqual(expect.arrayContaining([{ area: "clips", reason: expect.stringContaining("render or export job") }]));
        expect(markers(gc.removed)).toEqual([]);
        expect(hookCalls(dir)).toHaveLength(calls);
        expect(existsSync(join(dir, STATE, "c.json"))).toBe(true);
      } finally {
        await idle(dir);
        await conn.request("clip.remove", { cwd: dir, clip: slow });
        await idle(dir);
      }
      // Idle again: the hook runs and the stale marker goes.
      expect(markers((await conn.request("gc", { cwd: dir })).removed).map((entry) => entry.path)).toEqual([`${STATE}/c.json`]);
    },
    TIMEOUT,
  );

  it(
    "reports a hook that throws as skipped, with the plugin's name, and leaves the files",
    async () => {
      marker(dir, `${STATE}/c.json`);
      writeFileSync(join(dir, ".frameshell", "gc-fail"), "");
      try {
        const gc = await conn.request("gc", { cwd: dir });
        expect(gc.skipped).toEqual([{ area: "clips", reason: "card-plugin could not clean its own files: gc-card asked to fail" }]);
        expect(markers(gc.removed)).toEqual([]);
        expect(existsSync(join(dir, STATE, "c.json"))).toBe(true);
      } finally {
        rmSync(join(dir, ".frameshell", "gc-fail"));
      }
    },
    TIMEOUT,
  );

  it(
    "still cleans the adapter's files when none of its clips is left, as long as another generated clip makes the keys known",
    async () => {
      const other = await cardProject();
      card(other, "plain", { color: "blue", seconds: 1 });
      const otherTrack = (await conn.request("track.add", { cwd: other, kind: "video" })).changes.added[0]!;
      await conn.request("clip.add", { cwd: other, track: otherTrack, type: "card", source: "compositions/cards/plain.json", start: 0, duration: 1 });
      await idle(other);
      marker(other, `${STATE}/orphan.json`);
      const gc = await conn.request("gc", { cwd: other });
      expect(markers(gc.removed).map((entry) => entry.path)).toEqual([`${STATE}/orphan.json`]);
    },
    TIMEOUT,
  );

  it("loads no plugin and asks no hook in a project with no generated clips, even an untrusted one", async () => {
    const bare = await cardProject(conn, false);
    marker(bare, `${STATE}/orphan.json`);
    const gc = await conn.request("gc", { cwd: bare });
    expect(gc.skipped).toEqual([]);
    expect(markers(gc.removed)).toEqual([]);
    expect(hookCalls(bare)).toEqual([]);
    expect(existsSync(join(bare, STATE, "orphan.json"))).toBe(true);
  });

  it(
    "aborts the signal its inputs() got when the daemon stops",
    async () => {
      const store = globalThis as { cardSignals?: AbortSignal[] };
      const stopping = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
      const before = store.cardSignals?.length ?? 0;
      try {
        const link = await connectToDaemon(stopping.socketPath, { client: "test" });
        const own = await cardProject(link);
        card(own, "one", { color: "blue", seconds: 1 });
        const ownTrack = (await link.request("track.add", { cwd: own, kind: "video" })).changes.added[0]!;
        const id = (await link.request("clip.add", { cwd: own, track: ownTrack, type: "gc-card", source: "compositions/cards/one.json", start: 0, duration: 1 })).changes.added[0]!;
        const { clips } = await link.request("clip.renders", { cwd: own, timeline: "main" });
        expect(clips.find((clip) => clip.clip === id)?.key).not.toBeNull();
        await idle(own, link);
        link.close();
        const signals = (store.cardSignals ?? []).slice(before);
        expect(signals.length).toBeGreaterThan(0);
        expect(signals.every((signal) => !signal.aborted)).toBe(true);
        await stopping.close();
        expect(signals.every((signal) => signal.aborted)).toBe(true);
      } finally {
        await stopping.close().catch(() => {});
      }
    },
    TIMEOUT,
  );
});
