import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Clip, Timeline } from "@frameshell/schema";
import { mirrorsSound, otioAssetUrl, soundMirrorName, timelineToOtio } from "../src/index.js";
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

type OtioTrack = { kind: string; name: string; enabled: boolean; metadata: Json; children: Json[] };

/** Every track of an export, as OTIO objects. */
function tracksOf(otio: Record<string, unknown>): OtioTrack[] {
  return (otio.tracks as { children: OtioTrack[] }).children;
}

/** The first track of an export: the picture track of a timeline that starts with a video track. */
function pictureTrack(otio: Record<string, unknown>): OtioTrack {
  return tracksOf(otio)[0]!;
}

const schemas = (track: OtioTrack) => track.children.map((child) => child["OTIO_SCHEMA"]);

describe("timelineToOtio", () => {
  it.each([30, 24])("two media clips with a hole: Clip.2, Gap.1, Clip.2 with exact frames at %i fps", (fps) => {
    const timeline = timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_a", 0, 2, 4), media("c_b", 5, 10, 11.5)] }]);
    const { otio, warnings, tracks, clips, markers } = timelineToOtio(timeline, { fps, assetUrl });
    expect(warnings).toEqual([]);
    // The two clips are two pictures; their sound is the mirror track, which adds a track and no clip to the count.
    expect([tracks, clips, markers]).toEqual([2, 2, 0]);
    expect(otio).toMatchObject({ OTIO_SCHEMA: "Timeline.1", name: "main", global_start_time: time(0, fps), metadata: { frameshell: { timelineId: "main", revision: 4, schemaVersion: 1 } } });
    const track = pictureTrack(otio);
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
    const kinds = pictureTrack(timelineToOtio(timeline, { fps: 30, assetUrl }).otio).children.map((child) => child["OTIO_SCHEMA"]);
    expect(kinds).toEqual(["Gap.1", "Clip.2", "Clip.2"]);
  });

  it("speed 2: source_range lasts the timeline length (OTIO lays items out by it), LinearTimeWarp carries the rate", () => {
    const timeline = timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_fast", 0, 10, 14, { speed: 2 }), media("c_next", 5, 0, 1)] }]);
    const { otio, warnings } = timelineToOtio(timeline, { fps: 30, assetUrl });
    const [fast, gap] = pictureTrack(otio).children;
    expect(fast!["source_range"]).toEqual(range(300, 60, 30));
    expect(fast!["effects"]).toEqual([{ OTIO_SCHEMA: "LinearTimeWarp.1", name: "", effect_name: "LinearTimeWarp", time_scalar: 2, metadata: {} }]);
    expect(fast!["metadata"]).toEqual({ frameshell: { clipId: "c_fast", start: 0, length: 2, speed: 2 } });
    // The clip is 2 s on the timeline (frames 0-60): the hole before c_next at 5 s is 3 s.
    expect(gap!["source_range"]).toEqual(range(0, 90, 30));
    expect(warnings).toEqual([]);
    expect(otioProblems(otio)).toEqual([]);
  });

  it("rounds to whole frames at a fractional rate without drift", () => {
    const fps = 30000 / 1001;
    const clips = Array.from({ length: 40 }, (_, index) => media(`c_${index}`, Math.round(((index * 3) / fps) * 1000) / 1000, 0, Math.round((2 / fps) * 1000) / 1000));
    const { otio } = timelineToOtio(timelineOf([{ id: "t_v1", kind: "video", clips }]), { fps, assetUrl });
    const children = pictureTrack(otio).children;
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

  it("disables a muted audio track and a hidden video track, and moves the sound of a muted video track to its disabled mirror", () => {
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
      // A hidden video track still plays its sound; a muted one keeps its picture and silences the mirror.
      ["V1 sound", "Audio", true],
      ["V2 sound", "Audio", false],
    ]);
    expect(children[3]!["children"][0]).toMatchObject({ enabled: false, metadata: { frameshell: { gain: -6 } } });
    expect(children[1]!["metadata"]).toEqual({ frameshell: { trackId: "t_v2", muted: true } });
    expect(warnings).toEqual([]);
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
    // V1, A1 and the mirror of V1: the generated and nested clips have no sound to mirror.
    expect([trackCount, clips]).toEqual([3, 5]);
    const [video, audio, mirror] = (otio.tracks as { children: Json[] }).children;
    expect(mirror!["name"]).toBe("V1 sound");
    expect(mirror!["children"].map((child: Json) => [child["OTIO_SCHEMA"], child["source_range"], child["enabled"]])).toEqual([
      ["Clip.2", range(0, 60, 30), true],
      ["Gap.1", range(0, 240, 30), true],
      ["Clip.2", range(0, 30, 30), false],
    ]);
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
      "dips and fades (fadeIn, fadeOut, dissolve with no handle or no clip before it) on 2 clips not exported (c_a, c_b).",
      "transform and keys on 1 clip not exported (c_a).",
      "colour grade on 1 clip not exported (c_a).",
      "audio effects on 1 clip not exported (c_snd).",
    ]);
    expect(otioProblems(otio)).toEqual([]);
  });

  it("names a transition shape, a per-format override and a track behind the person", () => {
    const tracks = [
      { id: "t_v1", kind: "video", clips: [media("c_a", 0, 0, 2, { audio: { muted: true } })] },
      { id: "t_v2", kind: "video", behind: "t_v1", clips: [media("c_b", 0, 0, 2, { audio: { muted: true }, shape: { kind: "wipe" }, formats: { vertical: { hidden: true } } })] },
    ];
    const { warnings } = timelineToOtio(timelineOf(tracks), { fps: 30, assetUrl });
    expect(warnings).toEqual([
      "video track t_v2 sits behind the person on track t_v1 (subject matte): exported as a plain track.",
      "transition shape (no dissolve carries it) on 1 clip not exported (c_b).",
      "per-format overrides on 1 clip not exported (c_b).",
    ]);
  });

  describe("dissolves", () => {
    const muted = { audio: { muted: true } };
    /** The warnings about transitions only: the muted sound of the clips is not what these tests are about. */
    const aboutTransitions = (warnings: string[]) => warnings.filter((warning) => /^(dips and fades|transition shape)/.test(warning));
    const butted = (fps: number, dissolve: number, extra: Record<string, unknown> = {}) =>
      timelineToOtio(timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_a", 0, 2, 4, muted), media("c_b", 2, 5, 7, { ...muted, dissolve, ...extra })] }]), { fps, assetUrl, sourceDuration: () => 100 });

    it("a dissolve between butted clips is one Transition.1 of half frames each side, with no Gap.1 around it", () => {
      const { otio, warnings } = butted(30, 1);
      const children = pictureTrack(otio).children;
      expect(children.map((child) => child["OTIO_SCHEMA"])).toEqual(["Clip.2", "Transition.1", "Clip.2"]);
      expect(children[1]).toEqual({
        OTIO_SCHEMA: "Transition.1",
        name: "",
        transition_type: "SMPTE_Dissolve",
        in_offset: time(15, 30),
        out_offset: time(15, 30),
        metadata: { frameshell: { clipId: "c_b", dissolve: 1, half: 0.5 } },
      });
      // The clips keep their lengths: a transition has none of its own.
      expect(children[0]!["source_range"]).toEqual(range(60, 60, 30));
      expect(children[2]!["source_range"]).toEqual(range(150, 60, 30));
      expect(aboutTransitions(warnings)).toEqual([]);
      expect(otioProblems(otio)).toEqual([]);
    });

    it("keeps whole frames at a fractional rate", () => {
      const fps = 30000 / 1001;
      const frame = (index: number) => Math.round((index / fps) * 1000) / 1000;
      const timeline = timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_a", 0, 2, 2 + frame(48), { audio: { muted: true } }), media("c_b", frame(48), 5, 6, { audio: { muted: true }, dissolve: frame(10) })] }]);
      const { otio } = timelineToOtio(timeline, { fps, assetUrl, sourceDuration: () => 100 });
      const transition = pictureTrack(otio).children[1]!;
      expect(transition["OTIO_SCHEMA"]).toBe("Transition.1");
      expect(transition["in_offset"]).toEqual(time(5, fps));
      expect(transition["out_offset"]).toEqual(time(5, fps));
      expect(otioProblems(otio)).toEqual([]);
    });

    it("takes the effective half from edgeTransitions: cut to the handle the clips share", () => {
      // c_a ends at source 4 of a 4.2 s asset: 0.2 s of handle after, so a requested 1 s dissolve is 0.2 s a side.
      const { otio } = timelineToOtio(timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_a", 0, 2, 4, muted), media("c_b", 2, 5, 7, { ...muted, dissolve: 1 })] }]), {
        fps: 30,
        assetUrl,
        sourceDuration: () => 4.2,
      });
      expect(pictureTrack(otio).children[1]).toMatchObject({ in_offset: time(6, 30), out_offset: time(6, 30) });
    });

    it("a dissolve with no handle plays as a dip, one with no clip before it as a fade in: no Transition.1, one warning", () => {
      const noHandle = timelineToOtio(timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_a", 0, 2, 4, muted), media("c_b", 2, 0, 2, { ...muted, dissolve: 1 })] }]), {
        fps: 30,
        assetUrl,
        sourceDuration: () => 4,
      });
      expect(pictureTrack(noHandle.otio).children.map((child) => child["OTIO_SCHEMA"])).toEqual(["Clip.2", "Clip.2"]);
      expect(aboutTransitions(noHandle.warnings)).toEqual(["dips and fades (fadeIn, fadeOut, dissolve with no handle or no clip before it) on 1 clip not exported (c_b)."]);
      const apart = timelineToOtio(timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_a", 0, 2, 4, muted), media("c_b", 3, 5, 7, { ...muted, dissolve: 1 })] }]), { fps: 30, assetUrl });
      expect(pictureTrack(apart.otio).children.map((child) => child["OTIO_SCHEMA"])).toEqual(["Clip.2", "Gap.1", "Clip.2"]);
      expect(aboutTransitions(apart.warnings)).toHaveLength(1);
    });

    it("a shaped dissolve is a plain SMPTE_Dissolve with the shape in the metadata, and a warning", () => {
      const { otio, warnings } = butted(30, 1, { shape: { kind: "wipe" } });
      const transition = pictureTrack(otio).children[1]!;
      expect(transition["transition_type"]).toBe("SMPTE_Dissolve");
      expect(transition["metadata"]).toEqual({ frameshell: { clipId: "c_b", dissolve: 1, half: 0.5, shape: { kind: "wipe" } } });
      expect(aboutTransitions(warnings)).toEqual(["transition shape (its dissolve is written as a plain one) on 1 clip not exported (c_b)."]);
    });

    it("a generated clip dissolves too, and a fade next to a dissolve is still named", () => {
      const tracks = [
        {
          id: "t_v1",
          kind: "video",
          clips: [
            { id: "c_gen", type: "hyperframes", start: 0, duration: 2, source: "compositions/hyperframes/intro/index.html" },
            media("c_b", 2, 5, 7, { ...muted, dissolve: 0.6, fadeOut: 0.2 }),
          ],
        },
      ];
      const { otio, warnings } = timelineToOtio(timelineOf(tracks), { fps: 30, assetUrl });
      expect(pictureTrack(otio).children.map((child) => child["OTIO_SCHEMA"])).toEqual(["Clip.2", "Transition.1", "Clip.2"]);
      expect(pictureTrack(otio).children[1]).toMatchObject({ in_offset: time(9, 30), out_offset: time(9, 30) });
      expect(warnings.some((warning) => warning.startsWith("dips and fades") && warning.includes("(c_b)"))).toBe(true);
    });

    it("lists the first five clips of a warning and an ellipsis for the rest", () => {
      const clips = Array.from({ length: 7 }, (_, index) => media(`c_${index}`, index * 3, 0, 1, { ...muted, fadeIn: 0.1 }));
      const { warnings } = timelineToOtio(timelineOf([{ id: "t_v1", kind: "video", clips }]), { fps: 30, assetUrl });
      expect(aboutTransitions(warnings)).toEqual(["dips and fades (fadeIn, fadeOut, dissolve with no handle or no clip before it) on 7 clips not exported (c_0, c_1, c_2, c_3, c_4, …)."]);
    });
  });

  describe("sound mirror", () => {
    it("one Audio track per video track with media clips, after every real track, named and linked to its video track", () => {
      const tracks = [
        { id: "t_v1", kind: "video", clips: [media("c_a", 0, 2, 4)] },
        { id: "t_a1", kind: "audio", clips: [media("c_m", 0, 0, 4)] },
        { id: "t_v2", kind: "video", name: "Cam", clips: [media("c_b", 1, 0, 1)] },
        { id: "t_v3", kind: "video", clips: [{ id: "c_gen", type: "hyperframes", start: 0, duration: 2, source: "compositions/hyperframes/intro/index.html" }] },
      ];
      const { otio, tracks: count, clips } = timelineToOtio(timelineOf(tracks), { fps: 30, assetUrl });
      expect(tracksOf(otio).map((track) => [track.name, track.kind, track.enabled])).toEqual([
        ["V1", "Video", true],
        ["A1", "Audio", true],
        ["Cam", "Video", true],
        ["V3", "Video", true],
        ["V1 sound", "Audio", true],
        ["Cam sound", "Audio", true],
      ]);
      // The real audio track keeps A1; the track of generated clips has nothing to mirror.
      expect([count, clips]).toEqual([6, 4]);
      const [, , , , v1Sound, camSound] = tracksOf(otio);
      expect(v1Sound!.metadata).toEqual({ frameshell: { mirrorOf: "t_v1" } });
      expect(camSound!.metadata).toEqual({ frameshell: { mirrorOf: "t_v2" } });
      expect(schemas(camSound!)).toEqual(["Gap.1", "Clip.2"]);
      expect(otioProblems(otio)).toEqual([]);
    });

    it("a mirror clip is its picture: same name, range, file, speed and times, linked by clipId", () => {
      const timeline = timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_fast", 0, 10, 14, { speed: 2, audio: { gain: -3 } }), media("c_next", 5, 0, 1)] }]);
      const [video, sound] = tracksOf(timelineToOtio(timeline, { fps: 30, assetUrl }).otio);
      expect(sound!.children).toHaveLength(video!.children.length);
      for (const [picture, mirror] of video!.children.map((child, index) => [child, sound!.children[index]!] as const)) {
        expect(mirror["OTIO_SCHEMA"]).toBe(picture["OTIO_SCHEMA"]);
        expect(mirror["name"]).toBe(picture["name"]);
        expect(mirror["source_range"]).toEqual(picture["source_range"]);
        expect(mirror["effects"]).toEqual(picture["effects"]);
        expect(mirror["media_references"]).toEqual(picture["media_references"]);
      }
      expect(sound!.children[0]!["metadata"]).toEqual({ frameshell: { clipId: "c_fast", linkedClipId: "c_fast", start: 0, length: 2, gain: -3, speed: 2, sound: true } });
      expect(sound!.children[0]!["effects"]).toHaveLength(1);
    });

    it("a muted clip is a disabled slot on the mirror and stays enabled on the picture", () => {
      const timeline = timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_a", 0, 0, 1, { audio: { muted: true } }), media("c_b", 1, 0, 1)] }]);
      const { otio, warnings } = timelineToOtio(timeline, { fps: 30, assetUrl });
      const [video, sound] = tracksOf(otio);
      expect(video!.children.map((child) => child["enabled"])).toEqual([true, true]);
      expect(sound!.children.map((child) => child["enabled"])).toEqual([false, true]);
      expect(warnings).toEqual([]);
    });

    it("a still image has no sound: no mirror clip, and no mirror track when there is no other clip", () => {
      const timeline = timelineOf([
        { id: "t_v1", kind: "video", clips: [media("c_a", 0, 0, 1), { id: "c_pic", type: "media", asset: "assets/photo.png", start: 1, in: 0, out: 2 }] },
        { id: "t_v2", kind: "video", clips: [{ id: "c_pic2", type: "media", asset: "assets/photo.png", start: 0, in: 0, out: 2 }] },
      ]);
      const { otio, tracks } = timelineToOtio(timeline, { fps: 30, assetUrl, assetHasSound: (asset) => !asset.endsWith(".png") });
      expect(tracks).toBe(3);
      const [, , sound] = tracksOf(otio);
      expect(sound!.name).toBe("V1 sound");
      expect(sound!.children).toHaveLength(1);
      expect(mirrorsSound(media("c_a", 0, 0, 1), () => false)).toBe(false);
      expect(mirrorsSound(media("c_a", 0, 0, 1))).toBe(true);
      expect(soundMirrorName("Cam")).toBe("Cam sound");
    });

    it("a dissolve between butted clips crossfades the mirror as the same Transition.1", () => {
      const timeline = timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_a", 0, 2, 4), media("c_b", 2, 5, 7, { dissolve: 1, shape: { kind: "wipe" } })] }]);
      const [video, sound] = tracksOf(timelineToOtio(timeline, { fps: 30, assetUrl, sourceDuration: () => 100 }).otio);
      expect(schemas(sound!)).toEqual(["Clip.2", "Transition.1", "Clip.2"]);
      expect(sound!.children[1]).toMatchObject({ transition_type: "SMPTE_Dissolve", in_offset: time(15, 30), out_offset: time(15, 30) });
      // A crossfade of sound has no shape.
      expect(sound!.children[1]!["metadata"]).toEqual({ frameshell: { clipId: "c_b", dissolve: 1, half: 0.5, sound: true } });
      expect(video!.children[1]!["metadata"].frameshell.shape).toEqual({ kind: "wipe" });
    });

    it("no Transition.1 on the mirror where the clip before it has no sound to mirror", () => {
      const timeline = timelineOf([
        {
          id: "t_v1",
          kind: "video",
          clips: [{ id: "c_gen", type: "hyperframes", start: 0, duration: 2, source: "compositions/hyperframes/intro/index.html" }, media("c_b", 2, 5, 7, { dissolve: 0.6 })],
        },
      ]);
      const [video, sound] = tracksOf(timelineToOtio(timeline, { fps: 30, assetUrl }).otio);
      expect(schemas(video!)).toEqual(["Clip.2", "Transition.1", "Clip.2"]);
      expect(schemas(sound!)).toEqual(["Gap.1", "Clip.2"]);
    });

    it("names clip gain as metadata only, on video and audio tracks alike, and sound fades as not exported", () => {
      const timeline = timelineOf([
        { id: "t_v1", kind: "video", clips: [media("c_a", 0, 0, 1, { audio: { gain: -6 } }), media("c_b", 1, 0, 1, { audio: { fadeInMs: 12 } })] },
        { id: "t_a1", kind: "audio", clips: [media("c_m", 0, 0, 2, { audio: { gain: 3, fadeOutMs: 200 } }), media("c_z", 2, 0, 1, { audio: { gain: 0 } })] },
      ]);
      const { warnings } = timelineToOtio(timeline, { fps: 30, assetUrl });
      expect(warnings).toEqual([
        "clip gain (audio.gain) on 2 clips kept as metadata only, with no level change in the file (c_a, c_m).",
        "sound fades (audio.fadeInMs, audio.fadeOutMs) on 2 clips not exported (c_b, c_m).",
      ]);
    });
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
