import { describe, expect, it } from "vitest";
import {
  type MulticamGroup,
  type ProgramTrack,
  type ShotClip,
  type Timeline,
  createTimeline,
  flattenTimeline,
  isProgramSound,
  movedProgramGroups,
  parseTimeline,
  programSound,
  shotLayers,
  shotSound,
  shotTiles,
  withProgramSound,
} from "../src/index.js";

const group: MulticamGroup = {
  id: "g_talk",
  name: "Podcast",
  angles: [
    { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0 },
    { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 1.5, audio: { gain: -3 } },
    { id: "eva", name: "Eva", asset: "assets/eva.mp4", offset: 0.25, crop: { left: 0.25, right: 0.25 } },
  ],
};

const shot = (id: string, start: number, from: number, to: number, layout: ShotClip["shot"], angles: string[]): ShotClip => ({
  id,
  type: "shot",
  start,
  in: from,
  out: to,
  shot: layout,
  angles,
});

const program = (clips: ShotClip[], extra: Partial<ProgramTrack> = {}): ProgramTrack => ({ id: "t_p", kind: "program", group: "g_talk", clips, ...extra });

const multicam = (tracks: unknown[], groups: unknown = [group]): unknown => ({ ...createTimeline("main"), tracks, groups });

const errorOf = (input: unknown) => {
  const result = parseTimeline(input);
  return result.ok ? null : result.error;
};

describe("multicam timeline model", () => {
  it("accepts a group shown by a program track of solo, two-up and grid shots", () => {
    const input = multicam([
      program([
        shot("c_1", 0, 0, 4, "solo", ["ana"]),
        { ...shot("c_2", 4, 4, 6, "two-up", ["ana", "ben"]), confidence: 0.8, reason: "quick exchange" },
        shot("c_3", 6, 6, 9, "grid", ["ana", "ben", "eva"]),
      ]),
    ]);
    const result = parseTimeline(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(input);
  });

  it("keeps timelines without groups valid and unchanged (no migration)", () => {
    expect(parseTimeline(createTimeline("main"))).toEqual({ ok: true, value: createTimeline("main") });
  });

  it("refuses shots naming angles outside their group, repeated, or too many for the layout", () => {
    expect(errorOf(multicam([program([shot("c_1", 0, 0, 1, "solo", ["zoe"])])]))).toBe(
      'tracks.0.clips.0.angles.0: angle "zoe" is not in group "g_talk" (angles: ana, ben, eva)',
    );
    expect(errorOf(multicam([program([shot("c_1", 0, 0, 1, "two-up", ["ana", "ana"])])]))).toBe(
      'tracks.0.clips.0.angles.1: angle "ana" is listed twice',
    );
    expect(errorOf(multicam([program([shot("c_1", 0, 0, 1, "solo", ["ana", "ben"])])]))).toBe(
      "tracks.0.clips.0.angles: a solo shot takes exactly 1 angle(s), got 2",
    );
    expect(errorOf(multicam([program([shot("c_1", 0, 0, 1, "grid", ["ana"])])]))).toBe(
      "tracks.0.clips.0.angles: a grid shot takes at least 2 angle(s), got 1",
    );
  });

  it("refuses overlapping shots on a program track, but lets shots touch", () => {
    expect(errorOf(multicam([program([shot("c_1", 0, 0, 4, "solo", ["ana"]), shot("c_2", 3.5, 8, 9, "solo", ["ben"])])]))).toBe(
      "tracks.0.clips.1.start: overlaps c_1 (0–4); shots on a program track cannot overlap",
    );
    expect(errorOf(multicam([program([shot("c_1", 0, 0, 4, "solo", ["ana"]), shot("c_2", 4, 8, 9, "solo", ["ben"])])]))).toBeNull();
  });

  it("binds a program track to exactly one existing group, and a group to one program track", () => {
    expect(errorOf(multicam([program([], { group: "g_gone" })]))).toBe(
      'tracks.0.group: must name a multicam group in `groups`, got "g_gone" (groups: g_talk)',
    );
    expect(errorOf(multicam([program([]), program([], { id: "t_p2" })]))).toBe('tracks.1.group: group "g_talk" already has a program track');
  });

  it("checks group ids, angle ids and crops", () => {
    const twice = { ...group, angles: [group.angles[0], group.angles[0]] };
    expect(errorOf(multicam([], [twice]))).toBe('groups.0.angles.1.id: duplicate angle id "ana"');
    expect(errorOf(multicam([program([])], [{ ...group, id: "t_p" }]))).toMatch(/groups\.0\.id: duplicate id "t_p"/);
    const cropped = { ...group, angles: [{ ...group.angles[0], crop: { left: 0.6, right: 0.4 } }] };
    expect(errorOf(multicam([], [cropped]))).toBe("groups.0.angles.0.crop.right: left + right must leave some width");
    expect(errorOf(multicam([], [{ ...group, angles: [] }]))).toMatch(/groups\.0\.angles/);
  });

  it("keeps shots off video tracks and media off program tracks; `shot` is not an adapter type", () => {
    const onVideo = errorOf(multicam([{ id: "t_v", kind: "video", clips: [shot("c_1", 0, 0, 1, "solo", ["ana"])] }]));
    expect(onVideo).toMatch(/tracks\.0\.clips\.0/);
    const media = { id: "c_m", type: "media", asset: "assets/a.mp4", start: 0, in: 0, out: 1 };
    expect(errorOf(multicam([{ ...program([]), clips: [media] }]))).toMatch(/tracks\.0\.clips\.0/);
    const adapter = { id: "c_x", type: "shot", start: 0, duration: 1 };
    expect(errorOf(multicam([{ id: "t_v", kind: "video", clips: [adapter] }]))).toMatch(/tracks\.0\.clips\.0/);
  });

  it("refuses shot fields that do not apply: audio, transform, speed", () => {
    const loud = { ...shot("c_1", 0, 0, 1, "solo", ["ana"]), audio: { gain: -6 } };
    expect(errorOf(multicam([program([loud as ShotClip])]))).toMatch(/Unrecognized key.*audio/);
  });

  it("lets subtitles follow video or audio tracks, not a program track", () => {
    expect(errorOf(multicam([program([]), { id: "t_s", kind: "subtitles", follows: "t_p" }]))).toBe(
      'tracks.1.follows: must name a video or audio track, got "t_p"',
    );
  });
});

describe("shot layout (composite)", () => {
  const landscape = { width: 1920, height: 1080 };
  const portrait = { width: 1080, height: 1920 };
  const sizes = (asset: string) => (asset === "assets/eva.mp4" ? { width: 1280, height: 720 } : { width: 1920, height: 1080 });

  it("solo: the angle covers the frame, cut to its aspect", () => {
    expect(shotTiles("solo", 1, landscape)).toEqual([{ left: 0, top: 0, width: 1920, height: 1080 }]);
    expect(shotLayers(shot("c", 0, 0, 1, "solo", ["ana"]), group, landscape, sizes)).toEqual([
      { angle: "ana", asset: "assets/ana.mp4", tile: { left: 0, top: 0, width: 1920, height: 1080 }, crop: { left: 0, top: 0, width: 1920, height: 1080 }, backdrop: false },
    ]);
    // 9:16: the centre 608x1080 of the 16:9 picture.
    expect(shotLayers(shot("c", 0, 0, 1, "solo", ["ana"]), group, portrait, sizes)).toEqual([
      { angle: "ana", asset: "assets/ana.mp4", tile: { left: 0, top: 0, width: 1080, height: 1920 }, crop: { left: 656, top: 0, width: 608, height: 1080 }, backdrop: false },
    ]);
  });

  it("solo honours the angle's own crop before filling", () => {
    // Eva keeps the middle half (640x720 of 1280x720); filling 16:9 takes its centre 640x360.
    expect(shotLayers(shot("c", 0, 0, 1, "solo", ["eva"]), group, landscape, sizes)[0]!.crop).toEqual({ left: 320, top: 180, width: 640, height: 360 });
  });

  it("two-up: side by side at 16:9, stacked at 9:16", () => {
    expect(shotLayers(shot("c", 0, 0, 1, "two-up", ["ben", "ana"]), group, landscape, sizes)).toEqual([
      { angle: "ben", asset: "assets/ben.mp4", tile: { left: 0, top: 0, width: 960, height: 1080 }, crop: { left: 480, top: 0, width: 960, height: 1080 }, backdrop: false },
      { angle: "ana", asset: "assets/ana.mp4", tile: { left: 960, top: 0, width: 960, height: 1080 }, crop: { left: 480, top: 0, width: 960, height: 1080 }, backdrop: false },
    ]);
    expect(shotTiles("two-up", 2, portrait)).toEqual([
      { left: 0, top: 0, width: 1080, height: 960 },
      { left: 0, top: 960, width: 1080, height: 960 },
    ]);
  });

  it("grid: 2x2 with the last row centred at 16:9, one column at 9:16", () => {
    expect(shotTiles("grid", 3, landscape)).toEqual([
      { left: 0, top: 0, width: 960, height: 540 },
      { left: 960, top: 0, width: 960, height: 540 },
      { left: 480, top: 540, width: 960, height: 540 },
    ]);
    expect(shotTiles("grid", 4, landscape)).toEqual([
      { left: 0, top: 0, width: 960, height: 540 },
      { left: 960, top: 0, width: 960, height: 540 },
      { left: 0, top: 540, width: 960, height: 540 },
      { left: 960, top: 540, width: 960, height: 540 },
    ]);
    expect(shotTiles("grid", 3, portrait)).toEqual([
      { left: 0, top: 0, width: 1080, height: 640 },
      { left: 0, top: 640, width: 1080, height: 640 },
      { left: 0, top: 1280, width: 1080, height: 640 },
    ]);
    const layers = shotLayers(shot("c", 0, 0, 1, "grid", ["ana", "ben", "eva"]), group, landscape, sizes);
    expect(layers.map((layer) => layer.crop)).toEqual([
      { left: 0, top: 0, width: 1920, height: 1080 },
      { left: 0, top: 0, width: 1920, height: 1080 },
      // Eva's cropped 640x720 picture filled into a 16:9 tile.
      { left: 320, top: 180, width: 640, height: 360 },
    ]);
  });

  it("tiles split odd sizes without gaps", () => {
    const tiles = shotTiles("grid", 3, { width: 1001, height: 563 });
    expect(tiles[0]!.width + tiles[1]!.width).toBe(1001);
    expect(tiles[0]!.height + tiles[2]!.height).toBe(563);
  });
});

describe("shot sound (composite)", () => {
  it("plays every angle under every shot, on its own clock, with its gain", () => {
    expect(shotSound(shot("c_1", 10, 1, 4, "solo", ["ana"]), group)).toEqual([
      { id: "c_1/ana", type: "media", asset: "assets/ana.mp4", start: 10, in: 1, out: 4 },
      // Ben's file starts at group second 1.5: half a second later on the timeline.
      { id: "c_1/ben", type: "media", asset: "assets/ben.mp4", start: 10.5, in: 0, out: 2.5, audio: { gain: -3 } },
      { id: "c_1/eva", type: "media", asset: "assets/eva.mp4", start: 10, in: 0.75, out: 3.75 },
    ]);
    // Nothing of Ben before group second 1.5.
    expect(shotSound(shot("c_0", 0, 0, 1, "solo", ["ana"]), group).map((clip) => clip.id)).toEqual(["c_0/ana", "c_0/eva"]);
  });

  it("gives a program track one audio track per angle, and a timeline its program tracks as sound", () => {
    const track = program([shot("c_1", 0, 2, 4, "solo", ["ana"]), shot("c_2", 2, 6, 8, "solo", ["ben"])]);
    const sound = programSound(track, group);
    expect(sound.map((t) => [t.id, t.kind, t.name, t.clips.map((clip) => clip.id)])).toEqual([
      ["t_p/ana", "audio", "Ana", ["c_1/ana", "c_2/ana"]],
      ["t_p/ben", "audio", "Ben", ["c_1/ben", "c_2/ben"]],
      ["t_p/eva", "audio", "Eva", ["c_1/eva", "c_2/eva"]],
    ]);
    const timeline = { ...createTimeline("main"), tracks: [{ id: "t_v", kind: "video" as const, clips: [] }, track], groups: [group] };
    expect(withProgramSound(timeline).tracks.map((t) => t.id)).toEqual(["t_v", "t_p/ana", "t_p/ben", "t_p/eva"]);
  });
});

describe("flattening nested multicam timelines", () => {
  const podcast: Timeline = {
    ...createTimeline("podcast"),
    tracks: [program([shot("c_a", 0, 0, 3, "solo", ["ana"]), shot("c_b", 3, 3, 6, "two-up", ["ana", "ben"])])],
    groups: [group],
  };
  const resolve = (source: string) => (source === "timelines/podcast.json" ? podcast : null);

  it("puts a nested program track above a video host track, with a renamed copy of its group", () => {
    const main: Timeline = {
      ...createTimeline("main"),
      tracks: [{ id: "v1", kind: "video", clips: [{ id: "c_n", type: "timeline", source: "timelines/podcast.json", start: 10, in: 2, audio: { gain: -6 } }] }],
    };
    const flat = flattenTimeline(main, resolve);
    expect(flat.tracks.map((track) => [track.id, track.kind])).toEqual([
      ["v1", "video"],
      ["v1/p1", "program"],
    ]);
    const nested = flat.tracks[1] as ProgramTrack;
    expect(nested.group).toBe("c_n/g_talk");
    // Podcast seconds 2 to 6 from timeline second 10.
    expect(nested.clips).toEqual([
      { ...shot("c_n/c_a", 10, 2, 3, "solo", ["ana"]) },
      { ...shot("c_n/c_b", 11, 3, 6, "two-up", ["ana", "ben"]) },
    ]);
    // The nested clip's gain goes onto every angle of the copy.
    expect(flat.groups?.map((g) => [g.id, g.angles.map((angle) => angle.audio?.gain ?? 0)])).toEqual([["c_n/g_talk", [-6, -9, -6]]]);
    expect(parseTimeline(flat).ok).toBe(true);
  });

  it("gives each nested clip on one video host track its own program track and group", () => {
    const main: Timeline = {
      ...createTimeline("main"),
      tracks: [
        {
          id: "v",
          kind: "video",
          clips: [
            { id: "n1", type: "timeline", source: "timelines/podcast.json", start: 0, duration: 3 },
            { id: "n2", type: "timeline", source: "timelines/podcast.json", start: 10, duration: 3 },
          ],
        },
      ],
    };
    const flat = flattenTimeline(main, resolve);
    const programs = flat.tracks.filter((track): track is ProgramTrack => track.kind === "program");
    expect(programs.map((track) => [track.id, track.group, track.clips.map((clip) => [clip.id, clip.start])])).toEqual([
      ["v/p1", "n1/g_talk", [["n1/c_a", 0]]],
      ["v/p2", "n2/g_talk", [["n2/c_a", 10]]],
    ]);
    expect(flat.groups?.map((g) => g.id)).toEqual(["n1/g_talk", "n2/g_talk"]);
    expect(parseTimeline(flat).ok).toBe(true);
  });

  it("turns a nested program track on an audio host track into its angles' sound", () => {
    const main: Timeline = {
      ...createTimeline("main"),
      tracks: [{ id: "a1", kind: "audio", clips: [{ id: "c_n", type: "timeline", source: "timelines/podcast.json", start: 0, duration: 3 }] }],
    };
    const flat = flattenTimeline(main, resolve);
    expect(flat.tracks.map((track) => [track.id, track.kind])).toEqual([
      ["a1", "audio"],
      ["a1/a1", "audio"],
      ["a1/a2", "audio"],
    ]);
    expect((flat.tracks[0] as { clips: { id: string }[] }).clips.map((clip) => clip.id)).toEqual(["c_n/c_a/ana"]);
    expect(flat.groups).toBeUndefined();
  });

  it("marks the sound of a nested program track on an audio host track, at any depth, and only that", () => {
    const hosted = (id: string, source: string): Timeline => ({
      ...createTimeline(id),
      tracks: [
        { id: "a1", kind: "audio", clips: [{ id: "c_n", type: "timeline", source, start: 0, duration: 3 }] },
        { id: "a2", kind: "audio", clips: [{ id: "c_own", type: "media", asset: "assets/music.wav", start: 0, in: 0, out: 3 }] },
      ],
    });
    const wrapper: Timeline = { ...createTimeline("wrapper"), tracks: [{ id: "v1", kind: "video", clips: [{ id: "c_w", type: "timeline", source: "timelines/mid.json", start: 1 }] }] };
    const files: Record<string, Timeline> = { "timelines/podcast.json": podcast, "timelines/mid.json": hosted("mid", "timelines/podcast.json") };
    const marked = (timeline: Timeline) =>
      flattenTimeline(timeline, (source) => files[source] ?? null).tracks.flatMap((track) =>
        track.kind === "subtitles" ? [] : track.clips.map((clip) => [clip.id, isProgramSound(clip)]),
      );
    expect(marked(hosted("main", "timelines/podcast.json"))).toEqual([
      ["c_n/c_a/ana", true],
      ["c_n/c_a/ben", true],
      ["c_n/c_a/eva", true],
      ["c_own", false],
    ]);
    // Flattened again under a video host: the mark stays on its sound.
    expect(marked(wrapper).filter(([, mark]) => mark).map(([id]) => id)).toEqual(["c_w/c_n/c_a/ana", "c_w/c_n/c_a/ben", "c_w/c_n/c_a/eva"]);
    expect(marked(wrapper).filter(([, mark]) => !mark).map(([id]) => id)).toEqual(["c_w/c_own"]);
    // The mark is no field: the flattened timeline still parses, and JSON drops it.
    const flat = flattenTimeline(hosted("main", "timelines/podcast.json"), (source) => files[source] ?? null);
    expect(parseTimeline(flat).ok).toBe(true);
    expect(JSON.stringify(flat)).not.toContain("programSound");
  });

  it("leaves root program tracks and their groups as they are", () => {
    expect(flattenTimeline(podcast, () => null)).toEqual(podcast);
  });
});

describe("program tracks under a moved nested clip", () => {
  const podcast: Timeline = { ...createTimeline("podcast"), tracks: [program([shot("c_a", 0, 0, 3, "solo", ["ana"])])], groups: [group] };
  const wrapper: Timeline = {
    ...createTimeline("wrapper"),
    tracks: [{ id: "v1", kind: "video", clips: [{ id: "c_in", type: "timeline", source: "timelines/podcast.json", start: 0 }] }],
  };
  const files: Record<string, Timeline> = { "timelines/podcast.json": podcast, "timelines/wrapper.json": wrapper };
  const resolve = (source: string) => files[source] ?? null;
  const main = (tracks: Timeline["tracks"]): Timeline => ({ ...createTimeline("main"), tracks });

  it("names the flattened group of a program track whose nested clip has a transform, at any depth", () => {
    const moved = main([
      { id: "v1", kind: "video", clips: [{ id: "n1", type: "timeline", source: "timelines/podcast.json", start: 0, transform: { scale: 0.5 } }] },
      { id: "v2", kind: "video", clips: [{ id: "n2", type: "timeline", source: "timelines/wrapper.json", start: 0, transform: { opacity: 0.5 } }] },
      { id: "v3", kind: "video", clips: [{ id: "n3", type: "timeline", source: "timelines/podcast.json", start: 0 }] },
    ]);
    expect([...movedProgramGroups(moved, resolve)]).toEqual(["n1/g_talk", "n2/c_in/g_talk"]);
    // The same ids as flattening gives the groups.
    expect(flattenTimeline(moved, resolve).groups?.map((g) => g.id)).toEqual(["n1/g_talk", "n2/c_in/g_talk", "n3/g_talk"]);
  });

  it("ignores identity transforms, audio host tracks and root program tracks", () => {
    const still = main([
      { id: "v1", kind: "video", clips: [{ id: "n1", type: "timeline", source: "timelines/podcast.json", start: 0, transform: { x: 0, scale: 1 } }] },
      { id: "a1", kind: "audio", clips: [{ id: "n2", type: "timeline", source: "timelines/podcast.json", start: 0, transform: { scale: 0.5 } }] },
    ]);
    expect(movedProgramGroups(still, resolve).size).toBe(0);
    expect(movedProgramGroups(podcast, resolve).size).toBe(0);
  });
});

describe("separate mics", () => {
  // Wide camera hears nothing (`mic: null`); Ana has her own recorder file; Ben and Eva share the room mic; Cleo keeps her file's sound.
  const withMics: MulticamGroup = {
    id: "g_talk",
    angles: [
      { id: "wide", name: "Wide", asset: "assets/wide.mp4", offset: 0, mic: null },
      { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0, mic: "ana-lav" },
      { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 0.5, mic: "room" },
      { id: "eva", name: "Eva", asset: "assets/eva.mp4", offset: 0.25, mic: "room" },
      { id: "cleo", name: "Cleo", asset: "assets/cleo.mp4", offset: 1, audio: { gain: -2 } },
    ],
    mics: [
      { id: "ana-lav", name: "Ana lav", asset: "assets/ana.wav", offset: 2, audio: { gain: 3 } },
      { id: "room", name: "Room", asset: "assets/room.wav", offset: 0.1 },
    ],
  };

  it("keeps groups without mics valid and plays an angle's own file only without `mic`", () => {
    expect(errorOf(multicam([program([])], [withMics]))).toBeNull();
    expect(shotSound(shot("c_1", 0, 0, 4, "solo", ["ana"]), group).map((clip) => clip.asset)).toEqual(["assets/ana.mp4", "assets/ben.mp4", "assets/eva.mp4"]);
  });

  it("plays each mic once, however many angles use it, and nothing for angles with a mic or no mic", () => {
    const clips = shotSound(shot("c_1", 10, 1, 4, "solo", ["ana"]), withMics);
    expect(clips).toEqual([
      { id: "c_1/cleo", type: "media", asset: "assets/cleo.mp4", start: 10, in: 0, out: 3, audio: { gain: -2 } },
      // Ana's recorder starts at group second 2: its time 0 plays 1 s into the shot.
      { id: "c_1/ana-lav", type: "media", asset: "assets/ana.wav", start: 11, in: 0, out: 2, audio: { gain: 3 } },
      { id: "c_1/room", type: "media", asset: "assets/room.wav", start: 10, in: 0.9, out: 3.9 },
    ]);
    const sound = programSound(program([shot("c_1", 0, 0, 4, "solo", ["ana"])]), withMics);
    expect(sound.map((t) => [t.id, t.name])).toEqual([
      ["t_p/cleo", "Cleo"],
      ["t_p/ana-lav", "Ana lav"],
      ["t_p/room", "Room"],
    ]);
  });

  it("refuses unknown, reserved and clashing mic ids, and levels set on an angle that takes its sound from a mic", () => {
    const bad = (change: Partial<MulticamGroup>) => errorOf(multicam([], [{ ...withMics, ...change }]));
    expect(bad({ angles: [{ ...withMics.angles[1]!, mic: "gone" }] })).toBe(
      'groups.0.angles.0.mic: angle "ana" names mic "gone", which the group does not have (mics: ana-lav, room)',
    );
    expect(bad({ mics: [{ ...withMics.mics![0]!, id: "camera" }] })).toMatch(/groups\.0\.mics\.0\.id: mic id "camera" is reserved/);
    expect(bad({ mics: [{ ...withMics.mics![0]!, id: "wide" }] })).toMatch(/groups\.0\.mics\.0\.id: mic id "wide" is already an angle or mic id/);
    expect(bad({ mics: [withMics.mics![0]!, withMics.mics![0]!] })).toMatch(/groups\.0\.mics\.1\.id: mic id "ana-lav" is already/);
    expect(bad({ angles: [{ ...withMics.angles[1]!, audio: { gain: 1 } }] })).toMatch(
      /groups\.0\.angles\.0\.audio: angle "ana" takes its sound from mic "ana-lav": set gain and mute on the mic/,
    );
    expect(bad({ angles: [{ ...withMics.angles[0]!, audio: { muted: true } }] })).toMatch(/takes its sound from no one/);
  });

  it("puts a nested clip's gain on the mics and the angles playing their own file, not on angles with a mic", () => {
    const podcast: Timeline = { ...createTimeline("podcast"), tracks: [program([shot("c_a", 0, 0, 3, "solo", ["ana"])])], groups: [withMics] };
    const main: Timeline = {
      ...createTimeline("main"),
      tracks: [{ id: "v1", kind: "video", clips: [{ id: "c_n", type: "timeline", source: "timelines/podcast.json", start: 0, audio: { gain: -6 } }] }],
    };
    const flat = flattenTimeline(main, (source) => (source === "timelines/podcast.json" ? podcast : null));
    const copy = flat.groups![0]!;
    expect(copy.angles.map((angle) => angle.audio ?? null)).toEqual([null, null, null, null, { gain: -8 }]);
    expect(copy.mics!.map((mic) => mic.audio?.gain)).toEqual([-3, -6]);
    expect(parseTimeline(flat).ok).toBe(true);
  });
});
