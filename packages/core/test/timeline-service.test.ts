import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorCode, type MediaProbe, RpcError } from "@frameshell/protocol";
import type { ClipAdapter } from "@frameshell/plugin-api";
import { createProjectConfig, createTimeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TimelineService } from "../src/timeline/service.js";
import { tempDir } from "./helpers.js";

// Seam under test: TimelineService on a real project directory, with the media
// probe and plugin host replaced by in-memory adapters.

const PROBE: MediaProbe = {
  duration: 4,
  format: "mov,mp4",
  video: { codec: "h264", width: 320, height: 240, fps: 30, vfr: false, still: false },
  audio: null,
};

const titles: ClipAdapter = {
  type: "titles",
  propsSchema: z.strictObject({ title: z.string() }),
  render: async () => ({ file: "", hasAlpha: true }),
};

function project(): string {
  const root = tempDir();
  mkdirSync(join(root, "timelines"));
  mkdirSync(join(root, "assets", "raw"), { recursive: true });
  writeFileSync(join(root, "assets", "raw", "a.mp4"), "not really media");
  writeFileSync(join(root, "frameshell.json"), JSON.stringify(createProjectConfig("Test")));
  for (const id of ["main", "intro"]) {
    const timeline = { ...createTimeline(id), tracks: [{ id: "t_v", kind: "video", clips: [] }] };
    writeFileSync(join(root, "timelines", `${id}.json`), JSON.stringify(timeline));
  }
  return root;
}

function service() {
  let next = 0;
  const probed: string[] = [];
  const timelines = new TimelineService({
    probe: async (_root, asset) => {
      probed.push(asset);
      return PROBE;
    },
    clipTypes: async () => new Map([["titles", titles]]),
    newId: (prefix) => `${prefix}_${++next}`,
  });
  return { timelines, probed };
}

async function rejection(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("TimelineService", () => {
  it("stores assets project-relative whether given relative to cwd or to the project", async () => {
    const root = project();
    const { timelines, probed } = service();
    const call = (asset: string, cwd: string, start: number) =>
      timelines.apply({
        root,
        cwd,
        timeline: "main",
        author: "cli",
        request: { op: "clip.add", args: { track: "t_v", type: "media", asset, start } },
      });
    await call("a.mp4", join(root, "assets", "raw"), 0);
    await call("assets/raw/a.mp4", join(root, "assets"), 5);
    expect(probed).toEqual(["assets/raw/a.mp4", "assets/raw/a.mp4"]);
    const written = JSON.parse(readFileSync(join(root, "timelines", "main.json"), "utf8"));
    expect(written.revision).toBe(2);
    expect(written.tracks[0].clips.map((c: { asset: string }) => c.asset)).toEqual(["assets/raw/a.mp4", "assets/raw/a.mp4"]);
  });

  it("checks adapter props with the adapter's Standard Schema (Zod)", async () => {
    const root = project();
    const { timelines } = service();
    const add = (props: Record<string, unknown>) =>
      timelines.apply({
        root,
        cwd: root,
        timeline: "main",
        author: "cli",
        request: { op: "clip.add", args: { track: "t_v", type: "titles", duration: 2, props } },
      });
    const error = await rejection(add({ title: 7 }));
    expect(error.code).toBe(ErrorCode.InvalidOperation);
    expect(error.message).toMatch(/invalid props for titles: title: /);
    const added = await add({ title: "Hola" });
    expect(added).toMatchObject({ revision: 1, changes: { added: [expect.stringMatching(/^c_\d+$/)] } });
  });

  it("resolves nested timelines by id, derives their duration, and refuses cycles", async () => {
    const root = project();
    const { timelines } = service();
    const nest = (timeline: string, source: string) =>
      timelines.apply({
        root,
        cwd: root,
        timeline,
        author: "cli",
        request: { op: "clip.add", args: { track: "t_v", type: "timeline", source } },
      });
    await timelines.apply({
      root,
      cwd: root,
      timeline: "intro",
      author: "cli",
      request: { op: "clip.add", args: { track: "t_v", type: "media", asset: "assets/raw/a.mp4", start: 1 } },
    });
    const nested = await nest("main", "intro");
    expect(nested.operation.args).toMatchObject({ source: "timelines/intro.json" });
    const view = await timelines.show(root, "main");
    expect(view.tracks[0]!.clips[0]).toMatchObject({ type: "timeline", start: 0, end: 5 });
    expect(view.duration).toBe(5);

    const cycle = await rejection(nest("intro", "main"));
    expect(cycle.message).toContain(
      "timelines/intro.json would contain itself (timelines/intro.json -> timelines/main.json -> timelines/intro.json)",
    );
  });

  it("names the timelines that exist when one is missing", async () => {
    const error = await rejection(service().timelines.show(project(), "outro"));
    expect(error.code).toBe(ErrorCode.TimelineNotFound);
    expect(error.data).toEqual({ timeline: "outro", path: "timelines/outro.json", available: ["intro", "main"] });
  });
});
