import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Clip, Timeline } from "@frameshell/schema";
import { otioAssetUrl, timelineToOtio } from "../src/index.js";
import { otioProblems } from "./otio-check.js";

// Golden file: the reviewed OTIO document. Regenerate with UPDATE_GOLDEN=1 and review the diff.
const GOLDEN_DIR = fileURLToPath(new URL("./golden/", import.meta.url));

function golden(name: string, actual: unknown): void {
  const path = `${GOLDEN_DIR}${name}.json`;
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env["UPDATE_GOLDEN"] || !existsSync(path)) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(path, text);
    if (!process.env["UPDATE_GOLDEN"]) throw new Error(`golden ${name} was missing and has been written; review and rerun`);
  }
  expect(text).toBe(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
}

/** A parsed OTIO node: the tests index into it freely. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const assetUrl = (asset: string) => `../${asset}`;

function timelineOf(tracks: unknown[], extra: Record<string, unknown> = {}): Timeline {
  return { schemaVersion: 1, id: "main", revision: 4, tracks, ...extra } as Timeline;
}

function media(id: string, start: number, from: number, to: number, extra: Record<string, unknown> = {}): Clip {
  return { id, type: "media", asset: "assets/take.mp4", start, in: from, out: to, ...extra } as Clip;
}

const time = (value: number, rate: number) => ({ OTIO_SCHEMA: "RationalTime.1", rate, value });
const range = (start: number, duration: number, rate: number) => ({ OTIO_SCHEMA: "TimeRange.1", duration: time(duration, rate), start_time: time(start, rate) });

/** The only track of a one-track export, as OTIO objects. */
function onlyTrack(otio: Record<string, unknown>): { kind: string; name: string; enabled: boolean; children: Json[] } {
  const stack = otio.tracks as { children: never[] };
  expect(stack.children).toHaveLength(1);
  return stack.children[0]!;
}

describe("timelineToOtio", () => {
  it.each([30, 24])("two media clips with a hole: Clip.2, Gap.1, Clip.2 with exact frames at %i fps", (fps) => {
    const timeline = timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_a", 0, 2, 4), media("c_b", 5, 10, 11.5)] }]);
    const { otio, warnings, tracks, clips, markers } = timelineToOtio(timeline, { fps, assetUrl });
    expect(warnings).toEqual([]);
    expect([tracks, clips, markers]).toEqual([1, 2, 0]);
    expect(otio).toMatchObject({ OTIO_SCHEMA: "Timeline.1", name: "main", global_start_time: time(0, fps), metadata: { frameshell: { timelineId: "main", revision: 4, schemaVersion: 1 } } });
    const track = onlyTrack(otio);
    expect(track).toMatchObject({ OTIO_SCHEMA: "Track.1", kind: "Video", name: "V1", enabled: true });
    expect(track.children.map((child) => child["OTIO_SCHEMA"])).toEqual(["Clip.2", "Gap.1", "Clip.2"]);
    const [first, gap, second] = track.children;
    expect(first!["source_range"]).toEqual(range(2 * fps, 2 * fps, fps));
    expect(first!["media_references"]).toEqual({
      DEFAULT_MEDIA: { OTIO_SCHEMA: "ExternalReference.1", name: "", available_range: null, metadata: {}, target_url: "../assets/take.mp4" },
    });
    expect(first!["active_media_reference_key"]).toBe("DEFAULT_MEDIA");
    expect(first!["name"]).toBe("take.mp4");
    expect(gap!["source_range"]).toEqual(range(0, 3 * fps, fps));
    expect(second!["source_range"]).toEqual(range(10 * fps, 1.5 * fps, fps));
    expect(second!["metadata"]).toEqual({ frameshell: { clipId: "c_b", start: 5, length: 1.5 } });
    expect(otioProblems(otio)).toEqual([]);
  });

  it("starts the first clip with a gap and adds none between butted clips", () => {
    const timeline = timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_a", 1, 0, 1), media("c_b", 2, 0, 1)] }]);
    const kinds = onlyTrack(timelineToOtio(timeline, { fps: 30, assetUrl }).otio).children.map((child) => child["OTIO_SCHEMA"]);
    expect(kinds).toEqual(["Gap.1", "Clip.2", "Clip.2"]);
  });

  it("speed 2: source range is source time, LinearTimeWarp carries the rate, the gap counts timeline time", () => {
    const timeline = timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_fast", 0, 10, 14, { speed: 2 }), media("c_next", 5, 0, 1)] }]);
    const { otio, warnings } = timelineToOtio(timeline, { fps: 30, assetUrl });
    const [fast, gap] = onlyTrack(otio).children;
    expect(fast!["source_range"]).toEqual(range(300, 120, 30));
    expect(fast!["effects"]).toEqual([{ OTIO_SCHEMA: "LinearTimeWarp.1", name: "", effect_name: "LinearTimeWarp", time_scalar: 2, metadata: {} }]);
    expect(fast!["metadata"]).toEqual({ frameshell: { clipId: "c_fast", start: 0, length: 2, speed: 2 } });
    // The clip is 2 s on the timeline (frames 0-60): the hole before c_next at 5 s is 3 s.
    expect(gap!["source_range"]).toEqual(range(0, 90, 30));
    expect(warnings).toEqual([expect.stringContaining("c_fast plays at 2x")]);
    expect(otioProblems(otio)).toEqual([]);
  });

  it("rounds to whole frames at a fractional rate without drift", () => {
    const fps = 30000 / 1001;
    const clips = Array.from({ length: 40 }, (_, index) => media(`c_${index}`, Math.round(((index * 3) / fps) * 1000) / 1000, 0, Math.round((2 / fps) * 1000) / 1000));
    const { otio } = timelineToOtio(timelineOf([{ id: "t_v1", kind: "video", clips }]), { fps, assetUrl });
    const children = onlyTrack(otio).children;
    // Two frames of clip, one frame of gap, 40 times, with no frame lost to rounding.
    expect(children.filter((child) => child["OTIO_SCHEMA"] === "Gap.1").every((gap) => gap["source_range"].duration.value === 1)).toBe(true);
    expect(children.filter((child) => child["OTIO_SCHEMA"] === "Clip.2").every((clip) => clip["source_range"].duration.value === 2)).toBe(true);
    expect(JSON.stringify(otio)).toContain(`"rate":${fps}`);
    expect(otioProblems(otio)).toEqual([]);
  });

  it("markers become Marker.2 on the stack, sorted, with OTIO colours", () => {
    const timeline = timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_a", 0, 0, 5)] }], {
      markers: [
        { id: "m_2", at: 3, label: "drop", color: "purple" },
        { id: "m_1", at: 1.5, label: "hook", color: "red" },
        { id: "m_3", at: 4, label: "plain" },
      ],
    });
    const { otio, markers } = timelineToOtio(timeline, { fps: 24, assetUrl });
    expect(markers).toBe(3);
    const stack = otio.tracks as { OTIO_SCHEMA: string; markers: Record<string, unknown>[] };
    expect(stack.OTIO_SCHEMA).toBe("Stack.1");
    expect(stack.markers.map((marker) => [marker["name"], marker["color"], marker["marked_range"]])).toEqual([
      ["hook", "RED", range(36, 0, 24)],
      ["drop", "PURPLE", range(72, 0, 24)],
      ["plain", "GREEN", range(96, 0, 24)],
    ]);
    expect(stack.markers.every((marker) => marker["OTIO_SCHEMA"] === "Marker.2")).toBe(true);
  });

  it("disables a muted audio track and a hidden video track, and keeps a muted video track's picture", () => {
    const tracks = [
      { id: "t_v1", kind: "video", hidden: true, clips: [media("c_a", 0, 0, 1)] },
      { id: "t_v2", kind: "video", muted: true, clips: [media("c_b", 0, 0, 1)] },
      { id: "t_a1", kind: "audio", muted: true, name: "Music", clips: [media("c_c", 0, 0, 1)] },
      { id: "t_a2", kind: "audio", clips: [media("c_d", 0, 0, 1, { audio: { muted: true, gain: -6 } })] },
    ];
    const { otio, warnings } = timelineToOtio(timelineOf(tracks), { fps: 30, assetUrl });
    const children = (otio.tracks as { children: Json[] }).children;
    expect(children.map((track) => [track["name"], track["kind"], track["enabled"]])).toEqual([
      ["V1", "Video", false],
      ["V2", "Video", true],
      ["Music", "Audio", false],
      ["A2", "Audio", true],
    ]);
    expect(children[3]!["children"][0]).toMatchObject({ enabled: false, metadata: { frameshell: { gain: -6 } } });
    expect(warnings).toEqual([expect.stringContaining("video track t_v2 is muted")]);
  });

  it("keeps the slot of generated and nested clips as missing media, and names what it leaves out", () => {
    const tracks = [
      {
        id: "t_v1",
        kind: "video",
        clips: [
          media("c_a", 0, 0, 2, { dissolve: 0.5, transform: { x: 10 }, grade: { exposure: 1 } }),
          { id: "c_gen", type: "hyperframes", start: 2, duration: 3, source: "compositions/hyperframes/intro/index.html" },
          { id: "c_nest", type: "timeline", start: 5, source: "timelines/inner.json", in: 1 },
          { id: "c_lost", type: "timeline", start: 9, source: "timelines/gone.json" },
          media("c_b", 10, 0, 1, { fadeOut: 0.2, audio: { muted: true } }),
        ],
      },
      { id: "t_p1", kind: "program", group: "g_1", clips: [{ id: "s_1", type: "shot", start: 0, in: 0, out: 5, shot: "solo", angles: ["a_1"] }] },
      { id: "t_s1", kind: "subtitles", follows: "t_v1" },
      { id: "t_a1", kind: "audio", clips: [media("c_snd", 0, 0, 2, { audio: { effects: [{ kind: "highpass" }] } })] },
    ];
    const { otio, warnings, tracks: trackCount, clips } = timelineToOtio(timelineOf(tracks), { fps: 30, assetUrl, sourceDuration: (clip) => (clip.id === "c_nest" ? 6 : undefined) });
    expect([trackCount, clips]).toEqual([2, 5]);
    const [video, audio] = (otio.tracks as { children: Json[] }).children;
    expect(video!["children"].map((child: Json) => [child["OTIO_SCHEMA"], child["name"], child["source_range"]])).toEqual([
      ["Clip.2", "take.mp4", range(0, 60, 30)],
      ["Clip.2", "hyperframes intro", range(0, 90, 30)],
      ["Clip.2", "timeline inner", range(0, 150, 30)],
      ["Clip.2", "take.mp4", range(0, 30, 30)],
    ]);
    const missing = video!["children"][1]["media_references"]["DEFAULT_MEDIA"];
    expect(missing).toEqual({ OTIO_SCHEMA: "MissingReference.1", name: "", available_range: null, metadata: {} });
    expect(video!["children"][2]["media_references"]["DEFAULT_MEDIA"]).toMatchObject({ OTIO_SCHEMA: "MissingReference.1" });
    expect(audio!["name"]).toBe("A1");
    expect(warnings).toEqual([
      "generated clip c_gen (hyperframes) exported as missing media of its length: render it and relink the file by hand.",
      "nested timeline clip c_nest (inner) exported as missing media of its length: export that timeline on its own and relink it.",
      "clip c_lost (nested timelines/gone.json) has no known length: skipped.",
      "program track t_p1 (multicam shots) not exported: 1 shot skipped.",
      "subtitle track t_s1 not exported.",
      "transitions (dissolves, fades) on 2 clips not exported (c_a, c_b).",
      "transform and keys on 1 clip not exported (c_a).",
      "colour grade on 1 clip not exported (c_a).",
      "muted sound of a video clip on 1 clip not exported (c_b).",
      "audio effects on 1 clip not exported (c_snd).",
    ]);
    expect(otioProblems(otio)).toEqual([]);
  });

  it("matches the golden document of a small edit", () => {
    const timeline = timelineOf(
      [
        { id: "t_v1", kind: "video", clips: [media("c_a", 0, 2, 4), media("c_b", 5, 10, 14, { speed: 2 }), { id: "c_gen", type: "hyperframes", start: 7, duration: 2, source: "compositions/hyperframes/title/index.html" }] },
        { id: "t_a1", kind: "audio", name: "Music", muted: true, clips: [{ id: "c_m", type: "media", asset: "assets/music/theme.wav", start: 0, in: 0, out: 9 }] },
      ],
      { markers: [{ id: "m_1", at: 5, label: "hook", color: "orange" }] },
    );
    const result = timelineToOtio(timeline, { fps: 30, assetUrl });
    golden("otio-edit", result);
    expect(otioProblems(result.otio)).toEqual([]);
  });
});

describe("otioAssetUrl", () => {
  it("relative to the file's folder with `/`, whatever the machine's separator", () => {
    expect(otioAssetUrl({ root: "/p/video", outDir: "/p/video/exports", absolute: false, flavour: "posix" }, "assets/clip one.mp4")).toBe("../assets/clip%20one.mp4");
    expect(otioAssetUrl({ root: "C:\\p\\video", outDir: "C:\\p\\video\\exports", absolute: false, flavour: "win32" }, "assets/take.mp4")).toBe("../assets/take.mp4");
    expect(otioAssetUrl({ root: "C:\\p\\video", outDir: "C:\\p\\video", absolute: false, flavour: "win32" }, "assets/shoot/a.mp4")).toBe("assets/shoot/a.mp4");
  });

  it("absolute file URLs on request, and for a Windows asset on another drive", () => {
    expect(otioAssetUrl({ root: "/p/video", outDir: "/p/video/exports", absolute: true, flavour: "posix" }, "assets/a b.mp4")).toBe("file:///p/video/assets/a%20b.mp4");
    expect(otioAssetUrl({ root: "C:\\p\\video", outDir: "C:\\p\\video\\exports", absolute: true, flavour: "win32" }, "assets/take.mp4")).toBe("file:///C:/p/video/assets/take.mp4");
    expect(otioAssetUrl({ root: "C:\\p\\video", outDir: "D:\\out", absolute: false, flavour: "win32" }, "assets/take.mp4")).toBe("file:///C:/p/video/assets/take.mp4");
  });
});
