import { describe, expect, it } from "vitest";
import type { ReviewBehindSample } from "@frameshell/protocol";
import { type RequirementsFile, type Timeline, parseRequirementsFile, withSubjectLayers } from "@frameshell/schema";
import { type Mask, behindEntry, behindWarnings, boxesMeet, coverVerdict, coveredShare, matteFrameAt, sampleFrames, subjectSpans, within } from "../src/review/behind.js";
import { reviewMetrics } from "../src/review/metrics.js";
import { type ClipSpan, judgeRequirements } from "../src/review/requirements.js";
import type { MotionSeries } from "../src/review/source.js";

// A word behind the person (ADR 0032, #461): the covered share on synthetic masks, the verdict bands, the matte frame
// export draws, and the warnings through `requirements.json`.

/** A `width` x `height` mask whose pixel is `value(x, y)`. */
function mask(width: number, height: number, value: (x: number, y: number) => number): Mask {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = value(x, y);
  return { data, width, height };
}

const word = mask(100, 20, () => 255);
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });

describe("behind: covered share", () => {
  it("is the share of the word's alpha where the matte is the person, at the same film point", () => {
    // The person fills the left 40 columns of a plate laid out exactly where the word is.
    const person = mask(100, 20, (x) => (x < 40 ? 255 : 0));
    const found = coveredShare(word, rect(0, 0, 100, 20), person, rect(0, 0, 100, 20))!;
    expect(found.share).toBeCloseTo(0.4, 6);
    expect(found.box).toEqual({ x0: 0, y0: 0, x1: 100, y1: 20 });
  });

  it("maps through both layouts: a matte at another size, a plate moved and scaled, the word outside the plate uncovered", () => {
    // The plate's picture is 200 x 40 film px from x 50; its matte (50 x 10 px) is the person on its left half,
    // film x 50 to 150. The word spans film x 0 to 200: 100 of its 200 px over the plate, 100 of them over the person.
    const person = mask(50, 10, (x) => (x < 25 ? 255 : 0));
    const found = coveredShare(mask(200, 10, () => 255), rect(0, 0, 200, 40), person, rect(50, 0, 200, 40))!;
    expect(found.share).toBeCloseTo(0.5, 6);
  });

  it("weights by the word's alpha and the matte's softness, and skips alpha under the graphic threshold", () => {
    // Half the word is faint (alpha 10, not drawn), half solid; the matte is 50 % over all of it.
    const faint = mask(10, 1, (x) => (x < 5 ? 10 : 255));
    const found = coveredShare(faint, rect(0, 0, 10, 1), mask(10, 1, () => 128), rect(0, 0, 10, 1))!;
    expect(found.share).toBeCloseTo(128 / 255, 6);
    expect(found.box.x0).toBe(5);
    expect(coveredShare(mask(10, 1, () => 0), rect(0, 0, 10, 1), mask(10, 1, () => 255), rect(0, 0, 10, 1))).toBeNull();
  });

  it("boxes meet only when they overlap", () => {
    expect(boxesMeet({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 5, y0: 5, x1: 20, y1: 20 })).toBe(true);
    expect(boxesMeet({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 10, y0: 0, x1: 20, y1: 10 })).toBe(false);
  });
});

describe("behind: verdict bands (30-55 % fine, warn under 15 % or over 65 %)", () => {
  it("puts the boundaries on the right side", () => {
    expect(coverVerdict([0.149])).toBe("floats");
    expect(coverVerdict([0.15])).toBe("near");
    expect(coverVerdict([0.299])).toBe("near");
    expect(coverVerdict([0.3])).toBe("fine");
    expect(coverVerdict([0.55])).toBe("fine");
    expect(coverVerdict([0.551])).toBe("near");
    expect(coverVerdict([0.65])).toBe("near");
    expect(coverVerdict([0.651])).toBe("eaten");
  });

  it("judges by the sample farthest from the fine range and leaves frames with nothing drawn out", () => {
    expect(coverVerdict([0.4, 0.1, 0.7])).toBe("floats");
    expect(coverVerdict([0.4, 0.2, 0.9])).toBe("eaten");
    expect(coverVerdict([null, 0.45, null])).toBe("fine");
    expect(coverVerdict([null, null])).toBeNull();
  });
});

const sample = (at: number, covered: number | null, face: boolean | null = false): ReviewBehindSample => ({ at, plateClip: "p1", covered, face });
const words = { clip: "w1", track: "v2", plate: "v1" };

describe("behind: entries and craft warnings", () => {
  it("warns for a word that floats or is eaten, names the 30 to 55 % target, and only notes one near the band", () => {
    const floats = behindEntry(words, 1, 3, [sample(1, 0.05), sample(2, 0.1), sample(2.967, 0.2)]);
    expect(floats).toMatchObject({ verdict: "floats", from: 1, to: 3 });
    expect(floats.message).toContain("covers 5 %, 10 %, 20 % of it at 1 s, 2 s, 2.967 s");
    expect(floats.message).toContain("30 to 55 %");
    const [warning] = behindWarnings([floats]);
    expect(warning).toMatchObject({ check: "behind", clip: "w1", from: 1, to: 3 });

    const eaten = behindEntry(words, 1, 3, [sample(1, 0.8)]);
    expect(eaten.verdict).toBe("eaten");
    expect(behindWarnings([eaten])[0]!.message).toContain("over 65 %");

    const near = behindEntry(words, 1, 3, [sample(1, 0.25), sample(2, 0.4)]);
    expect(near.verdict).toBe("near");
    expect(near.message).toContain("fine to keep");
    expect(behindWarnings([near])).toEqual([]);
    expect(behindWarnings([behindEntry(words, 1, 3, [sample(1, 0.45)])])).toEqual([]);
  });

  it("keeps the farthest sample's verdict when samples fall on both sides of the band, and says so", () => {
    const both = behindEntry(words, 1, 3, [sample(1, 0.1), sample(2, 0.4), sample(3, 0.9)]);
    expect(both.verdict).toBe("eaten");
    expect(both.message).toContain("The samples fall on both sides of the band: part of the word floats, part is eaten.");
    expect(behindEntry(words, 1, 3, [sample(1, 0.1), sample(2, 0.4)]).message).not.toContain("both sides");
    expect(behindEntry(words, 1, 3, [sample(1, 0.8), sample(2, 0.4)]).message).not.toContain("both sides");
  });

  it("warns when the word meets a face, whatever its share; no scan (null) is no flag", () => {
    const face = behindEntry(words, 1, 3, [sample(1, 0.4, false), sample(2, 0.45, true), sample(3, 0.5, true)]);
    const found = behindWarnings([face]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ check: "behind", clip: "w1", from: 2, to: 3 });
    expect(found[0]!.message).toContain("meets a face of plate clip p1 at 2 s, 3 s");
    expect(behindWarnings([behindEntry(words, 1, 3, [sample(1, 0.4, null)])])).toEqual([]);
  });

  it("is unplaced when the word draws nothing at every frame", () => {
    expect(behindEntry(words, 1, 3, [sample(1, null)]).verdict).toBe("unplaced");
  });

  it("goes into the craft list through the metrics, with the entries kept", () => {
    const motion: MotionSeries = { times: [0, 1], energy: [0, 8], spread: [50, 50], first: 0, step: 30 };
    const behind = [behindEntry(words, 1, 3, [sample(1, 0.05)])];
    const metrics = reviewMetrics({ fps: 30, range: { from: 0, to: 2 }, source: "timeline", series: motion, tracks: null, loudness: null, hasSound: null, behind });
    expect(metrics.behind).toEqual(behind);
    expect(metrics.craft.filter((warning) => warning.check === "behind")).toHaveLength(1);
    expect(reviewMetrics({ fps: 30, range: { from: 0, to: 2 }, source: "timeline", series: motion, tracks: null, loudness: null, hasSound: null }).behind).toBeUndefined();
  });
});

describe("behind: frames", () => {
  it("picks the matte frame export draws: in point, speed, frame grid, half rounded down", () => {
    // Starts at 1 s from source 2 s at twice the speed: timeline frame 30 shows source frame 60, frame 45 source frame 90.
    expect(matteFrameAt({ start: 1, in: 2, speed: 2 }, 30, 30)).toBe(60);
    expect(matteFrameAt({ start: 1, in: 2, speed: 2 }, 31, 30)).toBe(62);
    expect(matteFrameAt({ start: 1, in: 2, speed: 2 }, 45, 30)).toBe(90);
    // 1.5x: frame 1 is source 1.5, shown as 1; frame 3 is 4.5, shown as 4.
    expect(matteFrameAt({ start: 0, in: 0, speed: 1.5 }, 1, 30)).toBe(1);
    expect(matteFrameAt({ start: 0, in: 0, speed: 1.5 }, 3, 30)).toBe(4);
    expect(matteFrameAt({ start: 2, in: 0 }, 0, 30)).toBe(0);
  });

  it("samples the first, middle and last frame of the time behind the person, inside its spans", () => {
    expect(sampleFrames([{ from: 1, to: 2 }], 30)).toEqual([30, 45, 59]);
    // A gap in the middle: the frame nearest the middle that is inside a span.
    expect(sampleFrames([{ from: 0, to: 1 }, { from: 3, to: 4 }], 30)).toEqual([0, 29, 119]);
    expect(sampleFrames([{ from: 1, to: 1.02 }], 30)).toEqual([30]);
    expect(sampleFrames([], 30)).toEqual([]);
  });

  it("finds where the subject of a plate is drawn, in timeline seconds, from the subject layers", () => {
    const timeline = {
      id: "main",
      tracks: [
        { id: "v1", kind: "video", clips: [{ id: "p1", type: "media", asset: "assets/talk.mp4", start: 0, in: 1, out: 5 }] },
        { id: "v2", kind: "video", behind: "v1", clips: [{ id: "w1", type: "card", source: "compositions/cards/w.json", start: 1, duration: 2 }] },
      ],
    } as unknown as Timeline;
    const spans = subjectSpans(withSubjectLayers(timeline), "v1");
    expect(spans.map((span) => [span.clip.id, span.from, span.to])).toEqual([["p1", 1, 3]]);
    expect(within(spans, 2, 5).map((span) => [span.from, span.to])).toEqual([[2, 3]]);
    expect(subjectSpans(timeline, "v1")).toEqual([]);
  });
});

describe("behind: requirements", () => {
  const file = (extra: Record<string, unknown>): RequirementsFile => {
    const parsed = parseRequirementsFile({ schemaVersion: 1, ...extra });
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  };
  const motion: MotionSeries = { times: [0, 1, 2, 3], energy: [0, 8, 8, 8], spread: [50, 50, 50, 50], first: 0, step: 30 };
  // Two words on screen at the same time, both floating.
  const behind = [behindEntry({ ...words, clip: "w1" }, 1, 3, [sample(1, 0.05)]), behindEntry({ ...words, clip: "w2" }, 1, 3, [sample(1, 0.08)])];
  const judge = (requirements: RequirementsFile) =>
    judgeRequirements({
      requirements,
      metrics: reviewMetrics({ fps: 30, range: { from: 0, to: 4 }, source: "timeline", series: motion, tracks: null, loudness: null, hasSound: null, behind }),
      series: motion,
      filmSeconds: 4,
      range: { from: 0, to: 4 },
      fps: 30,
      timeline: { id: "main", markers: [], tempo: undefined } as never,
      clips: [
        { id: "w1", start: 1, end: 3 },
        { id: "w2", start: 1, end: 3 },
      ] satisfies ClipSpan[],
      tracks: [],
    });

  it("a waiver naming one word covers that word's warning only, though the other plays at the same time", () => {
    const result = judge(file({ fail: ["behind"], waivers: [{ check: "behind", clip: "w1", reason: "the logo is meant to float" }] }));
    expect(result.metrics.waived).toEqual([expect.objectContaining({ check: "behind", clip: "w1", reason: "the logo is meant to float" })]);
    const left = result.metrics.craft.filter((warning) => warning.check === "behind");
    expect(left).toEqual([expect.objectContaining({ clip: "w2", severity: "fail" })]);
    expect(result.metrics.requirements!.failed).toBe(1);
  });

  it("a waiver of the whole check covers both, and without `fail` they stay warnings", () => {
    expect(judge(file({ waivers: [{ check: "behind", reason: "ok" }] })).metrics.waived).toHaveLength(2);
    expect(judge(file({})).metrics.craft.filter((warning) => warning.check === "behind").map((warning) => warning.severity)).toEqual(["warn", "warn"]);
  });
});
