import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { all, one, parseXml, premiereProblems, textOf, tracksOf, within } from "./premiere-check.js";
import { mediaTools, run, testBinaryManager } from "./media-tools.js";

// The `export.premiereXml` method end to end: a project whose timelines are written as files; media is synthetic and tiny.
let daemon: Daemon;
let conn: DaemonConnection;
let project: string;

const timeline = {
  schemaVersion: 1,
  id: "main",
  revision: 3,
  tracks: [
    {
      id: "t_v1",
      kind: "video",
      clips: [
        { id: "c_a", type: "media", asset: "assets/take.mp4", start: 0, in: 0, out: 1.5 },
        { id: "c_gen", type: "hyperframes", start: 4, duration: 2, source: "compositions/hyperframes/intro/index.html" },
      ],
    },
  ],
  markers: [{ id: "m_1", at: 2, label: "hook", color: "blue" }],
};

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  writeFileSync(join(project, "timelines", "main.json"), JSON.stringify(timeline, null, 2));
  const { ffmpeg } = await mediaTools();
  mkdirSync(join(project, "assets"), { recursive: true });
  await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=s=64x36:r=30:d=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-pix_fmt", "yuv420p", "-shortest",
    join(project, "assets", "take.mp4"),
  ]);
}, 120_000);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

describe("export.premiereXml", () => {
  it("writes exports/<timeline>.xml with an absolute pathurl, the file as probed, and reports what it left as offline", async () => {
    const result = await conn.request("export.premiereXml", { cwd: project });
    const path = join(project, "exports", "main.xml");
    expect(result).toMatchObject({ path, timeline: "main", fps: 30, tracks: 2, clips: 2, markers: 1 });
    expect(result.warnings).toEqual([
      "generated clip c_gen (hyperframes) exported as missing media of its length: render it and relink the file by hand.",
      "marker colours not exported.",
    ]);
    const xml = readFileSync(path, "utf8");
    expect(premiereProblems(xml)).toEqual([]);
    const doc = parseXml(xml);
    const [picture] = all(tracksOf(doc, "video")[0]!, "clipitem");
    const url = textOf(one(picture!, "file"), "pathurl");
    expect(url.startsWith("file://localhost/")).toBe(true);
    expect(url.endsWith("/assets/take.mp4")).toBe(true);
    // The file as ffprobe read it: 64x36 picture, one audio stream, 2 s at 30 fps.
    const file = one(picture!, "file");
    expect(within(file, "width").map((node) => node.text)).toEqual(["64"]);
    expect(within(file, "channelcount").map((node) => node.text)).toEqual(["1"]);
    expect(textOf(file, "duration")).toBe("60");
    expect(all(tracksOf(doc, "audio")[0]!, "clipitem")).toHaveLength(1);
    // Read-only: the timeline is as it was.
    expect(JSON.parse(readFileSync(join(project, "timelines", "main.json"), "utf8")).revision).toBe(3);
  });

  it("writes to the file asked for, and creates its folder", async () => {
    const out = join(tempDir(), "sub", "edit.xml");
    const result = await conn.request("export.premiereXml", { cwd: project, out });
    expect(result.path).toBe(out);
    expect(premiereProblems(readFileSync(out, "utf8"))).toEqual([]);
  });

  it("refuses an out that is not an .xml file, such as a timeline file", async () => {
    const out = join(project, "timelines", "main.json");
    await expect(conn.request("export.premiereXml", { cwd: project, out })).rejects.toMatchObject({ code: ErrorCode.InvalidOperation });
    expect(JSON.parse(readFileSync(out, "utf8")).id).toBe("main");
  });

  it("refuses an image project: it has no cut to hand to an editor", async () => {
    const image = tempDir();
    await conn.request("project.init", { dir: image, kind: "image" });
    await expect(conn.request("export.premiereXml", { cwd: image })).rejects.toMatchObject({ code: ErrorCode.InvalidOperation });
    expect(existsSync(join(image, "exports", "main.xml"))).toBe(false);
  });

  it("fails for a timeline that does not exist", async () => {
    await expect(conn.request("export.premiereXml", { cwd: project, timeline: "nope" })).rejects.toMatchObject({ code: ErrorCode.TimelineNotFound });
  });
});
