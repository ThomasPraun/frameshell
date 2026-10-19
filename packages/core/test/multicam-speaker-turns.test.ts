import { describe, expect, it } from "vitest";
import type { MediaProbe } from "@frameshell/protocol";
import type { MulticamGroup, Transcript } from "@frameshell/schema";
import { ENERGY_HOP_S, type EnergyProfile, type TurnsSource, type TurnsTranscript, groupTurns, wordTurns } from "../src/index.js";

describe("wordTurns", () => {
  const words = [
    { start: 1, end: 1.4, speaker: "s1" },
    { start: 1.6, end: 2, speaker: "s1" },
    { start: 2.05, end: 2.3, speaker: undefined },
    { start: 2.4, end: 3, speaker: "s1" },
    { start: 3.2, end: 3.6, speaker: "s2" },
    { start: 3.8, end: 4.2, speaker: "s1" },
    { start: 6, end: 6.1, speaker: "s1" },
  ];

  it("joins a speaker's words across short pauses, breaks where someone else speaks, drops blips, on the group clock", () => {
    expect(wordTurns(words, "s1", 10)).toEqual([
      { start: 11, end: 13 },
      { start: 13.8, end: 14.2 },
    ]);
    expect(wordTurns(words, "s2", 0)).toEqual([{ start: 3.2, end: 3.6 }]);
  });
});

const probe = (duration: number, audio = true): MediaProbe =>
  ({ duration, format: "mov", video: null, audio: audio ? { codec: "aac", sampleRate: 48_000, channels: 1 } : null }) as unknown as MediaProbe;

/** A mic quiet at -60 dB with speech at -20 dB inside `loud` (seconds). */
function mic(seconds: number, loud: [number, number][]): EnergyProfile {
  const db = new Float32Array(Math.round(seconds / ENERGY_HOP_S)).fill(-60);
  for (const [from, to] of loud) for (let h = Math.round(from / ENERGY_HOP_S); h < Math.round(to / ENERGY_HOP_S); h++) db[h] = -20;
  return { db, threshold: -55 };
}

const mixed: Transcript = {
  schemaVersion: 1,
  asset: "assets/room.mp4",
  assetHash: `sha256:${"a".repeat(64)}`,
  provider: "whisper-cpp",
  model: "m",
  words: [
    { id: "w_000001", text: "hola", start: 1, end: 1.5, speaker: "s1" },
    { id: "w_000002", text: "qué", start: 2, end: 2.5, speaker: "s2" },
    { id: "w_000003", text: "tal", start: 2.5, end: 3, speaker: "s2" },
    { id: "w_000004", text: "bien", start: 4, end: 4.6, speaker: "s2" },
  ],
  // A human said "bien" is Ana's.
  edits: { w_000004: { speaker: "s1" } },
  speakers: [
    { id: "s1", name: "Ana" },
    { id: "s2", name: "Ben" },
  ],
};

function source(transcripts: Record<string, TurnsTranscript | null>): TurnsSource {
  return {
    probe: async (_root, asset) => probe(asset === "assets/zoe.mp4" ? 6 : 8),
    profile: async () => mic(6, [[0.5, 2]]),
    transcript: async (_root, asset) => transcripts[asset] ?? null,
  };
}

const group = (angles: MulticamGroup["angles"]): MulticamGroup => ({ id: "g_1", angles });

describe("groupTurns with a shared mic", () => {
  it("takes turns of angles sharing a file from their transcript speakers, corrections included, and the rest from mics", async () => {
    const found = { path: "transcripts/room.words.json", transcript: mixed, stale: false };
    const result = await groupTurns(
      source({ "assets/room.mp4": found }),
      "/p",
      group([
        { id: "ana", name: "Ana", asset: "assets/room.mp4", offset: 0, speaker: "s1" },
        { id: "ben", name: "Ben", asset: "assets/room.mp4", offset: 0, speaker: "s2" },
        { id: "zoe", name: "Zoe", asset: "assets/zoe.mp4", offset: 1 },
      ]),
    );
    expect(result.turns).toEqual([
      { angle: "ana", name: "Ana", start: 1, end: 1.5 },
      { angle: "zoe", name: "Zoe", start: 1.5, end: 3 },
      { angle: "ben", name: "Ben", start: 2, end: 3 },
      { angle: "ana", name: "Ana", start: 4, end: 4.6 },
    ]);
    expect(result.duration).toBe(8);
    expect(result.speakers).toEqual([
      { angle: "ana", speaker: "s1", transcript: "transcripts/room.words.json" },
      { angle: "ben", speaker: "s2", transcript: "transcripts/room.words.json" },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("gives angles of a shared file without a speaker the free speakers in order, and says so", async () => {
    const found = { path: "transcripts/room.words.json", transcript: mixed, stale: false };
    const result = await groupTurns(
      source({ "assets/room.mp4": found }),
      "/p",
      group([
        { id: "ben", name: "Ben", asset: "assets/room.mp4", offset: 0, speaker: "s2" },
        { id: "ana", name: "Ana", asset: "assets/room.mp4", offset: 0 },
      ]),
    );
    expect(result.speakers.map(({ angle, speaker }) => [angle, speaker])).toEqual([
      ["ben", "s2"],
      ["ana", "s1"],
    ]);
    expect(result.warnings).toEqual([expect.stringMatching(/^Ana took speaker s1 \(Ana\) of transcripts\/room\.words\.json by order/)]);
  });

  it("warns instead of failing when the shared file has no transcript, a stale one, no speakers, or an unknown speaker", async () => {
    const angles = group([
      { id: "ana", name: "Ana", asset: "assets/room.mp4", offset: 0 },
      { id: "ben", name: "Ben", asset: "assets/room.mp4", offset: 0 },
    ]);
    const none = await groupTurns(source({}), "/p", angles);
    expect(none.turns).toEqual([]);
    expect(none.warnings).toEqual([expect.stringMatching(/Ana, Ben share assets\/room\.mp4, which has no transcript/)]);

    const stale = await groupTurns(source({ "assets/room.mp4": { path: "transcripts/room.words.json", transcript: mixed, stale: true } }), "/p", angles);
    expect(stale.warnings).toEqual([expect.stringMatching(/is stale/)]);

    const { speakers: _none, ...bare } = mixed;
    const plain = { ...bare, words: bare.words.map(({ speaker: _s, ...word }) => word), edits: {} };
    const unspoken = await groupTurns(source({ "assets/room.mp4": { path: "transcripts/room.words.json", transcript: plain, stale: false } }), "/p", angles);
    expect(unspoken.warnings).toEqual([expect.stringMatching(/has no speakers.*transcribe\.speakers/)]);

    const unknown = await groupTurns(
      source({ "assets/room.mp4": { path: "transcripts/room.words.json", transcript: mixed, stale: false } }),
      "/p",
      group([{ id: "ana", name: "Ana", asset: "assets/room.mp4", offset: 0, speaker: "s7" }]),
    );
    expect(unknown.turns).toEqual([]);
    expect(unknown.warnings).toEqual([expect.stringMatching(/speaker s7 is not in transcripts\/room\.words\.json \(s1 Ana, s2 Ben\)/)]);
  });
});
