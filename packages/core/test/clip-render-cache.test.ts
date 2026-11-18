import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

async function renders(format?: string): Promise<Map<string, ClipRenderInfo>> {
  const { clips } = await conn.request("clip.renders", { cwd: project, timeline: "main", ...(format ? { format } : {}) });
  return new Map(clips.map((clip) => [clip.clip, clip]));
}

/** Poll `clip.renders` (in `format`) until `check` holds for clip `id`; returns that state. */
async function until(id: string, check: (info: ClipRenderInfo) => boolean, format?: string): Promise<ClipRenderInfo> {
  let last: ClipRenderInfo | undefined;
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; ) {
    last = (await renders(format)).get(id);
    if (last && check(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`clip ${id} never reached the expected state; last: ${JSON.stringify(last)}`);
}

/** Keys of the cached renders made at the `tall` format's 36x64. */
function tallKeys(): Set<string> {
  const dir = join(project, ".frameshell", "cache", "clips");
  const metas = readdirSync(dir).filter((name) => /^[0-9a-f]{32}\.json$/.test(name));
  return new Set(
    metas.flatMap((name) => {
      const meta = JSON.parse(readFileSync(join(dir, name), "utf8")) as { width?: number; height?: number };
      return meta.width === 36 && meta.height === 64 ? [name.slice(0, 32)] : [];
    }),
  );
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
      // Exported in a vertical format (ADR 0027): every card renders again at that size first.
      writeCard("late", { color: "white", seconds: 1, delayMs: 300 });
      await addCard("late", 6);
      await conn.request("format.add", { cwd: project, id: "tall", width: 36, height: 64 });
      const { job, output } = await conn.request("render", { cwd: project, timeline: "main", formats: ["tall"] });
      let final: JobInfo | undefined;
      for (const deadline = Date.now() + 120_000; Date.now() < deadline && !final; ) {
        const found = (await conn.request("job.list", { cwd: project })).jobs.find((j) => j.id === job.id);
        if (found && (found.state === "done" || found.state === "failed")) final = found;
        else await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(final).toMatchObject({ state: "done" });
      expect(jobEvents.some((event) => event.id === job.id && event.step === "clips")).toBe(true);
      expect(existsSync(output)).toBe(true);
      expect(tallKeys().size).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  it(
    "renders another format only when asked: clip.renders with `format` reports and queues it, background renders stay primary",
    async () => {
      const tall = await renders("tall");
      expect([...tall.values()].every((info) => info.state === "ready" && info.width === 36 && info.height === 64)).toBe(true);
      expect([...tall.values()].every((info) => tallKeys().has(info.key!))).toBe(true);

      const before = { primary: (await renders()).get(red)!.key, tall: tall.get(red)!.key, cached: tallKeys().size };
      await conn.request("clip.set", { cwd: project, clip: red, props: { label: "Vertical" } });
      await until(red, (info) => info.state === "ready" && info.key !== before.primary);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(tallKeys().size).toBe(before.cached);

      const asked = await until(red, (info) => info.state === "ready" && info.key !== before.tall, "tall");
      expect(asked).toMatchObject({ width: 36, height: 64 });
      expect(tallKeys().has(asked.key!)).toBe(true);
      // The primary format by id is the same as no format.
      const primary = (await conn.request("format.list", { cwd: project })).formats[0]!.id;
      expect((await renders(primary)).get(red)!.key).toBe((await renders()).get(red)!.key);
      await expect(conn.request("clip.renders", { cwd: project, timeline: "main", format: "nope" })).rejects.toMatchObject({
        code: ErrorCode.FormatNotFound,
      });
    },
    TIMEOUT,
  );

  it(
    "renders a clip with its props override in that format only (ADR 0027 decision 5), and gc keeps that render",
    async () => {
      const primary = (await renders()).get(red)!.key;
      const plain = (await until(red, (info) => info.state === "ready", "tall")).key!;
      await conn.request("clip.set", { cwd: project, clip: red, format: "tall", props: { label: "Tall" } });
      const tall = await until(red, (info) => info.state === "ready" && info.key !== plain, "tall");
      expect(tall).toMatchObject({ width: 36, height: 64 });
      expect((await renders()).get(red)!.key).toBe(primary);
      const { removed } = await conn.request("gc", { cwd: project, dryRun: true });
      expect(removed.some((entry) => entry.path.includes(tall.key!))).toBe(false);
      await conn.request("clip.set", { cwd: project, clip: red, format: "tall", reset: true });
      expect((await renders("tall")).get(red)!.key).toBe(plain);
    },
    TIMEOUT,
  );

  it(
    "reports generated clips inside nested timelines under their composed id (`<nested clip>/<clip>`), from the same cache",
    async () => {
      writeCard("inner", { color: "blue", seconds: 3 });
      const inner = { schemaVersion: 1, id: "inner", revision: 0, tracks: [{ id: "t_in", kind: "video", clips: [] as unknown[] }] };
      inner.tracks[0]!.clips.push({ id: "c_card", type: "card", source: "compositions/cards/inner.json", start: 0.5, duration: 2 });
      await conn.request("file.write", { path: join(project, "timelines", "inner.json"), content: JSON.stringify(inner) });
      const nestTrack = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
      const main = JSON.parse(readFileSync(join(project, "timelines", "main.json"), "utf8")) as { tracks: { id: string; clips: unknown[] }[] };
      main.tracks.find((t) => t.id === nestTrack)!.clips.push({ id: "c_nest", type: "timeline", source: "timelines/inner.json", start: 20, in: 1, duration: 1 });
      await conn.request("file.write", { path: join(project, "timelines", "main.json"), content: JSON.stringify(main) });

      // The nested file's own clip renders in the background; the root reports it where the nesting shows it.
      const nested = await until("c_nest/c_card", (info) => info.state === "ready");
      expect(nested).toMatchObject({ track: nestTrack, type: "card", source: "compositions/cards/inner.json", hasAlpha: true });
      const own = (await conn.request("clip.renders", { cwd: project, timeline: "inner" })).clips;
      expect(own).toEqual([expect.objectContaining({ clip: "c_card", track: "t_in", key: nested.key, file: nested.file })]);
    },
    TIMEOUT,
  );

  it(
    "gc deletes renders no clip keys any more and keeps every current one, nested ones included",
    async () => {
      const { formats } = await conn.request("format.list", { cwd: project });
      if (!formats.some((format) => format.id === "tall")) await conn.request("format.add", { cwd: project, id: "tall", width: 36, height: 64 });
      // A render of the declared format that a props change made stale.
      const stale = (await until(red, (info) => info.state === "ready", "tall")).key!;
      await conn.request("clip.set", { cwd: project, clip: red, props: { label: "Swept" } });
      await until(red, (info) => info.state === "ready" && info.key !== stale, "tall");
      // Current renders of the declared format (asking queues the nested clip's).
      const tall = new Set([...(await renders("tall")).values()].map((info) => info.key!));
      for (const deadline = Date.now() + 60_000; ; ) {
        const { jobs } = await conn.request("job.list", { cwd: project, active: true });
        if (jobs.length === 0) break;
        if (Date.now() > deadline) throw new Error("clip jobs never settled");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const current = new Set<string>();
      for (const timeline of ["main", "inner"]) {
        for (const clip of (await conn.request("clip.renders", { cwd: project, timeline })).clips) if (clip.key) current.add(clip.key);
      }
      const orphan = "f".repeat(32);
      writeFileSync(join(project, ".frameshell", "cache", "clips", `${orphan}.webm`), "x");
      writeFileSync(join(project, ".frameshell", "cache", "clips", `${orphan}.json`), "{}");

      expect(tallKeys().has(stale)).toBe(true);
      const { removed, skipped } = await conn.request("gc", { cwd: project });
      expect(skipped).toEqual([]);
      const keyOf = (path: string) => path.split("/").at(-1)!.split(".")[0]!;
      const keys = new Set(removed.filter((entry) => entry.kind === "clip").map((entry) => keyOf(entry.path)));
      expect(keys).toContain(orphan);
      // Renders of a declared format stay (background renders never make them again); once it is removed they go.
      for (const key of tall) expect(keys).not.toContain(key);
      expect(keys).toContain(stale);
      await conn.request("format.remove", { cwd: project, id: "tall" });
      const unused = (await conn.request("gc", { cwd: project, dryRun: true })).removed.map((entry) => keyOf(entry.path));
      for (const key of tall) expect(unused).toContain(key);
      // Earlier edits left renders of old keys behind.
      expect(keys.size).toBeGreaterThan(1);
      for (const key of current) expect(keys).not.toContain(key);
      for (const timeline of ["main", "inner"]) {
        for (const clip of (await conn.request("clip.renders", { cwd: project, timeline })).clips) {
          if (clip.key) expect(clip.state).toBe("ready");
        }
      }
    },
    TIMEOUT,
  );

  it(
    "gives the adapter's inputs() the project and ensureBinary, so a key can depend on a tool's version",
    async () => {
      writeCard("context", { color: "green", seconds: 1, needsContext: true });
      const id = await addCard("context", 9);
      expect(await until(id, (info) => info.state === "ready" || info.state === "failed")).toMatchObject({ state: "ready", error: null });
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
    // Its key is unknown, so gc cannot tell which render it would use: the cache is left alone.
    mkdirSync(join(other, ".frameshell", "cache", "clips"), { recursive: true });
    writeFileSync(join(other, ".frameshell", "cache", "clips", `${"e".repeat(32)}.webm`), "x");
    const gc = await conn.request("gc", { cwd: other });
    expect(gc.removed).toEqual([]);
    expect(gc.skipped).toEqual([{ area: "clips", reason: expect.stringContaining("c_hf") }]);
  });
});

// Live preview (ADR 0010): `clip.live` asks the adapter for a page and checks it stays inside the project.
describe("clip.live", () => {
  const live = (clip: string) => conn.request("clip.live", { cwd: project, timeline: "main", clip });
  let liveTrack = "";
  const addLive = async (name: string, card: Record<string, unknown>, type = "card"): Promise<string> => {
    writeCard(name, { color: "green", seconds: 2, ...card });
    const result = await conn.request("clip.add", { cwd: project, track: liveTrack, type, source: `compositions/cards/${name}.json`, start: 40 + 3 * (await renders()).size, duration: 1 });
    return result.changes.added[0]!;
  };

  beforeAll(async () => {
    liveTrack = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
    writeFileSync(join(project, "compositions", "cards", "live.html"), "<!doctype html><title>card</title>");
  });

  it("returns the adapter's page, its head script and the clip's render key, without writing anything", async () => {
    const clip = await addLive("live-green", {});
    const page = await live(clip);
    expect(page).toEqual({
      clip,
      root: "compositions/cards",
      entry: "compositions/cards/live.html",
      head: expect.stringContaining("window.frameshellLive"),
      key: (await renders()).get(clip)!.key,
    });
    // The adapter got the project format.
    expect(page.head).toContain("window.cardFormat = [64,36,");
    expect(page.head).toContain('"green"');
  });

  it("returns the sheet of the clip's elements for the host bridge (ADR 0021), and none without them", async () => {
    const clip = await addLive("live-elements", {});
    expect(await live(clip)).not.toHaveProperty("elementCss");
    await conn.request("clip.set", { cwd: project, clip, elements: { "#title": { y: -40 }, "#a": { scale: 2 } } });
    expect(await live(clip)).toMatchObject({ elementCss: "#a { scale: 2 !important; }\n#title { translate: 0px -40px !important; }" });
  });

  it("addresses a clip inside a nested timeline as clip.renders does", async () => {
    const page = await live("c_nest/c_card");
    expect(page).toMatchObject({ clip: "c_nest/c_card", entry: "compositions/cards/live.html", key: (await renders()).get("c_nest/c_card")!.key });
  });

  it("is LiveUnavailable when the adapter has none, fails, or its page is missing", async () => {
    const still = await addLive("live-still", {}, "still");
    await expect(live(still)).rejects.toMatchObject({
      code: ErrorCode.LiveUnavailable,
      message: expect.stringContaining("card-plugin 0.1.0 adapter has no live preview"),
      data: { clip: still, type: "still", timeline: "main" },
    });
    const failing = await addLive("live-fail", { liveFail: true });
    await expect(live(failing)).rejects.toMatchObject({ code: ErrorCode.LiveUnavailable, message: expect.stringContaining("asks live preview to fail") });
    const missing = await addLive("live-missing", { liveEntry: "compositions/cards/nope.html" });
    await expect(live(missing)).rejects.toMatchObject({ code: ErrorCode.LiveUnavailable, message: expect.stringContaining("compositions/cards/nope.html does not exist") });
  });

  it("refuses a page outside the project, or an entry outside its root, as OutsideProject", async () => {
    for (const card of [{ liveRoot: "../elsewhere" }, { liveRoot: "/etc", liveEntry: "/etc/hosts" }, { liveRoot: "compositions/cards", liveEntry: "timelines/main.json" }]) {
      const clip = await addLive(`live-out-${Object.values(card).join("-").replace(/\W/g, "")}`, card);
      await expect(live(clip)).rejects.toMatchObject({ code: ErrorCode.OutsideProject });
    }
  });

  it("names the generated clips for an unknown id, and says why a project without the plugin has none", async () => {
    await expect(live("c_nope")).rejects.toMatchObject({ code: ErrorCode.ClipNotFound, message: expect.stringContaining("c_nest/c_card") });
    const other = tempDir();
    await conn.request("project.init", { dir: other });
    await conn.request("track.add", { cwd: other, kind: "video" });
    const timeline = JSON.parse(readFileSync(join(other, "timelines", "main.json"), "utf8")) as { tracks: { clips: unknown[] }[] };
    timeline.tracks[0]!.clips.push({ id: "c_hf", type: "hyperframes", source: "compositions/intro/index.html", start: 0, duration: 2 });
    await conn.request("file.write", { path: join(other, "timelines", "main.json"), content: JSON.stringify(timeline) });
    await expect(conn.request("clip.live", { cwd: other, timeline: "main", clip: "c_hf" })).rejects.toMatchObject({
      code: ErrorCode.LiveUnavailable,
      message: expect.stringContaining("frameshell plugin install @frameshell/hyperframes"),
    });
  });
});

// Style tokens (ADR 0028): an adapter with `styleTokens` gets the sheet of style.json, and its key counts it.
describe("style tokens in generated clips", () => {
  let styled = "";
  let tokenTrack = "";
  const own = () => tempDir();

  beforeAll(async () => {
    styled = own();
    await conn.request("project.init", { dir: styled });
    const configPath = join(styled, "frameshell.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...config, resolution: { width: 64, height: 36 } }));
    installLocalPlugin(styled, CARD_PLUGIN, "card-plugin");
    await conn.request("project.trust", { cwd: styled, decision: "trust" });
    mkdirSync(join(styled, "compositions", "cards"), { recursive: true });
    writeFileSync(join(styled, "compositions", "cards", "tokens.json"), JSON.stringify({ color: "blue", seconds: 1, requireStyle: "--fs-color-accent: #ff5a1f;" }));
    writeFileSync(join(styled, "compositions", "cards", "plain.json"), JSON.stringify({ color: "blue", seconds: 1 }));
    writeFileSync(join(styled, "compositions", "cards", "live.html"), "<!doctype html><title>card</title>");
    tokenTrack = (await conn.request("track.add", { cwd: styled, kind: "video" })).changes.added[0]!;
  }, TIMEOUT);

  const states = async () => {
    const { clips } = await conn.request("clip.renders", { cwd: styled, timeline: "main" });
    return new Map(clips.map((clip) => [clip.clip, clip]));
  };
  const settled = async (id: string) => {
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; ) {
      const info = (await states()).get(id)!;
      if (info.state === "ready" || info.state === "failed") return info;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`clip ${id} never settled`);
  };

  it(
    "renders with the sheet once style.json sets the value, re-keying only the clips whose adapter takes tokens",
    async () => {
      const add = async (type: string, name: string, start: number) =>
        (await conn.request("clip.add", { cwd: styled, track: tokenTrack, type, source: `compositions/cards/${name}.json`, start, duration: 1 })).changes.added[0]!;
      const token = await add("token-card", "tokens", 0);
      const plain = await add("token-card", "plain", 1);
      const card = await add("card", "plain", 2);
      // No style.json: no sheet, so the card that needs one fails and the others keep the recipe's keys.
      expect(await settled(token)).toMatchObject({ state: "failed", error: expect.stringContaining("got no style sheet") });
      const before = await states();
      expect(before.get(plain)!.key).not.toBe(before.get(token)!.key);
      await expect(conn.request("clip.live", { cwd: styled, timeline: "main", clip: plain })).resolves.not.toHaveProperty("styleCss");

      await conn.request("style.set", { cwd: styled, path: "colors.accent", value: "#FF5A1F" });
      expect(await settled(token)).toMatchObject({ state: "ready" });
      const after = await states();
      expect(after.get(plain)!.key).not.toBe(before.get(plain)!.key);
      expect(after.get(card)!.key).toBe(before.get(card)!.key);
      const page = await conn.request("clip.live", { cwd: styled, timeline: "main", clip: plain });
      expect(page.styleCss).toContain("--fs-color-accent: #ff5a1f;");
      expect(page.styleCss).toContain("--fs-motion-standard: 0.3s;");
      expect(await conn.request("clip.live", { cwd: styled, timeline: "main", clip: card })).not.toHaveProperty("styleCss");

      // A value outside the sheet (a brand note) keeps the keys.
      await conn.request("style.set", { cwd: styled, path: "notes", value: ["Calm voice."] });
      expect((await states()).get(plain)!.key).toBe(after.get(plain)!.key);
    },
    TIMEOUT,
  );
});

// Motion blur (ADR 0041): an adapter with `motionBlur` gets the clip's blur, defaults filled in, in a second render beside
// the sharp one (decision 11). The blur-card paints its blurred render red and its sharp one blue, so a pixel says which
// render a file or frame used.
describe("motion blur in generated clips", () => {
  let dir = "";
  let blurTrack = "";
  const requireBlur = { shutter: 90, samples: 8, blend: "linear" };

  beforeAll(async () => {
    dir = tempDir();
    await conn.request("project.init", { dir });
    const configPath = join(dir, "frameshell.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...config, resolution: { width: 64, height: 36 } }));
    installLocalPlugin(dir, CARD_PLUGIN, "card-plugin");
    await conn.request("project.trust", { cwd: dir, decision: "trust" });
    mkdirSync(join(dir, "compositions", "cards"), { recursive: true });
    const card = (name: string, value: Record<string, unknown>) => writeFileSync(join(dir, "compositions", "cards", `${name}.json`), JSON.stringify(value));
    card("blur", { color: "blue", blurColor: "red", seconds: 1, requireBlur, delayMs: 300, blurDelayMs: 600 });
    card("refuse", { color: "blue", blurColor: "red", seconds: 1, refuseBlur: true });
    card("plain", { color: "blue", seconds: 1 });
    card("noted", { color: "blue", blurColor: "red", seconds: 1, warn: "Clip noted caps its blur." });
    blurTrack = (await conn.request("track.add", { cwd: dir, kind: "video" })).changes.added[0]!;
  }, TIMEOUT);

  const add = async (type: string, name: string, start: number, props?: Record<string, unknown>) =>
    (await conn.request("clip.add", { cwd: dir, track: blurTrack, type, source: `compositions/cards/${name}.json`, start, duration: 1, ...(props ? { props } : {}) }))
      .changes.added[0]!;
  const isBlue = ({ red, blue }: { red: number; blue: number }) => red < 40 && blue > 150;
  const states = async () => new Map((await conn.request("clip.renders", { cwd: dir, timeline: "main" })).clips.map((clip) => [clip.clip, clip]));
  /** Poll `clip.renders` until `check` holds for clip `id`; every state seen on the way is pushed to `seen`. */
  const until = async (id: string, check: (info: ClipRenderInfo) => boolean, seen: ClipRenderInfo[] = []) => {
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; ) {
      const info = (await states()).get(id)!;
      seen.push(info);
      if (check(info)) return info;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`clip ${id} never reached the expected state; last: ${JSON.stringify(seen.at(-1))}`);
  };
  /** Red and blue of the middle pixel at `at` seconds of a video or image file. */
  const pixel = async (file: string, at = 0) => {
    const { ffmpeg } = await mediaTools();
    const args = ["-hide_banner", "-loglevel", "error", ...(at > 0 ? ["-ss", String(at)] : []), "-i", file, "-frames:v", "1"];
    const rgb = await runBuffer(ffmpeg, [...args, "-vf", "crop=1:1:32:18,format=rgb24", "-f", "rawvideo", "-"]);
    return { red: rgb[0]!, blue: rgb[2]! };
  };
  const exported = async (quality?: "draft" | "final") => {
    const out = join(tempDir(), `${quality ?? "untiered"}.mp4`);
    const { job } = await conn.request("render", { cwd: dir, timeline: "main", out, ...(quality ? { quality } : {}) });
    for (const deadline = Date.now() + 120_000; Date.now() < deadline; ) {
      const found = (await conn.request("job.list", { cwd: dir })).jobs.find((one) => one.id === job.id)!;
      if (found.state === "done" || found.state === "failed") return { job: found, out };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`render ${job.id} never finished`);
  };

  it(
    "keeps the sharp render as the draft, renders the blurred one after it, and keeps the keys of clips without blur",
    async () => {
      const blurred = await add("blur-card", "blur", 0);
      const sharp = await add("card", "plain", 1);
      // No blur: one render, keyed by the recipe as before.
      const plain = await until(blurred, (info) => info.state === "ready");
      expect(plain).not.toHaveProperty("final");
      const sharpKey = (await until(sharp, (info) => info.state === "ready")).key;

      const set = await conn.request("clip.set", { cwd: dir, clip: blurred, motionBlur: { shutter: 90 } });
      expect(set.warnings ?? []).toEqual([]);
      const seen: ClipRenderInfo[] = [];
      const done = await until(blurred, (info) => info.final?.state === "ready", seen);
      // The draft keeps the sharp key and stays ready; the preview had it while the blurred render was made.
      expect(done).toMatchObject({ state: "ready", key: plain.key, file: plain.file });
      expect(seen.some((info) => info.state === "ready" && info.final !== undefined && info.final.state !== "ready")).toBe(true);
      expect(done.final).toMatchObject({ file: `.frameshell/cache/clips/${done.final!.key}.webm`, hasAlpha: true, width: 64, height: 36, progress: 1, error: null });
      expect(done.final!.key).not.toBe(plain.key);

      // A clip added with blur gets its draft first, then the blurred one, which waits for it meanwhile.
      const second = await add("blur-card", "blur", 2, { label: "Second" });
      await conn.request("clip.set", { cwd: dir, clip: second, motionBlur: { shutter: 90 } });
      const order: ClipRenderInfo[] = [];
      const both = await until(second, (info) => info.final?.state === "ready", order);
      expect(order.some((info) => info.state !== "ready" && info.final?.state === "waiting")).toBe(true);
      const jobs = (await conn.request("job.list", { cwd: dir })).jobs.filter((job) => job.kind === "clip");
      const started = (key: string) => jobs.findIndex((job) => job.output?.endsWith(key));
      expect(started(both.key!)).toBeLessThan(started(both.final!.key));

      const warned = await conn.request("clip.set", { cwd: dir, clip: sharp, motionBlur: {} });
      expect(warned.warnings).toEqual([expect.stringMatching(/card plugin does not apply motion blur yet/)]);
      expect((await states()).get(sharp)).toMatchObject({ key: sharpKey });
      expect((await states()).get(sharp)).not.toHaveProperty("final");
      await conn.request("clip.remove", { cwd: dir, clip: second });
    },
    TIMEOUT,
  );

  it(
    "exports a draft from the sharp render and a final, an untiered render and frames from the blurred one",
    async () => {
      const draft = await exported("draft");
      expect(draft.job.state).toBe("done");
      expect(isBlue(await pixel(draft.out, 0.5))).toBe(true);
      for (const quality of ["final", undefined] as const) {
        const final = await exported(quality);
        expect(final.job.state).toBe("done");
        expect(final.job.warnings.filter((warning) => warning.includes("motion blur"))).toEqual([]);
        expect((await pixel(final.out, 0.5)).red).toBeGreaterThan(150);
      }
      const png = join(tempDir(), "frame.png");
      await conn.request("frame", { cwd: dir, timeline: "main", at: 0.5, out: png });
      expect((await pixel(png)).red).toBeGreaterThan(150);
    },
    TIMEOUT,
  );

  it(
    "exports a clip whose plugin refuses the blur from its sharp render, with a warning, and never retries the refusal",
    async () => {
      const refused = await add("blur-card", "refuse", 4);
      await conn.request("clip.set", { cwd: dir, clip: refused, motionBlur: { shutter: 90 } });
      const failed = await until(refused, (info) => info.final?.state === "failed");
      expect(failed).toMatchObject({ state: "ready", final: { error: expect.stringContaining("cannot be motion-blurred"), file: null, refused: true } });
      const before = (await conn.request("job.list", { cwd: dir })).jobs.filter((job) => job.output?.endsWith(failed.final!.key)).length;

      const { job, out } = await exported();
      expect(job.state).toBe("done");
      expect(job.warnings).toEqual([expect.stringMatching(new RegExp(`^Clip ${refused} is used without motion blur, from its sharp render: .*cannot be motion-blurred`))]);
      expect(isBlue(await pixel(out, 4.5))).toBe(true);
      // The blurred clip beside it still exports blurred.
      expect((await pixel(out, 0.5)).red).toBeGreaterThan(150);
      expect((await conn.request("job.list", { cwd: dir })).jobs.filter((one) => one.output?.endsWith(failed.final!.key)).length).toBe(before);
      await conn.request("clip.remove", { cwd: dir, clip: refused });
    },
    TIMEOUT,
  );

  it(
    "gc keeps both renders of a blurred clip, and the blurred one goes once the blur is cleared",
    async () => {
      const [blurred] = [...(await states()).values()].filter((info) => info.final !== undefined);
      const { key, final } = await until(blurred!.clip, (info) => info.final?.state === "ready");
      for (const deadline = Date.now() + 60_000; (await conn.request("job.list", { cwd: dir, active: true })).jobs.length > 0; ) {
        if (Date.now() > deadline) throw new Error("clip jobs never settled");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const keyOf = (path: string) => path.split("/").at(-1)!.split(".")[0]!;
      const kept = (await conn.request("gc", { cwd: dir, dryRun: true })).removed.map((entry) => keyOf(entry.path));
      expect(kept).not.toContain(key);
      expect(kept).not.toContain(final!.key);

      await conn.request("clip.set", { cwd: dir, clip: blurred!.clip, motionBlur: null });
      expect((await states()).get(blurred!.clip)).toMatchObject({ key, state: "ready" });
      const unused = (await conn.request("gc", { cwd: dir, dryRun: true })).removed.map((entry) => keyOf(entry.path));
      expect(unused).toContain(final!.key);
      expect(unused).not.toContain(key);
    },
    TIMEOUT,
  );

  it(
    "tells what a blurred render says (ctx.warn) and a refused blur on frames, reviews and exports, from the cache too",
    async () => {
      const noted = await add("blur-card", "noted", 5);
      const refused = await add("blur-card", "refuse", 6);
      for (const id of [noted, refused]) await conn.request("clip.set", { cwd: dir, clip: id, motionBlur: { shutter: 90 } });
      await until(noted, (info) => info.final?.state === "ready");
      await until(refused, (info) => info.final?.state === "failed");
      const frame = () => conn.request("frame", { cwd: dir, timeline: "main", at: 5.5, out: join(tempDir(), "frame.png") });
      const sharpWords = new RegExp(`^Clip ${refused} is used without motion blur, from its sharp render: .*cannot be motion-blurred`);

      expect((await frame()).warnings).toEqual(expect.arrayContaining(["Clip noted caps its blur.", expect.stringMatching(sharpWords)]));
      // The render is cached now: the note comes from its entry, not from a render.
      expect((await frame()).warnings).toContain("Clip noted caps its blur.");

      const review = await conn.request("review", { cwd: dir, timeline: "main", from: 5, to: 7, sheets: ["contact"] });
      expect(review.warnings.filter((warning) => warning === "Clip noted caps its blur.")).toHaveLength(1);
      expect(review.warnings).toEqual(expect.arrayContaining([expect.stringMatching(sharpWords)]));

      expect((await exported("final")).job.warnings).toContain("Clip noted caps its blur.");
      expect((await exported("draft")).job.warnings).not.toContain("Clip noted caps its blur.");
      for (const id of [noted, refused]) await conn.request("clip.remove", { cwd: dir, clip: id });
    },
    TIMEOUT,
  );
});

// Finals (ADR 0035 slice 2, on the draft/final model of ADR 0041 decision 11): a `final-card` is an adapter with
// `finals`, like Blender. Its draft is blue and its final red; the final is rendered only when an export waits for it.
describe("finals of generated clips", () => {
  let dir = "";
  let finalTrack = "";

  beforeAll(async () => {
    dir = tempDir();
    await conn.request("project.init", { dir });
    const configPath = join(dir, "frameshell.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...config, resolution: { width: 64, height: 36 } }));
    installLocalPlugin(dir, CARD_PLUGIN, "card-plugin");
    await conn.request("project.trust", { cwd: dir, decision: "trust" });
    mkdirSync(join(dir, "compositions", "cards"), { recursive: true });
    const card = (name: string, value: Record<string, unknown>) => writeFileSync(join(dir, "compositions", "cards", `${name}.json`), JSON.stringify(value));
    card("quick", { color: "blue", finalColor: "red", seconds: 1, estimateSeconds: 120 });
    card("slow", { color: "blue", finalColor: "red", seconds: 1, estimateSeconds: 240 });
    card("other", { color: "blue", finalColor: "red", seconds: 1, estimateSeconds: 120, other: true });
    card("unknown", { color: "blue", finalColor: "red", seconds: 1, noEstimate: true });
    finalTrack = (await conn.request("track.add", { cwd: dir, kind: "video" })).changes.added[0]!;
  }, TIMEOUT);

  const add = async (name: string, start: number) =>
    (await conn.request("clip.add", { cwd: dir, track: finalTrack, type: "final-card", source: `compositions/cards/${name}.json`, start, duration: 1 })).changes
      .added[0]!;
  const states = async () => new Map((await conn.request("clip.renders", { cwd: dir, timeline: "main" })).clips.map((clip) => [clip.clip, clip]));
  const until = async (id: string, check: (info: ClipRenderInfo) => boolean) => {
    let last: ClipRenderInfo | undefined;
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; ) {
      last = (await states()).get(id)!;
      if (check(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`clip ${id} never reached the expected state; last: ${JSON.stringify(last)}`);
  };
  const idle = async () => {
    for (const deadline = Date.now() + 60_000; (await conn.request("job.list", { cwd: dir, active: true })).jobs.length > 0; ) {
      if (Date.now() > deadline) throw new Error("jobs never settled");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const pixel = async (file: string, at = 0) => {
    const { ffmpeg } = await mediaTools();
    const args = ["-hide_banner", "-loglevel", "error", ...(at > 0 ? ["-ss", String(at)] : []), "-i", file, "-frames:v", "1"];
    const rgb = await runBuffer(ffmpeg, [...args, "-vf", "crop=1:1:32:18,format=rgb24", "-f", "rawvideo", "-"]);
    return { red: rgb[0]!, blue: rgb[2]! };
  };
  const isBlue = ({ red, blue }: { red: number; blue: number }) => red < 40 && blue > 150;
  const exported = async (params: { quality?: "draft" | "final"; yes?: boolean } = {}) => {
    const out = join(tempDir(), "out.mp4");
    const started = await conn.request("render", { cwd: dir, timeline: "main", out, ...params });
    for (const deadline = Date.now() + 120_000; Date.now() < deadline; ) {
      const found = (await conn.request("job.list", { cwd: dir })).jobs.find((one) => one.id === started.job.id)!;
      if (found.state === "done" || found.state === "failed") return { started, job: found, out };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`render ${started.job.id} never finished`);
  };
  const confirmation = async (params: { quality?: "final" } = {}) => {
    const error = await conn.request("render", { cwd: dir, timeline: "main", out: join(tempDir(), "refused.mp4"), ...params }).then(
      () => null,
      (caught: unknown) => caught as { code: number; message: string; data: { finals: { clip: string; seconds: number | null }[]; seconds: number | null; limit: number } },
    );
    expect(error).not.toBeNull();
    expect(error!.code).toBe(ErrorCode.ConfirmationRequired);
    return error!;
  };

  it(
    "renders the draft in the background and never the final, which waits for an export",
    async () => {
      const quick = await add("quick", 0);
      const info = await until(quick, (state) => state.state === "ready");
      expect(info.final).toMatchObject({ state: "waiting", file: null, job: null, refused: false, onDemand: true });
      expect(info.final!.key).not.toBe(info.key);
      await idle();
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect((await states()).get(quick)!.final).toMatchObject({ state: "waiting" });
      const jobs = (await conn.request("job.list", { cwd: dir })).jobs.filter((job) => job.output?.endsWith(info.final!.key));
      expect(jobs).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "draft exports use the draft with a warning; frames use the draft until the final exists; a final export makes it",
    async () => {
      const [quick] = [...(await states()).keys()];
      const draft = await exported({ quality: "draft" });
      expect(draft.job.state).toBe("done");
      expect(draft.started.warnings).toEqual([expect.stringMatching(new RegExp(`^Clip ${quick} \\(final-card\\) is exported from its draft render`))]);
      expect(isBlue(await pixel(draft.out, 0.5))).toBe(true);

      const png = join(tempDir(), "frame.png");
      const frame = await conn.request("frame", { cwd: dir, timeline: "main", at: 0.5, out: png });
      expect(frame.warnings).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^Clip ${quick} \\(final-card\\) is drawn from its draft render`))]));
      expect(isBlue(await pixel(png))).toBe(true);

      // 120 s estimated: under the 5-minute limit, no confirmation.
      const final = await exported({ quality: "final" });
      expect(final.job.state).toBe("done");
      expect(final.started.warnings.filter((warning) => warning.includes("draft"))).toEqual([]);
      expect((await pixel(final.out, 0.5)).red).toBeGreaterThan(150);
      expect((await states()).get(quick!)!.final).toMatchObject({ state: "ready", progress: 1 });

      const again = await conn.request("frame", { cwd: dir, timeline: "main", at: 0.5, out: png });
      expect(again.warnings.filter((warning) => warning.includes("draft"))).toEqual([]);
      expect((await pixel(png)).red).toBeGreaterThan(150);
    },
    TIMEOUT,
  );

  it(
    "asks for a confirmation when the missing finals are estimated over 5 minutes or unknown, and renders with yes",
    async () => {
      const slow = await add("slow", 1);
      const other = await add("other", 2);
      await until(slow, (state) => state.state === "ready");
      await until(other, (state) => state.state === "ready");
      // 240 + 120 s: the clip at 0 has its final already, so only these two count.
      const refused = await confirmation();
      expect(refused.data).toMatchObject({ seconds: 360, limit: 300, finals: [{ clip: slow, seconds: 240 }, { clip: other, seconds: 120 }] });
      expect(refused.message).toMatch(/about 6 min.*`yes: true`/);
      expect((await conn.request("job.list", { cwd: dir, active: true })).jobs).toEqual([]);
      // A draft export needs no confirmation.
      expect((await exported({ quality: "draft" })).job.state).toBe("done");

      const confirmed = await exported({ yes: true });
      expect(confirmed.job.state).toBe("done");
      expect((await pixel(confirmed.out, 1.5)).red).toBeGreaterThan(150);
      // Every final is cached now: nothing to confirm.
      expect((await exported({ quality: "final" })).job.state).toBe("done");

      const unknown = await add("unknown", 3);
      await until(unknown, (state) => state.state === "ready");
      expect((await confirmation({ quality: "final" })).data).toMatchObject({ seconds: null, finals: [{ clip: unknown, seconds: null }] });
      await conn.request("clip.remove", { cwd: dir, clip: unknown });
    },
    TIMEOUT,
  );

  it(
    "gc keeps both renders of a clip with a final",
    async () => {
      await idle();
      const infos = [...(await states()).values()];
      const keyOf = (path: string) => path.split("/").at(-1)!.split(".")[0]!;
      const removed = (await conn.request("gc", { cwd: dir, dryRun: true })).removed.map((entry) => keyOf(entry.path));
      for (const info of infos) {
        expect(removed).not.toContain(info.key);
        expect(removed).not.toContain(info.final!.key);
      }
    },
    TIMEOUT,
  );
});

// Timing (ADR 0029 decision 8): a `beat-card` whose card asks for beats and markers gets them inside its range, in
// composition seconds; its key moves with them, while a clip that does not ask keeps its key.
describe("timing in generated clips", () => {
  let dir = "";
  let beatTrack = "";

  /** A trusted 64x36 project at 30 fps with the card plugin and an empty `compositions/cards/`. */
  const cardProject = async () => {
    const at = tempDir();
    await conn.request("project.init", { dir: at });
    const configPath = join(at, "frameshell.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...config, fps: 30, resolution: { width: 64, height: 36 } }));
    installLocalPlugin(at, CARD_PLUGIN, "card-plugin");
    await conn.request("project.trust", { cwd: at, decision: "trust" });
    mkdirSync(join(at, "compositions", "cards"), { recursive: true });
    return at;
  };

  beforeAll(async () => {
    dir = await cardProject();
    writeFileSync(join(dir, "compositions", "cards", "plain.json"), JSON.stringify({ color: "blue", seconds: 1 }));
    writeFileSync(join(dir, "compositions", "cards", "live.html"), "<!doctype html><title>card</title>");
    beatTrack = (await conn.request("track.add", { cwd: dir, kind: "video" })).changes.added[0]!;
  }, TIMEOUT);

  const states = async () => new Map((await conn.request("clip.renders", { cwd: dir, timeline: "main" })).clips.map((clip) => [clip.clip, clip]));
  const settled = async (id: string) => {
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; ) {
      const info = (await states()).get(id)!;
      if (info.state === "ready" || info.state === "failed") return info;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`clip ${id} never settled`);
  };

  it(
    "renders a clip that asks with the beats and markers inside it, re-keying only that clip when they move",
    async () => {
      await conn.request("tempo.set", { cwd: dir, bpm: 120 });
      const hook = (await conn.request("marker.add", { cwd: dir, at: 1.2, label: "hook" })).changes.added[0]!;
      // At 120 BPM from 0 s the clip (timeline 1..2 s, composition 0..1 s) hears beats 3 and 4; no bar starts in it.
      const expected = { beats: [{ at: 0, beat: 3 }, { at: 0.5, beat: 4 }], tempo: { bpm: 120, meter: 4 }, markers: [{ at: 0.2, id: hook, label: "hook" }] };
      const card = { color: "blue", seconds: 1, timing: ["beats", "markers"], requireTiming: expected };
      writeFileSync(join(dir, "compositions", "cards", "beats.json"), JSON.stringify(card));
      const add = async (type: string, name: string, start: number) =>
        (await conn.request("clip.add", { cwd: dir, track: beatTrack, type, source: `compositions/cards/${name}.json`, start, duration: 1 })).changes.added[0]!;
      const timed = await add("beat-card", "beats", 1);
      const plain = await add("card", "plain", 3);
      expect(await settled(timed)).toMatchObject({ state: "ready", error: null });
      const page = await conn.request("clip.live", { cwd: dir, timeline: "main", clip: timed });
      expect(page.head).toContain(`window.cardTiming = ${JSON.stringify(expected)};`);
      const before = await states();

      await conn.request("marker.set", { cwd: dir, marker: hook, at: 1.5 });
      const moved = await states();
      expect(moved.get(timed)!.key).not.toBe(before.get(timed)!.key);
      expect(moved.get(plain)!.key).toBe(before.get(plain)!.key);

      await conn.request("tempo.set", { cwd: dir, bpm: 100 });
      const retimed = await states();
      expect(retimed.get(timed)!.key).not.toBe(moved.get(timed)!.key);
      expect(retimed.get(plain)!.key).toBe(before.get(plain)!.key);
      // The render got the timing it was keyed with: the card refuses any other, so the new timing fails it.
      expect(await settled(timed)).toMatchObject({ state: "failed", error: expect.stringContaining('"bpm":100') });
    },
    TIMEOUT,
  );

  it(
    "renders a nested clip that asks once, keyed through its host in the background, and export uses that render",
    async () => {
      const at = await cardProject();
      await conn.request("tempo.set", { cwd: at, bpm: 120 });
      const tempo = { bpm: 120, meter: 4 };
      // 120 BPM from 0 s: the top card (timeline 0.5..1.5 s) hears beats 2 and 3; the nested card (its timeline's
      // 0.5..1.5 s, shown from timeline 2.5 s) beats 6 and 7. Its own file has no tempo, so keyed there it would get
      // `no-tempo`, which the card refuses: a render against the nested file fails a job.
      const card = (beats: number[]) => ({ color: "blue", seconds: 1, timing: ["beats"], requireTiming: { beats: [{ at: 0, beat: beats[0] }, { at: 0.5, beat: beats[1] }], tempo } });
      writeFileSync(join(at, "compositions", "cards", "top.json"), JSON.stringify(card([2, 3])));
      writeFileSync(join(at, "compositions", "cards", "inner.json"), JSON.stringify(card([6, 7])));
      // The host first, so no refresh ever sees the nested file without it.
      const hostTrack = (await conn.request("track.add", { cwd: at, kind: "video" })).changes.added[0]!;
      const main = JSON.parse(readFileSync(join(at, "timelines", "main.json"), "utf8")) as { tracks: { id: string; clips: unknown[] }[] };
      main.tracks.find((t) => t.id === hostTrack)!.clips.push(
        { id: "c_top", type: "beat-card", source: "compositions/cards/top.json", start: 0.5, duration: 1 },
        { id: "c_nest", type: "timeline", source: "timelines/inner.json", start: 2, duration: 2 },
      );
      await conn.request("file.write", { path: join(at, "timelines", "main.json"), content: JSON.stringify(main) });
      const inner = { schemaVersion: 1, id: "inner", revision: 0, tracks: [{ id: "t_in", kind: "video", clips: [] as unknown[] }] };
      inner.tracks[0]!.clips.push({ id: "c_beat", type: "beat-card", source: "compositions/cards/inner.json", start: 0.5, duration: 1 });
      await conn.request("file.write", { path: join(at, "timelines", "inner.json"), content: JSON.stringify(inner) });

      // Background renders only: `clip.renders` is not asked until they settle, so it queues nothing itself.
      const jobs = async () => (await conn.request("job.list", { cwd: at })).jobs.filter((job) => job.kind === "clip");
      for (const deadline = Date.now() + 60_000; ; ) {
        const now = await jobs();
        if (now.length >= 2 && now.every((job) => job.state === "done" || job.state === "failed")) break;
        if (Date.now() > deadline) throw new Error(`background clip renders never settled: ${JSON.stringify(now)}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const background = await jobs();
      expect(background.map((job) => [job.asset, job.state]).sort()).toEqual([
        ["compositions/cards/inner.json", "done"],
        ["compositions/cards/top.json", "done"],
      ]);

      const shown = new Map((await conn.request("clip.renders", { cwd: at, timeline: "main" })).clips.map((clip) => [clip.clip, clip]));
      expect(shown.get("c_top")).toMatchObject({ state: "ready" });
      expect(shown.get("c_nest/c_beat")).toMatchObject({ state: "ready" });
      const cache = join(at, ".frameshell", "cache", "clips");
      const entries = () => new Set(readdirSync(cache).filter((name) => /^[0-9a-f]{32}\.json$/.test(name)).map((name) => name.slice(0, 32)));
      expect(entries()).toEqual(new Set([shown.get("c_top")!.key, shown.get("c_nest/c_beat")!.key]));

      // Export keys each clip as the preview does: no new render, and the cards accept the timing they get.
      const out = join(tempDir(), "timed.mp4");
      const { job } = await conn.request("render", { cwd: at, timeline: "main", out });
      let final: JobInfo | undefined;
      for (const deadline = Date.now() + 120_000; Date.now() < deadline && !final; ) {
        const found = (await conn.request("job.list", { cwd: at })).jobs.find((one) => one.id === job.id);
        if (found && (found.state === "done" || found.state === "failed")) final = found;
        else await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(final).toMatchObject({ state: "done" });
      expect(await jobs()).toHaveLength(2);
      expect(entries()).toEqual(new Set([shown.get("c_top")!.key, shown.get("c_nest/c_beat")!.key]));
      // gc keeps the host's key of the nested clip.
      const { removed } = await conn.request("gc", { cwd: at, dryRun: true });
      expect(removed.filter((entry) => entry.kind === "clip")).toEqual([]);
    },
    TIMEOUT,
  );
});
