import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, connectToDaemon, methods } from "@frameshell/protocol";
import { type Timeline, parseTranscript } from "@frameshell/schema";
import { type AudioExtractor, BinaryManager, DIARIZATION_TOOL, type Daemon, type DiarizeRequest, SEGMENTATION_MODEL, SPEAKER_EMBEDDING_MODEL, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeClip } from "./media-fixtures.js";
import { mediaTools } from "./media-tools.js";

// `transcribe.speakers` and `multicam.turns` from speakers through a real daemon: real ffmpeg for the media, a stand-in
// diarizer (the real one is opt-in, see manifest.test.ts) and fake model files.
const MEDIA_TIMEOUT = 120_000;

const extractAudio: AudioExtractor = async (_input, output) => writeFileSync(output, "wav");
const asked: Omit<DiarizeRequest, "onProgress">[] = [];
const diarize = async ({ onProgress, ...request }: DiarizeRequest) => {
  asked.push(request);
  onProgress(1);
  return [
    { start: 0, end: 1.2, label: "speaker_00" },
    { start: 1.4, end: 2.6, label: "speaker_01" },
  ];
};

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let asset: string;

beforeAll(async () => {
  const dirs = { dataDir: tempDir(), configDir: tempDir() };
  const { ffmpeg, ffprobe } = await mediaTools();
  const engine = join(tempDir(), DIARIZATION_TOOL);
  writeFileSync(engine, "");
  writeFileSync(join(dirs.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg, ffprobe, [DIARIZATION_TOOL]: engine } }));
  const binaries = new BinaryManager(dirs);
  for (const id of [SEGMENTATION_MODEL, SPEAKER_EMBEDDING_MODEL]) {
    const model = await binaries.locateModel(id);
    mkdirSync(join(model.path, ".."), { recursive: true });
    writeFileSync(model.path, "fake model");
  }
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs, binaries, extractAudio, diarize, idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "cli/test", session: "term-1" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  const footage = tempDir();
  await makeClip(join(footage, "room.mp4"), { durationS: 3 });
  const { imported } = await conn.request("asset.import", { cwd: project, files: [join(footage, "room.mp4")] });
  asset = imported[0]!.asset;
  const hash = createHash("sha256").update(readFileSync(join(project, asset))).digest("hex");
  writeFileSync(
    join(project, "transcripts", "room.words.json"),
    JSON.stringify({
      schemaVersion: 1,
      asset,
      assetHash: `sha256:${hash}`,
      provider: "whisper-cpp",
      model: "m",
      words: [
        { id: "w_000001", text: "Hola", start: 0.1, end: 0.5 },
        { id: "w_000002", text: "Ben", start: 0.6, end: 1.1 },
        { id: "w_000003", text: "hola", start: 1.5, end: 1.9 },
        { id: "w_000004", text: "Ana", start: 2, end: 2.5 },
      ],
      edits: {},
      nextWordId: 5,
    }),
  );
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

describe("transcribe.speakers", () => {
  it("writes the speakers of a transcript, and multicam.turns then takes the turns of a shared mic from them", async () => {
    const result = await conn.request("transcribe.speakers", { cwd: project, asset, speakers: 2 });
    expect(methods["transcribe.speakers"].result.parse(result)).toEqual(result);
    expect(result).toMatchObject({
      transcript: "transcripts/room.words.json",
      speakers: [
        { id: "s1", name: "Speaker 1", words: 2 },
        { id: "s2", name: "Speaker 2", words: 2 },
      ],
      segments: 2,
      unassigned: 0,
    });
    expect(asked).toEqual([expect.objectContaining({ binary: expect.stringContaining(DIARIZATION_TOOL), speakers: 2 })]);
    const written = parseTranscript(JSON.parse(readFileSync(join(project, "transcripts", "room.words.json"), "utf8")));
    expect(written.ok && written.value.words.map((word) => word.speaker)).toEqual(["s1", "s1", "s2", "s2"]);

    // One recording of two people: both angles show the same file and share its mic.
    const path = join(project, "timelines", "main.json");
    const current = JSON.parse(readFileSync(path, "utf8")) as Timeline;
    const timeline: Timeline = {
      ...current,
      groups: [
        {
          id: "g_room",
          angles: [
            { id: "ana", name: "Ana", asset, offset: 0, speaker: "s2" },
            { id: "ben", name: "Ben", asset, offset: 0, crop: { left: 0.5 } },
          ],
        },
      ],
      tracks: [{ id: "t_p", kind: "program", group: "g_room", clips: [{ id: "c_s", type: "shot", start: 0, in: 0, out: 3, shot: "grid", angles: ["ana", "ben"] }] }],
    };
    await conn.request("file.write", { path, content: JSON.stringify(timeline) });

    const turns = await conn.request("multicam.turns", { cwd: project, timeline: "main", group: "g_room" });
    expect(turns.turns).toEqual([
      { angle: "ben", name: "Ben", start: 0.1, end: 1.1 },
      { angle: "ana", name: "Ana", start: 1.5, end: 2.5 },
    ]);
    expect(turns.speakers).toEqual([
      { angle: "ana", speaker: "s2", transcript: "transcripts/room.words.json" },
      { angle: "ben", speaker: "s1", transcript: "transcripts/room.words.json" },
    ]);
    expect(turns.warnings).toEqual([expect.stringContaining("Ben took speaker s1 (Speaker 1)")]);
  }, MEDIA_TIMEOUT);

  it("refuses an asset without a transcript and says to transcribe it first", async () => {
    const footage = tempDir();
    await makeClip(join(footage, "other.mp4"), { durationS: 1 });
    const { imported } = await conn.request("asset.import", { cwd: project, files: [join(footage, "other.mp4")] });
    await expect(conn.request("transcribe.speakers", { cwd: project, asset: imported[0]!.asset })).rejects.toMatchObject({
      message: expect.stringContaining("Run `transcribe` on it first"),
    });
  }, MEDIA_TIMEOUT);
});
