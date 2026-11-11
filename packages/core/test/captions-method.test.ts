import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { parseCaptionText, resolveCaptions } from "../src/timeline/captions.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeClip } from "./media-fixtures.js";
import { testBinaryManager } from "./media-tools.js";

// `captions.set`: hand-chunked phrases with a keyword, resolved onto the transcript's word ids.
const MEDIA_TIMEOUT = 180_000;
const WORDS = ["No", "need", "to", "open", "any", "editor"];

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let video = "";
let subtitles = "";

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  const footage = join(tempDir(), "take.mp4");
  await makeClip(footage, { durationS: 1 });
  const { imported } = await conn.request("asset.import", { cwd: project, files: [footage] });
  const asset = imported[0]!.asset;
  video = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
  await conn.request("clip.add", { cwd: project, track: video, asset, start: 0, in: 0, out: 1 });
  subtitles = (await conn.request("track.add", { cwd: project, kind: "subtitles", follows: video })).changes.added[0]!;
  const transcript = {
    schemaVersion: 1,
    asset,
    assetHash: `sha256:${"0".repeat(64)}`,
    provider: "test",
    model: "test",
    words: WORDS.map((text, i) => ({ id: `w_00000${i + 1}`, text, start: 0.1 + i * 0.15, end: 0.2 + i * 0.15 })),
    edits: {},
  };
  await conn.request("file.write", { path: join(project, "transcripts", "take.words.json"), content: JSON.stringify(transcript) });
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

const shown = async () => (await conn.request("timeline.show", { cwd: project })).tracks.find((track) => track.id === subtitles)!;

describe("captions.set", () => {
  it(
    "maps chunked text onto word ids, marks the keyword, and reports the cues it makes",
    async () => {
      const result = await conn.request("captions.set", { cwd: project, track: subtitles, text: "No need to | open any | *editor*" });
      expect(result).toMatchObject({ phrases: 1, words: 6, warnings: [] });
      expect(result.cues.map((cue) => cue.text)).toEqual(["NO NEED TO", "OPEN ANY", "*EDITOR*"]);
      const track = await shown();
      expect(track.phrases).toEqual([expect.objectContaining({ words: ["w_000001", "w_000002", "w_000003", "w_000004", "w_000005", "w_000006"], chunks: [3, 2, 1], keyword: 5 })]);
      // One transaction: reverting it takes the phrases away.
      await conn.request("revert", { cwd: project, target: result.operation.tx });
      expect((await shown()).phrases).toBeUndefined();
    },
    MEDIA_TIMEOUT,
  );

  it("refuses a text that loses or repeats a word, naming the first difference", async () => {
    await expect(conn.request("captions.set", { cwd: project, track: subtitles, text: "No need to | any | *editor*" })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining('word 4: the text has "any", the track shows "open"'),
    });
    await expect(conn.request("captions.set", { cwd: project, track: subtitles, text: "No need to | open any | editor editor" })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining("7 words but the track shows 6"),
    });
    expect((await shown()).phrases).toBeUndefined();
  });

  it("matches by position: a differently spelt word only warns", async () => {
    const result = await conn.request("captions.set", { cwd: project, track: subtitles, text: "No need to | open any | *editors*" });
    expect(result.warnings[0]).toContain('"editors" for "editor"');
  });

  it("limits the captions to the words between from and to, and keeps the phrases it does not touch", async () => {
    await conn.request("captions.set", { cwd: project, track: subtitles, text: "No need", from: 0, to: 0.4, replace: true });
    const result = await conn.request("captions.set", { cwd: project, track: subtitles, text: "*editor*", from: 0.8 });
    expect(result.phrases).toBe(1);
    expect((await shown()).phrases).toHaveLength(2);
  });

  it("replaces the phrases it shares words with, and clears them with replace alone", async () => {
    await conn.request("captions.set", { cwd: project, track: subtitles, text: "*editor*", from: 0.8 });
    expect((await shown()).phrases).toHaveLength(2);
    await conn.request("captions.set", { cwd: project, track: subtitles, replace: true });
    expect((await shown()).phrases).toBeUndefined();
  });

  it("refuses a second keyword, an empty chunk and a track that is not a subtitle track", async () => {
    await expect(conn.request("captions.set", { cwd: project, track: subtitles, text: "*No* need to | open any | *editor*" })).rejects.toMatchObject({
      message: expect.stringContaining("one keyword"),
    });
    await expect(conn.request("captions.set", { cwd: project, track: subtitles, text: "No need to | | open any editor" })).rejects.toMatchObject({
      message: expect.stringContaining("empty chunk"),
    });
    await expect(conn.request("captions.set", { cwd: project, track: video, text: "x" })).rejects.toMatchObject({ code: ErrorCode.InvalidOperation });
    await expect(conn.request("captions.set", { cwd: project, track: "t_nope", text: "x" })).rejects.toMatchObject({ code: ErrorCode.TrackNotFound });
  });

  it("reads the text from a project file", async () => {
    await conn.request("file.write", { path: join(project, "captions.txt"), content: "# hook\nNo need to | open any | *editor*\n" });
    const result = await conn.request("captions.set", { cwd: project, track: subtitles, file: "captions.txt", replace: true });
    expect(result.cues).toHaveLength(3);
  });
});

describe("caption style and gaps on a subtitle track", () => {
  it("store the entry, keyword tokens and gaps snapped to the frame grid; gaps hide cues", async () => {
    await conn.request("track.set", { cwd: project, track: subtitles, style: { entry: "words", keywordColor: null, keywordScale: 1.2 }, gaps: [{ from: 0.41, to: 0.6 }] });
    const track = await shown();
    expect(track.style).toMatchObject({ entry: "words", keywordColor: null, keywordScale: 1.2 });
    expect(track.gaps).toEqual([{ from: 0.4, to: 0.6 }]);
    await conn.request("track.set", { cwd: project, track: subtitles, gaps: [] });
    expect((await shown()).gaps).toBeUndefined();
  });

  it("refuse gaps on a clip track", async () => {
    await expect(conn.request("track.set", { cwd: project, track: video, gaps: [{ from: 0, to: 1 }] })).rejects.toMatchObject({ code: ErrorCode.InvalidOperation });
  });
});

describe("caption text parsing", () => {
  it("reads chunks, one keyword, an entry tag, and skips blank and comment lines", () => {
    expect(parseCaptionText("# hook\n\n[chars] A b | c *d*,\n")).toEqual([{ line: 3, chunks: [["A", "b"], ["c", "d,"]], keyword: 3, entry: "chars" }]);
  });

  it("refuses an unknown entry", () => {
    expect(() => parseCaptionText("[wobble] a b")).toThrow(/wobble/);
  });

  it("splits a phrase across assets only by error", () => {
    const word = (id: string, asset: string) => ({ id, asset, clip: "c", text: id, start: 0, end: 1, sourceStart: 0, sourceEnd: 1 });
    expect(() => resolveCaptions(parseCaptionText("a b"), [word("a", "x.mp4"), word("b", "y.mp4")], () => 0)).toThrow(/spans/);
  });
});
