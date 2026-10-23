import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import { type Transcript, parseTranscript } from "@frameshell/schema";
import { type AudioExtractor, type DiarizeRequest, type SpeakerSegment, type TranscriberTools, diarizeAsset } from "../src/index.js";
import { tempDir } from "./helpers.js";

/** sha256("hello"): independent known value. */
const HELLO_SHA256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

const fakeExtract: AudioExtractor = async (input, output) => writeFileSync(output, `wav-of:${readFileSync(input.path, "utf8")}`);

const tools: TranscriberTools = {
  ensureBinary: async (name) => `/bin/${name}`,
  ensureModel: async (id) => `/models/${id}`,
};

function transcript(extra: Partial<Transcript> = {}): Transcript {
  return {
    schemaVersion: 1,
    asset: "assets/talk.mp4",
    assetHash: `sha256:${HELLO_SHA256}`,
    provider: "whisper-cpp",
    model: "m",
    words: [
      { id: "w_000001", text: "Hola", start: 0.2, end: 0.6 },
      { id: "w_000002", text: "qué", start: 2.1, end: 2.4 },
      { id: "w_000003", text: "tal", start: 2.4, end: 2.8 },
      { id: "w_000004", text: "bien", start: 4.1, end: 4.5 },
    ],
    edits: {},
    nextWordId: 5,
    ...extra,
  };
}

function project(content: Transcript | null = transcript()): string {
  const dir = tempDir();
  writeFileSync(join(dir, "frameshell.json"), "{}");
  mkdirSync(join(dir, "assets"));
  mkdirSync(join(dir, "transcripts"));
  writeFileSync(join(dir, "assets", "talk.mp4"), "hello");
  if (content) writeFileSync(join(dir, "transcripts", "talk.words.json"), JSON.stringify(content));
  return dir;
}

/** Diarizer replaying `segments`; records what it was asked. */
function fakeDiarizer(segments: SpeakerSegment[]) {
  const calls: Omit<DiarizeRequest, "onProgress">[] = [];
  const diarize = async ({ onProgress, ...request }: DiarizeRequest) => {
    calls.push(request);
    onProgress(0.5);
    return segments;
  };
  return { diarize, calls };
}

const read = (dir: string) => {
  const parsed = parseTranscript(JSON.parse(readFileSync(join(dir, "transcripts", "talk.words.json"), "utf8")));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

const run = (dir: string, diarize: ReturnType<typeof fakeDiarizer>["diarize"], speakers?: number) =>
  diarizeAsset({ projectDir: dir, asset: join(dir, "assets", "talk.mp4"), tools, extractAudio: fakeExtract, diarize, speakers });

const ANA_BEN: SpeakerSegment[] = [
  { start: 0, end: 1, label: "speaker_01" },
  { start: 2, end: 3, label: "speaker_00" },
  { start: 4, end: 5, label: "speaker_01" },
];

describe("diarizeAsset", () => {
  it("writes a speaker on every word and the speaker list, from the transcription WAV and the pinned models", async () => {
    const dir = project();
    const { diarize, calls } = fakeDiarizer(ANA_BEN);
    const result = await run(dir, diarize, 2);
    expect(calls).toEqual([
      {
        binary: "/bin/sherpa-onnx-offline-speaker-diarization",
        segmentation: "/models/pyannote-segmentation-3-0",
        embedding: "/models/3dspeaker-campplus-en-voxceleb",
        runtime: "/bin/onnxruntime-web",
        audio: join(dir, ".frameshell", "cache", "audio", `${HELLO_SHA256.slice(0, 16)}-asset.wav`),
        speakers: 2,
      },
    ]);
    const written = read(dir);
    expect(written.words.map((word) => word.speaker)).toEqual(["s1", "s2", "s2", "s1"]);
    expect(written.speakers).toEqual([
      { id: "s1", name: "Speaker 1" },
      { id: "s2", name: "Speaker 2" },
    ]);
    expect(written.nextWordId).toBe(5);
    expect(result).toMatchObject({
      transcript: "transcripts/talk.words.json",
      asset: "assets/talk.mp4",
      speakers: [
        { id: "s1", name: "Speaker 1", words: 2, seconds: 0.8 },
        { id: "s2", name: "Speaker 2", words: 2, seconds: 0.7 },
      ],
      segments: 3,
      unassigned: 0,
      corrections: 0,
    });
  });

  it("keeps names and human corrections when run again, whatever labels the clustering picks", async () => {
    const dir = project();
    await run(dir, fakeDiarizer(ANA_BEN).diarize);
    const named = read(dir);
    named.speakers = [
      { id: "s1", name: "Ana" },
      { id: "s2", name: "Ben" },
    ];
    named.edits = { w_000004: { speaker: "s2" } };
    writeFileSync(join(dir, "transcripts", "talk.words.json"), JSON.stringify(named));

    const swapped = ANA_BEN.map((segment) => ({ ...segment, label: segment.label === "speaker_00" ? "speaker_01" : "speaker_00" }));
    const result = await run(dir, fakeDiarizer(swapped).diarize);
    const again = read(dir);
    expect(again.words.map((word) => word.speaker)).toEqual(["s1", "s2", "s2", "s1"]);
    expect(again.edits).toEqual({ w_000004: { speaker: "s2" } });
    expect(again.speakers).toEqual(named.speakers);
    expect(result.speakers.map(({ name, words }) => [name, words])).toEqual([
      ["Ana", 1],
      ["Ben", 3],
    ]);
    expect(result.corrections).toBe(1);
  });

  it("refuses without a transcript, or with a stale one, before running anything", async () => {
    const { diarize, calls } = fakeDiarizer(ANA_BEN);
    const none = await run(project(null), diarize).catch((error: unknown) => error);
    expect(none).toBeInstanceOf(RpcError);
    expect(none).toMatchObject({ code: ErrorCode.InvalidOperation, data: { reason: "no transcript" } });
    const stale = await run(project(transcript({ assetHash: `sha256:${"0".repeat(64)}` })), diarize).catch((error: unknown) => error);
    expect(stale).toMatchObject({ code: ErrorCode.InvalidOperation, data: { reason: "stale transcript" } });
    expect(calls).toEqual([]);
  });

  it("reports a diarization failure as TranscriptionFailed and leaves the transcript alone", async () => {
    const dir = project();
    const before = readFileSync(join(dir, "transcripts", "talk.words.json"), "utf8");
    const error = await run(dir, async () => {
      throw new Error("exited with code 1");
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: ErrorCode.TranscriptionFailed, data: { provider: "sherpa-onnx", asset: "assets/talk.mp4" } });
    expect(readFileSync(join(dir, "transcripts", "talk.words.json"), "utf8")).toBe(before);
  });
});
