import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon, methods } from "@frameshell/protocol";
import type { Timeline } from "@frameshell/schema";
import { type Daemon, SHEET_GAP, applyLook, propsFlags, startDaemon, withVariant } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, runBuffer, testBinaryManager } from "./media-tools.js";
import { CARD_PLUGIN, installLocalPlugin } from "./plugin-fixture.js";

// `clip.compare` (ADR 0035): the pure parts (props merge, flags, the clip swap), then the method through
// a real daemon with the `card` fixture adapter standing in for Blender: cards of known colours, read back per tile.
const MEDIA_TIMEOUT = 240_000;

describe("applyLook", () => {
  it("merges props over the clip's own, drops a null key, and takes the look's source", () => {
    const current = { source: "scenes/a.blend", props: { scene: "Day", camera: "Wide" } };
    expect(applyLook(current, { props: { scene: "Dusk" } })).toEqual({ source: "scenes/a.blend", props: { scene: "Dusk", camera: "Wide" } });
    expect(applyLook(current, { props: { camera: null } })).toEqual({ source: "scenes/a.blend", props: { scene: "Day" } });
    expect(applyLook(current, { source: "scenes/b.blend" })).toEqual({ source: "scenes/b.blend", props: { scene: "Day", camera: "Wide" } });
    expect(applyLook({ source: undefined, props: undefined }, { props: { a: 1 } })).toEqual({ source: undefined, props: { a: 1 } });
    expect(applyLook({ source: "x", props: { a: 1 } }, { props: { a: null } })).toEqual({ source: "x", props: undefined });
  });
});

describe("propsFlags", () => {
  it("gives the whole props as one quoted --props, and nothing when they are the clip's own", () => {
    const current = { source: "a", props: { scene: "Day" } };
    expect(propsFlags({ source: "a", props: { scene: "Day" } }, current)).toBe("");
    expect(propsFlags({ source: "a", props: { scene: "Dusk" } }, current)).toBe(`--props '{"scene":"Dusk"}'`);
    expect(propsFlags({ source: "a", props: { scene: "Mum's" } }, current)).toBe(`--props '{"scene":"Mum'\\''s"}'`);
    expect(propsFlags({ source: "b", props: undefined }, current)).toBe("--props '{}'");
  });
});

describe("withVariant", () => {
  it("swaps only the named clip's source and props, leaving the timeline it was given as it was", () => {
    const timeline = {
      version: 1,
      id: "main",
      revision: 1,
      tracks: [
        {
          id: "v1",
          kind: "video",
          clips: [
            { id: "a", type: "card", source: "a.json", start: 0, duration: 2, props: { label: "x" }, grade: { exposure: 1 } },
            { id: "b", type: "card", source: "b.json", start: 2, duration: 2 },
          ],
        },
      ],
    } as unknown as Timeline;
    const before = structuredClone(timeline);
    const clips = (t: Timeline) => (t.tracks[0] as { clips: Record<string, unknown>[] }).clips;
    expect(clips(withVariant(timeline, "a", { source: "c.json", props: { label: "y" } }))[0]).toEqual({ id: "a", type: "card", source: "c.json", start: 0, duration: 2, props: { label: "y" }, grade: { exposure: 1 } });
    expect("props" in clips(withVariant(timeline, "a", { source: "a.json", props: undefined }))[0]!).toBe(false);
    expect(clips(withVariant(timeline, "a", { source: "c.json", props: undefined }))[1]).toBe(clips(timeline)[1]);
    expect(timeline).toEqual(before);
  });
});

describe("clip.compare", () => {
  let daemon: Daemon;
  let conn: DaemonConnection;
  let project: string;
  let ffmpeg: string;
  let clip: string;
  let media: string;
  const W = 64;
  const H = 36;

  const timelineFile = () => readFile(join(project, "timelines", "main.json"), "utf8");
  const writeCard = (name: string, card: Record<string, unknown>) => writeFileSync(join(project, "compositions", "cards", `${name}.json`), JSON.stringify(card));

  /** Colour near the lower middle of tile `index` of a sheet laid out `columns` wide with tiles `tile` px. */
  async function tileColour(path: string, index: number, columns: number, tile: { width: number; height: number }): Promise<number[]> {
    const x = SHEET_GAP + (index % columns) * (tile.width + SHEET_GAP) + tile.width / 2;
    const y = SHEET_GAP + Math.floor(index / columns) * (tile.height + SHEET_GAP) + tile.height * 0.75;
    const raw = await runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", path, "-vf", `crop=1:1:${x}:${Math.round(y)}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    return [...raw];
  }

  beforeAll(async () => {
    ({ ffmpeg } = await mediaTools());
    daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs: { dataDir: tempDir(), configDir: tempDir() }, binaries: testBinaryManager(), idleTimeoutMs: Infinity });
    conn = await connectToDaemon(daemon.socketPath, { client: "test" });
    project = tempDir();
    await conn.request("project.init", { dir: project });
    const configPath = join(project, "frameshell.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...config, resolution: { width: W, height: H } }));
    installLocalPlugin(project, CARD_PLUGIN, "card-plugin");
    await conn.request("project.trust", { cwd: project, decision: "trust" });
    mkdirSync(join(project, "compositions", "cards"), { recursive: true });
    writeCard("red", { color: "red", seconds: 2 });
    writeCard("blue", { color: "blue", seconds: 2 });
    writeCard("lime", { color: "lime", seconds: 2 });
    const footage = tempDir();
    const still = join(footage, "grey.png");
    await runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=0x787878:s=${W}x${H},format=rgb24`, "-frames:v", "1", still]);
    await conn.request("asset.import", { cwd: project, files: [still] });
    const track = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
    clip = (await conn.request("clip.add", { cwd: project, track, type: "card", source: "compositions/cards/red.json", start: 0, duration: 2, props: { label: "day" } })).changes.added[0]!;
    media = (await conn.request("clip.add", { cwd: project, track, asset: "assets/grey.png", start: 2, duration: 2 })).changes.added[0]!;
  }, MEDIA_TIMEOUT);

  afterAll(async () => {
    conn.close();
    await daemon.close();
  });

  it(
    "renders the clip as it is and each variant's own render on one frame, labelled, and changes nothing",
    async () => {
      const before = await timelineFile();
      const result = await conn.request("clip.compare", {
        cwd: project,
        timeline: "main",
        clip,
        tileWidth: 160,
        looks: [{ name: "blue", source: "compositions/cards/blue.json" }, { name: "named", props: { label: "dusk" } }, { source: "compositions/cards/lime.json", props: { label: null } }, { props: { label: "day" } }],
      });
      expect(methods["clip.compare"].result.safeParse(result).success).toBe(true);
      expect(result).toMatchObject({ clip, type: "card", frame: 30, at: 1, columns: 3, rows: 2, view: "current" });
      expect(result.path).toBe(join(project, ".frameshell", "looks", `compare-${clip}-30.png`));
      expect(result.tiles.map((tile) => tile.label)).toEqual(["1 current", "2 blue", "3 named", "4 look 3", "5 look 4"]);
      expect(result.tiles.map((tile) => tile.flags)).toEqual(["", "", `--props '{"label":"dusk"}'`, "--props '{}'", ""]);
      expect(result.tiles.map((tile) => tile.source)).toEqual(["red", "blue", "red", "lime", "red"].map((name) => `compositions/cards/${name}.json`));
      expect(result.warnings).toEqual(['Look "look 4" changes nothing: its tile is the clip as it is.']);
      expect({ width: result.width, height: result.height }).toEqual({ width: 3 * (160 + SHEET_GAP) + SHEET_GAP, height: 2 * (90 + SHEET_GAP) + SHEET_GAP });
      const tile = { width: 160, height: 90 };
      const [current, blue, named, lime, same] = await Promise.all([0, 1, 2, 3, 4].map((i) => tileColour(result.path, i, 3, tile)));
      expect(current![0]).toBeGreaterThan(200);
      expect(current![2]).toBeLessThan(60);
      expect(blue![2]).toBeGreaterThan(200);
      expect(blue![0]).toBeLessThan(60);
      expect(named).toEqual(current);
      expect(lime![1]).toBeGreaterThan(200);
      expect(lime![0]).toBeLessThan(60);
      expect(same).toEqual(current);
      // Read only: the timeline file is byte for byte as it was, and no scratch is left behind.
      expect(await timelineFile()).toBe(before);
      expect(readdirSync(join(project, ".frameshell", "cache")).filter((name) => name.startsWith("clip-compare")).flatMap((name) => readdirSync(join(project, ".frameshell", "cache", name)))).toEqual([]);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "writes to `out` at the frame `at` asks for",
    async () => {
      const out = join(tempDir(), "sheets", "looks.png");
      const result = await conn.request("clip.compare", { cwd: project, timeline: "main", clip, at: 0.5, out, tileWidth: 160, looks: [{ props: { label: "dawn" } }] });
      expect(result).toMatchObject({ path: out, frame: 15, columns: 2, rows: 1 });
      expect(existsSync(out)).toBe(true);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "refuses a clip with nothing to vary, a frame outside the clip, an empty look, a source outside the project, and a variant whose render fails",
    async () => {
      const look = { props: { label: "x" } };
      await expect(conn.request("clip.compare", { cwd: project, timeline: "main", clip: "c_none", looks: [look] })).rejects.toMatchObject({ code: ErrorCode.ClipNotFound });
      await expect(conn.request("clip.compare", { cwd: project, timeline: "main", clip: media, looks: [look] })).rejects.toMatchObject({ code: ErrorCode.InvalidOperation, data: { reason: "not-generated" } });
      await expect(conn.request("clip.compare", { cwd: project, timeline: "main", clip, at: 3, looks: [look] })).rejects.toMatchObject({
        code: ErrorCode.InvalidOperation,
        data: { reason: "outside-clip", valid: { from: 0, to: 2 } },
      });
      await expect(conn.request("clip.compare", { cwd: project, timeline: "main", clip, looks: [{ name: "nothing" }] })).rejects.toMatchObject({
        code: ErrorCode.InvalidOperation,
        message: expect.stringMatching(/look "nothing" sets neither/),
      });
      for (const source of ["../outside.json", "/etc/passwd", "C:\\x\\y.json"]) {
        await expect(conn.request("clip.compare", { cwd: project, timeline: "main", clip, looks: [{ source }] })).rejects.toMatchObject({ data: { reason: "source-outside-project" } });
      }
      writeCard("broken", { color: "red", seconds: 2, fail: true });
      await expect(conn.request("clip.compare", { cwd: project, timeline: "main", clip, looks: [{ name: "broken", source: "compositions/cards/broken.json" }] })).rejects.toMatchObject({
        message: expect.stringMatching(/tile "2 broken".*asks to fail/),
      });
      await expect(conn.request("clip.compare", { cwd: project, timeline: "main", clip, looks: Array.from({ length: 12 }, () => look) })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      await expect(conn.request("clip.compare", { cwd: project, timeline: "main", clip, out: "sheet.jpg", looks: [look] })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    },
    MEDIA_TIMEOUT,
  );
});
