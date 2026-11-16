import type { ClipCompareResult, DaemonConnection } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { executeTimeline, parseClipLook, parseTimelineCommand } from "../src/timeline-commands.js";

// Seam under test: `clip compare` (#482, ADR 0035) from argv to the `clip.compare` request and the report.

const result: ClipCompareResult = {
  view: "current",
  proposal: null,
  timeline: "main",
  clip: "c_hero",
  type: "blender",
  frame: 30,
  at: 1,
  path: "/p/.frameshell/looks/compare-c_hero-30.png",
  width: 1450,
  height: 278,
  columns: 3,
  rows: 1,
  tiles: [
    { label: "1 current", kind: "current", source: "scenes/hero.blend", props: { scene: "Day" }, flags: "" },
    { label: "2 dusk", kind: "look", source: "scenes/hero.blend", props: { scene: "Dusk" }, flags: `--props '{"scene":"Dusk"}'` },
    { label: "3 copy", kind: "look", source: "scenes/hero-b.blend", props: { scene: "Day" }, flags: "" },
  ],
  warnings: ["Track v1 is hidden."],
};

function stub(reply: ClipCompareResult) {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const conn = {
    request: async (method: string, params: Record<string, unknown>) => {
      sent.push({ method, params });
      return reply;
    },
  } as unknown as DaemonConnection;
  return { conn, sent };
}

describe("clip compare", () => {
  it("reads a look as [name:]key=value pairs: props, with source apart", () => {
    expect(parseClipLook("dusk:scene=Dusk")).toEqual({ name: "dusk", props: { scene: "Dusk" } });
    expect(parseClipLook("close:camera=Close, scene=Dusk")).toEqual({ name: "close", props: { camera: "Close", scene: "Dusk" } });
    expect(parseClipLook("b:source=scenes/hero-b.blend")).toEqual({ name: "b", source: "scenes/hero-b.blend" });
    expect(parseClipLook("samples=32,denoise=true,camera=null")).toEqual({ props: { samples: 32, denoise: true, camera: null } });
    expect(parseClipLook(`{"name":"x","props":{"a":[1,2]}}`)).toEqual({ name: "x", props: { a: [1, 2] } });
    expect(() => parseClipLook("dusk")).toThrow(/--look: expected \[name:\]key=value/);
  });

  it("keeps scene and camera names as text, even when they read as numbers or booleans; null still drops them", () => {
    expect(parseClipLook("a:scene=2024")).toEqual({ name: "a", props: { scene: "2024" } });
    expect(parseClipLook("camera=001,scene=true,samples=32")).toEqual({ props: { camera: "001", scene: "true", samples: 32 } });
    expect(parseClipLook("scene=null")).toEqual({ props: { scene: null } });
  });

  it("refuses looks that are not key=value pairs or JSON objects", () => {
    expect(() => parseClipLook("dusk:scene=")).toThrow(/--look: expected/);
    expect(() => parseClipLook("{nope")).toThrow(/expected a JSON object/);
  });

  it("sends the clip, looks and options to clip.compare, on the given timeline", () => {
    const inv = parseTimelineCommand(["clip", "compare", "c_hero"], {
      timeline: "intro",
      look: ["dusk:scene=Dusk", "source=scenes/b.blend"],
      at: "1.5",
      out: "sheet.png",
      "tile-width": "320",
      format: "9x16",
    });
    expect(inv).toMatchObject({
      method: "clip.compare",
      withCwd: true,
      params: { timeline: "intro", clip: "c_hero", looks: [{ name: "dusk", props: { scene: "Dusk" } }, { source: "scenes/b.blend" }], at: 1.5, out: "sheet.png", tileWidth: 320, projectFormat: "9x16" },
    });
    expect(parseTimelineCommand(["clip", "compare", "c_hero"], { look: ["scene=Dusk"] })!.params).toEqual({ clip: "c_hero", looks: [{ props: { scene: "Dusk" } }] });
  });

  it("refuses no look, too many, a bad tile width and other commands' flags", () => {
    expect(() => parseTimelineCommand(["clip", "compare", "c_hero"], {})).toThrow(/needs at least one --look/);
    expect(() => parseTimelineCommand(["clip", "compare", "c_hero"], { look: Array.from({ length: 12 }, () => "a=1") })).toThrow(/at most 11 looks/);
    expect(() => parseTimelineCommand(["clip", "compare", "c_hero"], { look: ["a=1"], "tile-width": "100" })).toThrow(/--tile-width/);
    expect(() => parseTimelineCommand(["clip", "compare", "c_hero"], { look: ["a=1"], samples: "3" })).toThrow(/does not take --samples/);
    expect(() => parseTimelineCommand(["clip", "compare"], { look: ["a=1"] })).toThrow(/takes 1 argument/);
  });

  it("prints the image and the clip set command that keeps each look; nothing is applied", async () => {
    const inv = parseTimelineCommand(["clip", "compare", "c_hero"], { look: ["dusk:scene=Dusk"] })!;
    const { conn, sent } = stub(result);
    const text = await executeTimeline(conn, inv, "/p", false);
    expect(sent.map((call) => call.method)).toEqual(["clip.compare"]);
    expect(text).toContain("Clip compare of c_hero (blender) on main · frame 30 at 1.000 s · 3 tiles, 3x1");
    expect(text).toContain("/p/.frameshell/looks/compare-c_hero-30.png (1450x278)");
    expect(text).toContain("1 current          (the clip as it is)");
    expect(text).toContain(`2 dusk             frameshell clip set c_hero --props '{"scene":"Dusk"}'`);
    expect(text).toContain("3 copy             (same props as the clip) (source scenes/hero-b.blend: clip add it again to keep)");
    expect(text).toContain("warning: Track v1 is hidden.");
  });

  it("gives --json the daemon's result as it is", async () => {
    const inv = parseTimelineCommand(["clip", "compare", "c_hero"], { look: ["a=1"] })!;
    const { conn } = stub(result);
    expect(JSON.parse(await executeTimeline(conn, inv, "/p", true))).toEqual(result);
  });
});
