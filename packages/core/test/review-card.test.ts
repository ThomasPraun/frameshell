import { describe, expect, it } from "vitest";
import { layer } from "../src/analyze/card.js";
import { REVIEW_LAYER_HOLDS, reviewCardMarkdown } from "../src/review/card.js";

// The card of a review (#801): verdict, warnings to fix first, key numbers with their labels, then the layers.

const base = {
  view: "current" as const,
  proposal: null,
  source: "timeline" as const,
  timeline: "main",
  file: null,
  run: 4,
  dir: "/p/.frameshell/review/4",
  range: { from: 0, to: 12 },
  fps: 30,
  width: 1080,
  height: 1920,
  sheets: [{ kind: "contact" as const, path: "/p/.frameshell/review/4/contact.png", width: 10, height: 10, columns: 1, rows: 1, tile: { width: 10, height: 10 }, tiles: [] }],
  peaks: [{ at: 3.2, energy: 40, strip: null }],
  safeZones: [],
  warnings: [],
};
const span = (from: number, to: number) => ({ from, to, seconds: to - from });
const metrics = {
  picture: { samples: 90, spacing: 0.13, sampled: true, longestStatic: span(8, 11.5), staticRuns: [span(8, 11.5)], events: 14, largestGap: span(8, 11.5), blank: [], firstFrameEmpty: false },
  rhythm: { label: "ESTIMATED", shotLengthCv: 0.4, stillShare: 0.2, bursts: [] },
  subtitles: { cues: 9, shortCues: [] },
  loudness: null,
  sync: null,
  seam: null,
  delivery: null,
  sound: null,
  craft: [
    { check: "static", from: 8, to: 11.5, message: "Nothing changes for 3.5 s.", severity: "fail" },
    { check: "reading", from: 2, to: 2.3, message: "A cue is on screen for 0.3 s.", severity: "warn" },
  ],
  waived: [],
  requirements: {
    file: "requirements.json",
    checks: [
      { id: "film.maxSeconds", status: "pass", expected: 15, actual: 12, message: "ok" },
      { id: "film.maxStatic", status: "fail", expected: 3, actual: 3.5, message: "the film holds still for 3.5 s, over the 3 s allowed." },
    ],
    waivers: [],
    failed: 2,
  },
};

describe("review card", () => {
  it("leads with the verdict and the failing warning, labels every number, then lists the layers smallest first", () => {
    const layers = [layer("review.json", 800, REVIEW_LAYER_HOLDS.review), layer("metrics.json", 4000, REVIEW_LAYER_HOLDS.metrics)];
    const card = reviewCardMarkdown({ ...base, metrics } as never, layers);
    expect(card).toContain("# Review 4 of timeline main\n\n0 to 12 s, 1080x1920 at 30 fps.");
    expect(card).toContain("- [DECISION] Requirements (requirements.json): FAIL, 2 failed; 1 checks pass, 1 fail, 0 skipped.");
    expect(card).toContain("  - film.maxStatic: the film holds still for 3.5 s");
    expect(card).toContain("- [ESTIMATED] Craft warnings: 2 (1 fail).\n  - FAIL static 8-11.5 s: Nothing changes for 3.5 s.\n  - reading 2-2.3 s:");
    expect(card).toContain("- [ESTIMATED] Picture (90 samples): longest still 3.5 s at 8 s");
    expect(card).toContain("- [ESTIMATED] Rhythm:");
    expect(card).toContain("- [MEASURED] Fastest moments: 3.2 s.");
    expect(card).toContain("- `review.json`: the sheets with every tile's time, the fastest moments, the safe-zone flags (800 bytes, about 200 tokens)\n- `metrics.json`:");
    expect(card).toContain("- Images (1, contact): `contact.png`");
    // About 300 tokens: a card, not the report.
    expect(card.length / 4).toBeLessThan(450);
  });

  it("says when no metrics were asked for and the project has no requirements", () => {
    const card = reviewCardMarkdown({ ...base, metrics: null } as never, [layer("review.json", 100, REVIEW_LAYER_HOLDS.review)]);
    expect(card).toContain("- No metrics: `metrics` was not among the outputs asked for.");
    const none = reviewCardMarkdown({ ...base, metrics: { ...metrics, requirements: null, craft: [] } } as never, []);
    expect(none).toContain("- [DECISION] Requirements: the project has no `requirements.json`.");
    expect(none).toContain("Craft warnings: 0.");
  });
});
