import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon, methods } from "@frameshell/protocol";
import type { Angle, Timeline } from "@frameshell/schema";
import { type Daemon, angleFaceKeys, startDaemon } from "../src/index.js";
import { makeMarkerClip, markerDetector } from "./face-fixture.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeClip } from "./media-fixtures.js";
import { mediaTools, testBinaryManager } from "./media-tools.js";

// `multicam.faces` through a real daemon and managed ffmpeg, with a stand-in detector that takes a white square on
// black for the face: nothing is downloaded.
const MEDIA_TIMEOUT = 180_000;
let daemon: Daemon;
let conn: DaemonConnection;
/** No terminal session: its operations never join another command's transaction. */
let solo: DaemonConnection;
let project: string;
let group: string;

beforeAll(async () => {
  daemon = await startDaemon({
    socketPath: uniqueSocketPath(),
    dirs: { dataDir: tempDir(), configDir: tempDir() },
    binaries: testBinaryManager(),
    idleTimeoutMs: Infinity,
    faceScanner: (request) => angleFaceKeys({ ...request, detect: markerDetector }),
  });
  conn = await connectToDaemon(daemon.socketPath, { client: "cli/test", session: "term-1" });
  solo = await connectToDaemon(daemon.socketPath, { client: "cli/test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  const { ffmpeg } = await mediaTools();
  const footage = tempDir();
  // Ana sits left for 4 s, then right; Ben stays right; the deck is a screen share, the only file with sound.
  await makeMarkerClip(ffmpeg, join(footage, "ana.mp4"), { x: "if(lt(t,4),40,240)" });
  await makeMarkerClip(ffmpeg, join(footage, "ben.mp4"), { x: "240" });
  await makeClip(join(footage, "deck.mp4"), { width: 320, height: 180, durationS: 8 });
  const { imported } = await conn.request("asset.import", { cwd: project, files: ["ana", "ben", "deck"].map((name) => join(footage, `${name}.mp4`)) });
  const created = await conn.request("multicam.create", { cwd: project, assets: imported.map((entry) => entry.asset), names: ["Ana", "Ben", "Deck"] });
  group = created.group;
  await conn.request("multicam.offset", { cwd: project, group, angle: "ana", offset: 0 });
  await conn.request("multicam.offset", { cwd: project, group, angle: "ben", offset: 1 });
  await conn.request("multicam.angle", { cwd: project, group, angle: "deck", screen: true });
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  solo.close();
  await daemon.close();
});

async function angle(id: string): Promise<Angle> {
  const timeline = JSON.parse(await readFile(join(project, "timelines", "main.json"), "utf8")) as Timeline;
  return timeline.groups!.find((candidate) => candidate.id === group)!.angles.find((candidate) => candidate.id === id)!;
}

describe("multicam.faces", () => {
  it(
    "keys every person angle where the face stops, on the group clock, one operation per angle in one transaction",
    async () => {
      const result = await solo.request("multicam.faces", { cwd: project, group });
      expect(methods["multicam.faces"].result.parse(result)).toEqual(result);
      expect(result.angles.map(({ angle, samples, faces, keys }) => [angle, samples, faces, keys])).toEqual([
        ["ana", 16, 16, 2],
        ["ben", 16, 16, 1],
      ]);
      expect(result).toMatchObject({ group, kept: [], warnings: [] });
      const ana = (await angle("ana")).reframe!;
      expect(ana.map((key) => key.at)).toEqual([3.5, 4]);
      expect(ana[0]!.x).toBeCloseTo(0.1875, 2);
      expect(ana[1]!.x).toBeCloseTo(0.8125, 2);
      // Ben's file plays from group second 1.
      expect((await angle("ben")).reframe!.map((key) => key.at)).toEqual([1]);
      expect(await angle("deck")).not.toHaveProperty("reframe");

      const history = await conn.request("history", { cwd: project });
      const tx = history.transactions.find((entry) => entry.tx === result.tx)!;
      expect(tx.operations.map((op) => op.op)).toEqual(["multicam.reframe", "multicam.reframe"]);
      expect(tx.operations.map((op) => op.id)).toEqual(result.angles.map((entry) => entry.operation));

      const { jobs } = await solo.request("job.list", { cwd: project });
      expect(jobs.filter((job) => job.kind === "faces")).toEqual([
        expect.objectContaining({ asset: "timelines/main.json", state: "done", step: null, progress: 1 }),
      ]);

      await solo.request("revert", { cwd: project, target: result.tx! });
      expect(await angle("ana")).not.toHaveProperty("reframe");
      expect(await angle("ben")).not.toHaveProperty("reframe");
    },
    MEDIA_TIMEOUT,
  );

  it(
    "keeps angles that already have keys unless asked to replace them",
    async () => {
      await conn.request("multicam.reframe", { cwd: project, group, angle: "ben", at: 2, x: 0.5 });
      const kept = await conn.request("multicam.faces", { cwd: project, group, angles: ["ben"] });
      expect(kept).toMatchObject({ angles: [], kept: ["ben"], tx: null });
      expect((await angle("ben")).reframe).toEqual([{ at: 2, x: 0.5, y: 0.5 }]);

      const replaced = await conn.request("multicam.faces", { cwd: project, group, angles: ["ben"], replace: true });
      expect(replaced.kept).toEqual([]);
      expect(replaced.angles.map((entry) => entry.angle)).toEqual(["ben"]);
      const ben = (await angle("ben")).reframe!;
      expect(ben).toHaveLength(1);
      expect(ben[0]!.x).toBeCloseTo(0.8125, 2);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "in review mode, one proposal that is ready once the run ends, also without a terminal session",
    async () => {
      const app = await connectToDaemon(daemon.socketPath, { client: "desktop/test" });
      try {
        await app.request("review.set", { cwd: project, enabled: true });
        const before = await angle("ana");
        const result = await solo.request("multicam.faces", { cwd: project, group, angles: ["ana"], replace: true });
        expect(await angle("ana")).toEqual(before);
        const { proposal } = await solo.request("proposal.status", { cwd: project });
        expect(proposal).toMatchObject({ tx: result.tx, state: "ready", operations: 1 });
        await app.request("proposal.reject", { cwd: project, tx: result.tx! });
      } finally {
        await app.request("review.set", { cwd: project, enabled: false });
        app.close();
      }
    },
    MEDIA_TIMEOUT,
  );

  it("refuses a screen or an unknown angle", async () => {
    await expect(conn.request("multicam.faces", { cwd: project, group, angles: ["deck"] })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining("is a screen"),
    });
    await expect(conn.request("multicam.faces", { cwd: project, group, angles: ["zoe"] })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining("angles: ana, ben, deck"),
    });
  });
});
