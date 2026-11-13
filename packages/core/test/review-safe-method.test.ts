import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, type ReviewResult, connectToDaemon } from "@frameshell/protocol";
import { SAFE_ZONES, type Transcript, VERTICAL_CAPTION_SCALE, parseTimeline, scaledCaptions, subtitleTracks } from "@frameshell/schema";
import { type Daemon, bundledFontMetrics, startDaemon } from "../src/index.js";
import { cueCrossings, filmInsets, safeFlags } from "../src/review/safe.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeClip } from "./media-fixtures.js";
import { testBinaryManager } from "./media-tools.js";

// The `safe` sheet of `review` on a 1 s project laid out as 9x16 with big-keyword captions low in the frame.
const MEDIA_TIMEOUT = 180_000;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let footage: string;
let transcript: Transcript;

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  await conn.request("format.add", { cwd: project, id: "9x16" });
  footage = join(tempDir(), "take.mp4");
  await makeClip(footage, { durationS: 1 });
  const { imported } = await conn.request("asset.import", { cwd: project, files: [footage] });
  const asset = imported[0]!.asset;
  const video = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
  await conn.request("clip.add", { cwd: project, track: video, asset, start: 0, in: 0, out: 1 });
  await conn.request("track.add", { cwd: project, kind: "subtitles", follows: video });
  transcript = {
    schemaVersion: 1,
    asset,
    assetHash: `sha256:${"0".repeat(64)}`,
    provider: "test",
    model: "test",
    words: ["Hola", "mundo"].map((text, i) => ({ id: `w_00000${i + 1}`, text, start: 0.1 + i * 0.4, end: 0.4 + i * 0.4 })),
    edits: {},
  } as Transcript;
  await conn.request("file.write", { path: join(project, "transcripts", "take.words.json"), content: JSON.stringify(transcript) });
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

function pngSize(path: string): [number, number] {
  const png = readFileSync(path);
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

describe("review safe sheet", () => {
  let result: ReviewResult;

  it(
    "draws the platform's zones over the frames and flags the frames where captions cross one",
    async () => {
      result = await conn.request("review", { cwd: project, projectFormat: "9x16", platform: "instagram-reels", sheets: ["safe"], every: 0.25 });
      expect(result).toMatchObject({ width: 1080, height: 1920, warnings: [] });
      expect(result.sheets.map((sheet) => sheet.kind)).toEqual(["safe"]);
      const sheet = result.sheets[0]!;
      expect(sheet.path).toBe(join(result.dir, "safe-instagram-reels.png"));
      expect(existsSync(sheet.path)).toBe(true);
      expect(pngSize(sheet.path)).toEqual([sheet.width, sheet.height]);
      expect(sheet.tile).toEqual({ width: 200, height: 356 });
      const flagged = sheet.tiles.filter((tile) => tile.flags);
      expect(flagged.length).toBeGreaterThan(0);
      expect(flagged.every((tile) => tile.flags!.join() === "subtitle" && tile.label.endsWith(" !subtitle"))).toBe(true);
      expect(sheet.tiles.some((tile) => tile.flags === undefined)).toBe(true);
      const ig = SAFE_ZONES["instagram-reels"];
      expect(result.safeZones).toHaveLength(1);
      expect(result.safeZones[0]).toMatchObject({
        platform: "instagram-reels",
        measured: true,
        insets: { top: ig.top, right: ig.right, bottom: ig.bottom, left: 0 },
        sheets: [sheet.path],
        flags: [expect.objectContaining({ subject: "subtitle", zone: "bottom", cues: expect.any(Number), reach: expect.any(Number) })],
      });
      expect(result.safeZones[0]!.flags[0]!.reach).toBeGreaterThan(0);
      const manifest = JSON.parse(readFileSync(join(result.dir, "review.json"), "utf8")) as { safeZones: unknown };
      expect(manifest.safeZones).toEqual(result.safeZones);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "measures captions at the size export draws them in a vertical non-primary format",
    async () => {
      expect(result.fps).toBeGreaterThan(0);
      const parsed = parseTimeline(JSON.parse(readFileSync(join(project, "timelines", "main.json"), "utf8")));
      if (!parsed.ok) throw new Error(parsed.error);
      const timeline = parsed.value;
      const tracks = subtitleTracks(timeline, () => transcript, result.fps);
      const frame = { width: result.width, height: result.height };
      const insets = filmInsets(SAFE_ZONES["instagram-reels"], frame);
      const metrics = await bundledFontMetrics();
      const reachAt = (scale: number): number | undefined =>
        safeFlags(cueCrossings(scaledCaptions(tracks, { cover: true, captionScale: scale }), insets, frame, metrics), result.fps)[0]?.reach;
      const scaled = reachAt(VERTICAL_CAPTION_SCALE);
      expect(scaled).toBeDefined();
      expect(scaled).not.toBe(reachAt(1));
      expect(result.safeZones[0]!.flags[0]!.reach).toBe(scaled);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "adds the sheet to the default ones when a platform is given, and not otherwise",
    async () => {
      const withPlatform = await conn.request("review", { cwd: project, projectFormat: "9x16", platform: "tiktok", from: 0, to: 0.5 });
      expect(withPlatform.sheets.map((sheet) => sheet.kind)).toEqual(["contact", "safe", "phone", "motion", "seam"]);
      const without = await conn.request("review", { cwd: project, projectFormat: "9x16", from: 0, to: 0.5, sheets: ["contact", "phone"] });
      expect(without.safeZones).toEqual([]);
      expect(without.sheets.some((sheet) => sheet.kind === "safe")).toBe(false);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "takes the platforms of the style guide on a vertical film, and says why there is none when asked for the sheet",
    async () => {
      const none = await conn.request("review", { cwd: project, projectFormat: "9x16", sheets: ["safe"], from: 0, to: 0.3 });
      expect(none.sheets).toEqual([]);
      expect(none.warnings.join("\n")).toContain("pass `platform`");
      await conn.request("file.write", { path: join(project, "style.json"), content: JSON.stringify({ schemaVersion: 1, platforms: ["tiktok", "youtube"] }) });
      const styled = await conn.request("review", { cwd: project, projectFormat: "9x16", from: 0, to: 0.3, sheets: ["safe"] });
      // youtube is a horizontal platform: left out of a vertical film.
      expect(styled.safeZones.map((zone) => zone.platform)).toEqual(["tiktok"]);
      const automatic = await conn.request("review", { cwd: project, projectFormat: "9x16", from: 0, to: 0.3 });
      expect(automatic.sheets.map((sheet) => sheet.kind)).toContain("safe");
      const wide = await conn.request("review", { cwd: project, from: 0, to: 0.3 });
      expect(wide.sheets.map((sheet) => sheet.kind)).not.toContain("safe");
    },
    MEDIA_TIMEOUT,
  );

  it(
    "the metrics of a timeline count the cues of its subtitle tracks",
    async () => {
      const metrics = (await conn.request("review", { cwd: project, projectFormat: "9x16", sheets: ["metrics"] })).metrics!;
      expect(metrics.subtitles).toMatchObject({ cues: expect.any(Number), shortCues: [] });
      expect(metrics.subtitles!.cues).toBeGreaterThan(0);
      expect(metrics.loudness).toBeNull();
    },
    MEDIA_TIMEOUT,
  );

  it(
    "a file has the zones but no flags, and a platform of the other orientation is scaled with a warning",
    async () => {
      const file = await conn.request("review", { cwd: project, file: footage, platform: "instagram-reels", sheets: ["safe"] });
      expect(file.safeZones[0]).toMatchObject({ platform: "instagram-reels", flags: [] });
      expect(file.sheets[0]!.tiles.every((tile) => tile.flags === undefined)).toBe(true);
      expect(file.warnings.join("\n")).toContain("vertical platform and the film is not");
      const ignored = await conn.request("review", { cwd: project, platform: "tiktok", sheets: ["seam"], from: 0, to: 0.3 });
      expect(ignored.warnings.join("\n")).toContain("is ignored");
    },
    MEDIA_TIMEOUT,
  );
});
