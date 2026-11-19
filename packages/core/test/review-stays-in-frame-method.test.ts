import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, type MethodResult, connectToDaemon } from "@frameshell/protocol";
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

describe("review: requirements of a review-mode proposal", () => {
  it(
    "judges the proposal's requirements.json with view: proposal and the file's with view: current",
    async () => {
      const ui = await connectToDaemon(daemon.socketPath, { client: "desktop/test", agent: null });
      const agent = await connectToDaemon(daemon.socketPath, { client: "cli/test", agent: null, session: "term-1" });
      await ui.request("review.set", { cwd: project, enabled: true });
      try {
        const begun = await agent.request("tx.begin", { label: "Shorter" });
        await agent.request("review.require", { cwd: project, path: "film.maxSeconds", value: 0.5 });
        await agent.request("tx.commit", {});
        const maxSeconds = (result: MethodResult<"review">) => result.metrics!.requirements!.checks.find((candidate) => candidate.id === "film.maxSeconds");

        const proposed = await agent.request("review", { cwd: project, sheets: ["metrics"], view: "proposal" });
        expect(maxSeconds(proposed)).toMatchObject({ status: "fail", expected: 0.5 });
        const current = await agent.request("review", { cwd: project, sheets: ["metrics"], view: "current" });
        expect(maxSeconds(current)).toBeUndefined();
        expect(current.metrics!.requirements!.checks.find((candidate) => candidate.id === "clip.staysInFrame")).toBeDefined();

        await ui.request("proposal.reject", { cwd: project, tx: begun.tx });
      } finally {
        await ui.request("review.set", { cwd: project, enabled: false });
        ui.close();
        agent.close();
      }
    },
    MEDIA_TIMEOUT,
  );
});

describe("review: requirements on a clip inside a nested timeline", () => {
  it(
    "judges `<nested clip id>/<clip id>` from the flattened film and answers a bare inner id with the path",
    async () => {
      const outer = {
        schemaVersion: 1,
        id: "outer",
        revision: 0,
        tracks: [{ id: "v1", kind: "video", clips: [{ id: "c_nest", type: "timeline", source: "timelines/main.json", start: 0.2, in: 0, duration: 1 }] }],
      };
      await conn.request("file.write", { path: join(project, "timelines", "outer.json"), content: JSON.stringify(outer) });
      const path = `c_nest/${clip}`;
      await conn.request("review.require", { cwd: project, clip: path, path: "staysInFrame", value: true });
      await conn.request("review.require", { cwd: project, clip: path, path: "appearsBy", value: 0.1 });

      const result = await conn.request("review", { cwd: project, timeline: "outer", projectFormat: "9x16", sheets: ["metrics"] });
      const checks = result.metrics!.requirements!.checks;
      // The face sits right of the 9x16 crop's middle strip.
      expect(checks.find((check) => check.id === "clip.staysInFrame" && check.clip === path)).toMatchObject({ status: "fail", format: "9x16" });
      expect(checks.find((check) => check.id === "clip.appearsBy" && check.clip === path)).toMatchObject({ status: "fail", actual: 0.2 });
      // The first test's requirement names the bare id, which is not a clip of this timeline: the message names the path.
      expect(checks.find((check) => check.id === "clip.staysInFrame" && check.clip === clip)).toMatchObject({
        status: "fail",
        message: expect.stringContaining(`name it as ${path}`),
      });

      const wide = await conn.request("review", { cwd: project, timeline: "outer", sheets: ["metrics"] });
      expect(wide.metrics!.requirements!.checks.find((check) => check.id === "clip.staysInFrame" && check.clip === path)).toMatchObject({ status: "pass", format: "16x9" });
    },
    MEDIA_TIMEOUT,
  );
});
