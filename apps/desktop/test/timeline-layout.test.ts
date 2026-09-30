import type { TimelineView } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import {
  LANE_HEIGHT,
  RULER_HEIGHT,
  clampScroll,
  clipAt,
  contentWidth,
  fitZoom,
  formatDuration,
  formatTimecode,
  layoutTimeline,
  rulerTicks,
  visibleClips,
  zoomAround,
  zoomLimits,
} from "../src/renderer/src/timeline/layout.js";

// Seam under test: the timeline panel's pure geometry, fed `timeline.show` results.

type Track = TimelineView["tracks"][number];

function view(tracks: Track[], overrides: Partial<TimelineView> = {}): TimelineView {
  return { timeline: "main", path: "timelines/main.json", revision: 3, fps: 30, duration: 20, tracks, problems: [], ...overrides };
}

const media = (id: string, start: number, end: number, asset = "assets/raw-01.mp4") => ({
  id,
  type: "media",
  asset,
  start,
  end,
  in: 1,
  out: 1 + (end - start),
});

describe("layoutTimeline", () => {
  it("stacks the top video layer first, then audio, then subtitles, numbering each kind from the bottom layer", () => {
    const layout = layoutTimeline(
      view([
        { id: "t_v1", kind: "video", name: "Picture", follows: null, clips: [] },
        { id: "t_a1", kind: "audio", name: "Voice", follows: null, clips: [] },
        { id: "t_v2", kind: "video", name: null, follows: null, clips: [] },
        { id: "t_s1", kind: "subtitles", name: null, follows: "t_a1", clips: [] },
        { id: "t_a2", kind: "audio", name: "Music", follows: null, clips: [] },
      ]),
    );
    expect(layout.rows.map((row) => [row.id, row.label, row.name])).toEqual([
      ["t_v2", "V2", null],
      ["t_v1", "V1", "Picture"],
      ["t_a1", "A1", "Voice"],
      ["t_a2", "A2", "Music"],
      ["t_s1", "S1", null],
    ]);
    expect(layout.rows.map((row) => row.top)).toEqual([
      RULER_HEIGHT,
      RULER_HEIGHT + LANE_HEIGHT.video,
      RULER_HEIGHT + 2 * LANE_HEIGHT.video,
      RULER_HEIGHT + 2 * LANE_HEIGHT.video + LANE_HEIGHT.audio,
      RULER_HEIGHT + 2 * LANE_HEIGHT.video + 2 * LANE_HEIGHT.audio,
    ]);
    expect(layout.rows[4]!.followsLabel).toBe("A1");
    expect(layout.height).toBe(RULER_HEIGHT + 2 * LANE_HEIGHT.video + 2 * LANE_HEIGHT.audio + LANE_HEIGHT.subtitles);
  });

  it("names clips after what they play and tells media, nested timelines and generated clips apart", () => {
    const layout = layoutTimeline(
      view([
        {
          id: "t_v1",
          kind: "video",
          name: null,
          follows: null,
          clips: [
            media("c_1", 0, 4.5, "assets/raw/take-03.mov"),
            { id: "c_2", type: "timeline", source: "timelines/intro.json", start: 4.5, end: 10 },
            { id: "c_3", type: "hyperframes", source: "compositions/hyperframes/lower-third/index.html", start: 10, end: 12, duration: 2 },
            { id: "c_4", type: "titles", start: 12, end: 13, duration: 1 },
          ],
        },
      ]),
    );
    expect(layout.rows[0]!.clips.map(({ id, name, kind, start, end }) => ({ id, name, kind, start, end }))).toEqual([
      { id: "c_1", name: "take-03.mov", kind: "media", start: 0, end: 4.5 },
      { id: "c_2", name: "intro", kind: "timeline", start: 4.5, end: 10 },
      { id: "c_3", name: "lower-third", kind: "generated", start: 10, end: 12 },
      { id: "c_4", name: "titles", kind: "generated", start: 12, end: 13 },
    ]);
    expect(layout.rows[0]!.clips[0]).toMatchObject({ asset: "assets/raw/take-03.mov", in: 1, speed: 1, problem: null });
  });

  it("gives a clip with unknown length a stand-in width up to the next clip and flags it", () => {
    const layout = layoutTimeline(
      view(
        [
          {
            id: "t_v1",
            kind: "video",
            name: null,
            follows: null,
            clips: [
              { id: "c_1", type: "timeline", source: "timelines/gone.json", start: 2, end: null },
              media("c_2", 3, 5),
              { id: "c_3", type: "timeline", source: "timelines/gone.json", start: 8, end: null },
            ],
          },
        ],
        {
          duration: null,
          problems: [
            { clip: "c_1", track: "t_v1", source: "timelines/gone.json", message: "timelines/gone.json does not exist" },
            { clip: "c_3", track: "t_v1", source: "timelines/gone.json", message: "timelines/gone.json does not exist" },
          ],
        },
      ),
    );
    const [first, , last] = layout.rows[0]!.clips;
    expect(first).toMatchObject({ start: 2, end: 3, problem: "timelines/gone.json does not exist" });
    expect(last).toMatchObject({ start: 8, end: 10 });
    expect(layout.duration).toBe(10);
  });
});

describe("visibleClips", () => {
  const clips = layoutTimeline(
    view([
      {
        id: "t_v1",
        kind: "video",
        name: null,
        follows: null,
        clips: Array.from({ length: 250 }, (_, i) => media(`c_${i}`, i * 2, i * 2 + 1.5)),
      },
    ]),
  ).rows[0]!.clips;

  it("returns only the clips overlapping the time window", () => {
    expect(visibleClips(clips, 10.2, 14.9).map((clip) => clip.id)).toEqual(["c_5", "c_6", "c_7"]);
    expect(visibleClips(clips, 11.6, 11.9)).toEqual([]);
    expect(visibleClips(clips, 0, 1).map((clip) => clip.id)).toEqual(["c_0"]);
    expect(visibleClips(clips, 497, 600).map((clip) => clip.id)).toEqual(["c_248", "c_249"]);
    expect(visibleClips([], 0, 10)).toEqual([]);
  });
});

describe("zoom and scroll", () => {
  it("keeps the time under the pointer fixed while zooming", () => {
    const limits = { min: 1, max: 1200 };
    const next = zoomAround({ pxPerSecond: 50, scrollLeft: 300 }, 2, 200, limits);
    // Before: (300 + 200) / 50 = 10 s under the pointer.
    expect(next).toEqual({ pxPerSecond: 100, scrollLeft: 800 });
    expect((next.scrollLeft + 200) / next.pxPerSecond).toBe(10);
  });

  it("clamps zoom to its limits and scroll to the start", () => {
    const limits = { min: 10, max: 100 };
    expect(zoomAround({ pxPerSecond: 80, scrollLeft: 0 }, 4, 0, limits).pxPerSecond).toBe(100);
    expect(zoomAround({ pxPerSecond: 20, scrollLeft: 10 }, 0.1, 400, limits)).toEqual({ pxPerSecond: 10, scrollLeft: 0 });
  });

  it("lets zoom go from the whole timeline in view down to single frames", () => {
    expect(zoomLimits(100, 1000, 30)).toEqual({ min: 8, max: 30 * 24 });
    // Empty or tiny timelines still get a usable range.
    expect(zoomLimits(0, 1000, 25).min).toBe(1000 / 60);
  });

  it("fits the whole timeline, with a quarter of its length as room after its end", () => {
    expect(fitZoom(100, 1000)).toBe(8);
    // Short or empty timelines show at least one minute.
    expect(fitZoom(0, 1200)).toBe(20);
    expect(contentWidth(100, 9, 1000)).toBe(1125);
    expect(contentWidth(1, 9, 1000)).toBe(1000);
    expect(clampScroll(5000, 100, 9, 1000)).toBe(125);
    expect(clampScroll(-4, 100, 9, 1000)).toBe(0);
  });
});

describe("ruler", () => {
  it("labels round times at least 80 px apart, with finer unlabeled ticks between", () => {
    const ticks = rulerTicks({ pxPerSecond: 20, scrollLeft: 0, width: 400 }, 30);
    expect(ticks.major.map((tick) => [tick.x, tick.label])).toEqual([
      [0, "00:00:00"],
      [100, "00:00:05"],
      [200, "00:00:10"],
      [300, "00:00:15"],
      [400, "00:00:20"],
    ]);
    expect(ticks.minor.slice(0, 4)).toEqual([20, 40, 60, 80]);
  });

  it("switches to frame labels when zoomed in below a second", () => {
    const ticks = rulerTicks({ pxPerSecond: 600, scrollLeft: 6000, width: 300 }, 30);
    expect(ticks.major.map((tick) => tick.label)).toEqual(["00:00:10:00", "00:00:10:05", "00:00:10:10", "00:00:10:15"]);
    expect(ticks.major[0]!.x).toBe(0);
  });
});

describe("formatting", () => {
  it("writes SMPTE-style timecodes at the project frame rate", () => {
    expect(formatTimecode(0, 30)).toBe("00:00:00:00");
    expect(formatTimecode(65.5, 30)).toBe("00:01:05:15");
    expect(formatTimecode(3723.04, 25)).toBe("01:02:03:01");
  });

  it("writes clip durations short", () => {
    expect(formatDuration(0.5)).toBe("0.5s");
    expect(formatDuration(12.533)).toBe("12.5s");
    expect(formatDuration(75)).toBe("1:15");
    expect(formatDuration(3725)).toBe("1:02:05");
  });
});

describe("clipAt", () => {
  it("finds the clip under a point of the lanes", () => {
    const layout = layoutTimeline(
      view([{ id: "t_v1", kind: "video", name: null, follows: null, clips: [media("c_1", 1, 3), media("c_2", 4, 6)] }]),
    );
    const y = RULER_HEIGHT + LANE_HEIGHT.video / 2;
    const viewport = { pxPerSecond: 10, scrollLeft: 0, scrollTop: 0 };
    expect(clipAt(layout, viewport, 45, y)?.clip.id).toBe("c_2");
    expect(clipAt(layout, viewport, 35, y)).toBeNull();
    expect(clipAt(layout, viewport, 45, RULER_HEIGHT / 2)).toBeNull();
    expect(clipAt(layout, { ...viewport, scrollLeft: 20 }, 25, y)?.clip.id).toBe("c_2");
  });
});
