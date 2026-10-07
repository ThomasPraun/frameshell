import type { TimelineView } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { layoutTimeline } from "../src/renderer/src/timeline/layout.js";
import { DEFAULT_THEME, type MediaLookup, type Paint2D, paintTimeline } from "../src/renderer/src/timeline/paint.js";

// Seam under test: `paintTimeline` against a recording 2D context, the way the panel calls it each frame.

/** Records what a canvas would draw; no pixels. */
function recorder(): Paint2D<string> & { texts: string[]; images: string[]; rects: number; bars: number[] } {
  const noop = () => {};
  const ctx = {
    texts: [] as string[],
    images: [] as string[],
    rects: 0,
    /** Heights of 1 px wide fills: waveform bars. */
    bars: [] as number[],
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    font: "",
    textBaseline: "alphabetic",
    textAlign: "start",
    save: noop,
    restore: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    rect: noop,
    roundRect: noop,
    clip: noop,
    fill: noop,
    stroke: noop,
    setLineDash: noop,
    setTransform: noop,
    clearRect: noop,
    strokeRect: noop,
    fillRect: (_x: number, _y: number, w: number, h: number) => {
      ctx.rects++;
      if (w === 1) ctx.bars.push(h);
    },
    fillText: (text: string) => void ctx.texts.push(text),
    measureText: (text: string) => ({ width: text.length * 6 }),
    drawImage: (image: string) => void ctx.images.push(image),
  };
  return ctx;
}

const noMedia: MediaLookup<string> = { waveform: () => null, thumbnails: () => null };

function longTimeline(clips: number): TimelineView {
  const at = (i: number) => ({ id: `c_${i}`, type: "media", asset: `assets/take-${i}.mp4`, start: i * 3, end: i * 3 + 2.5, in: 0, out: 2.5 });
  return {
    timeline: "main",
    path: "timelines/main.json",
    revision: 1,
    fps: 30,
    duration: clips * 3,
    tracks: [
      { id: "t_v", kind: "video", name: null, follows: null, clips: Array.from({ length: clips }, (_, i) => at(i)) },
      { id: "t_a", kind: "audio", name: null, follows: null, clips: Array.from({ length: clips }, (_, i) => at(i + clips)).map((clip, i) => ({ ...clip, start: i * 3, end: i * 3 + 2.5 })) },
    ],
    problems: [],
  };
}

const viewport = (pxPerSecond: number, scrollLeft = 0) => ({ pxPerSecond, scrollLeft, scrollTop: 0, width: 600, height: 200 });

describe("paintTimeline", () => {
  it("draws only the clips inside the viewport, however long the timeline", () => {
    const layout = layoutTimeline(longTimeline(250));
    const ctx = recorder();
    // 600 px at 60 px/s from 30 s: 30..40 s, clips 10..13 on each track.
    const stats = paintTimeline(ctx, { layout, viewport: viewport(60, 1800), fps: 30, playhead: 0, theme: DEFAULT_THEME, media: noMedia });
    expect(stats.clipsDrawn).toBe(8);
    expect(ctx.texts).toEqual(expect.arrayContaining(["take-10.mp4", "take-13.mp4", "2.5s"]));
    expect(ctx.texts).not.toContain("take-9.mp4");
    expect(ctx.texts).not.toContain("take-14.mp4");
  });

  it("counts the clips drawn with derived media, so its arrival is observable", () => {
    const layout = layoutTimeline(longTimeline(3));
    const input = { layout, viewport: viewport(60), fps: 30, playhead: 0, theme: DEFAULT_THEME };
    expect(paintTimeline(recorder(), { ...input, media: noMedia }).mediaDrawn).toBe(0);
    const media: MediaLookup<string> = {
      // take-4 is the second audio clip; take-0 the first video clip.
      waveform: (asset) => (asset === "assets/take-4.mp4" ? { peaksPerSecond: 10, peaks: [[-9, 9]] } : null),
      thumbnails: (asset) =>
        asset === "assets/take-0.mp4" ? { interval: 1, count: 3, aspect: 16 / 9, image: (index) => `thumb-${index}` } : null,
    };
    const ctx = recorder();
    expect(paintTimeline(ctx, { ...input, media }).mediaDrawn).toBe(2);
    expect(ctx.images).toContain("thumb-1");
  });

  it("frames selected clips in the accent color, and only those", () => {
    const layout = layoutTimeline(longTimeline(3));
    const strokes = (selected?: ReadonlySet<string>) => {
      const ctx = recorder();
      const accentFrames: number[] = [];
      ctx.strokeRect = (x: number) => {
        if (ctx.strokeStyle === DEFAULT_THEME.accent && ctx.lineWidth === 2) accentFrames.push(x);
      };
      const input = { layout, viewport: viewport(20), fps: 30, playhead: 0, theme: DEFAULT_THEME, media: noMedia };
      paintTimeline(ctx, selected ? { ...input, selected } : input);
      return accentFrames;
    };
    expect(strokes()).toEqual([]);
    expect(strokes(new Set(["c_nope"]))).toEqual([]);
    // c_1 starts at 3 s: 60 px, plus the half-pixel gap and the 1 px inset.
    expect(strokes(new Set(["c_1"]))).toEqual([61.5]);
  });

  it("labels the ruler with timecodes of the visible range", () => {
    const layout = layoutTimeline(longTimeline(3));
    const ctx = recorder();
    paintTimeline(ctx, { layout, viewport: viewport(20, 200), fps: 30, playhead: 0, theme: DEFAULT_THEME, media: noMedia });
    expect(ctx.texts).toEqual(expect.arrayContaining(["00:00:10", "00:00:15", "00:00:35"]));
    expect(ctx.texts).not.toContain("00:00:05");
  });

  it("fills video clips with the thumbnails of the source times they show", () => {
    const layout = layoutTimeline(longTimeline(1));
    const ctx = recorder();
    const media: MediaLookup<string> = {
      waveform: () => null,
      // One thumbnail per second of source.
      thumbnails: (asset) => ({ interval: 1, count: 3, image: (index) => `${asset}#${index}`, aspect: 16 / 9 }),
    };
    paintTimeline(ctx, { layout, viewport: viewport(100), fps: 30, playhead: 0, theme: DEFAULT_THEME, media });
    // 38 px high clip body, 16:9 tiles about 68 px wide: 250 px of clip takes 4, starting at source 0, 0.68, 1.35, 2.03 s.
    expect(ctx.images).toEqual(["assets/take-0.mp4#1", "assets/take-0.mp4#1", "assets/take-0.mp4#2", "assets/take-0.mp4#3"]);
  });

  it("draws a waveform for audio clips when peaks are known", () => {
    const layout = layoutTimeline(longTimeline(1));
    const without = recorder();
    paintTimeline(without, { layout, viewport: viewport(100), fps: 30, playhead: 0, theme: DEFAULT_THEME, media: noMedia });
    const withPeaks = recorder();
    const peaks: [number, number][] = Array.from({ length: 250 }, (_, i) => [-(i % 100), i % 100]);
    paintTimeline(withPeaks, {
      layout,
      viewport: viewport(100),
      fps: 30,
      playhead: 0,
      theme: DEFAULT_THEME,
      media: { waveform: () => ({ peaksPerSecond: 100, peaks }), thumbnails: () => null },
    });
    // One bar per pixel column of the 250 px audio clip.
    expect(withPeaks.rects - without.rects).toBeGreaterThanOrEqual(240);
  });

  it("scales an audio clip's waveform by its gain and flattens a muted one, and says so in the label", () => {
    const peaks: [number, number][] = Array.from({ length: 250 }, () => [-100, 100]);
    const media: MediaLookup<string> = { waveform: () => ({ peaksPerSecond: 100, peaks }), thumbnails: () => null };
    const tallest = (audio: Record<string, unknown> | undefined) => {
      const view = longTimeline(1);
      view.tracks = [{ ...view.tracks[1]!, clips: [{ ...view.tracks[1]!.clips[0]!, ...(audio ? { audio } : {}) }] }];
      const ctx = recorder();
      paintTimeline(ctx, { layout: layoutTimeline(view), viewport: viewport(100), fps: 30, playhead: 0, theme: DEFAULT_THEME, media });
      // Constant peaks: the waveform is the most frequent bar height (ruler ticks and the playhead are few).
      const counts = new Map<number, number>();
      for (const bar of ctx.bars) counts.set(bar, (counts.get(bar) ?? 0) + 1);
      const height = [...counts].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
      return { height, texts: ctx.texts };
    };
    const unity = tallest(undefined);
    const quieter = tallest({ gain: -6 });
    // -6 dB is half the amplitude.
    expect(quieter.height / unity.height).toBeCloseTo(0.5, 1);
    expect(quieter.texts.some((text) => text.includes("-6 dB"))).toBe(true);
    const muted = tallest({ gain: -6, muted: true });
    expect(muted.height).toBe(1);
    expect(muted.texts.some((text) => text.includes("muted"))).toBe(true);
  });

  it("stays cheap with 250 clips on screen", () => {
    const layout = layoutTimeline(longTimeline(250));
    const ctx = recorder();
    const zoomedOut = { ...viewport(0.8), width: 1200 };
    const input = { layout, viewport: zoomedOut, fps: 30, playhead: 0, theme: DEFAULT_THEME, media: noMedia };
    expect(paintTimeline(ctx, input).clipsDrawn).toBe(500);
    const started = performance.now();
    for (let i = 0; i < 20; i++) paintTimeline(recorder(), input);
    expect((performance.now() - started) / 20).toBeLessThan(8);
  });

  it("marks clips whose length is unknown", () => {
    const layout = layoutTimeline({
      ...longTimeline(0),
      tracks: [{ id: "t_v", kind: "video", name: null, follows: null, clips: [{ id: "c_1", type: "timeline", source: "timelines/gone.json", start: 0, end: null }] }],
      problems: [{ clip: "c_1", track: "t_v", source: "timelines/gone.json", message: "timelines/gone.json does not exist" }],
    });
    const ctx = recorder();
    paintTimeline(ctx, { layout, viewport: viewport(100), fps: 30, playhead: 0, theme: DEFAULT_THEME, media: noMedia });
    expect(ctx.texts).toEqual(expect.arrayContaining(["gone", "length unknown"]));
  });

  it("draws a dragged clip's ghost where it would land, dims the original and marks the snap line", () => {
    const layout = layoutTimeline(longTimeline(3));
    const draw = (blocked: boolean) => {
      const ctx = recorder();
      const ghosts: { x: number; color: string }[] = [];
      const lines: number[] = [];
      const alphaOf: Record<string, number> = {};
      ctx.strokeRect = (x: number) => {
        if (ctx.lineWidth === 1.5) ghosts.push({ x, color: String(ctx.strokeStyle) });
      };
      ctx.fillRect = (x: number, y: number, w: number) => {
        if (ctx.fillStyle === DEFAULT_THEME.accent && y === 22 && w === 1) lines.push(x);
      };
      ctx.fillText = (text: string) => void (alphaOf[text] = ctx.globalAlpha);
      const drag = { clip: "c_1", row: "t_v", start: 10, end: 12.5, blocked, guide: 10 };
      paintTimeline(ctx, { layout, viewport: viewport(20), fps: 30, playhead: 0, theme: DEFAULT_THEME, media: noMedia, drag });
      return { ghosts, lines, alphaOf };
    };
    const free = draw(false);
    // 10 s at 20 px/s: 200 px, plus the half-pixel gap and the stroke's half-pixel.
    expect(free.ghosts).toEqual([{ x: 201, color: DEFAULT_THEME.accent }]);
    expect(free.lines).toEqual([200]);
    expect(free.alphaOf["take-1.mp4"]).toBeLessThan(1);
    expect(free.alphaOf["take-0.mp4"]).toBe(1);
    expect(draw(true).ghosts).toEqual([{ x: 201, color: DEFAULT_THEME.danger }]);
  });

  it("draws a ghost for every clip of a group move and dims them all (#119)", () => {
    const layout = layoutTimeline(longTimeline(3));
    const ctx = recorder();
    const ghosts: number[] = [];
    const alphaOf: Record<string, number> = {};
    ctx.strokeRect = (x: number) => {
      if (ctx.lineWidth === 1.5) ghosts.push(x);
    };
    ctx.fillText = (text: string) => void (alphaOf[text] = ctx.globalAlpha);
    const drag = {
      clip: "c_1",
      row: "t_v",
      start: 10,
      end: 12.5,
      blocked: false,
      guide: null,
      others: [{ clip: "c_0", row: "t_v", start: 5, end: 7.5 }],
    };
    paintTimeline(ctx, { layout, viewport: viewport(20), fps: 30, playhead: 0, theme: DEFAULT_THEME, media: noMedia, drag });
    expect(ghosts).toEqual([201, 101]);
    expect(alphaOf["take-0.mp4"]).toBeLessThan(1);
    expect(alphaOf["take-1.mp4"]).toBeLessThan(1);
    expect(alphaOf["take-2.mp4"]).toBe(1);
  });

  it("marks what the selected history entry did: removed clips as ghosts, added, moved and changed ones framed", () => {
    const layout = layoutTimeline(longTimeline(3));
    const ctx = recorder();
    const frames: { x: number; color: string; dashed: boolean }[] = [];
    let dashed = false;
    ctx.setLineDash = (segments: number[]) => void (dashed = segments.length > 0);
    ctx.strokeRect = (x: number) => {
      if (ctx.lineWidth === 1.5) frames.push({ x, color: String(ctx.strokeStyle), dashed });
    };
    const place = (start: number, end: number | null, track = "t_v") => ({ track, start, end });
    const diff = [
      { clip: "c_gone", change: "removed" as const, before: place(20, 22), after: null },
      { clip: "c_0", change: "added" as const, before: null, after: place(0, 2.5) },
      { clip: "c_1", change: "moved" as const, before: place(12, 14.5), after: place(3, 5.5) },
      { clip: "c_2", change: "changed" as const, before: place(6, 9), after: place(6, 8.5) },
      // On a track the timeline no longer has: nothing to draw it on.
      { clip: "c_lost", change: "removed" as const, before: place(1, 2, "t_gone"), after: null },
    ];
    paintTimeline(ctx, { layout, viewport: viewport(20), fps: 30, playhead: 0, theme: DEFAULT_THEME, media: noMedia, diff });
    // Start s at 20 px/s: 20 s px, plus the half-pixel gap and the stroke's half-pixel.
    expect(frames).toEqual([
      { x: 401, color: DEFAULT_THEME.danger, dashed: true },
      { x: 1, color: DEFAULT_THEME.diffAdded, dashed: false },
      { x: 241, color: DEFAULT_THEME.diffMoved, dashed: true },
      { x: 61, color: DEFAULT_THEME.diffMoved, dashed: false },
      { x: 121, color: DEFAULT_THEME.diffChanged, dashed: true },
      { x: 121, color: DEFAULT_THEME.diffChanged, dashed: false },
    ]);
  });

  it("marks the selected words' range on the ruler and over the lanes, and nothing without one", () => {
    const layout = layoutTimeline(longTimeline(3));
    const bars = (range?: { from: number; to: number }) => {
      const ctx = recorder();
      const found: { x: number; w: number; h: number }[] = [];
      ctx.fillRect = (x: number, y: number, w: number, h: number) => {
        if (String(ctx.fillStyle).startsWith("rgba(227, 165, 60") || (ctx.fillStyle === DEFAULT_THEME.accent && h === RANGE_BAR)) found.push({ x, w, h });
      };
      const input = { layout, viewport: viewport(20), fps: 30, playhead: 0, theme: DEFAULT_THEME, media: noMedia };
      paintTimeline(ctx, range ? { ...input, range } : input);
      return found;
    };
    expect(bars()).toEqual([]);
    // 2 s to 3.5 s at 20 px/s: 40 px wide 30; a band over the lanes (below the 22 px ruler) and a bar on the ruler.
    expect(bars({ from: 2, to: 3.5 })).toEqual([
      { x: 40, w: 30, h: 200 - 22 },
      { x: 40, w: 30, h: RANGE_BAR },
    ]);
  });

  it("draws a subtitle lane's cues with their words, framing them when the track is selected; a hint when it has none", () => {
    const view = longTimeline(2);
    view.tracks.push({ id: "t_s", kind: "subtitles", name: null, follows: "t_v", clips: [] });
    const layout = layoutTimeline(view);
    const cue = (start: number, end: number, text: string) => ({ start, end, text, cue: { start: 0, end: 1, words: [], highlight: true } });
    const paint = (subtitles?: Map<string, ReturnType<typeof cue>[]>, selectedTrack?: string) => {
      const ctx = recorder();
      const frames: string[] = [];
      ctx.strokeRect = () => void frames.push(String(ctx.strokeStyle));
      const input = { layout, viewport: viewport(60), fps: 30, playhead: 0, theme: DEFAULT_THEME, media: noMedia };
      paintTimeline(ctx, { ...input, ...(subtitles ? { subtitles } : {}), ...(selectedTrack ? { selectedTrack } : {}) });
      return { texts: ctx.texts, accentFrames: frames.filter((color) => color === DEFAULT_THEME.accent).length };
    };
    expect(paint().texts).toContain("Words show here once the clips of V1 are transcribed");
    const cues = new Map([["t_s", [cue(0.5, 1.5, "HOLA A TODOS"), cue(2, 3, "HOY"), cue(20, 21, "LEJOS")]]]);
    const shown = paint(cues);
    // 600 px at 60 px/s shows 0-10 s: the cue at 20 s is culled.
    expect(shown.texts).toEqual(expect.arrayContaining(["HOLA A TODOS", "HOY"]));
    expect(shown.texts).not.toContain("LEJOS");
    expect(shown.accentFrames).toBe(0);
    expect(paint(cues, "t_s").accentFrames).toBe(2);
  });
});

/** Height of the ruler bar marking a selected range, px. */
const RANGE_BAR = 3;
