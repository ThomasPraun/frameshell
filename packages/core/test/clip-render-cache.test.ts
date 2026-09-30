import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ClipRenderInfo, type DaemonConnection, ErrorCode, type JobInfo, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { ffprobeJson } from "./media-fixtures.js";
import { mediaTools, runBuffer, testBinaryManager } from "./media-tools.js";
import { CARD_PLUGIN, installLocalPlugin } from "./plugin-fixture.js";

// Clip render cache (SPEC §6.5) through the daemon: the `card` fixture adapter renders VP9-alpha cards with the
// real managed ffmpeg, in milliseconds, so the cache, its keys, the watcher and export are all exercised for real.
const TIMEOUT = 180_000;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let track = "";
const jobEvents: JobInfo[] = [];

function writeCard(name: string, card: Record<string, unknown>): void {
  writeFileSync(join(project, "compositions", "cards", `${name}.json`), JSON.stringify(card));
}

async function addCard(name: string, start: number, extra: Record<string, unknown> = {}): Promise<string> {
  const result = await conn.request("clip.add", {
    cwd: project,
    track,
    type: "card",
    source: `compositions/cards/${name}.json`,
    start,
    duration: 1,
    ...extra,
  });
  return result.changes.added[0]!;
}

async function renders(): Promise<Map<string, ClipRenderInfo>> {
  const { clips } = await conn.request("clip.renders", { cwd: project, timeline: "main" });
  return new Map(clips.map((clip) => [clip.clip, clip]));
}

/** Poll `clip.renders` until `check` holds for clip `id`; returns that state. */
async function until(id: string, check: (info: ClipRenderInfo) => boolean): Promise<ClipRenderInfo> {
  let last: ClipRenderInfo | undefined;
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; ) {
    last = (await renders()).get(id);
    if (last && check(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`clip ${id} never reached the expected state; last: ${JSON.stringify(last)}`);
}

const clipJobs = async () => (await conn.request("job.list", { cwd: project })).jobs.filter((job) => job.kind === "clip");

beforeAll(async () => {
  await mediaTools();
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  const configPath = join(project, "frameshell.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  writeFileSync(configPath, JSON.stringify({ ...config, resolution: { width: 64, height: 36 } }));
  installLocalPlugin(project, CARD_PLUGIN, "card-plugin");
  await conn.request("project.trust", { cwd: project, decision: "trust" });
  await conn.request("events.subscribe", { cwd: project, events: ["job.progress"] });
  conn.on("job.progress", ({ job }) => jobEvents.push(job));
  await conn.request("file.write", { path: join(project, "compositions", "cards", "red.json"), content: JSON.stringify({ color: "red", alpha: 0.5, seconds: 2, delayMs: 800 }) });
  writeCard("blue", { color: "blue", seconds: 2 });
  track = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
}, TIMEOUT);

afterAll(async () => {
  conn?.close();
  await daemon?.close();
});

describe("clip render cache", () => {
  let red = "";
  let blue = "";

  it(
    "renders a generated clip in the background as soon as it is added, into .frameshell/cache/clips/<key>.webm",
    async () => {
      red = await addCard("red", 0, { props: { label: "Launch" } });
      blue = await addCard("blue", 1);
      const ready = await until(red, (info) => info.state === "ready");
      expect(ready).toMatchObject({
        track,
        type: "card",
        source: "compositions/cards/red.json",
        file: `.frameshell/cache/clips/${ready.key}.webm`,
        hasAlpha: true,
        width: 64,
        height: 36,
        progress: 1,
        error: null,
      });
      expect(ready.key).toMatch(/^[0-9a-f]{32}$/);
      const probe = (await ffprobeJson(join(project, ready.file!), ["-show_streams"])) as { streams: { codec_name: string; tags?: Record<string, string> }[] };
      expect(probe.streams[0]).toMatchObject({ codec_name: "vp9", tags: expect.objectContaining({ alpha_mode: "1" }) });
      await until(blue, (info) => info.state === "ready");
      // Progress reached app and CLI as `job.progress` events of kind `clip`: queued, render step, done.
      const events = jobEvents.filter((job) => job.kind === "clip" && job.asset === "compositions/cards/red.json");
      expect(events.map((job) => job.state)).toEqual(expect.arrayContaining(["queued", "running", "done"]));
      expect(events.some((job) => job.step === "render" && job.progress > 0 && job.progress < 1)).toBe(true);
      expect(events.at(-1)).toMatchObject({ state: "done", output: join(project, ".frameshell", "cache", "clips", ready.key!) });
    },
    TIMEOUT,
  );

  it(
    "reuses the cache while nothing that changes the pixels changes: moving, trimming, a daemon restart",
    async () => {
      const before = (await renders()).get(red)!;
      const jobs = (await clipJobs()).length;
      await conn.request("clip.move", { cwd: project, clip: red, start: 3 });
      await conn.request("clip.set", { cwd: project, clip: red, transform: { opacity: 0.5 } });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect((await renders()).get(red)).toMatchObject({ state: "ready", key: before.key, file: before.file });
      expect(await clipJobs()).toHaveLength(jobs);

      const second = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
      try {
        const other = await connectToDaemon(second.socketPath, { client: "test" });
        const { clips } = await other.request("clip.renders", { cwd: project, timeline: "main" });
        expect(clips.map((clip) => [clip.clip, clip.state, clip.key])).toEqual([
          [blue, "ready", (await renders()).get(blue)!.key],
          [red, "ready", before.key],
        ]);
        expect((await other.request("job.list", { cwd: project })).jobs).toEqual([]);
        other.close();
      } finally {
        await second.close();
      }
    },
    TIMEOUT,
  );

  it(
    "re-renders only the clips whose composition was edited, and when props change",
    async () => {
      const before = await renders();
      writeCard("blue", { color: "green", seconds: 2 });
      const edited = await until(blue, (info) => info.state === "ready" && info.key !== before.get(blue)!.key);
      expect(edited.file).not.toBe(before.get(blue)!.file);
      expect((await renders()).get(red)!.key).toBe(before.get(red)!.key);
      expect((await clipJobs()).filter((job) => job.asset === "compositions/cards/red.json")).toHaveLength(1);

      await conn.request("clip.set", { cwd: project, clip: red, props: { label: "Launch day" } });
      await until(red, (info) => info.state === "ready" && info.key !== before.get(red)!.key);
    },
    TIMEOUT,
  );

  it(
    "reports a failed render with the adapter's error, and renders again once the composition is fixed",
    async () => {
      writeCard("broken", { fail: true });
      const broken = await addCard("broken", 5);
      const failed = await until(broken, (info) => info.state === "failed");
      expect(failed.error).toContain("asks to fail");
      writeCard("broken", { color: "yellow" });
      await until(broken, (info) => info.state === "ready");
      await conn.request("clip.remove", { cwd: project, clip: broken });
    },
    TIMEOUT,
  );

  it(
    "exports and captures frames with the render overlaid, alpha intact (red at 50% over black)",
    async () => {
      const png = join(tempDir(), "frame.png");
      await conn.request("frame", { cwd: project, timeline: "main", at: 3.5, out: png });
      const { ffmpeg } = await mediaTools();
      const pixel = await runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", png, "-vf", "crop=1:1:32:18,format=rgb24", "-f", "rawvideo", "-"]);
      // Red card at alpha 0.5, then clip opacity 0.5: a quarter of red over the black gap.
      expect(pixel[0]).toBeGreaterThan(40);
      expect(pixel[0]).toBeLessThan(90);
      expect(pixel[1]).toBeLessThan(20);

      // A card added just before the export: the render job waits for it (step `clips`), then overlays it.
      writeCard("late", { color: "white", seconds: 1, delayMs: 300 });
      await addCard("late", 6);
      const { job, output } = await conn.request("render", { cwd: project, timeline: "main", preset: "vertical-1080x1920" });
      let final: JobInfo | undefined;
      for (const deadline = Date.now() + 120_000; Date.now() < deadline && !final; ) {
        const found = (await conn.request("job.list", { cwd: project })).jobs.find((j) => j.id === job.id);
        if (found && (found.state === "done" || found.state === "failed")) final = found;
        else await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(final).toMatchObject({ state: "done" });
      expect(jobEvents.some((event) => event.id === job.id && event.step === "clips")).toBe(true);
      expect(existsSync(output)).toBe(true);
    },
    TIMEOUT,
  );

  it("reports clips no loaded plugin renders as unavailable, and refuses to export them", async () => {
    const other = tempDir();
    await conn.request("project.init", { dir: other });
    const video = (await conn.request("track.add", { cwd: other, kind: "video" })).changes.added[0]!;
    const timeline = JSON.parse(readFileSync(join(other, "timelines", "main.json"), "utf8")) as { tracks: { clips: unknown[] }[] };
    timeline.tracks[0]!.clips.push({ id: "c_hf", type: "hyperframes", source: "compositions/intro/index.html", start: 0, duration: 2 });
    await conn.request("file.write", { path: join(other, "timelines", "main.json"), content: JSON.stringify(timeline) });
    const { clips } = await conn.request("clip.renders", { cwd: other, timeline: "main" });
    expect(clips).toEqual([
      expect.objectContaining({ clip: "c_hf", track: video, state: "unavailable", key: null, error: expect.stringContaining("frameshell plugin install @frameshell/hyperframes") }),
    ]);
    await expect(conn.request("render", { cwd: other, timeline: "main" })).rejects.toMatchObject({
      code: ErrorCode.ClipRenderFailed,
      data: { clip: "c_hf", type: "hyperframes", timeline: "main" },
    });
  });
});
