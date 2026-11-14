import { describe, expect, it } from "vitest";
import type { Clip, SfxKind, Timeline, Track } from "@frameshell/schema";
import type { EnergyProfile } from "../src/media/energy.js";
import { fileSound, findClicks, heardClips, soundWarnings, timelineSound } from "../src/review/sound.js";

// The sound review list of `review` (#457): roles, voice over bed, repeats, cut-off tails, the ending and clicks, on
// envelopes made up per test (one dBFS value per 10 ms).

const FPS = 30;

/** A media clip of `asset` at `start` playing source seconds `in` to `out`. */
function clip(id: string, asset: string, start: number, length: number, extra: Partial<Clip> = {}): Clip {
  return { id, type: "media", asset, start, in: 0, out: length, ...extra } as Clip;
}

function track(id: string, clips: Clip[], extra: Partial<Track> = {}): Track {
  return { id, kind: "audio", clips, ...extra } as Track;
}

function timeline(tracks: Track[]): Timeline {
  return { id: "main", tracks } as unknown as Timeline;
}

/** An envelope of `seconds` at `db`, or per-hop levels from `level(i)`. */
function profile(seconds: number, db: number | ((i: number) => number), threshold = -70): EnergyProfile {
  const values = Float32Array.from({ length: Math.round(seconds * 100) }, (_, i) => (typeof db === "number" ? db : db(i)));
  return { db: values, threshold };
}

const none = { transcribed: new Set<string>(), kinds: new Map<string, SfxKind>() };

describe("review sound: roles", () => {
  it("sorts clips into voice, music, effects and other, and leaves out muted clips and footage that is not a voice", () => {
    const tl = timeline([
      track("t_vo", [clip("c_vo", "assets/vo.wav", 0, 2)], { name: "Voiceover" }),
      track("t_m", [clip("c_m", "assets/song.wav", 0, 4)], { name: "Music" }),
      track("t_take", [clip("c_take", "assets/sound/music-lofi-abcdef12.wav", 0, 4)]),
      track("t_fx", [clip("c_fx", "assets/sound/pop-12345678.wav", 1, 0.3), clip("c_hand", "assets/boom.wav", 2, 0.3)], { name: "SFX" }),
      track("t_room", [clip("c_room", "assets/room.wav", 0, 4), clip("c_mute", "assets/room.wav", 4, 1, { audio: { muted: true } } as Partial<Clip>)]),
      track("t_cam", [clip("c_cam", "assets/broll.mp4", 0, 4), clip("c_talk", "assets/talk.mp4", 4, 2)], { kind: "video" }),
    ]);
    const heard = heardClips(tl, FPS, { transcribed: new Set(["assets/talk.mp4"]), kinds: new Map([["assets/sound/pop-12345678.wav", "pop"]]) });
    expect(Object.fromEntries(heard.map((item) => [item.id, item.role]))).toEqual({
      c_vo: "voice",
      c_m: "music",
      c_take: "music",
      c_fx: "sfx",
      c_hand: "sfx",
      c_room: "other",
      c_talk: "voice",
    });
    expect(heard.find((item) => item.id === "c_fx")!.kind).toBe("pop");
  });

  it("a track a duck names in `under` is a voice, and the ducked clip is music", () => {
    const duck = { under: ["t_a"], depth: 12, attackMs: 80, releaseMs: 300, threshold: -40, gap: 0.3 };
    const tl = timeline([track("t_a", [clip("c_a", "assets/a.wav", 0, 2)]), track("t_b", [clip("c_b", "assets/b.wav", 0, 2, { audio: { duck } } as Partial<Clip>)])]);
    expect(heardClips(tl, FPS, none).map((item) => item.role)).toEqual(["voice", "music"]);
  });
});

describe("review sound: voice over bed", () => {
  const tl = (musicGain: number) =>
    timeline([
      track("t_vo", [clip("c_vo", "assets/vo.wav", 0, 3)], { name: "Voiceover" }),
      track("t_m", [clip("c_m", "assets/song.wav", 0, 3, { audio: { gain: musicGain } } as Partial<Clip>)], { name: "Music" }),
    ]);
  const profiles = new Map([
    // Speech for the first 2 s, then quiet.
    ["assets/vo.wav", profile(3, (i) => (i < 200 ? -20 : -90), -60)],
    ["assets/song.wav", profile(3, -32)],
  ]);

  it("measures the margin per 0.5 s window where the voice speaks", () => {
    const sound = timelineSound({ clips: heardClips(tl(0), FPS, none), profiles, range: { from: 0, to: 3 }, filmEnd: 3 })!;
    expect(sound.voice).toMatchObject({ window: 0.5, windows: 4, withBed: 4, minMargin: 12, medianMargin: 12, low: [] });
    expect(soundWarnings(sound).filter((warning) => warning.check === "voice-bed")).toEqual([]);
  });

  it("lists the stretches where the bed comes within 6 dB of the voice, merged, and warns", () => {
    const sound = timelineSound({ clips: heardClips(tl(8), FPS, none), profiles, range: { from: 0, to: 3 }, filmEnd: 3 })!;
    expect(sound.voice!.minMargin).toBe(4);
    expect(sound.voice!.low).toEqual([{ from: 0, to: 2, margin: 4 }]);
    const warnings = soundWarnings(sound).filter((warning) => warning.check === "voice-bed");
    expect(warnings).toEqual([expect.objectContaining({ from: 0, to: 2, message: expect.stringContaining("within 4 dB of the voice") })]);
  });

  it("a voice with no bed under it has no margin", () => {
    const solo = timeline([track("t_vo", [clip("c_vo", "assets/vo.wav", 0, 3)], { name: "Voiceover" })]);
    const sound = timelineSound({ clips: heardClips(solo, FPS, none), profiles, range: { from: 0, to: 3 }, filmEnd: 3 })!;
    expect(sound.voice).toMatchObject({ windows: 4, withBed: 0, minMargin: null, low: [] });
  });
});

describe("review sound: repeated effects", () => {
  const whoosh = "assets/sound/whoosh-aaaaaaaa.wav";
  const other = "assets/sound/pop-bbbbbbbb.wav";
  const tick = "assets/sound/tick-cccccccc.wav";
  const kinds = new Map<string, SfxKind>([
    [whoosh, "whoosh"],
    [other, "pop"],
    [tick, "tick"],
  ]);
  const profiles = new Map([whoosh, other, tick].map((file) => [file, profile(0.3, (i) => -10 - i * 2)] as const));

  it("lists effect files heard more than once and warns over twice; ticks and clicks are left out", () => {
    const clips = [clip("a", whoosh, 1, 0.3), clip("b", other, 2, 0.3), clip("c", whoosh, 3, 0.3), clip("d", whoosh, 5, 0.3), clip("e", tick, 6, 0.3), clip("f", tick, 7, 0.3), clip("g", tick, 8, 0.3)];
    const sound = timelineSound({ clips: heardClips(timeline([track("t_fx", clips)]), FPS, { ...none, kinds }), profiles, range: { from: 0, to: 10 }, filmEnd: 10 })!;
    expect(sound.repeats).toEqual([{ file: whoosh, plays: 3, at: [1, 3, 5] }]);
    expect(sound.machineGun).toEqual([]);
    expect(soundWarnings(sound).map((warning) => warning.check)).toEqual(["sfx-repeat"]);
  });

  it("four plays of one file in a row are a machine gun, ticks included; another effect between breaks the run", () => {
    const clips = [0, 1, 2, 3].map((i) => clip(`t${i}`, tick, i, 0.3));
    const sound = timelineSound({ clips: heardClips(timeline([track("t_fx", clips)]), FPS, { ...none, kinds }), profiles, range: { from: 0, to: 5 }, filmEnd: 5 })!;
    expect(sound.machineGun).toEqual([{ file: tick, plays: 4, from: 0, to: 3 }]);
    expect(sound.repeats).toEqual([]);
    const broken = [clip("a", tick, 0, 0.3), clip("b", tick, 1, 0.3), clip("x", other, 2, 0.3), clip("c", tick, 3, 0.3), clip("d", tick, 4, 0.3)];
    const after = timelineSound({ clips: heardClips(timeline([track("t_fx", broken)]), FPS, { ...none, kinds }), profiles, range: { from: 0, to: 5 }, filmEnd: 5 })!;
    expect(after.machineGun).toEqual([]);
  });
});

describe("review sound: cut-off tails and the ending", () => {
  // A sustained sound: full level for 4 s.
  const profiles = new Map([["assets/pad.wav", profile(10, -12)]]);

  it("a clip that ends inside the film while still loud is chopped; a fade out or the same sound going on is not", () => {
    const run = (clips: Clip[]) => timelineSound({ clips: heardClips(timeline([track("t_a", clips)]), FPS, none), profiles, range: { from: 0, to: 6 }, filmEnd: 6 })!;
    const cut = run([clip("c_a", "assets/pad.wav", 0, 2)]);
    expect(cut.chopped).toEqual([{ clip: "c_a", track: "t_a", role: "other", at: 2, level: 0 }]);
    // The warning spans the last 10 ms, inside the clip, where a waiver naming the clip finds it.
    expect(soundWarnings(cut).map(({ check, from, to }) => ({ check, from, to }))).toEqual([{ check: "chopped", from: 1.99, to: 2 }]);
    expect(run([clip("c_a", "assets/pad.wav", 0, 2, { fadeOut: 0.5 } as Partial<Clip>)]).chopped).toEqual([]);
    // A 5 ms de-click ramp still cuts the tail.
    expect(run([clip("c_a", "assets/pad.wav", 0, 2, { audio: { fadeOutMs: 5 } } as Partial<Clip>)]).chopped).toHaveLength(1);
    // c_b picks the sound up where c_a stops: only c_b's own end is a cut.
    expect(run([clip("c_a", "assets/pad.wav", 0, 2), clip("c_b", "assets/pad.wav", 2, 2, { in: 2, out: 4 } as Partial<Clip>)]).chopped!.map((entry) => entry.clip)).toEqual(["c_b"]);
  });

  it("the music still loud on the last frame is an ending warning; music that ended before has no level", () => {
    const music = (length: number, extra: Partial<Clip> = {}) => timeline([track("t_m", [clip("c_m", "assets/pad.wav", 0, length, extra)], { name: "Music" })]);
    const cut = timelineSound({ clips: heardClips(music(4), FPS, none), profiles, range: { from: 0, to: 4 }, filmEnd: 4 })!;
    expect(cut.ending).toEqual({ measure: "music", level: 0, musicEndsAt: 4, loudestAt: null, loudestShare: null });
    expect(soundWarnings(cut).map((warning) => warning.check)).toEqual(["ending"]);
    const faded = timelineSound({ clips: heardClips(music(4, { fadeOut: 1 } as Partial<Clip>), FPS, none), profiles, range: { from: 0, to: 4 }, filmEnd: 4 })!;
    expect(faded.ending!.level!).toBeLessThan(-35);
    expect(soundWarnings(faded)).toEqual([]);
    const early = timelineSound({ clips: heardClips(music(3), FPS, none), profiles, range: { from: 0, to: 4 }, filmEnd: 4 })!;
    expect(early.ending).toMatchObject({ level: null, musicEndsAt: 3 });
    // The range stops short of the end: no ending.
    expect(timelineSound({ clips: heardClips(music(4), FPS, none), profiles, range: { from: 0, to: 2 }, filmEnd: 4 })!.ending).toBeNull();
  });
});

describe("review sound: a file", () => {
  it("reports the level of the last 50 ms and where the loudest 400 ms are, and warns on a loud end and a late peak", () => {
    // 10 s at -30 dBFS with a -6 dBFS second at 9 s to the end.
    const envelope = Float32Array.from({ length: 1000 }, (_, i) => (i >= 900 ? -6 : -30));
    const sound = fileSound({ envelope, clicks: [], range: { from: 0, to: 10 }, filmEnd: 10 });
    // The first 400 ms within 1 dB of the loudest start at 8.92 s: 32 of their 40 steps are in the loud second.
    expect(sound.ending).toEqual({ measure: "mix", level: -6, musicEndsAt: null, loudestAt: 8.92, loudestShare: 0.912 });
    expect(soundWarnings(sound).map((warning) => warning.message)).toEqual([expect.stringContaining("above -45 dBFS"), expect.stringContaining("peaks at its end")]);
    const resolved = Float32Array.from({ length: 1000 }, (_, i) => (i >= 300 && i < 340 ? -6 : i >= 990 ? -80 : -30));
    expect(soundWarnings(fileSound({ envelope: resolved, clicks: [], range: { from: 0, to: 10 }, filmEnd: 10 }))).toEqual([]);
  });

  it("a steady sound that wobbles under 1 dB peaks where it starts, not at its end", () => {
    const envelope = Float32Array.from({ length: 300 }, (_, i) => (i >= 250 ? -20.9 : -21.2));
    const sound = fileSound({ envelope, clicks: [], range: { from: 0, to: 3 }, filmEnd: 3 });
    expect(sound.ending).toMatchObject({ loudestAt: 0, level: -20.9 });
    expect(soundWarnings(sound).map((warning) => warning.message)).toEqual([expect.stringContaining("above -45 dBFS")]);
  });

  it("lists clicks inside the range as one craft warning", () => {
    const sound = fileSound({ envelope: new Float32Array(100), clicks: [0.25, 0.6, 3], range: { from: 0, to: 1 }, filmEnd: 1 });
    expect(sound.clicks).toEqual({ count: 2, at: [0.25, 0.6] });
    expect(soundWarnings(sound).filter((warning) => warning.check === "click")).toEqual([expect.objectContaining({ from: 0.25, to: 0.6, message: expect.stringContaining("2 clicks") })]);
  });
});

describe("review sound: clicks", () => {
  const RATE = 48_000;

  it("finds a lone step in an otherwise quiet band, once", () => {
    const samples = new Int16Array(RATE);
    samples[24_000] = 12_000;
    samples[24_001] = -8_000;
    expect(findClicks(samples, RATE)).toEqual([0.5]);
  });

  it("a ringing burst (a hi-hat) spreads its energy over tens of ms and is no click; nor is steady noise", () => {
    const hat = new Int16Array(RATE);
    let seed = 7;
    const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    for (let i = 0; i < 0.04 * RATE; i++) hat[10_000 + i] = Math.round(8000 * noise() * Math.exp(-i / (0.01 * RATE)));
    expect(findClicks(hat, RATE)).toEqual([]);
    const hiss = Int16Array.from({ length: RATE }, () => Math.round(2000 * noise()));
    expect(findClicks(hiss, RATE)).toEqual([]);
  });

  it("a sound already playing at the first sample is no click: the band filter starts from rest", () => {
    const samples = new Int16Array(RATE);
    samples[1] = 12_000;
    expect(findClicks(samples, RATE)).toEqual([]);
  });

  it("ignores steps under -60 dBFS", () => {
    const samples = new Int16Array(RATE);
    samples[1000] = 20;
    expect(findClicks(samples, RATE)).toEqual([]);
  });
});
