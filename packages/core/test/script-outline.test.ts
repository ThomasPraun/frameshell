import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { createTimeline } from "@frameshell/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// Seam under test: the `script.outline` registry method and `scriptRef` checks
// of `clip.add`/`clip.set`, through a real in-process daemon and project dir.

const SCRIPT = ["---", "title: Launch", "target_duration: 45", "aspect: '9:16'", "---", "## Intro", "Hola.", "## Demo", "Show it.", "## Outro", "Bye."].join("\n");

/** Hand-written adapter clip: its timing needs no plugin, so none is loaded. */
function titleClip(id: string, start: number, scriptRef?: string) {
  return { id, type: "titles", start, duration: 1, ...(scriptRef ? { scriptRef } : {}) };
}

let daemon: Daemon;
let conn: DaemonConnection;
let root: string;

beforeEach(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), idleTimeoutMs: Number.POSITIVE_INFINITY });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  root = join(tempDir(), "launch");
  await conn.request("project.init", { dir: root });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "launch.md"), SCRIPT);
  const main = {
    ...createTimeline("main"),
    tracks: [
      {
        id: "t_v",
        kind: "video",
        clips: [
          titleClip("c_a", 0, "scripts/launch.md#intro"),
          titleClip("c_b", 2, "scripts/launch.md#intro"),
          titleClip("c_gone", 4, "scripts/launch.md#cut-scene"),
          titleClip("c_free", 6),
        ],
      },
    ],
  };
  const intro = { ...createTimeline("intro"), tracks: [{ id: "t_x", kind: "video", clips: [titleClip("c_n", 0, "scripts/launch.md#demo")] }] };
  writeFileSync(join(root, "timelines", "main.json"), JSON.stringify(main));
  writeFileSync(join(root, "timelines", "intro.json"), JSON.stringify(intro));
  const filler = { ...createTimeline("filler"), tracks: [{ id: "t_f", kind: "video", clips: [titleClip("c_f", 0)] }] };
  writeFileSync(join(root, "timelines", "filler.json"), JSON.stringify(filler));
});

afterEach(async () => {
  conn.close();
  await daemon.close();
});

describe("script.outline", () => {
  it("returns frontmatter, scenes with refs, and the clips of every timeline linked to each scene", async () => {
    const outline = await conn.request("script.outline", { cwd: join(root, "scripts"), file: "launch.md" });
    expect(outline.path).toBe("scripts/launch.md");
    expect(outline.meta).toEqual({ title: "Launch", targetDuration: 45, aspect: "9:16" });
    expect(outline.scenes.map(({ slug, ref, line, clips }) => ({ slug, ref, line, clips }))).toEqual([
      { slug: "intro", ref: "scripts/launch.md#intro", line: 6, clips: [{ timeline: "main", clip: "c_a" }, { timeline: "main", clip: "c_b" }] },
      { slug: "demo", ref: "scripts/launch.md#demo", line: 8, clips: [{ timeline: "intro", clip: "c_n" }] },
      { slug: "outro", ref: "scripts/launch.md#outro", line: 10, clips: [] },
    ]);
    expect(outline.unresolved).toEqual([{ timeline: "main", clip: "c_gone", scriptRef: "scripts/launch.md#cut-scene" }]);
    expect(outline.warnings).toEqual([]);
  });

  it("resolves the file from the project root too, and skips unreadable timelines with a warning", async () => {
    writeFileSync(join(root, "timelines", "broken.json"), "{ nope");
    const outline = await conn.request("script.outline", { cwd: join(root, "assets"), file: "scripts/launch.md" });
    expect(outline.path).toBe("scripts/launch.md");
    expect(outline.warnings).toEqual([expect.stringMatching(/timelines\/broken\.json.*skipped/)]);
  });

  it("fails with ScriptNotFound listing the scripts there are", async () => {
    await expect(conn.request("script.outline", { cwd: root, file: "scripts/nope.md" })).rejects.toMatchObject({
      code: ErrorCode.ScriptNotFound,
      data: { path: "scripts/nope.md", available: ["scripts/launch.md"] },
    });
  });

  it("refuses files outside the project", async () => {
    const outside = join(tempDir(), "x.md");
    writeFileSync(outside, "## A\n");
    await expect(conn.request("script.outline", { cwd: root, file: outside })).rejects.toMatchObject({ code: ErrorCode.OutsideProject });
  });
});

describe("scriptRef on clip operations", () => {
  const set = (scriptRef: string | null) => conn.request("clip.set", { cwd: root, clip: "c_free", scriptRef });

  it("stores a ref to an existing scene without warnings", async () => {
    const result = await set("scripts/launch.md#outro");
    expect(result.warnings).toEqual([]);
    const view = await conn.request("timeline.show", { cwd: root });
    expect(view.tracks[0]!.clips.find((clip) => clip.id === "c_free")).toMatchObject({ scriptRef: "scripts/launch.md#outro" });
  });

  it("stores a ref to a missing scene or script but warns with what exists", async () => {
    const missingScene = await set("scripts/launch.md#Outro");
    expect(missingScene.revision).toBeGreaterThan(0);
    expect(missingScene.warnings).toEqual([expect.stringMatching(/no scene "Outro" in scripts\/launch\.md.*intro, demo, outro/)]);

    const missingFile = await set("scripts/later.md#intro");
    expect(missingFile.warnings).toEqual([expect.stringMatching(/scripts\/later\.md does not exist/)]);

    const noAnchor = await set("scripts/launch.md");
    expect(noAnchor.warnings).toEqual([expect.stringMatching(/no `#scene` anchor/)]);

    const view = await conn.request("timeline.show", { cwd: root });
    expect(view.tracks[0]!.clips.find((clip) => clip.id === "c_free")).toMatchObject({ scriptRef: "scripts/launch.md" });
  });

  it("checks refs given to clip.add and never warns when clearing", async () => {
    const added = await conn.request("clip.add", {
      cwd: root,
      track: "t_v",
      type: "timeline",
      source: "timelines/filler.json",
      duration: 1,
      start: 10,
      scriptRef: "scripts/launch.md#nope",
    });
    expect(added.warnings).toHaveLength(1);
    expect((await set(null)).warnings).toEqual([]);
    expect((await conn.request("clip.set", { cwd: root, clip: "c_free", gain: -3 })).warnings).toEqual([]);
  });
});
