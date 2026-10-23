import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AppDirs, type DaemonConnection, ErrorCode, RpcError, connectToDaemon, methods } from "@frameshell/protocol";
import { SCHEMA_VERSION } from "@frameshell/schema";
import { afterEach, describe, expect, it } from "vitest";
import { type AudioExtractor, type Daemon, FACE_EMBEDDING_DIMS, type FaceTrack, VOICES_DIR, type VoiceEmbedRequest, startDaemon, writeFaceScan } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools } from "./media-tools.js";

// Seam under test: `people.suggest` and `people.confirm` over the daemon socket (ADR 0020). The speaker model is a
// stand-in that hands out a fixed voice per file and stretch, so nothing is downloaded and no audio is decoded.

let daemon: Daemon | undefined;
const connections: DaemonConnection[] = [];
afterEach(async () => {
  for (const conn of connections.splice(0)) conn.close();
  await daemon?.close();
  daemon = undefined;
});

const EP1 = "transcripts/ep1.words.json";
const EP2 = "transcripts/ep2.words.json";
const EP3 = "transcripts/ep3.words.json";

/** Unit vector along `axis` of 16 dimensions, tilted towards `toward` so their cosine is `similarity`. */
function voice(axis: number, toward?: number, similarity = 1): number[] {
  const vector = new Array<number>(16).fill(0);
  vector[axis] = toward === undefined ? 1 : Math.sqrt(1 - similarity ** 2);
  if (toward !== undefined) vector[toward] = similarity;
  return vector;
}

/** Two people talk in each file: the first from 0.2 s to 4.8 s, the second from 5.2 s to 9.8 s, in four words each. */
function transcript(asset: string, hash: string, speakers = true) {
  const words = [0.2, 1.4, 2.6, 3.8, 5.2, 6.4, 7.6, 8.8].map((start, i) => ({
    id: `w_${String(i + 1).padStart(6, "0")}`,
    text: "hola",
    start,
    end: Math.round((start + 1) * 10) / 10,
    ...(speakers ? { speaker: i < 4 ? "s1" : "s2" } : {}),
  }));
  return {
    schemaVersion: SCHEMA_VERSION,
    asset,
    assetHash: `sha256:${hash}`,
    provider: "test",
    model: "test",
    words,
    edits: {},
    nextWordId: 9,
    ...(speakers ? { speakers: [{ id: "s1", name: "Speaker 1" }, { id: "s2", name: "Speaker 2" }], nextSpeakerId: 3 } : {}),
  };
}

/** WAVs are written as text: the stand-in embedder never reads them. */
const extractAudio: AudioExtractor = async (_input, output) => writeFileSync(output, "wav");

async function setup(options: { embedder?: boolean } = {}) {
  const dirs: AppDirs = { dataDir: tempDir(), configDir: tempDir() };
  // Attaching the project ingests its assets; with ffmpeg at hand the text "videos" fail at once instead of installing it.
  const { ffmpeg, ffprobe } = await mediaTools();
  writeFileSync(join(dirs.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg, ffprobe } }));
  /** Voice of each file's first and second speaker, by the file's audio cache key. */
  const voices = new Map<string, [number[], number[]]>();
  const asked: VoiceEmbedRequest[] = [];
  const voiceEmbedder = async (request: VoiceEmbedRequest) => {
    asked.push(request);
    const key = /([0-9a-f]{16})-(asset|sidecar)\.wav$/.exec(request.audio)![1]!;
    return request.stretches.map((stretch) => voices.get(key)![stretch.start < 5 ? 0 : 1]);
  };
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs, extractAudio, ...(options.embedder === false ? {} : { voiceEmbedder }), idleTimeoutMs: Infinity });
  const connect = async (client: string, options: { session?: string; agent?: string | null } = {}) => {
    const conn = await connectToDaemon(daemon!.socketPath, { client, agent: null, ...options });
    connections.push(conn);
    return conn;
  };
  const cli = await connect("cli/test");
  const dir = join(tempDir(), "talk");
  await cli.request("project.init", { dir });
  const episode = (name: string, first: number[], second: number[], speakers = true) => {
    const bytes = `episode ${name}`;
    writeFileSync(join(dir, "assets", `${name}.mp4`), bytes);
    const hash = createHash("sha256").update(bytes).digest("hex");
    voices.set(hash.slice(0, 16), [first, second]);
    writeFileSync(join(dir, "transcripts", `${name}.words.json`), JSON.stringify(transcript(`assets/${name}.mp4`, hash, speakers)));
    return hash;
  };
  // Juan speaks first in both episodes (a little different the second time); Ben and Carla are different voices.
  const ep1 = episode("ep1", voice(0), voice(1));
  const ep2 = episode("ep2", voice(2, 0, 0.92), voice(3));
  episode("ep3", voice(4), voice(5), false);
  await cli.request("people.add", { cwd: dir, name: "Juan" });
  await cli.request("people.link", { cwd: dir, person: "Juan", speaker: { transcript: EP1, speaker: "s1" } });
  const read = (rel: string) => JSON.parse(readFileSync(join(dir, rel), "utf8"));
  return { dir, dirs, cli, connect, asked, read, ep1, ep2 };
}

async function failure(call: Promise<unknown>): Promise<RpcError> {
  try {
    await call;
  } catch (error) {
    return error as RpcError;
  }
  throw new Error("expected the request to fail");
}

describe("people.suggest", () => {
  it("with download: false never fetches the voice model: voices are left out and the size is reported", async () => {
    const { dir, dirs, cli } = await setup({ embedder: false });
    const result = await cli.request("people.suggest", { cwd: dir, download: false });
    expect(result.suggestions.filter((suggestion) => suggestion.kind === "speaker")).toEqual([]);
    // ONNX Runtime Web's tarball and CAM++, as pinned in the binary manifest.
    expect(result.voiceDownload).toEqual({ bytes: 33_106_585 + 29_596_978 });
    expect(result.hints).toContain("the voice model is not downloaded yet: its voice is not compared.");
    expect(existsSync(join(dirs.dataDir, "models"))).toBe(false);
  });

  it("suggests the same voice in another file and not the different voices, with hints for undiarized transcripts", async () => {
    const { dir, cli } = await setup();
    const result = await cli.request("people.suggest", { cwd: dir });
    expect(methods["people.suggest"].result.parse(result)).toEqual(result);
    expect(result.suggestions).toEqual([
      expect.objectContaining({
        kind: "speaker",
        person: expect.objectContaining({ name: "Juan" }),
        speaker: { transcript: EP2, speaker: "s1", name: "Speaker 1" },
        score: 0.92,
        reason: `s1 (Speaker 1) in ${EP2} sounds like Juan (0.92).`,
      }),
    ]);
    expect(result.hints).toEqual([`${EP3} has no speakers, so its voices are not compared: frameshell transcribe --speakers assets/ep3.mp4`]);
    // A model at hand (here the stand-in) compares voices with or without `download`.
    expect(await cli.request("people.suggest", { cwd: dir, download: false })).toEqual(result);
  });

  it("computes each print once, caches it per asset content, and recomputes when the speaker's words change", async () => {
    const { dir, cli, asked, read, ep2 } = await setup();
    await cli.request("people.suggest", { cwd: dir });
    // ep1 (both speakers) and ep2 (both): four words of 1 s each per speaker make one stretch per speaker.
    expect(asked.map((request) => request.stretches.length)).toEqual([2, 2]);
    expect(existsSync(join(dir, VOICES_DIR, `${ep2.slice(0, 16)}.json`))).toBe(true);
    asked.length = 0;
    await cli.request("people.suggest", { cwd: dir });
    expect(asked).toEqual([]);

    const changed = read(EP2);
    changed.edits = { w_000004: { speaker: "s2" } };
    writeFileSync(join(dir, EP2), JSON.stringify(changed));
    await cli.request("people.suggest", { cwd: dir });
    expect(asked.map((request) => request.stretches)).toEqual([
      [
        { start: 0.2, end: 3.6 },
        { start: 3.8, end: 9.8 },
      ],
    ]);
  });

  it("says why there is nothing to compare when no person has a voice", async () => {
    const { dir, cli } = await setup();
    await cli.request("people.unlink", { cwd: dir, person: "Juan", speaker: { transcript: EP1, speaker: "s1" } });
    const result = await cli.request("people.suggest", { cwd: dir });
    expect(result.suggestions).toEqual([]);
    expect(result.hints[0]).toContain("No person has a linked transcript speaker");
  });

  it("reports a stale transcript instead of comparing it", async () => {
    const { dir, cli } = await setup();
    writeFileSync(join(dir, "assets", "ep2.mp4"), "re-encoded");
    const result = await cli.request("people.suggest", { cwd: dir });
    expect(result.suggestions).toEqual([]);
    expect(result.hints).toContain(`${EP2} is stale: assets/ep2.mp4 changed after it was transcribed: its voice is not compared.`);
  });
});

describe("people.confirm", () => {
  it("links a confirmed suggestion, names the speaker in its transcript, and stops suggesting it", async () => {
    const { dir, cli, read } = await setup();
    const [suggestion] = (await cli.request("people.suggest", { cwd: dir })).suggestions;
    const result = await cli.request("people.confirm", { cwd: dir, suggestions: [suggestion!.id] });
    expect(methods["people.confirm"].result.parse(result)).toEqual(result);
    expect(result).toMatchObject({
      confirmed: [{ id: suggestion!.id, person: { name: "Juan" }, speaker: { transcript: EP2, speaker: "s1" }, linked: true, transcripts: [EP2] }],
      dismissed: [],
    });
    expect(read(EP2).speakers).toEqual([{ id: "s1", name: "Juan" }, { id: "s2", name: "Speaker 2" }]);
    expect(read("people.json").people[0].speakers).toEqual([
      { transcript: EP1, speaker: "s1" },
      { transcript: EP2, speaker: "s1" },
    ]);
    expect((await cli.request("people.suggest", { cwd: dir })).suggestions).toEqual([]);
  });

  it("records an agent's confirmation in `by`", async () => {
    const { dir, cli, connect, read } = await setup();
    const [suggestion] = (await cli.request("people.suggest", { cwd: dir })).suggestions;
    const agent = await connect("cli/test", { session: "term-9", agent: "claude" });
    await agent.request("people.confirm", { cwd: dir, suggestions: [suggestion!.id] });
    expect(read("people.json").people[0].speakers[1]).toEqual({ transcript: EP2, speaker: "s1", by: "agent:claude:term-9" });
  });

  it("dismisses with reject, so the suggestion is not asked again", async () => {
    const { dir, cli, read } = await setup();
    const [suggestion] = (await cli.request("people.suggest", { cwd: dir })).suggestions;
    const result = await cli.request("people.confirm", { cwd: dir, suggestions: [suggestion!.id], reject: true });
    expect(result).toEqual({ dir: expect.any(String), confirmed: [], dismissed: [suggestion!.id] });
    expect(read("people.json").dismissed).toEqual([suggestion!.id]);
    expect(read("people.json").people[0].speakers).toHaveLength(1);
    expect((await cli.request("people.suggest", { cwd: dir })).suggestions).toEqual([]);
    // Dismissing again changes nothing.
    expect((await cli.request("people.confirm", { cwd: dir, suggestions: [suggestion!.id], reject: true })).dismissed).toEqual([]);
  });

  it("refuses an id that is not a current suggestion, changing nothing", async () => {
    const { dir, cli, read } = await setup();
    const before = read("people.json");
    const error = await failure(cli.request("people.confirm", { cwd: dir, suggestions: ["sg_00000000"] }));
    expect(error).toBeInstanceOf(RpcError);
    expect(error.code).toBe(ErrorCode.InvalidOperation);
    expect(error.data).toMatchObject({ op: "people.confirm", reason: "unknown suggestion" });
    expect(read("people.json")).toEqual(before);
  });
});

/** A face at `x` sampled twice a second from `start` to `end`, with face print `axis` once a second. */
function faceTrack(id: string, start: number, end: number, x: number, axis: number): FaceTrack {
  const vector = new Float32Array(FACE_EMBEDDING_DIMS);
  vector[axis] = 1;
  const boxes = [];
  for (let time = start; time <= end; time += 0.5) boxes.push({ time, x, y: 0.4, width: 0.2, height: 0.3, score: 0.9 });
  return { id, start, end, boxes, embeddings: boxes.filter((box) => Number.isInteger(box.time)).map((box) => ({ time: box.time, vector })) };
}

describe("faces", () => {
  /** ep1's scan: the first speaker's face on the left while they talk, the second's on the right. */
  async function scanned() {
    const context = await setup();
    await writeFaceScan(context.dir, `sha256:${context.ep1}`, { width: 1280, height: 720, samples: 20, tracks: [faceTrack("t1", 0, 5, 0.3, 0), faceTrack("t2", 5, 10, 0.7, 1)] });
    return context;
  }

  it("suggests the face on screen while each speaker talks, and hints at videos with speakers but no scan", async () => {
    const { dir, cli } = await scanned();
    const result = await cli.request("people.suggest", { cwd: dir });
    expect(methods["people.suggest"].result.parse(result)).toEqual(result);
    const pairs = result.suggestions.filter((suggestion) => suggestion.kind === "face-speaker");
    expect(pairs).toEqual([
      expect.objectContaining({ person: expect.objectContaining({ name: "Juan" }), speaker: expect.objectContaining({ transcript: EP1, speaker: "s1" }), links: ["face"] }),
      expect.objectContaining({ speaker: expect.objectContaining({ transcript: EP1, speaker: "s2" }), links: ["speaker", "face"] }),
    ]);
    expect(pairs[0]!.face!.anchor).toMatchObject({ asset: "assets/ep1.mp4", x: 0.3, y: 0.4 });
    expect(result.hints).toContain("assets/ep2.mp4 has no face scan, so the faces of transcripts/ep2.words.json's speakers are not matched: frameshell people scan assets/ep2.mp4");
  });

  it("links a confirmed face as an anchor, and needs a person for a suggestion that names nobody", async () => {
    const { dir, cli, read } = await scanned();
    const pairs = (await cli.request("people.suggest", { cwd: dir })).suggestions.filter((suggestion) => suggestion.kind === "face-speaker");
    const [juan, nobody] = pairs;
    const result = await cli.request("people.confirm", { cwd: dir, suggestions: [juan!.id] });
    expect(methods["people.confirm"].result.parse(result)).toEqual(result);
    expect(result.confirmed).toEqual([{ id: juan!.id, person: juan!.person, added: false, face: juan!.face!.anchor, linked: true, transcripts: [] }]);
    expect(read("people.json").people[0].faces).toEqual([juan!.face!.anchor]);

    const error = await failure(cli.request("people.confirm", { cwd: dir, suggestions: [nobody!.id] }));
    expect(error.data).toMatchObject({ op: "people.confirm", reason: "needs person" });
    const named = await cli.request("people.confirm", { cwd: dir, suggestions: [nobody!.id], person: "Ben" });
    expect(named.confirmed).toEqual([
      expect.objectContaining({ person: expect.objectContaining({ name: "Ben" }), added: true, speaker: { transcript: EP1, speaker: "s2" }, face: nobody!.face!.anchor, linked: true, transcripts: [EP1] }),
    ]);
    expect(read(EP1).speakers).toEqual([{ id: "s1", name: "Juan" }, { id: "s2", name: "Ben" }]);
    expect(read("people.json").people[1]).toMatchObject({ name: "Ben", speakers: [{ transcript: EP1, speaker: "s2" }], faces: [nobody!.face!.anchor] });
    // Both faces now have their person: nothing more to ask about ep1.
    expect((await cli.request("people.suggest", { cwd: dir })).suggestions.filter((suggestion) => suggestion.kind !== "speaker")).toEqual([]);
  });

  it("dismisses a suggestion that names nobody", async () => {
    const { dir, cli, read } = await scanned();
    const nobody = (await cli.request("people.suggest", { cwd: dir })).suggestions.find((suggestion) => !suggestion.person)!;
    expect((await cli.request("people.confirm", { cwd: dir, suggestions: [nobody.id], reject: true })).dismissed).toEqual([nobody.id]);
    expect(read("people.json").dismissed).toEqual([nobody.id]);
  });
});

describe("gc", () => {
  it("sweeps the voice prints of an asset that is gone", async () => {
    const { dir, cli, ep2 } = await setup();
    await cli.request("people.suggest", { cwd: dir });
    rmSync(join(dir, "assets", "ep2.mp4"));
    const result = await cli.request("gc", { cwd: dir });
    expect(result.removed).toContainEqual(expect.objectContaining({ path: `${VOICES_DIR}/${ep2.slice(0, 16)}.json`, kind: "voice" }));
  });
});
