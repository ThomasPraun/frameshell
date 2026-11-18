import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, type ReviewBehind, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon, writeFaceScan } from "../src/index.js";
import { makeMarkerClip } from "./face-fixture.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run, testBinaryManager } from "./media-tools.js";
import { CARD_PLUGIN, installLocalPlugin } from "./plugin-fixture.js";

// `review` of words behind the person (ADR 0032, #461) through a real daemon, the stand-in matte (bright = person) and
// `card` words with alpha. A still 60 px white square (x 130 to 190, y 60 to 120 of 320x180) is the person; a face
// scan puts its face on the square's top 20 rows. Three words, one second each: 37.5 % covered, none, all and the face;
// then a still picture, which is no generated clip. `review`'s own frame captures make the matte, as `frame` does.
const MEDIA_TIMEOUT = 300_000;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
const words: Record<string, string> = {};

/** A card word painting only the film rectangle `x, y, width, height` (px of 320x180). */
function writeWord(name: string, x: number, y: number, width: number, height: number): void {
  writeFileSync(join(project, "compositions", "cards", `${name}.json`), JSON.stringify({ color: "red", seconds: 1, box: [x / 320, y / 180, width / 320, height / 180] }));
}

beforeAll(async () => {
  daemon = await startDaemon({
    socketPath: uniqueSocketPath(),
    dirs: { dataDir: tempDir(), configDir: tempDir() },
    binaries: testBinaryManager(),
    idleTimeoutMs: Infinity,
    matteStandIn: true,
  });
  conn = await connectToDaemon(daemon.socketPath, { client: "cli/test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  const configPath = join(project, "frameshell.json");
  writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, "utf8")), resolution: { width: 320, height: 180 } }));
  installLocalPlugin(project, CARD_PLUGIN, "card-plugin");
  await conn.request("project.trust", { cwd: project, decision: "trust" });
  const { ffmpeg } = await mediaTools();
  const footage = join(tempDir(), "talk.mp4");
  await makeMarkerClip(ffmpeg, footage, { box: 60, durationS: 4, x: "130" });
  const still = join(tempDir(), "word.png");
  await run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x180", "-frames:v", "1", "-y", still]);
  await conn.request("asset.import", { cwd: project, files: [footage, still] });
  const hash = `sha256:${createHash("sha256").update(readFileSync(footage)).digest("hex")}`;
  const boxes = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((time) => ({ time, x: 160 / 320, y: 70 / 180, width: 60 / 320, height: 20 / 180, score: 0.9 }));
  await writeFaceScan(project, hash, { width: 320, height: 180, samples: boxes.length, tracks: [{ id: "t1", start: 0, end: 3.5, boxes, embeddings: [] }] });

  mkdirSync(join(project, "compositions", "cards"), { recursive: true });
  writeWord("fine", 100, 90, 120, 40);
  writeWord("far", 10, 60, 60, 60);
  writeWord("face", 140, 62, 40, 38);
  const plate = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
  const track = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
  await conn.request("clip.add", { cwd: project, track: plate, asset: "assets/talk.mp4", start: 0, in: 0, out: 4 });
  for (const [index, name] of ["fine", "far", "face"].entries()) {
    const added = await conn.request("clip.add", { cwd: project, track, type: "card", source: `compositions/cards/${name}.json`, start: index, duration: 1 });
    words[name] = added.changes.added[0]!;
  }
  words.still = (await conn.request("clip.add", { cwd: project, track, asset: "assets/word.png", start: 3, duration: 1 })).changes.added[0]!;
  await conn.request("track.set", { cwd: project, track, behind: plate });
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

const entry = (found: readonly ReviewBehind[], name: string) => found.find((candidate) => candidate.clip === words[name])!;

describe("review: words behind the person", () => {
  it(
    "measures the covered share at the first, middle and last frame, and flags the face",
    async () => {
      const result = await conn.request("review", { cwd: project, sheets: ["metrics"] });
      const found = result.metrics!.behind!;
      expect(found).toHaveLength(4);

      const fine = entry(found, "fine");
      expect(fine).toMatchObject({ verdict: "fine", plate: expect.any(String), from: 0, to: 1 });
      expect(fine.samples.map((sample) => sample.at)).toEqual([0, 0.5, 0.967]);
      for (const sample of fine.samples) {
        // 60 x 30 of the word's 120 x 40 px lie over the square: 37.5 %, give or take the matte's soft edge.
        expect(sample.covered).toBeGreaterThan(0.32);
        expect(sample.covered).toBeLessThan(0.43);
        expect(sample.face).toBe(false);
      }
      expect(entry(found, "far")).toMatchObject({ verdict: "floats", samples: [{ covered: 0 }, { covered: 0 }, { covered: 0 }] });
      const face = entry(found, "face");
      expect(face.verdict).toBe("eaten");
      expect(face.samples.every((sample) => sample.covered! > 0.9 && sample.face === true)).toBe(true);
      expect(entry(found, "still")).toMatchObject({ verdict: "unplaced", from: null, samples: [] });
      expect(entry(found, "still").message).toContain("is not a generated clip");

      const craft = result.metrics!.craft.filter((warning) => warning.check === "behind");
      expect(craft.map((warning) => [warning.clip, warning.severity])).toEqual([
        [words.far, "warn"],
        [words.face, "warn"],
        [words.face, "warn"],
      ]);
      expect(craft[0]!.message).toContain("30 to 55 %");
      expect(craft[2]!.message).toContain("meets a face");
    },
    MEDIA_TIMEOUT,
  );

  it(
    "fails the warnings when requirements.json lists behind, except the word a waiver names",
    async () => {
      await conn.request("review.require", { cwd: project, path: "fail", value: ["behind"] });
      await conn.request("review.waive", { cwd: project, check: "behind", clip: words.far!, reason: "the side word is meant to float" });
      const metrics = (await conn.request("review", { cwd: project, sheets: ["metrics"] })).metrics!;
      expect(metrics.waived.map((warning) => [warning.check, warning.clip])).toEqual([["behind", words.far]]);
      expect(metrics.craft.filter((warning) => warning.check === "behind").map((warning) => [warning.clip, warning.severity])).toEqual([
        [words.face, "fail"],
        [words.face, "fail"],
      ]);
      expect(metrics.requirements!.failed).toBe(2);
    },
    MEDIA_TIMEOUT,
  );
});
