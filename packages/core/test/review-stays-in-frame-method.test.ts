import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon, writeFaceScan } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeClip } from "./media-fixtures.js";
import { testBinaryManager } from "./media-tools.js";

// `staysInFrame` of a footage clip through `review` (#457): the faces of a written face-scan cache, laid out in the
// format reviewed. A 4:3 test picture: the 9x16 cover crop keeps its middle, so a face at the right leaves that frame only.
const MEDIA_TIMEOUT = 180_000;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let clip: string;

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  await conn.request("format.add", { cwd: project, id: "9x16" });
  const footage = join(tempDir(), "talk.mp4");
  await makeClip(footage, { durationS: 1 });
  const { imported } = await conn.request("asset.import", { cwd: project, files: [footage] });
  const video = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
  const added = await conn.request("clip.add", { cwd: project, track: video, asset: imported[0]!.asset, start: 0, in: 0, out: 1 });
  clip = added.changes.added[0]!;
  const hash = `sha256:${createHash("sha256").update(await readFile(footage)).digest("hex")}`;
  // A face at 80 % of the width, from 0.5 s: inside the whole 4:3 picture, right of the 9x16 crop's middle strip.
  const boxes = [0.5, 0.75].map((time) => ({ time, x: 0.8, y: 0.5, width: 0.1, height: 0.15, score: 0.9 }));
  await writeFaceScan(project, hash, { width: 320, height: 240, samples: 2, tracks: [{ id: "t1", start: 0.5, end: 0.75, boxes, embeddings: [] }] });
  await conn.request("review.require", { cwd: project, clip, path: "staysInFrame", value: true });
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

describe("review: staysInFrame of footage", () => {
  it(
    "fails in the 9x16 format with the times the face is out, and passes in the primary format where it is whole",
    async () => {
      const vertical = await conn.request("review", { cwd: project, projectFormat: "9x16", sheets: ["metrics"] });
      const check = vertical.metrics!.requirements!.checks.find((candidate) => candidate.id === "clip.staysInFrame")!;
      expect(check).toMatchObject({ clip, status: "fail", format: "9x16", expected: 0 });
      expect(check.spans![0]!.from).toBe(0.5);
      expect(check.message).toContain(`a face of clip ${clip} leaves the frame of format 9x16 (right)`);
      expect(vertical.metrics!.requirements!.failed).toBe(1);

      const wide = await conn.request("review", { cwd: project, sheets: ["metrics"] });
      expect(wide.metrics!.requirements!.checks.find((candidate) => candidate.id === "clip.staysInFrame")).toMatchObject({ clip, status: "pass", format: "16x9" });
    },
    MEDIA_TIMEOUT,
  );
});
