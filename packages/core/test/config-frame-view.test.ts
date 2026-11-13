import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeClip } from "./media-fixtures.js";
import { testBinaryManager } from "./media-tools.js";

// `view: proposal` on `frame --project-format` and `review` (ADR 0036): a format only a proposal adds can be looked at.
const MEDIA_TIMEOUT = 180_000;

let daemon: Daemon;
let ui: DaemonConnection;
let agent: DaemonConnection;
let project: string;

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity, txIdleGapMs: 60_000 });
  ui = await connectToDaemon(daemon.socketPath, { client: "desktop/test" });
  agent = await connectToDaemon(daemon.socketPath, { client: "cli/test", agent: null, session: "term-1" });
  project = tempDir();
  await ui.request("project.init", { dir: project });
  const footage = join(tempDir(), "wide.mp4");
  await makeClip(footage, { width: 320, height: 180, durationS: 1 });
  const { imported } = await ui.request("asset.import", { cwd: project, files: [footage] });
  const video = (await ui.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
  await ui.request("clip.add", { cwd: project, track: video, asset: imported[0]!.asset, start: 0, in: 0, out: 1 });
  await ui.request("review.set", { cwd: project, enabled: true });
}, MEDIA_TIMEOUT);

afterAll(async () => {
  agent.close();
  ui.close();
  await daemon.close();
});

describe("a format only a proposal adds", () => {
  it(
    "is refused by the file's frame and captured by the proposal's, for the author by default",
    async () => {
      await agent.request("tx.begin", { label: "Vertical" });
      await agent.request("format.add", { cwd: project, id: "9x16" });
      await agent.request("tx.commit", {});
      const out = join(tempDir(), "vertical.png");

      await expect(ui.request("frame", { cwd: project, at: 0.5, out, projectFormat: "9x16" })).rejects.toMatchObject({ code: ErrorCode.FormatNotFound });
      const shown = await ui.request("frame", { cwd: project, at: 0.5, out, projectFormat: "9x16", view: "proposal" });
      expect(shown).toMatchObject({ view: "proposal", projectFormat: "9x16", width: 1080, height: 1920, proposal: { state: "ready" } });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "lays the review sheets out in it",
    async () => {
      const current = await ui.request("review", { cwd: project, sheets: ["contact"], projectFormat: "9x16", view: "current" }).then(
        () => null,
        (error: { code: number }) => error.code,
      );
      expect(current).toBe(ErrorCode.FormatNotFound);
      const shown = await ui.request("review", { cwd: project, sheets: ["contact"], projectFormat: "9x16", view: "proposal" });
      expect(shown).toMatchObject({ view: "proposal" });
    },
    MEDIA_TIMEOUT,
  );
});
