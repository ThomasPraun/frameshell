import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type RequirementsFile, type Timeline, parseRequirementsFile } from "@frameshell/schema";
import type { GeneratedSource } from "../src/export/compiler.js";
import { reviewMetrics } from "../src/review/metrics.js";
import { type BoxSpan, graphicBoxes } from "../src/review/placement.js";
import { type FramePlacement, type JudgeInput, judgeRequirements } from "../src/review/requirements.js";
import type { MotionSeries } from "../src/review/source.js";
import { mediaTools, run } from "./media-tools.js";
import { tempDir } from "./helpers.js";

// `staysInFrame`: the boxes of what a clip draws, from `placement.ts`, against the frame of the format reviewed.

const film = { width: 1080, height: 1920 };
const MOTION: MotionSeries = { times: [0, 1, 2, 3, 4], energy: [0, 5, 5, 5, 5], spread: [50, 50, 50, 50, 50], first: 0, step: 30 };

function file(clips: unknown[]): RequirementsFile {
  const parsed = parseRequirementsFile({ schemaVersion: 1, clips });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function box(clip: string, from: number, to: number, x0: number, y0: number, x1: number, y1: number, subject: BoxSpan["subject"] = "graphic"): BoxSpan {
  return { subject, track: "v1", clip, from, to, box: { x0, y0, x1, y1 } };
}

function placement(boxes: BoxSpan[], extra: Partial<FramePlacement> = {}): FramePlacement {
  return { format: "9x16", picture: { left: 0, top: 0, ...film }, boxes, unplaced: new Map(), ...extra };
}

function judge(requirements: RequirementsFile, given: FramePlacement | null, extra: Partial<JudgeInput> = {}) {
  const metrics = reviewMetrics({ fps: 30, range: { from: 0, to: 5 }, source: "timeline", series: MOTION, tracks: null, loudness: null, hasSound: null });
  const result = judgeRequirements({
    requirements,
    metrics,
    series: MOTION,
    filmSeconds: 5,
    range: { from: 0, to: 5 },
    fps: 30,
    timeline: { id: "main", markers: [], tempo: undefined } as unknown as JudgeInput["timeline"],
    clips: [
      { id: "title", start: 1, end: 4 },
      { id: "talk", start: 0, end: null },
    ],
    tracks: [],
    placement: given,
    ...extra,
  });
  return result.metrics.requirements!.checks.filter((check) => check.id === "clip.staysInFrame");
}

describe("requirements: staysInFrame", () => {
  it("accepts `true` and a margin, and refuses a margin outside 0 to 0.25", () => {
    expect(file([{ clip: "title", staysInFrame: true }]).clips[0]!.staysInFrame).toBe(true);
    expect(file([{ clip: "title", staysInFrame: { margin: 0.05 } }]).clips[0]!.staysInFrame).toEqual({ margin: 0.05 });
    expect(parseRequirementsFile({ schemaVersion: 1, clips: [{ clip: "title", staysInFrame: { margin: 0.5 } }] }).ok).toBe(false);
    expect(parseRequirementsFile({ schemaVersion: 1, clips: [{ clip: "title", staysInFrame: false }] }).ok).toBe(false);
  });

  it("fails with the times and the format when a box leaves the frame, merging touching samples", () => {
    const boxes = [
      box("title", 1, 1.5, 100, 100, 600, 300),
      box("title", 1.5, 2, 800, 100, 1200, 300),
      box("title", 2, 2.5, 900, 100, 1300, 300),
      box("title", 2.5, 3, 300, 100, 600, 300),
      box("title", 3, 3.5, 300, -40, 600, 200),
    ];
    const [check] = judge(file([{ clip: "title", staysInFrame: true }]), placement(boxes));
    expect(check).toMatchObject({ clip: "title", status: "fail", expected: 0, actual: 1.5, format: "9x16" });
    expect(check!.spans).toEqual([
      { from: 1.5, to: 2.5, seconds: 1 },
      { from: 3, to: 3.5, seconds: 0.5 },
    ]);
    expect(check!.message).toContain("leaves the frame of format 9x16 (right, top) from 1.5 to 2.5 s, 3 to 3.5 s");
  });

  it("counts touching an edge as leaving it, and a margin as a share of the picture on every side", () => {
    const touching = [box("title", 1, 2, 0, 500, 400, 700)];
    expect(judge(file([{ clip: "title", staysInFrame: true }]), placement(touching))[0]).toMatchObject({ status: "fail" });
    // 54 px of 1080 is 5 %: a box 60 px in passes, one 40 px in does not.
    const near = [box("title", 1, 2, 60, 500, 400, 700)];
    expect(judge(file([{ clip: "title", staysInFrame: { margin: 0.05 } }]), placement(near))[0]).toMatchObject({ status: "pass", actual: 0 });
    const closer = [box("title", 1, 2, 40, 500, 400, 700)];
    const [check] = judge(file([{ clip: "title", staysInFrame: { margin: 0.05 } }]), placement(closer));
    expect(check).toMatchObject({ status: "fail", expected: 0.05 });
    expect(check!.message).toContain("comes within 5 % of the edge of the frame of format 9x16 (left)");
  });

  it("judges against the picture inside the letterbox bars, and only boxes in the range while the clip plays", () => {
    const boxes = [box("title", 1, 2, 100, 400, 600, 800)];
    const bars = { left: 0, top: 420, width: 1080, height: 1080 };
    expect(judge(file([{ clip: "title", staysInFrame: true }]), placement(boxes))[0]!.status).toBe("pass");
    expect(judge(file([{ clip: "title", staysInFrame: true }]), placement(boxes, { picture: bars }))[0]).toMatchObject({ status: "fail", spans: [{ from: 1, to: 2 }] });
    const late = [box("title", 1, 2, -10, 400, 600, 800)];
    expect(judge(file([{ clip: "title", staysInFrame: true }]), placement(late), { range: { from: 2.5, to: 5 } })[0]!.status).toBe("skipped");
  });

  it("names a face of footage, and skips a clip with nothing placed, a file, or a timeline that could not be laid out", () => {
    const faces = [box("talk", 0, 0.5, 900, 300, 1110, 600, "face")];
    expect(judge(file([{ clip: "talk", staysInFrame: true }]), placement(faces))[0]!.message).toContain("a face of clip talk leaves the frame");
    const none = judge(file([{ clip: "title", staysInFrame: true }]), placement([], { unplaced: new Map([["title", "its render has no alpha plane"]]) }))[0]!;
    expect(none).toMatchObject({ status: "skipped", actual: null, format: "9x16" });
    expect(none.message).toContain("its render has no alpha plane");
    expect(judge(file([{ clip: "talk", staysInFrame: true }]), placement([]))[0]!.message).toContain("people scan");
    expect(judge(file([{ clip: "title", staysInFrame: true }]), null)[0]!.status).toBe("skipped");
    expect(judge(file([{ clip: "title", staysInFrame: true }]), null, { timeline: null, clips: null })[0]!.message).toContain("a file has no clips");
    expect(judge(file([{ clip: "gone", staysInFrame: true }]), placement([]))[0]!.status).toBe("fail");
  });

  it("fails a generated clip whose alpha, read from a real render, slides off the right edge", async () => {
    const { ffmpeg } = await mediaTools();
    const dir = tempDir();
    const render = join(dir, "slide.webm");
    // A 320x180 transparent frame with a 60x40 white box moving right at 120 px/s from x 100: it reaches the edge at 1.33 s.
    await run(ffmpeg, [
      ...["-hide_banner", "-loglevel", "error", "-y"],
      ...["-f", "lavfi", "-i", "color=c=black@0.0:s=320x180:r=10:d=2,format=yuva420p"],
      ...["-f", "lavfi", "-i", "color=c=white:s=60x40:r=10:d=2,format=yuva420p"],
      ...["-filter_complex", "[0][1]overlay=x='100+120*t':y=70:format=auto,format=yuva420p"],
      ...["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", render],
    ]);
    const source: GeneratedSource = { path: render, hasAlpha: true, width: 320, height: 180 };
    const wide = { width: 1920, height: 1080 };
    const found = await graphicBoxes({
      ffmpeg,
      timeline: { id: "main", tracks: [{ id: "v2", kind: "video", clips: [{ id: "title", type: "hyperframes", start: 1, duration: 2 }] }] } as unknown as Timeline,
      renders: new Map([["title", source]]),
      film: wide,
      project: wide,
      work: join(dir, "work"),
    });
    expect(found.boxes.length).toBeGreaterThan(2);
    const [check] = judge(file([{ clip: "title", staysInFrame: true }]), { format: "16x9", picture: { left: 0, top: 0, ...wide }, boxes: found.boxes, unplaced: new Map() });
    expect(check).toMatchObject({ status: "fail", format: "16x9" });
    // Timeline seconds: the clip starts at 1 s, so the box reaches the edge after about 2.3 s, never before 2 s.
    expect(check!.spans![0]!.from).toBeGreaterThan(2);
    expect(check!.spans!.at(-1)!.to).toBeLessThanOrEqual(3);
    expect(check!.message).toContain("(right)");
  }, 120_000);
});
