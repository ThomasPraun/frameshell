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

describe("groupTurns with separate mics and screens", () => {
  const roomMic = { path: "transcripts/room.words.json", transcript: { ...mixed, asset: "assets/room.wav" }, stale: false };
  const withMics = (angles: MulticamGroup["angles"], mics: MulticamGroup["mics"]): MulticamGroup => ({ id: "g_1", angles, ...(mics ? { mics } : {}) });

  it("takes turns of cameras sharing one mic from the mic's transcript speakers, on the mic's clock", async () => {
    const result = await groupTurns(
      source({ "assets/room.wav": roomMic }),
      "/p",
      withMics(
        [
          { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0, mic: "lav", speaker: "s1" },
          { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 0.2, mic: "lav", speaker: "s2" },
        ],
        [{ id: "lav", name: "Room", asset: "assets/room.wav", offset: 1 }],
      ),
    );
    expect(result.turns).toEqual([
      { angle: "ana", name: "Ana", start: 2, end: 2.5 },
      { angle: "ben", name: "Ben", start: 3, end: 4 },
      { angle: "ana", name: "Ana", start: 5, end: 5.6 },
    ]);
    expect(result.speakers.map(({ angle, speaker, transcript }) => [angle, speaker, transcript])).toEqual([
      ["ana", "s1", "transcripts/room.words.json"],
      ["ben", "s2", "transcripts/room.words.json"],
    ]);
    expect(result.duration).toBe(9);
    expect(result.warnings).toEqual([]);
  });

  it("names the mic when cameras sharing it name a speaker but it has no transcript", async () => {
    const result = await groupTurns(
      source({ "assets/ana.mp4": roomMic }),
      "/p",
      withMics(
        [
          { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0, mic: "lav", speaker: "s1" },
          { id: "ben", name: "Ben", asset: "assets/ana.mp4", offset: 0, mic: "lav" },
        ],
        [{ id: "lav", name: "Room", asset: "assets/room.wav", offset: 0 }],
      ),
    );
    expect(result.turns).toEqual([]);
    expect(result.warnings).toEqual([expect.stringMatching(/^Ana, Ben share mic Room \(assets\/room\.wav\), which has no transcript.*on assets\/room\.wav\.$/)]);
  });

  it("lets cameras sharing an undiarized mic speak together from its energy: two cameras of one person", async () => {
    const plain = { ...roomMic, transcript: { ...roomMic.transcript, speakers: [] } };
    const angles: MulticamGroup["angles"] = [
      { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0, mic: "lav" },
      { id: "ana-2", name: "Ana 2", asset: "assets/ana2.mp4", offset: 0, mic: "lav" },
    ];
    const mics = [{ id: "lav", name: "Ana lav", asset: "assets/room.wav", offset: 0 }];
    for (const transcripts of [{}, { "assets/room.wav": plain }, { "assets/room.wav": { ...roomMic, stale: true } }]) {
      const result = await groupTurns(source(transcripts), "/p", withMics(angles, mics));
      expect(result.turns).toEqual([
        { angle: "ana", name: "Ana", start: 0.5, end: 2 },
        { angle: "ana-2", name: "Ana 2", start: 0.5, end: 2 },
      ]);
      expect(result.speakers).toEqual([]);
      expect(result.warnings).toEqual([]);
    }
  });

  it("measures angles of one camera file heard through their own mics by energy, not speakers", async () => {
    const result = await groupTurns(
      source({ "assets/room.mp4": { path: "transcripts/room.words.json", transcript: mixed, stale: false } }),
      "/p",
      withMics(
        [
          { id: "ana", name: "Ana", asset: "assets/room.mp4", offset: 0, mic: "ana-lav" },
          { id: "ben", name: "Ben", asset: "assets/room.mp4", offset: 0, mic: "ben-lav" },
        ],
        [
          { id: "ana-lav", name: "Ana lav", asset: "assets/ana.wav", offset: 0 },
          { id: "ben-lav", name: "Ben lav", asset: "assets/ben.wav", offset: 0 },
        ],
      ),
    );
    expect(result.speakers).toEqual([]);
    expect(result.turns.map((turn) => turn.angle).sort()).toEqual(["ana", "ben"]);
    expect(result.warnings).toEqual([]);
  });

  it("uses the transcript of an angle's own mic when it names a speaker", async () => {
    const result = await groupTurns(
      source({ "assets/room.wav": roomMic }),
      "/p",
      withMics([{ id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 0, mic: "lav", speaker: "s2" }], [{ id: "lav", name: "Room", asset: "assets/room.wav", offset: 0 }]),
    );
    expect(result.turns).toEqual([{ angle: "ben", name: "Ben", start: 2, end: 3 }]);
  });

  it("never makes a screen angle a speaker, even when it shares a file or names one", async () => {
    const result = await groupTurns(
      source({ "assets/room.mp4": { path: "transcripts/room.words.json", transcript: mixed, stale: false } }),
      "/p",
      group([
        { id: "ana", name: "Ana", asset: "assets/room.mp4", offset: 0 },
        { id: "screen", name: "Screen", asset: "assets/room.mp4", offset: 0, screen: true, speaker: "s2" },
      ]),
    );
    // Ana alone on the file once the screen is set aside: her energy, not a speaker.
    expect(result.speakers).toEqual([]);
    expect(result.turns).toEqual([{ angle: "ana", name: "Ana", start: 0.5, end: 2 }]);
    expect(result.warnings).toEqual([]);
  });
});
