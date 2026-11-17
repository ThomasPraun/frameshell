import { AUDIO_INSPECT_MAX } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import {
  AUDITION_MAX,
  candidateFiles,
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
    expect(soundFiles(["b.mp3", "a.png", "b.mp3", "c.flac"])).toEqual(["b.mp3", "c.flac"]);
    expect(soundFiles(Array.from({ length: 40 }, (_, i) => `s${i}.wav`))).toHaveLength(AUDITION_MAX);
  });

  it("takes a folder's own sounds, not its subfolders'", () => {
    const folder = {
      kind: "dir" as const,
      name: "sound",
      path: "assets/sound",
      children: [
        { kind: "file" as const, name: "whoosh.wav", path: "assets/sound/whoosh.wav" },
        { kind: "file" as const, name: "notes.md", path: "assets/sound/notes.md" },
        { kind: "file" as const, name: "click.wav", path: "assets/sound/click.wav" },
        { kind: "dir" as const, name: "old", path: "assets/sound/old", children: [{ kind: "file" as const, name: "a.wav", path: "assets/sound/old/a.wav" }] },
      ],
    };
    expect(soundFilesIn(folder)).toEqual(["assets/sound/click.wav", "assets/sound/whoosh.wav"]);
  });

  it("finds the music candidates by rank from one of their tracks", () => {
    const track = (kind: string, name: string | null, asset: string | null) => ({ kind, name, clips: asset ? [{ asset }] : [] });
    const rows = [
      track("video", "Music 9", "assets/a.mp4"),
      track("audio", "Music 2", "assets/music/b.mp3"),
      track("audio", "Voice", "assets/voice.wav"),
      track("audio", "Music 1", "assets/music/a.mp3"),
      track("audio", "Music 3", null),
    ];
    expect(candidateFiles(rows, rows[1]!)).toEqual(["assets/music/a.mp3", "assets/music/b.mp3"]);
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
