import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import type { Timeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { type InspectOptions, InspectService } from "../src/inspect/service.js";
import { tempDir } from "./helpers.js";
import { testBinaryManager } from "./media-tools.js";

// Seam under test: `inspect.point` (ADR 0011): the clip stack under a point from the export placement, and the
// element of a generated clip from its live page in headless Chrome (opt-in: FRAMESHELL_TEST_REAL_CHROME=1).

const HD = { width: 1920, height: 1080 };

/** Footage on v1 (0-4 s); on v2 a `card` overlay at half size, centered (1-3 s, in 0.5). */
const timeline: Timeline = {
  $schema: "https://frameshell.dev/schema/v1/timeline.json",
  schemaVersion: 1,
  id: "main",
  revision: 3,
  tracks: [
    { id: "v1", kind: "video", clips: [{ id: "c_cam", type: "media", asset: "assets/cam.mp4", start: 0, in: 0, out: 4 }] },
    { id: "v2", kind: "video", clips: [{ id: "c_card", type: "card", source: "comp/card.html", start: 1, in: 0.5, duration: 2, transform: { scale: 0.5 } }] },
  ],
} as Timeline;

function service(overrides: Partial<InspectOptions> = {}): InspectService {
  return new InspectService({
    timeline: async () => ({ timeline, fps: 30 }),
    resolution: async () => HD,
    pictureSize: async () => HD,
    live: async () => {
      throw new RpcError(ErrorCode.LiveUnavailable, "card clip c_card cannot be shown live: the project's plugins are not trusted", {
        details: "the project's plugins are not trusted",
      });
    },
    chrome: async () => {
      throw new Error("Chrome must not start");
    },
    ...overrides,
  });
}

describe("inspect.point", () => {
  it("lists the clips under a point, topmost first, and names the footage where nothing covers it", async () => {
    const point = await service().point("/p", { timeline: "main", at: 0.5, x: 0.5, y: 0.5 });
    expect(point).toEqual({
      x: 0.5,
      y: 0.5,
      at: 0.5,
      layers: [{ clip: "c_cam", type: "media", paints: true }],
      target: "c_cam",
      elements: [],
      unavailable: null,
      timeline: "main",
      frame: 15,
      pixel: { x: 960, y: 540 },
    });
  });

  it("without a live page, the generated clip's box decides, Chrome never starts, and `unavailable` says why", async () => {
    const point = await service().point("/p", { timeline: "main", at: 2, x: 0.5, y: 0.5 });
    expect(point.layers).toEqual([
      { clip: "c_card", type: "card", paints: true },
      { clip: "c_cam", type: "media", paints: true },
    ]);
    expect(point).toMatchObject({ target: "c_card", elements: [], unavailable: "the project's plugins are not trusted" });
    // Outside the half-size card: only the footage.
    expect((await service().point("/p", { timeline: "main", at: 2, x: 0.1, y: 0.1 })).target).toBe("c_cam");
  });

  it("hits the shot whose tile holds the point on a program track above the footage", async () => {
    const multicam = {
      ...timeline,
      tracks: [
        timeline.tracks[0]!,
        { id: "t_p", kind: "program", group: "g_talk", clips: [{ id: "c_s", type: "shot", start: 1, in: 0, out: 2, shot: "two-up", angles: ["ana", "ben"] }] },
      ],
      groups: [
        {
          id: "g_talk",
          angles: [
            { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0 },
            { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 0 },
          ],
        },
      ],
    } as Timeline;
    const inspect = service({ timeline: async () => ({ timeline: multicam, fps: 30 }) });
    const point = await inspect.point("/p", { timeline: "main", at: 2, x: 0.75, y: 0.5 });
    expect(point.layers).toEqual([
      { clip: "c_s", type: "shot", paints: true },
      { clip: "c_cam", type: "media", paints: true },
    ]);
    expect(point.target).toBe("c_s");
    // Before the shot starts: the footage.
    expect((await inspect.point("/p", { timeline: "main", at: 0.5, x: 0.75, y: 0.5 })).target).toBe("c_cam");
  });

  it("takes project pixels too, and refuses a time or a point outside the timeline and frame", async () => {
    const point = await service().point("/p", { timeline: "main", at: 0.5, x: 480, y: 270, unit: "pixel" });
    expect(point).toMatchObject({ x: 0.25, y: 0.25, pixel: { x: 480, y: 270 }, target: "c_cam" });
    await expect(service().point("/p", { timeline: "main", at: 4, x: 0.5, y: 0.5 })).rejects.toMatchObject({ code: ErrorCode.InvalidOperation });
    await expect(service().point("/p", { timeline: "main", at: 1, x: 2000, y: 10, unit: "pixel" })).rejects.toThrow(/outside the 1920x1080 frame/);
    await expect(service().point("/p", { timeline: "main", at: 1, x: 1.5, y: 0.5 })).rejects.toThrow(/not a fraction/);
  });
});

describe.runIf(process.env["FRAMESHELL_TEST_REAL_CHROME"] === "1")("inspect.point in real headless Chrome", () => {
  it(
    "loads the clip's live page, seeks it and reports the element painting the point, or lets the point through",
    async () => {
      const root = tempDir();
      mkdirSync(join(root, "comp"), { recursive: true });
      // A 1920x1080 page: a title box at the top left whose text is the seek time, the rest transparent.
      writeFileSync(
        join(root, "comp", "card.html"),
        `<!doctype html><html><head><style>html,body{margin:0;background:transparent}#title{position:absolute;left:100px;top:100px;width:600px;height:200px;background:#222;color:#fff;font:64px sans-serif}</style></head>` +
          `<body><div id="title" class="card"><span>-</span></div></body></html>`,
      );
      const head =
        `window.frameshellLive = { ready: Promise.resolve(), seek(t) { document.querySelector("#title span").textContent = t.toFixed(2); },` +
        ` describe(element) { return { source: "comp/card.html" }; } };`;
      const inspect = service({
        live: async (_root, _timeline, clip) => ({ clip, root: "comp", entry: "comp/card.html", head, key: "k" }),
        chrome: () => testBinaryManager().ensure("chrome-headless-shell"),
      });
      // Card at half size, centered: page pixel (200, 200) is frame pixel (480 + 100, 270 + 100).
      const hit = await inspect.point(root, { timeline: "main", at: 2, x: 580 / 1920, y: 370 / 1080 });
      expect(hit.target).toBe("c_card");
      expect(hit.elements[0]).toMatchObject({ selector: "#title", tag: "div", text: "1.50", box: { x: 100, y: 100, width: 600, height: 200 }, adapter: { source: "comp/card.html" }, generated: false });
      // Inside the card's box but on its transparent part: the footage below.
      const through = await inspect.point(root, { timeline: "main", at: 2, x: 0.6, y: 0.6 });
      expect(through.target).toBe("c_cam");
      expect(through.layers).toEqual([
        { clip: "c_card", type: "card", paints: false },
        { clip: "c_cam", type: "media", paints: true },
      ]);
    },
    600_000,
  );
});
