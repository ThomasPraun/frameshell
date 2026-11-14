import { describe, expect, it } from "vitest";
import type { ReviewLoudness } from "@frameshell/protocol";
import { type RequirementsFile, type ResolvedSubtitleTrack, parseRequirementsFile } from "@frameshell/schema";
import { type MetricsInput, reviewMetrics } from "../src/review/metrics.js";
import { type ClipSpan, type JudgeInput, judgeRequirements } from "../src/review/requirements.js";
import type { MotionSeries } from "../src/review/source.js";

// `requirements.json` judged against hand-made motion series: one sample every half second.

function series(energy: number[], spread: number[] = energy.map(() => 50), step = 0.5): MotionSeries {
  return { times: energy.map((_, i) => i * step), energy, spread };
}

function file(extra: Record<string, unknown>): RequirementsFile {
  const parsed = parseRequirementsFile({ schemaVersion: 1, ...extra });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/** A 7 s film: changes to 1 s, a still stretch from 1 to 4 s, a change, then still again from 4.5 s. */
const MOTION = series([0, 8, 8, ...Array(6).fill(0.1), 8, ...Array(4).fill(0.1)]);

function judge(requirements: RequirementsFile, extra: Partial<JudgeInput> = {}, metricsExtra: Partial<MetricsInput> = {}) {
  const motion = extra.series ?? MOTION;
  const end = motion.times.at(-1)! + 0.5;
  const metrics = reviewMetrics({ fps: 30, range: { from: 0, to: end }, series: motion, tracks: null, loudness: null, hasSound: null, ...metricsExtra });
  return judgeRequirements({
    requirements,
    metrics,
    series: motion,
    filmSeconds: end,
    range: { from: 0, to: end },
    fps: 30,
    timeline: { id: "main", markers: [{ id: "m_aaaaaa", at: 2, label: "hook" }], tempo: undefined } as unknown as JudgeInput["timeline"],
    clips: [
      { id: "c_a", start: 0, end: 3 },
      { id: "c_b", start: 3, end: null },
    ] satisfies ClipSpan[],
    tracks: [],
    ...extra,
  });
}

const checkOf = (result: ReturnType<typeof judge>, id: string, clip?: string) => result.metrics.requirements!.checks.find((check) => check.id === id && check.clip === clip)!;

describe("requirements: film", () => {
  it("checks the length with half a frame of slack", () => {
    const result = judge(file({ film: { maxSeconds: 5, minSeconds: 8 } }));
    expect(checkOf(result, "film.maxSeconds")).toMatchObject({ status: "fail", expected: 5, actual: 7 });
    expect(checkOf(result, "film.minSeconds")).toMatchObject({ status: "fail", expected: 8, actual: 7 });
    expect(judge(file({ film: { maxSeconds: 7, minSeconds: 7 } })).metrics.requirements!.failed).toBe(0);
  });

  it("fails a still stretch longer than declared, though the craft threshold (3 s) is not reached", () => {
    const result = judge(file({ film: { maxStatic: 2 } }));
    expect(checkOf(result, "film.maxStatic")).toMatchObject({ status: "fail", expected: 2, actual: 3 });
    expect(result.metrics.requirements!.failed).toBe(1);
    expect(checkOf(judge(file({ film: { maxStatic: 4 } })), "film.maxStatic").status).toBe("pass");
  });

  it("an end card is the held, not blank picture at the end of the range", () => {
    // Changes up to 4 s, then holds from 4 s to the end at 7 s.
    const held = series([0, 8, 8, 8, 8, 8, 8, 8, 8, 0.1, 0.1, 0.1, 0.1, 0.1]);
    expect(checkOf(judge(file({ film: { endCard: { minSeconds: 2.5 } } }), { series: held }), "film.endCard")).toMatchObject({ status: "pass", actual: 3 });
    expect(checkOf(judge(file({ film: { endCard: { minSeconds: 3.5 } } }), { series: held }), "film.endCard")).toMatchObject({ status: "fail", actual: 3 });
    const blank = series([0, 8, 8, 0.1, 0.1, 0.1], [50, 50, 50, 1, 1, 1]);
    expect(checkOf(judge(file({ film: { endCard: { minSeconds: 1 } } }), { series: blank }), "film.endCard")).toMatchObject({ status: "fail" });
  });

  it("an end card is skipped when the range stops short of the end", () => {
    const result = judge(file({ film: { endCard: { minSeconds: 1 } } }), { range: { from: 0, to: 3 } });
    expect(checkOf(result, "film.endCard").status).toBe("skipped");
    expect(result.metrics.requirements!.failed).toBe(0);
  });

  it("loudness is the file's: a timeline skips it, a file fails outside the tolerance and over the true peak", () => {
    const wanted = file({ film: { loudness: { target: -14, maxTruePeak: -1 } } });
    expect(checkOf(judge(wanted), "film.loudness.target").status).toBe("skipped");
    const loud: ReviewLoudness = { integrated: -11, range: 4, truePeak: -0.2, phoneBand: -12 };
    const asFile = { timeline: null, clips: null, tracks: null } as const;
    const result = judge(wanted, asFile, { loudness: loud });
    expect(checkOf(result, "film.loudness.target")).toMatchObject({ status: "fail", actual: -11 });
    expect(checkOf(result, "film.loudness.maxTruePeak")).toMatchObject({ status: "fail", actual: -0.2 });
    const near = judge(wanted, asFile, { loudness: { ...loud, integrated: -14.9, truePeak: -1.5 } });
    expect(near.metrics.requirements!.failed).toBe(0);
  });
});

describe("requirements: captions and clips", () => {
  const track = (size: number): ResolvedSubtitleTrack =>
    ({ track: "subs", follows: "v1", fps: 30, unknownPreset: null, missing: [], style: { size }, cues: [{ start: 0, end: 60, words: [], highlight: false, entry: "none" }] }) as unknown as ResolvedSubtitleTrack;

  it("reads the caption size as a share of the short side", () => {
    expect(checkOf(judge(file({ captions: { minSize: 0.026 } }), { tracks: [track(0.02)] }), "captions.minSize")).toMatchObject({ status: "fail", actual: 0.02 });
    expect(checkOf(judge(file({ captions: { minSize: 0.026 } }), { tracks: [track(0.045)] }), "captions.minSize").status).toBe("pass");
    expect(checkOf(judge(file({ captions: { minSize: 0.026 } })), "captions.minSize").status).toBe("skipped");
  });

  it("appearsBy takes seconds or a marker; before compares starts; a missing clip fails", () => {
    const result = judge(file({ clips: [{ clip: "c_b", appearsBy: "hook+0.5", before: "c_a" }, { clip: "c_a", appearsBy: 1, before: "c_b" }, { clip: "c_gone", appearsBy: 1 }] }));
    expect(checkOf(result, "clip.appearsBy", "c_b")).toMatchObject({ status: "fail", actual: 3 });
    expect(checkOf(result, "clip.before", "c_b").status).toBe("fail");
    expect(checkOf(result, "clip.appearsBy", "c_a").status).toBe("pass");
    expect(checkOf(result, "clip.before", "c_a").status).toBe("pass");
    expect(checkOf(result, "clip.appearsBy", "c_gone")).toMatchObject({ status: "fail", actual: null });
    expect(checkOf(judge(file({ clips: [{ clip: "c_a", appearsBy: "nowhere" }] })), "clip.appearsBy", "c_a").status).toBe("fail");
  });

  it("keepsMoving measures the still stretch inside the clip's own span", () => {
    // Still from 1 to 4 s and from 4.5 to 6.5 s: clip c_a (0 to 3 s) holds 2 s of the first, c_b (from 3 s) 2 s of the second.
    const result = judge(file({ clips: [{ clip: "c_a", keepsMoving: { maxStatic: 1 } }, { clip: "c_b", keepsMoving: { maxStatic: 2 } }] }));
    expect(checkOf(result, "clip.keepsMoving", "c_a")).toMatchObject({ status: "fail", actual: 2 });
    expect(checkOf(result, "clip.keepsMoving", "c_b")).toMatchObject({ status: "pass", actual: 2 });
  });

  it("clip checks of a file are skipped", () => {
    const result = judge(file({ clips: [{ clip: "c_a", appearsBy: 1 }] }), { timeline: null, clips: null, tracks: null });
    expect(checkOf(result, "clip.appearsBy", "c_a").status).toBe("skipped");
  });
});

describe("requirements: craft warnings and waivers", () => {
  // Frame 0 empty, then still for 4 s from 0.5 s (a craft warning).
  const still = series([0, 8, ...Array(8).fill(0.1), 8, 8], [1, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50]);

  it("a craft warning stays a warning unless the file lists its check", () => {
    const plain = judge(file({}), { series: still });
    expect(plain.metrics.craft.map((warning) => [warning.check, warning.severity])).toEqual([["frame-0", "warn"], ["static", "warn"]]);
    expect(plain.metrics.requirements!.failed).toBe(0);
    const strict = judge(file({ fail: ["static"] }), { series: still });
    expect(strict.metrics.craft.map((warning) => [warning.check, warning.severity])).toEqual([["frame-0", "warn"], ["static", "fail"]]);
    expect(strict.metrics.requirements!.failed).toBe(1);
  });

  it("a waiver moves the warning into waived with its reason and lifts the failure", () => {
    const result = judge(file({ fail: ["static"], waivers: [{ check: "static", clip: "c_a", reason: "the hold is the point" }] }), { series: still });
    expect(result.metrics.craft.map((warning) => warning.check)).toEqual(["frame-0"]);
    expect(result.metrics.waived).toEqual([expect.objectContaining({ check: "static", clip: "c_a", reason: "the hold is the point", from: 0.5, to: 4.5 })]);
    expect(result.metrics.waived[0]).not.toHaveProperty("severity");
    expect(result.metrics.requirements!.failed).toBe(0);
    expect(result.metrics.requirements!.waivers).toEqual([{ check: "static", clip: "c_a", reason: "the hold is the point", matched: 1 }]);
  });

  it("a clip waiver covers only warnings that overlap the clip; one with no clip covers the whole check", () => {
    const later: ClipSpan[] = [{ id: "c_late", start: 5, end: 5.5 }];
    const missed = judge(file({ waivers: [{ check: "static", clip: "c_late", reason: "x" }] }), { series: still, clips: later });
    expect(missed.metrics.waived).toEqual([]);
    expect(missed.metrics.requirements!.waivers[0]!.matched).toBe(0);
    const whole = judge(file({ waivers: [{ check: "frame-0", reason: "fades in from black on purpose" }] }), { series: still });
    expect(whole.metrics.waived.map((warning) => warning.check)).toEqual(["frame-0"]);
    expect(whole.metrics.waived[0]).not.toHaveProperty("clip");
  });

  it("says in the notes which waivers name a clip it cannot place", () => {
    const named = file({ waivers: [{ check: "static", clip: "c_gone", reason: "x" }] });
    expect(judge(named, { series: still }).notes).toEqual([expect.stringContaining("clip c_gone, which is not on the timeline")]);
    expect(judge(named, { series: still, timeline: null, clips: null, tracks: null }).notes).toEqual([expect.stringContaining("a file has no clips")]);
  });
});
