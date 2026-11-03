import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Timeline, createProjectConfig, createTimeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { fileUses, timelineUses } from "../src/file-uses.js";
import { tempDir } from "./helpers.js";

function media(id: string, asset: string, start = 0) {
  return { id, type: "media" as const, asset, start, in: 0, out: 1 };
}

function project(timelines: Record<string, Timeline | string>): string {
  const root = tempDir();
  writeFileSync(join(root, "frameshell.json"), JSON.stringify(createProjectConfig("p")));
  mkdirSync(join(root, "timelines"));
  for (const [id, timeline] of Object.entries(timelines)) {
    writeFileSync(join(root, "timelines", `${id}.json`), typeof timeline === "string" ? timeline : JSON.stringify(timeline));
  }
  return root;
}

function withClips(id: string, clips: ReturnType<typeof media>[]): Timeline {
  return { ...createTimeline(id), tracks: [{ id: "t_v1", kind: "video", clips }] };
}

describe("timelineUses", () => {
  it("finds clips naming the file or anything under a folder, not look-alike names", () => {
    const timeline = withClips("main", [media("c_a", "assets/take.mp4"), media("c_b", "assets/take.mp4.bak", 1), media("c_c", "assets/sub/x.mp4", 2)]);
    expect(timelineUses("main", timeline, "assets/take.mp4")).toEqual([{ timeline: "main", id: "c_a", ref: "assets/take.mp4" }]);
    expect(timelineUses("main", timeline, "assets/sub").map((use) => use.id)).toEqual(["c_c"]);
    expect(timelineUses("main", timeline, "assets").map((use) => use.id)).toEqual(["c_a", "c_b", "c_c"]);
  });

  it("finds multicam angles and mics by their group", () => {
    const timeline = {
      ...createTimeline("main"),
      groups: [{ id: "g_1", angles: [{ id: "a", asset: "assets/cam.mp4", offset: 0 }], mics: [{ id: "m", asset: "assets/mic.wav", offset: 0 }] }],
    } as unknown as Timeline;
    expect(timelineUses("main", timeline, "assets/mic.wav")).toEqual([{ timeline: "main", id: "g_1", ref: "assets/mic.wav" }]);
  });
});

describe("fileUses", () => {
  it("lists uses across timelines, project-relative, and skips unreadable timelines", async () => {
    const root = project({
      main: withClips("main", [media("c_a", "exports/cut.mp4")]),
      short: withClips("short", [media("c_b", "exports/cut.mp4")]),
      broken: "{",
    });
    expect(await fileUses(join(root, "exports", "cut.mp4"))).toEqual({
      project: root,
      path: "exports/cut.mp4",
      uses: [
        { timeline: "main", id: "c_a", ref: "exports/cut.mp4" },
        { timeline: "short", id: "c_b", ref: "exports/cut.mp4" },
      ],
    });
    expect((await fileUses(join(root, "scripts", "none.md"))).uses).toEqual([]);
  });

  it("refuses paths outside a project and the project root itself", async () => {
    const root = project({});
    await expect(fileUses(join(tempDir(), "x.mp4"))).rejects.toThrow(/not inside a Frameshell project/);
    await expect(fileUses(root)).rejects.toThrow(/not inside a Frameshell project/);
  });
});
