import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeBurstClip } from "./media-fixtures.js";
import { testBinaryManager } from "./media-tools.js";

// Seam under test: `word:` time references through a real daemon (ADR 0029 slice 4 part 3): the daemon reads the
// project's transcripts (and their hashes) for the timeline as each call sees it, in operations and in methods that
// resolve times of their own. The transcript is written by hand on a recording of tone bursts.
const MEDIA_TIMEOUT = 180_000;

const WORDS: [string, number, number][] = [
  ["so", 1.0, 1.3],
  ["the", 1.3, 1.6],
  ["key", 1.6, 2.0],
  ["so", 3.0, 3.3],
  ["the", 3.3, 3.6],
  ["key", 3.6, 4.0],
  ["idea", 4.0, 4.5],
  ["twenty", 5.0, 5.4],
  ["okay", 6.0, 6.5],
];

let daemon: Daemon;
let conn: DaemonConnection;
let root: string;

beforeEach(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Number.POSITIVE_INFINITY });
  conn = await connectToDaemon(daemon.socketPath, { client: "cli/test", session: "term-1" });
  root = join(tempDir(), "talk");
  await conn.request("project.init", { dir: root });
}, 60_000);

afterEach(async () => {
  conn.close();
  await daemon.close();
});

async function setup() {
  const footage = join(tempDir(), "talk.mp4");
  await makeBurstClip(footage, { durationS: 8, bursts: WORDS.map(([, start, end], index) => [start, end - start, 300 + 40 * index] as const) });
  const { imported } = await conn.request("asset.import", { cwd: root, files: [footage] });
  const asset = imported[0]!.asset;
  mkdirSync(join(root, "transcripts"), { recursive: true });
  writeFileSync(
    join(root, "transcripts", "talk.words.json"),
    JSON.stringify({
      schemaVersion: 1,
      asset,
      assetHash: `sha256:${createHash("sha256").update(readFileSync(join(root, asset))).digest("hex")}`,
      provider: "test",
      model: "test",
      language: "en",
      words: WORDS.map(([text, start, end], index) => ({ id: `w_${String(index + 1).padStart(6, "0")}`, text, start, end })),
    }),
  );
  const video = (await conn.request("track.add", { cwd: root, kind: "video", name: "Camera" })).changes.added[0]!;
  await conn.request("clip.add", { cwd: root, track: video, asset, start: 0 });
  return { video };
}

describe("word: through the daemon", () => {
  it(
    "cuts between two words, places a marker on a word of the cut timeline and limits captions.set to a word",
    async () => {
      const { video } = await setup();
      const cut = await conn.request("cut", { cwd: root, from: "word:so", to: "word:so#2", snap: false });
      expect(cut.operation.args).toMatchObject({ from: 1, to: 3 });
      const marker = await conn.request("marker.add", { cwd: root, at: "word:okay", label: "okay" });
      expect(marker.operation.args).toMatchObject({ at: 4 });

      const subtitles = (await conn.request("track.add", { cwd: root, kind: "subtitles", follows: video })).changes.added[0]!;
      const captions = await conn.request("captions.set", { cwd: root, track: subtitles, text: "*idea*", from: "word:idea", to: "word:20" });
      expect(captions).toMatchObject({ phrases: 1, words: 1 });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "refuses a word while a clip's transcript belongs to other content, naming transcribe",
    async () => {
      await setup();
      const path = join(root, "transcripts", "talk.words.json");
      const transcript = JSON.parse(readFileSync(path, "utf8")) as { assetHash: string };
      transcript.assetHash = `sha256:${"0".repeat(64)}`;
      writeFileSync(path, JSON.stringify(transcript));
      await expect(conn.request("marker.add", { cwd: root, at: "word:idea", label: "idea" })).rejects.toMatchObject({
        code: ErrorCode.InvalidOperation,
        data: { field: "at", reason: "time reference" },
        message: expect.stringContaining("is older than its file"),
      });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "reads a review-mode proposal's own timeline: a word after a cut of the same proposal",
    async () => {
      await setup();
      const ui = await connectToDaemon(daemon.socketPath, { client: "desktop/test" });
      try {
        await ui.request("review.set", { cwd: root, enabled: true });
        const before = readFileSync(join(root, "timelines", "main.json"), "utf8");
        await conn.request("tx.begin", { label: "Tighten" });
        await conn.request("cut", { cwd: root, from: "word:so", to: "word:so#2", snap: false });
        const marker = await conn.request("marker.add", { cwd: root, at: "word:okay", label: "okay" });
        // The proposal holds the cut, so "okay" plays 2 s earlier there; the file still has it at 6 s.
        expect(marker.operation.args).toMatchObject({ at: 4 });
        await conn.request("tx.commit", {});
        expect(readFileSync(join(root, "timelines", "main.json"), "utf8")).toBe(before);
      } finally {
        ui.close();
      }
    },
    MEDIA_TIMEOUT,
  );
});
