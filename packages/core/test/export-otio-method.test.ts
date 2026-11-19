import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { otioProblems } from "./otio-check.js";
import { mediaTools, run, testBinaryManager } from "./media-tools.js";

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
}, 120_000);

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
      "sound of media clips on a video track (OTIO keeps sound on audio tracks) on 1 clip not exported (c_a).",
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

  it("writes a dissolve between butted clips as Transition.1, its half cut to the handle the files have", async () => {
    const { ffmpeg } = await mediaTools();
    mkdirSync(join(project, "assets"), { recursive: true });
    // 2.2 s of media: a clip ending at 2 s has 0.2 s of handle after it, so a requested 1 s dissolve is 0.2 s a side.
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=64x36:r=30:d=2.2", "-pix_fmt", "yuv420p", join(project, "assets", "short.mp4")]);
    const dissolved = {
      ...timeline,
      id: "dissolved",
      tracks: [
        {
          id: "t_v1",
          kind: "video",
          clips: [
            { id: "c_a", type: "media", asset: "assets/short.mp4", start: 0, in: 0, out: 2, audio: { muted: true } },
            { id: "c_b", type: "media", asset: "assets/short.mp4", start: 2, in: 0.5, out: 2.1, dissolve: 1, audio: { muted: true } },
          ],
        },
      ],
    };
    writeFileSync(join(project, "timelines", "dissolved.json"), JSON.stringify(dissolved, null, 2));
    const result = await conn.request("export.otio", { cwd: project, timeline: "dissolved" });
    expect(result).toMatchObject({ tracks: 1, clips: 2 });
    expect(result.warnings.filter((warning) => warning.includes("dissolve") || warning.includes("transition"))).toEqual([]);
    const otio = JSON.parse(readFileSync(join(project, "exports", "dissolved.otio"), "utf8"));
    const children = otio.tracks.children[0].children;
    expect(children.map((child: { OTIO_SCHEMA: string }) => child.OTIO_SCHEMA)).toEqual(["Clip.2", "Transition.1", "Clip.2"]);
    expect(children[1]).toMatchObject({ transition_type: "SMPTE_Dissolve", in_offset: { value: 6 }, out_offset: { value: 6 } });
    expect(otioProblems(otio)).toEqual([]);
  }, 120_000);

  it("refuses an image project: it has no cut to hand to an editor", async () => {
    const image = tempDir();
    await conn.request("project.init", { dir: image, kind: "image" });
    await expect(conn.request("export.otio", { cwd: image })).rejects.toMatchObject({ code: ErrorCode.InvalidOperation });
    expect(existsSync(join(image, "exports", "main.otio"))).toBe(false);
  });

  it("fails for a timeline that does not exist", async () => {
    await expect(conn.request("export.otio", { cwd: project, timeline: "nope" })).rejects.toMatchObject({ code: ErrorCode.TimelineNotFound });
  });
});
