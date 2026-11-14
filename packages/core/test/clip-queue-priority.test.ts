import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, type JobInfo, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeClip } from "./media-fixtures.js";
import { mediaTools, testBinaryManager } from "./media-tools.js";
import { CARD_PLUGIN, installLocalPlugin } from "./plugin-fixture.js";

// Clip render queue order (#502) through the daemon, with the `card` fixture adapter as the stand-in whose
// render time is known (`delayMs`): a long render holds the one clip slot while the rest line up behind it.
const TIMEOUT = 180_000;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
const events: JobInfo[] = [];

const writeCard = (name: string, card: Record<string, unknown>) =>
  conn.request("file.write", { path: join(project, "compositions", "cards", `${name}.json`), content: JSON.stringify(card) });

/** Write timeline `id` with one video track holding a 1 s card clip per name, in this order. */
async function writeTimeline(id: string, names: string[]): Promise<void> {
  const path = join(project, "timelines", `${id}.json`);
  const revision = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { revision: number }).revision : 0;
  const timeline = {
    schemaVersion: 1,
    id,
    revision,
    tracks: [{ id: `t_${id}`, kind: "video", clips: names.map((name, index) => ({ id: `c_${name}`, type: "card", source: `compositions/cards/${name}.json`, start: index * 2, duration: 1 })) }],
  };
  await conn.request("file.write", { path, content: JSON.stringify(timeline) });
}

const clipJobs = async (active = false) => (await conn.request("job.list", { cwd: project, active })).jobs.filter((job) => job.kind === "clip");
const jobOf = async (card: string) => (await clipJobs()).filter((job) => job.asset === `compositions/cards/${card}.json`).at(-1);

/**
 * Poll `read` until it answers. `nudge` runs about every second meanwhile: a project's file watcher may still be
 * starting when the first files are written (a cold machine), and an event lost then is never replayed.
 */
async function until<T>(read: () => Promise<T | undefined | false>, nudge?: () => Promise<unknown>): Promise<T> {
  let nudged = Date.now();
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; ) {
    const value = await read();
    if (value) return value;
    if (nudge && Date.now() - nudged > 1000) {
      nudged = Date.now();
      await nudge();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`never reached the expected state; jobs: ${JSON.stringify(await clipJobs())}`);
}

beforeAll(async () => {
  await mediaTools();
  // Own config dir: project trust is a read-modify-write of one file, and test files run in parallel.
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs: { dataDir: tempDir(), configDir: tempDir() }, binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  const configPath = join(project, "frameshell.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  writeFileSync(configPath, JSON.stringify({ ...config, resolution: { width: 64, height: 36 } }));
  installLocalPlugin(project, CARD_PLUGIN, "card-plugin");
  await conn.request("project.trust", { cwd: project, decision: "trust" });
  await conn.request("events.subscribe", { cwd: project, events: ["job.progress"] });
  conn.on("job.progress", ({ job }) => events.push(job));
}, TIMEOUT);

afterAll(async () => {
  conn?.close();
  await daemon?.close();
});

describe("clip render queue priority", () => {
  it(
    "renders what the preview asks for before background renders, and shows priority and place in job.list",
    async () => {
      await writeCard("long", { color: "red", seconds: 1, delayMs: 2000 });
      for (const name of ["bg1", "bg2", "urgent"]) await writeCard(name, { color: "blue", seconds: 1, delayMs: name === "urgent" ? 0 : 50 });
      await writeTimeline("main", ["long"]);
      await until(async () => (await jobOf("long"))?.state === "running", () => writeCard("long", { color: "red", seconds: 1, delayMs: 2000 }));

      // Nobody looks at `alt`: its renders wait in the background; the new clip of `main` queues the same way.
      await writeTimeline("alt", ["bg1", "bg2"]);
      const nudgeAlt = () => writeCard("bg1", { color: "blue", seconds: 1, delayMs: 50 });
      await until(async () => (await clipJobs(true)).filter((job) => job.state === "queued").length === 2, nudgeAlt);
      await writeTimeline("main", ["long", "urgent"]);
      const queued = await until(async () => {
        const jobs = (await clipJobs(true)).filter((job) => job.state === "queued");
        return jobs.length === 3 && jobs;
      }, nudgeAlt);
      expect(queued.map((job) => [job.priority, job.position]).sort()).toEqual([["background", 1], ["background", 2], ["background", 3]]);

      // The preview reads `main`: the render it needs moves to the front, the others keep their order.
      await conn.request("clip.renders", { cwd: project, timeline: "main" });
      const urgent = (await jobOf("urgent"))!;
      expect(urgent).toMatchObject({ state: "queued", priority: "interactive", position: 1 });
      expect((await jobOf("bg1"))).toMatchObject({ priority: "background", position: expect.any(Number) });
      expect(new Set((await clipJobs(true)).filter((job) => job.state === "queued").map((job) => job.position))).toEqual(new Set([1, 2, 3]));
      expect((await jobOf("long"))).toMatchObject({ state: "running", position: null });

      await until(async () => (await clipJobs(true)).length === 0);
      const runs = events.filter((job) => job.state === "running" && job.kind === "clip");
      const started = [...new Map(runs.map((job) => [job.id, job.asset.replace(/.*\/|\.json$/g, "")])).values()];
      expect(started.slice(0, 2)).toEqual(["long", "urgent"]);
      // Starvation: the background renders still ran, both.
      expect(new Set(started)).toEqual(new Set(["long", "urgent", "bg1", "bg2"]));
    },
    TIMEOUT,
  );

  it(
    "cancels a queued render, then a running one; the clip stays failed with the cancel as its error",
    async () => {
      await writeCard("long2", { color: "green", seconds: 1, delayMs: 3000 });
      await writeCard("queued", { color: "white", seconds: 1 });
      await writeTimeline("main", ["long2"]);
      await until(async () => (await jobOf("long2"))?.state === "running", () => writeCard("long2", { color: "green", seconds: 1, delayMs: 3000 }));
      await writeTimeline("alt", ["queued"]);
      const waiting = await until(
        async () => {
          const job = await jobOf("queued");
          return job?.state === "queued" && job;
        },
        () => writeCard("queued", { color: "white", seconds: 1 }),
      );
      expect(waiting).toMatchObject({ priority: "background", position: 1 });

      const canceled = await conn.request("job.cancel", { cwd: project, job: waiting.id });
      expect(canceled.job).toMatchObject({ id: waiting.id, state: "canceled", position: null });
      const { clips } = await conn.request("clip.renders", { cwd: project, timeline: "alt" });
      expect(clips[0]).toMatchObject({ clip: "c_queued", state: "failed", error: expect.stringContaining("canceled") });
      expect(await jobOf("long2")).toMatchObject({ state: "running" });

      const running = (await jobOf("long2"))!;
      await conn.request("job.cancel", { cwd: project, job: running.id });
      await until(async () => (await jobOf("long2"))?.state === "canceled");
      expect(await clipJobs(true)).toEqual([]);
    },
    TIMEOUT,
  );

  it("refuses to cancel a job that is not a clip render, or that does not exist", async () => {
    await expect(conn.request("job.cancel", { cwd: project, job: "j_c9999" })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      data: { op: "job.cancel", reason: "unknown-job", field: "job" },
    });
    const video = join(tempDir(), "raw.mp4");
    await makeClip(video, { durationS: 0.5 });
    const { imported } = await conn.request("asset.import", { cwd: project, files: [video] });
    await expect(conn.request("job.cancel", { cwd: project, job: imported[0]!.job.id })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      data: { op: "job.cancel", reason: "not-cancelable", field: "job" },
    });
  });
});
