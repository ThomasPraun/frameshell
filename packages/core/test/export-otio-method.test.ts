import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { otioProblems } from "./otio-check.js";
import { testBinaryManager } from "./media-tools.js";

// The `export.otio` method end to end: a project whose timelines are written as files, so no ffmpeg runs.
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
        { id: "c_a", type: "media", asset: "assets/take.mp4", start: 0, in: 1, out: 3 },
        { id: "c_gen", type: "hyperframes", start: 4, duration: 2, source: "compositions/hyperframes/intro/index.html" },
        { id: "c_inner", type: "timeline", start: 6, source: "timelines/inner.json" },
      ],
    },
  ],
  markers: [{ id: "m_1", at: 2, label: "hook", color: "blue" }],
};

const inner = {
  schemaVersion: 1,
  id: "inner",
  revision: 1,
  tracks: [{ id: "t_i1", kind: "video", clips: [{ id: "c_i", type: "media", asset: "assets/take.mp4", start: 0, in: 0, out: 1.5 }] }],
};

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  writeFileSync(join(project, "timelines", "main.json"), JSON.stringify(timeline, null, 2));
  writeFileSync(join(project, "timelines", "inner.json"), JSON.stringify(inner, null, 2));
});

afterAll(async () => {
  conn.close();
  await daemon.close();
});

describe("export.otio", () => {
  it("writes exports/<timeline>.otio, relative to the file, and reports what it left as missing", async () => {
    const result = await conn.request("export.otio", { cwd: project });
    const path = join(project, "exports", "main.otio");
    expect(result).toMatchObject({ path, timeline: "main", fps: 30, tracks: 1, clips: 3, markers: 1 });
    expect(result.warnings).toEqual([
      "generated clip c_gen (hyperframes) exported as missing media of its length: render it and relink the file by hand.",
      "nested timeline clip c_inner (inner) exported as missing media of its length: export that timeline on its own and relink it.",
    ]);
    const otio = JSON.parse(readFileSync(path, "utf8"));
    expect(otio.OTIO_SCHEMA).toBe("Timeline.1");
    expect(otioProblems(otio)).toEqual([]);
    const children = otio.tracks.children[0].children;
    expect(children.map((child: { OTIO_SCHEMA: string }) => child.OTIO_SCHEMA)).toEqual(["Clip.2", "Gap.1", "Clip.2", "Clip.2"]);
    expect(children[0].media_references.DEFAULT_MEDIA.target_url).toBe("../assets/take.mp4");
    expect(children[3].source_range.duration.value).toBe(45);
    expect(otio.tracks.markers[0]).toMatchObject({ name: "hook", color: "BLUE" });
    // Read-only: the timeline is as it was.
    expect(JSON.parse(readFileSync(join(project, "timelines", "main.json"), "utf8")).revision).toBe(3);
  });

  it("writes absolute file URLs on request, to the folder asked for", async () => {
    const out = join(tempDir(), "sub", "edit.otio");
    const result = await conn.request("export.otio", { cwd: project, out, absolutePaths: true });
    expect(result.path).toBe(out);
    const url = JSON.parse(readFileSync(out, "utf8")).tracks.children[0].children[0].media_references.DEFAULT_MEDIA.target_url as string;
    expect(url.startsWith("file:///")).toBe(true);
    expect(url.endsWith("/assets/take.mp4")).toBe(true);
    const relative = join(tempDir(), "elsewhere", "edit.otio");
    await conn.request("export.otio", { cwd: project, out: relative });
    const link = JSON.parse(readFileSync(relative, "utf8")).tracks.children[0].children[0].media_references.DEFAULT_MEDIA.target_url as string;
    expect(link.startsWith("..") || link.startsWith("file:///")).toBe(true);
  });

  it("refuses an out that is not an .otio file, such as a timeline file", async () => {
    const out = join(project, "timelines", "main.json");
    await expect(conn.request("export.otio", { cwd: project, out })).rejects.toMatchObject({ code: ErrorCode.InvalidOperation });
    expect(JSON.parse(readFileSync(out, "utf8")).id).toBe("main");
  });

  it("fails for a timeline that does not exist", async () => {
    await expect(conn.request("export.otio", { cwd: project, timeline: "nope" })).rejects.toMatchObject({ code: ErrorCode.TimelineNotFound });
  });

  // FRAMESHELL_TEST_OTIO=1 reads the file with OpenTimelineIO itself; never required, no Python dependency otherwise.
  it.skipIf(process.env["FRAMESHELL_TEST_OTIO"] !== "1")("OpenTimelineIO reads the file", async () => {
    await conn.request("export.otio", { cwd: project });
    const path = join(project, "exports", "main.otio");
    expect(existsSync(path)).toBe(true);
    mkdirSync(dirname(path), { recursive: true });
    const script = "import sys, opentimelineio as otio; t = otio.adapters.read_from_file(sys.argv[1]); print(len(t.tracks), t.duration().value)";
    const out = execFileSync("python", ["-I", "-c", script, path], { encoding: "utf8" }).trim();
    expect(out.startsWith("1 ")).toBe(true);
  });
});
