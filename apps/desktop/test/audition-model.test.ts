import { AUDIO_INSPECT_MAX } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import {
  AUDITION_MAX,
  candidateFiles,
  candidateTracks,
  mixStart,
  soloOf,
  withSolo,
  dbText,
  isSoundPath,
  matchGains,
  matchTarget,
  soundFiles,
  soundFilesIn,
  spectrogramColour,
} from "../src/renderer/src/audition/model.js";

describe("match loudness", () => {
  it("brings every sound down to the quietest one", () => {
    const lufs = [-14, -20.04, -9.5];
    expect(matchTarget(lufs)).toBe(-20.04);
    expect(matchGains(lufs, true)).toEqual([-6, 0, -10.5]);
  });

  it("plays everything as recorded when off, and leaves silence alone", () => {
    expect(matchGains([-14, -20], false)).toEqual([0, 0]);
    expect(matchGains([null, -18, -12], true)).toEqual([0, 0, -6]);
    expect(matchTarget([null, null])).toBeNull();
    expect(matchGains([null, null], true)).toEqual([0, 0]);
  });

  it("writes dB with one decimal and a sign above zero", () => {
    expect(dbText(-6)).toBe("-6.0");
    expect(dbText(0.5)).toBe("+0.5");
    expect(dbText(-0.01)).toBe("0.0");
  });
});

describe("which files", () => {
  it("keeps sound files once, in order, to the cap of audio.inspect", () => {
    expect(AUDITION_MAX).toBe(AUDIO_INSPECT_MAX);
    expect(isSoundPath("assets/sound/pop-1a2b.WAV")).toBe(true);
    expect(isSoundPath("assets/clip.mp4")).toBe(false);
    expect(isSoundPath("assets/wav")).toBe(false);
    expect(soundFiles(["b.mp3", "a.png", "b.mp3", "c.flac"])).toEqual([
      "b.mp3",
      "c.flac",
    ]);
    expect(
      soundFiles(Array.from({ length: 40 }, (_, i) => `s${i}.wav`)),
    ).toHaveLength(AUDITION_MAX);
  });

  it("takes a folder's own sounds, not its subfolders'", () => {
    const folder = {
      kind: "dir" as const,
      name: "sound",
      path: "assets/sound",
      children: [
        {
          kind: "file" as const,
          name: "whoosh.wav",
          path: "assets/sound/whoosh.wav",
        },
        {
          kind: "file" as const,
          name: "notes.md",
          path: "assets/sound/notes.md",
        },
        {
          kind: "file" as const,
          name: "click.wav",
          path: "assets/sound/click.wav",
        },
        {
          kind: "dir" as const,
          name: "old",
          path: "assets/sound/old",
          children: [
            {
              kind: "file" as const,
              name: "a.wav",
              path: "assets/sound/old/a.wav",
            },
          ],
        },
      ],
    };
    expect(soundFilesIn(folder)).toEqual([
      "assets/sound/click.wav",
      "assets/sound/whoosh.wav",
    ]);
  });

  it("finds the music candidates by rank from one of their tracks", () => {
    const track = (
      kind: string,
      name: string | null,
      asset: string | null,
    ) => ({
      id: `t_${name}`,
      kind,
      name,
      clips: asset ? [{ asset, start: 0, end: 10 }] : [],
    });
    const rows = [
      track("video", "Music 9", "assets/a.mp4"),
      track("audio", "Music 2", "assets/music/b.mp3"),
      track("audio", "Voice", "assets/voice.wav"),
      track("audio", "Music 1", "assets/music/a.mp3"),
      track("audio", "Music 3", null),
    ];
    expect(candidateFiles(rows, rows[1]!)).toEqual([
      "assets/music/a.mp3",
      "assets/music/b.mp3",
    ]);
    expect(candidateFiles(rows, rows[2]!)).toEqual([]);
    expect(candidateFiles(rows.slice(0, 3), rows[1]!)).toEqual([]);
  });
});

describe("spectrogram colours", () => {
  it("runs from dark at the floor to bright at -6 dB", () => {
    expect(spectrogramColour(-96, -96)).toEqual([8, 10, 24]);
    expect(spectrogramColour(-200, -96)).toEqual([8, 10, 24]);
    expect(spectrogramColour(-6, -96)).toEqual([255, 245, 200]);
    expect(spectrogramColour(3, -96)).toEqual([255, 245, 200]);
    const [r] = spectrogramColour(-40, -96);
    expect(r).toBeGreaterThan(8);
    expect(r).toBeLessThan(255);
  });
});

describe("in the mix (#803)", () => {
  const row = (
    id: string,
    name: string,
    asset: string,
    start: number,
    end: number,
  ) => ({ id, kind: "audio", name, clips: [{ asset, start, end }] });
  const rows = [
    row("t_v", "Voice", "assets/voice.wav", 0, 30),
    row("t_2", "Music 2", "assets/music/b.mp3", 4, 20),
    row("t_1", "Music 1", "assets/music/a.mp3", 2, 18),
  ];
  const tracks = candidateTracks(rows, rows[1]!);

  it("pairs each candidate with its track, by rank", () => {
    expect(tracks).toEqual([
      { file: "assets/music/a.mp3", track: "t_1" },
      { file: "assets/music/b.mp3", track: "t_2" },
    ]);
  });

  it("starts at the playhead inside the music, else where the music starts", () => {
    expect(mixStart(rows, tracks, 10)).toBe(10);
    expect(mixStart(rows, tracks, 0.5)).toBe(2);
    expect(mixStart(rows, tracks, 25)).toBe(2);
    expect(mixStart(rows, [], 10)).toBeNull();
  });

  it("solos one candidate in the preview's view, leaving every other track as stored", () => {
    const view = {
      tracks: [
        { id: "t_v", muted: true },
        { id: "t_1" },
        { id: "t_2", muted: true },
      ],
    };
    const solo = soloOf(tracks, "assets/music/b.mp3")!;
    expect(solo).toEqual({ keep: "t_2", mute: ["t_1"] });
    expect(withSolo(view, solo).tracks).toEqual([
      { id: "t_v", muted: true },
      { id: "t_1", muted: true },
      { id: "t_2" },
    ]);
    expect(withSolo(view, null)).toBe(view);
    expect(withSolo(view, soloOf(tracks, "assets/music/a.mp3"))).toBe(view);
    expect(soloOf(tracks, "assets/other.wav")).toBeNull();
  });
});
