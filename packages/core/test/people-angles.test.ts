import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type AppDirs, type DaemonConnection, connectToDaemon, methods } from "@frameshell/protocol";
import { type MulticamGroup, type Person, SCHEMA_VERSION, type Timeline, type Transcript } from "@frameshell/schema";
import { afterEach, describe, expect, it } from "vitest";
import { type Daemon, FACE_EMBEDDING_DIMS, type FaceTrack, type ScannedAsset, angleSuggestions, clusterFaces, facesOfPeople, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// `angle` suggestions (ADR 0020 decision 5): a multicam group with two angles, names and mic transcripts, written by hand.

const group = {
  id: "g_talk",
  angles: [
    { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0, mic: "alav" },
    { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 0, mic: "blav" },
    { id: "scr", name: "Slides", asset: "assets/slides.mp4", offset: 0, screen: true },
  ],
  mics: [
    { id: "alav", name: "Ana lav", asset: "assets/alav.wav", offset: 0 },
    { id: "blav", name: "Ben lav", asset: "assets/blav.wav", offset: 0 },
  ],
} as unknown as MulticamGroup;

const timeline = { schemaVersion: SCHEMA_VERSION, id: "talk", revision: 0, tracks: [], groups: [group] } as unknown as Timeline;

/** `count` words per `[speaker id, count]` entry; no entries: an undiarized transcript. */
function transcript(asset: string, speakers: [id: string, count: number][]): Transcript {
  const words = speakers.flatMap(([id, count]) => Array.from({ length: count }, () => id));
  return {
    schemaVersion: SCHEMA_VERSION,
    asset,
    assetHash: `sha256:${"a".repeat(64)}`,
    provider: "test",
    model: "test",
    words: words.map((id, n) => ({ id: `w_${String(n + 1).padStart(6, "0")}`, text: "hola", start: n, end: n + 0.5, ...(speakers.length > 0 ? { speaker: id } : {}) })),
    edits: {},
    nextWordId: words.length + 1,
    ...(speakers.length > 0 ? { speakers: speakers.map(([id], n) => ({ id, name: `Speaker ${n + 1}` })), nextSpeakerId: speakers.length + 1 } : {}),
  } as Transcript;
}

const transcripts = new Map([
  ["transcripts/alav.words.json", transcript("assets/alav.wav", [])],
  [
    "transcripts/blav.words.json",
    transcript("assets/blav.wav", [
      ["s1", 9],
      ["s2", 1],
    ]),
  ],
]);

const noFaces = { model: clusterFaces([]), owners: { tracks: new Map(), clusters: new Map(), unresolved: [] } };
const person = (id: string, name: string, parts: Partial<Person> = {}): Person => ({ id, name, speakers: [], angles: [], faces: [], ...parts });

function faceTrack(id: string, start: number, end: number, axis: number): FaceTrack {
  const vector = new Float32Array(FACE_EMBEDDING_DIMS);
  vector[axis] = 1;
  const boxes = [];
  for (let time = start; time <= end; time += 0.5) boxes.push({ time, x: 0.5, y: 0.4, width: 0.2, height: 0.3, score: 0.9 });
  return { id, start, end, boxes, embeddings: boxes.filter((box) => Number.isInteger(box.time)).map((box) => ({ time: box.time, vector })) };
}
const scan = (asset: string, tracks: FaceTrack[]): ScannedAsset => ({
  asset,
  scan: { hash: `sha256:${asset}`, models: { detector: "d", recognizer: "r" }, hz: 2, width: 1280, height: 720, samples: 100, tracks },
});

describe("angleSuggestions", () => {
  const input = { timelines: new Map([["talk", timeline]]), people: [] as Person[], transcripts, ...noFaces };

  it("proposes a new person per angle with its mic voice, skips screens, and takes a whole undiarized mic", () => {
    const found = angleSuggestions(input);
    expect(found.map((suggestion) => suggestion.angle)).toEqual([
      { timeline: "talk", group: "g_talk", angle: "ana", name: "Ana" },
      { timeline: "talk", group: "g_talk", angle: "ben", name: "Ben" },
    ]);
    expect(found[0]).toMatchObject({ kind: "angle", links: ["angle", "speaker"], speaker: { transcript: "transcripts/alav.words.json" } });
    expect(found[0]!.person).toBeUndefined();
    expect(found[0]!.speaker!.speaker).toBeUndefined();
    // Ben's mic is diarized: s1 holds 90% of the words.
    expect(found[1]).toMatchObject({ links: ["angle", "speaker"], speaker: { transcript: "transcripts/blav.words.json", speaker: "s1" } });
    expect(found[1]!.id).toMatch(/^sg_[0-9a-f]{8}$/);
  });

  it("matches an existing person by name ignoring case, and skips linked angles and voices someone else has", () => {
    const ben = person("p_ben", "BEN", { speakers: [{ transcript: "transcripts/blav.words.json", speaker: "s1" }] });
    const other = person("p_o", "Someone", { angles: [{ timeline: "talk", group: "g_talk", angle: "ana" }] });
    const found = angleSuggestions({ ...input, people: [ben, other] });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ person: { id: "p_ben", name: "BEN" }, links: ["angle"] });
  });

  it("takes the angle's own speaker, and no voice from a shared mic without a clear speaker", () => {
    const shared = { ...group, angles: [{ ...group.angles[0]!, speaker: "s2" }, { ...group.angles[1]!, mic: "alav" }] } as unknown as MulticamGroup;
    const diarized = new Map([
      [
        "transcripts/alav.words.json",
        transcript("assets/alav.wav", [
          ["s1", 5],
          ["s2", 5],
        ]),
      ],
    ]);
    const found = angleSuggestions({ ...input, timelines: new Map([["talk", { ...timeline, groups: [shared] } as Timeline]]), transcripts: diarized });
    expect(found[0]!.speaker).toMatchObject({ speaker: "s2" });
    expect(found[1]!.links).toEqual(["angle"]);
  });

  it("adds the face that fills the angle's scanned picture, not a split one or someone's", () => {
    const model = clusterFaces([scan("assets/ana.mp4", [faceTrack("t1", 0, 20, 0)]), scan("assets/ben.mp4", [faceTrack("t1", 0, 10, 1), faceTrack("t2", 0, 8, 2)])]);
    const found = angleSuggestions({ ...input, model, owners: facesOfPeople(model, []) });
    expect(found[0]).toMatchObject({ links: ["angle", "speaker", "face"], face: { anchor: { asset: "assets/ana.mp4" } } });
    expect(found[1]!.links).toEqual(["angle", "speaker"]);

    const xavi = person("p_x", "Xavi", { faces: [found[0]!.face!.anchor] });
    const owned = angleSuggestions({ ...input, model, owners: facesOfPeople(model, [xavi]), people: [xavi] });
    expect(owned[0]!.links).toEqual(["angle", "speaker"]);
  });
});

describe("angle suggestions over the daemon", () => {
  let daemon: Daemon | undefined;
  const connections: DaemonConnection[] = [];
  afterEach(async () => {
    for (const conn of connections.splice(0)) conn.close();
    await daemon?.close();
    daemon = undefined;
  });

  async function setup() {
    const dirs: AppDirs = { dataDir: tempDir(), configDir: tempDir() };
    daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs, idleTimeoutMs: Infinity });
    const cli = await connectToDaemon(daemon.socketPath, { client: "cli/test", agent: null });
    connections.push(cli);
    const dir = join(tempDir(), "talk");
    await cli.request("project.init", { dir });
    const write = (rel: string, value: unknown) => cli.request("file.write", { path: join(dir, rel), content: JSON.stringify(value) });
    for (const [rel, value] of transcripts) await write(rel, value);
    await write("timelines/talk.json", timeline);
    const read = (rel: string) => JSON.parse(readFileSync(join(dir, rel), "utf8")) as { people: Person[]; dismissed: string[]; speakers: { id: string; name: string }[] };
    return { dir, cli, read };
  }

  it("confirms an angle once: adds a person named like it, links angle and voice, and links nothing before", async () => {
    const { dir, cli, read } = await setup();
    await cli.request("people.add", { cwd: dir, name: "ben" });
    const result = await cli.request("people.suggest", { cwd: dir });
    expect(methods["people.suggest"].result.parse(result)).toEqual(result);
    expect(result.suggestions.map((suggestion) => suggestion.kind)).toEqual(["angle", "angle"]);
    expect(read("people.json").people.every((entry) => entry.angles.length === 0 && entry.speakers.length === 0)).toBe(true);

    const [ana, ben] = result.suggestions;
    const confirmed = await cli.request("people.confirm", { cwd: dir, suggestions: [ana!.id, ben!.id] });
    expect(methods["people.confirm"].result.parse(confirmed)).toEqual(confirmed);
    expect(confirmed.confirmed).toEqual([
      expect.objectContaining({ person: expect.objectContaining({ name: "Ana" }), added: true, angle: { timeline: "talk", group: "g_talk", angle: "ana" }, speaker: { transcript: "transcripts/alav.words.json" }, linked: true }),
      expect.objectContaining({
        person: expect.objectContaining({ name: "ben" }),
        added: false,
        angle: { timeline: "talk", group: "g_talk", angle: "ben" },
        speaker: { transcript: "transcripts/blav.words.json", speaker: "s1" },
        linked: true,
        transcripts: ["transcripts/blav.words.json"],
      }),
    ]);
    expect(read("people.json").people.map((entry) => [entry.name, entry.angles.length, entry.speakers.length])).toEqual([
      ["ben", 1, 1],
      ["Ana", 1, 1],
    ]);
    expect(read("transcripts/blav.words.json").speakers[0]).toEqual({ id: "s1", name: "ben" });
    expect((await cli.request("people.suggest", { cwd: dir })).suggestions).toEqual([]);
  });

  it("dismisses an angle suggestion with reject", async () => {
    const { dir, cli, read } = await setup();
    const [first] = (await cli.request("people.suggest", { cwd: dir })).suggestions;
    const result = await cli.request("people.confirm", { cwd: dir, suggestions: [first!.id], reject: true });
    expect(result.dismissed).toEqual([first!.id]);
    expect(read("people.json").dismissed).toEqual([first!.id]);
    expect((await cli.request("people.suggest", { cwd: dir })).suggestions).toHaveLength(1);
  });

  it("links the angle alone when its voice was taken since", async () => {
    const { dir, cli } = await setup();
    const [ana] = (await cli.request("people.suggest", { cwd: dir })).suggestions;
    await cli.request("people.add", { cwd: dir, name: "Other" });
    await cli.request("people.link", { cwd: dir, person: "Other", speaker: { transcript: "transcripts/alav.words.json" } });
    const result = await cli.request("people.confirm", { cwd: dir, suggestions: [ana!.id] });
    expect(result.confirmed[0]!.speaker).toBeUndefined();
    expect(result.confirmed[0]!.angle).toEqual({ timeline: "talk", group: "g_talk", angle: "ana" });
  });
});
