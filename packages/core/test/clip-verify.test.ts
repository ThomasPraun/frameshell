import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import type { Timeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { type ClipVerifyOptions, ClipVerifier, comparePixels, probeTimes, reseekIndex } from "../src/clips/verify.js";
import { tempDir } from "./helpers.js";
import { testBinaryManager } from "./media-tools.js";

// Seam under test: `clip.verify` (ADR 0033): probe times, the pixel comparison, the errors before Chrome starts, and
// (opt-in: FRAMESHELL_TEST_REAL_CHROME=1) cold-vs-reseek captures of real pages.

const SMALL = { width: 64, height: 36 };

/** A motion clip of 2 s played from composition second 1. */
const timeline = {
  $schema: "https://frameshell.dev/schema/v1/timeline.json",
  schemaVersion: 1,
  id: "main",
  revision: 1,
  tracks: [{ id: "v1", kind: "video", clips: [{ id: "c_motion", type: "hyperframes", source: "comp/page.html", start: 0, in: 1, duration: 2 }] }],
} as Timeline;

function verifier(overrides: Partial<ClipVerifyOptions> = {}): ClipVerifier {
  return new ClipVerifier({
    timeline: async () => ({ timeline, fps: 30 }),
    live: async () => {
      throw new Error("no live page here");
    },
    resolution: async () => SMALL,
    chrome: async () => {
      throw new Error("Chrome must not start");
    },
    ffmpeg: async () => {
      throw new Error("ffmpeg must not start");
    },
    ...overrides,
  });
}

describe("probe plan", () => {
  it("spreads probes at (i + 0.37) x duration / n from the clip's in", () => {
    expect(probeTimes(1, 2, 4)).toEqual([1.185, 1.685, 2.185, 2.685]);
    expect(probeTimes(0, 1, 12)[0]).toBe(0.031);
    expect(probeTimes(0, 1, 12)[11]).toBeCloseTo(0.9475, 2);
  });

  it("reseeks from a probe other than the one captured, for every count", () => {
    for (const count of [2, 3, 4, 5, 12, 48]) {
      for (let i = 0; i < count; i++) expect(reseekIndex(i, count)).not.toBe(i);
    }
    expect(reseekIndex(0, 12)).toBe(5);
    expect(reseekIndex(8, 12)).toBe(1);
  });
});

describe("comparePixels", () => {
  const rgba = (...pixels: number[][]) => Uint8Array.from(pixels.flat());

  it("reports the largest channel difference, the pixels over the tolerance and where the worst one is", () => {
    const a = rgba([10, 10, 10, 255], [0, 0, 0, 0], [50, 60, 70, 255], [1, 1, 1, 255]);
    const b = rgba([10, 12, 10, 255], [0, 0, 0, 0], [50, 60, 90, 255], [1, 1, 1, 253]);
    // Width 2: pixel 2 is row 1, column 0.
    expect(comparePixels(a, b, 2, 2)).toEqual({ max: 20, pixels: 1, at: { x: 0, y: 1 } });
    expect(comparePixels(a, b, 2, 0)).toEqual({ max: 20, pixels: 3, at: { x: 0, y: 1 } });
  });

  it("counts alpha, and calls identical pictures identical", () => {
    expect(comparePixels(rgba([5, 5, 5, 0]), rgba([5, 5, 5, 9]), 1, 2)).toMatchObject({ max: 9, pixels: 1 });
    expect(comparePixels(rgba([5, 5, 5, 9]), rgba([5, 5, 5, 9]), 1, 2)).toEqual({ max: 0, pixels: 0, at: null });
  });

  it("refuses pictures of different sizes", () => {
    expect(() => comparePixels(new Uint8Array(8), new Uint8Array(4), 1, 2)).toThrow(/different sizes/);
  });
});

describe("clip.verify before Chrome", () => {
  it("names the generated clips when the one asked for does not exist", async () => {
    const error = await verifier().verify("/p", { timeline: "main", clip: "c_nope" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect(error).toMatchObject({ code: ErrorCode.ClipNotFound });
    expect((error as Error).message).toContain("generated clips: c_motion");
  });

  it("passes the adapter's LiveUnavailable through without starting Chrome", async () => {
    const unavailable = new RpcError(ErrorCode.LiveUnavailable, "hyperframes clip c_motion cannot be shown live: the project's plugins are not trusted");
    const error = await verifier({
      live: async () => {
        throw unavailable;
      },
    })
      .verify("/p", { timeline: "main", clip: "c_motion" })
      .catch((e: unknown) => e);
    expect(error).toBe(unavailable);
  });
});

describe.runIf(process.env["FRAMESHELL_TEST_REAL_CHROME"] === "1")("clip.verify in real headless Chrome", () => {
  /** Project with `comp/page.html`: a 64x36 page whose `#box` is painted by `paint`, plus the `head` the adapter would add. */
  function project(paint: string, extraState = "") {
    const root = tempDir();
    mkdirSync(join(root, "comp"), { recursive: true });
    writeFileSync(
      join(root, "comp", "page.html"),
      `<!doctype html><html><head><style>html,body{margin:0;background:transparent}` +
        `#box{position:absolute;left:0;top:10px;width:12px;height:12px;background:#f00}</style></head><body><div id="box" class="moving"></div></body></html>`,
    );
    const head =
      `${extraState} window.frameshellLive = { ready: Promise.resolve(), seek(t) { const box = document.getElementById("box"); ${paint} } };`;
    return {
      root,
      verifier: verifier({
        live: async (_root, _timeline, clip) => ({ clip, root: "comp", entry: "comp/page.html", head, key: "k" }),
        chrome: () => testBinaryManager().ensure("chrome-headless-shell"),
        ffmpeg: () => testBinaryManager().ensure("ffmpeg"),
      }),
    };
  }

  it(
    "passes a pure function of time, over distinct pictures",
    async () => {
      const { root, verifier: v } = project(`box.style.transform = "translate(" + (t * 20) + "px, 0)";`);
      const result = await v.verify(root, { timeline: "main", clip: "c_motion", probes: 6 });
      expect(result).toMatchObject({ ok: true, tolerance: 2, size: SMALL, type: "hyperframes", worst: null, warnings: [] });
      expect(result.probes).toHaveLength(6);
      expect(result.probes.every((probe) => probe.max === 0 && probe.ok)).toBe(true);
      expect(result.probes[0]).toMatchObject({ at: 1.123, reseekFrom: 1.79 });
      expect(result.distinct).toBeGreaterThan(3);
    },
    120_000,
  );

  it(
    "fails a page that keeps state between seeks, naming the worst probe, pixel and element",
    async () => {
      // Eases toward the target instead of jumping: where the box is depends on the seek before.
      const { root, verifier: v } = project(`state.x += (t * 20 - state.x) * 0.5; box.style.transform = "translate(" + state.x + "px, 0)";`, "const state = { x: 0 };");
      const result = await v.verify(root, { timeline: "main", clip: "c_motion", probes: 6 });
      expect(result.ok).toBe(false);
      expect(result.probes.some((probe) => !probe.ok)).toBe(true);
      expect(result.worst).toMatchObject({ max: expect.any(Number), element: { selector: "#box", tag: "div", id: "box", classes: ["moving"] } });
      expect(result.worst!.max).toBeGreaterThan(2);
      expect(result.worst!.at).toBe(result.probes.reduce((a, b) => (b.max > a.max ? b : a)).at);
      // A looser tolerance accepts what a tighter one failed.
      const loose = await v.verify(root, { timeline: "main", clip: "c_motion", probes: 6, tolerance: 255 });
      expect(loose.ok).toBe(true);
      expect(loose.worst?.max).toBe(result.worst!.max);
    },
    120_000,
  );

  it(
    "warns when every probe is the same picture, and says the page failed when it defines no seek",
    async () => {
      const still = project("void t;");
      const result = await still.verifier.verify(still.root, { timeline: "main", clip: "c_motion", probes: 4 });
      expect(result).toMatchObject({ ok: true, distinct: 1 });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(/same picture/);

      const none = project("void t;");
      writeFileSync(join(none.root, "comp", "page.html"), "<!doctype html><html><head></head><body></body></html>");
      const broken = verifier({
        live: async (_root, _timeline, clip) => ({ clip, root: "comp", entry: "comp/page.html", head: "", key: "k" }),
        chrome: () => testBinaryManager().ensure("chrome-headless-shell"),
        ffmpeg: () => testBinaryManager().ensure("ffmpeg"),
      });
      await expect(broken.verify(none.root, { timeline: "main", clip: "c_motion", probes: 2 })).rejects.toMatchObject({
        code: ErrorCode.LiveUnavailable,
        message: expect.stringContaining("defines no window.frameshellLive"),
      });
    },
    120_000,
  );
});
