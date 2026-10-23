import type { Person, Timeline, Transcript } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import {
  FACE_EMBEDDING_DIMS,
  FACE_MIN_SCREEN_S,
  type FaceTrack,
  type ScannedAsset,
  clusterFaces,
  clusterFacesOffThread,
  faceSpans,
  faceSuggestions,
  facesOfPeople,
  overlapSeconds,
  personRanges,
  presence,
  resolveAnchor,
} from "../src/index.js";

// Face clusters, anchors, `face` / `face-speaker` suggestions and on-screen spans (ADR 0020), from hand-made tracks
// and face prints: no video, no model.

/** Unit vector of SFace's size along `axis`, tilted towards `toward` so their cosine is `similarity`. */
function print(axis: number, toward?: number, similarity = 1): Float32Array {
  const vector = new Float32Array(FACE_EMBEDDING_DIMS);
  vector[axis] = toward === undefined ? 1 : Math.sqrt(1 - similarity ** 2);
  if (toward !== undefined) vector[toward] = similarity;
  return vector;
}

/** A face at (`x`, `y`) sampled twice a second from `start` to `end`, one print per second (none when `vector` is null). */
function track(id: string, start: number, end: number, x: number, vector: Float32Array | null, y = 0.4): FaceTrack {
  const boxes = [];
  for (let time = start; time <= end + 1e-9; time += 0.5) boxes.push({ time, x, y, width: 0.2, height: 0.3, score: 0.9 });
  const embeddings = vector ? boxes.filter((box) => Number.isInteger(box.time)).map((box) => ({ time: box.time, vector })) : [];
  return { id, start, end, boxes, embeddings };
}

function scanned(asset: string, tracks: FaceTrack[], hash = `sha256:${asset}`): ScannedAsset {
  return { asset, scan: { hash, models: { detector: "d", recognizer: "r" }, hz: 2, width: 1280, height: 720, samples: 100, tracks } };
}

const person = (id: string, name: string, parts: Partial<Person> = {}): Person => ({ id, name, speakers: [], angles: [], faces: [], ...parts });

describe("clusterFaces", () => {
  it("groups the same face across videos and keeps different faces and print-less tracks apart", () => {
    const model = clusterFaces([
      scanned("assets/a.mp4", [track("t1", 0, 20, 0.3, print(0)), track("t2", 0, 20, 0.7, print(1)), track("t3", 2, 3, 0.5, null)]),
      scanned("assets/b.mp4", [track("t1", 0, 5, 0.5, print(2, 0, 0.8)), track("t2", 6, 9, 0.5, print(3))]),
    ]);
    expect(model.clusters.map((cluster) => cluster.tracks.map((entry) => entry.key))).toEqual([
      ["assets/a.mp4#t1", "assets/b.mp4#t1"],
      ["assets/a.mp4#t2"],
      ["assets/b.mp4#t2"],
    ]);
    expect(model.clusters[0]!.id).toMatch(/^fc_[0-9a-f]{6}$/);
    expect(model.clusters[0]!.seconds).toBeCloseTo(25.5, 3);
    expect(model.tracks.find((entry) => entry.key === "assets/a.mp4#t3")!.cluster).toBeNull();
    // The most central sample is a sample of the cluster's tracks, at its box centre.
    expect(model.clusters[0]!.anchor).toMatchObject({ asset: "assets/a.mp4", x: 0.3, y: 0.4 });
  });

  it("does not chain: a face between two others joins the closer one only (average linkage)", () => {
    const a = new Float32Array(FACE_EMBEDDING_DIMS);
    a[0] = 1;
    const b = new Float32Array(FACE_EMBEDDING_DIMS);
    b[0] = 0.6;
    b[1] = 0.8;
    const c = new Float32Array(FACE_EMBEDDING_DIMS);
    c[1] = 0.625;
    c[2] = Math.sqrt(1 - 0.625 ** 2);
    // cos(a, b) = 0.6 and cos(b, c) = 0.5 are both over the line; cos(a, c) = 0, so the average for c is 0.25.
    const model = clusterFaces([scanned("assets/a.mp4", [track("t1", 0, 1, 0.2, a), track("t2", 2, 3, 0.2, b), track("t3", 4, 5, 0.2, c)])]);
    expect(model.clusters.map((cluster) => cluster.tracks.map((entry) => entry.track.id).sort())).toEqual(expect.arrayContaining([["t1", "t2"], ["t3"]]));
    expect(model.clusters).toHaveLength(2);
  });
});

describe("clusterFacesOffThread", () => {
  const scans = [
    scanned("assets/a.mp4", [track("t1", 0, 20, 0.3, print(0)), track("t2", 0, 20, 0.7, print(1)), track("t3", 2, 3, 0.5, null)]),
    scanned("assets/b.mp4", [track("t1", 0, 5, 0.5, print(2, 0, 0.8)), track("t2", 6, 9, 0.5, print(3))]),
  ];

  it("gives the model clusterFaces gives, and the same one again for the same scans", async () => {
    const off = await clusterFacesOffThread(scans);
    expect(off).toEqual(clusterFaces(scans));
    expect(await clusterFacesOffThread([...scans].reverse())).toBe(off);
    expect((await clusterFacesOffThread([scans[0]!])).clusters).toHaveLength(2);
  });
});

describe("anchors", () => {
  const scans = [scanned("assets/a.mp4", [track("t1", 0, 20, 0.3, print(0)), track("t2", 0, 20, 0.7, print(1))])];

  it("names the face whose box holds the point in a sample near the second", () => {
    const model = clusterFaces(scans);
    expect(resolveAnchor(model, { asset: "assets/a.mp4", at: 12.3, x: 0.32, y: 0.45 })?.key).toBe("assets/a.mp4#t1");
    expect(resolveAnchor(model, { asset: "assets/a.mp4", at: 12.3, x: 0.68, y: 0.3 })?.key).toBe("assets/a.mp4#t2");
    expect(resolveAnchor(model, { asset: "assets/a.mp4", at: 12.3, x: 0.5, y: 0.4 })).toBeNull();
    expect(resolveAnchor(model, { asset: "assets/a.mp4", at: 30, x: 0.3, y: 0.4 })).toBeNull();
    expect(resolveAnchor(model, { asset: "assets/b.mp4", at: 1, x: 0.3, y: 0.4 })).toBeNull();
  });

  it("survive a rescan that numbers the tracks differently, and give the person every face of the cluster", () => {
    const ana = person("p_ana", "Ana", { faces: [{ asset: "assets/a.mp4", at: 5, x: 0.3, y: 0.4 }] });
    const first = facesOfPeople(clusterFaces([...scans, scanned("assets/b.mp4", [track("t1", 0, 4, 0.5, print(2, 0, 0.9))])]), [ana]);
    expect(first.tracks.get("p_ana")!.map((entry) => entry.key)).toEqual(["assets/a.mp4#t1", "assets/b.mp4#t1"]);
    const rescanned = clusterFaces([
      scanned("assets/a.mp4", [track("t7", 0, 20, 0.7, print(1)), track("t8", 0, 20, 0.3, print(0, 4, 0.1))]),
      scanned("assets/b.mp4", [track("t1", 0, 4, 0.5, print(2, 0, 0.9))]),
    ]);
    const again = facesOfPeople(rescanned, [ana]);
    expect(again.tracks.get("p_ana")!.map((entry) => entry.key)).toEqual(["assets/a.mp4#t8", "assets/b.mp4#t1"]);
    expect(again.clusters.get(rescanned.clusters.find((cluster) => cluster.tracks.some((entry) => entry.key === "assets/a.mp4#t8"))!.id)).toBe("p_ana");
  });

  it("splits a cluster holding two people's anchors by closeness, and reports anchors that name no face", () => {
    const model = clusterFaces([scanned("assets/a.mp4", [track("t1", 0, 2, 0.3, print(0)), track("t2", 3, 5, 0.3, print(0, 1, 0.5)), track("t3", 6, 8, 0.3, print(0, 1, 0.1))])]);
    expect(model.clusters).toHaveLength(1);
    const owners = facesOfPeople(model, [
      person("p_a", "A", { faces: [{ asset: "assets/a.mp4", at: 1, x: 0.3, y: 0.4 }] }),
      person("p_b", "B", { faces: [{ asset: "assets/a.mp4", at: 4, x: 0.3, y: 0.4 }, { asset: "assets/c.mp4", at: 1, x: 0.5, y: 0.5 }] }),
    ]);
    expect(owners.tracks.get("p_a")!.map((entry) => entry.track.id)).toEqual(["t1", "t3"]);
    expect(owners.tracks.get("p_b")!.map((entry) => entry.track.id)).toEqual(["t2"]);
    expect(owners.clusters.size).toBe(0);
    expect(owners.unresolved).toEqual([expect.objectContaining({ reason: "assets/c.mp4 has no face scan" })]);
  });
});

describe("presence", () => {
  it("covers a quarter second either side of each sample, merged", () => {
    const model = clusterFaces([scanned("assets/a.mp4", [track("t1", 1, 3, 0.3, print(0)), track("t2", 10, 10, 0.3, print(0))])]);
    const spans = presence(model.tracks, "assets/a.mp4");
    expect(spans).toEqual([
      { start: 0.75, end: 3.25 },
      { start: 9.75, end: 10.25 },
    ]);
    expect(overlapSeconds(spans, [{ start: 3, end: 10 }])).toBeCloseTo(0.5, 6);
  });
});

/** s1 talks from 0 to 12 s of a.mp4, s2 from 12 to 24 s, in 1 s words. */
function interview(asset = "assets/a.mp4", hash = `sha256:${asset}`): Transcript {
  const words = Array.from({ length: 24 }, (_, i) => ({ id: `w_${String(i + 1).padStart(6, "0")}`, text: "hola", start: i, end: i + 0.9, speaker: i < 12 ? "s1" : "s2" }));
  return {
    schemaVersion: 1,
    asset,
    assetHash: hash,
    provider: "test",
    model: "test",
    words,
    edits: {},
    speakers: [
      { id: "s1", name: "Speaker 1" },
      { id: "s2", name: "Speaker 2" },
    ],
    nextSpeakerId: 3,
    nextWordId: 25,
  } as Transcript;
}

describe("faceSuggestions", () => {
  // The host's face shows while s1 talks, the guest's while s2 talks.
  const scans = [scanned("assets/a.mp4", [track("t1", 0, 12, 0.3, print(0)), track("t2", 12, 24, 0.7, print(1))])];
  const transcripts = new Map([["transcripts/a.words.json", interview()]]);
  const suggest = (people: Person[], assets = scans, files = transcripts) => {
    const model = clusterFaces(assets);
    return faceSuggestions({ model, owners: facesOfPeople(model, people), people, transcripts: files });
  };

  it("face-speaker: ties each speaker to the face on screen while they talk, joined to the side already known", () => {
    const juan = person("p_juan", "Juan", { speakers: [{ transcript: "transcripts/a.words.json", speaker: "s1" }] });
    const { suggestions } = suggest([juan]);
    const pairs = suggestions.filter((suggestion) => suggestion.kind === "face-speaker");
    expect(pairs).toEqual([
      expect.objectContaining({ person: { id: "p_juan", name: "Juan" }, speaker: expect.objectContaining({ speaker: "s1" }), links: ["face"], score: 1 }),
      expect.objectContaining({ speaker: expect.objectContaining({ speaker: "s2" }), links: ["speaker", "face"], score: 1 }),
    ]);
    expect(pairs[1]).not.toHaveProperty("person");
    expect(pairs[0]!.face!.anchor).toMatchObject({ asset: "assets/a.mp4", x: 0.3 });
    expect(pairs[1]!.reason).toContain("Who is it?");
  });

  it("face-speaker: a known face names the voice; nothing when both sides are one person or two different ones", () => {
    const ana = person("p_ana", "Ana", { faces: [{ asset: "assets/a.mp4", at: 18, x: 0.7, y: 0.4 }] });
    const pairs = suggest([ana]).suggestions.filter((suggestion) => suggestion.kind === "face-speaker");
    expect(pairs.find((suggestion) => suggestion.speaker?.speaker === "s2")).toMatchObject({ person: { name: "Ana" }, links: ["speaker"] });

    const both = person("p_ana", "Ana", { ...ana, speakers: [{ transcript: "transcripts/a.words.json", speaker: "s2" }] });
    // s1's voice is Ben's while the face on screen as s1 talks is Ana's: two people, so no suggestion.
    const ben = person("p_ben", "Ben", { speakers: [{ transcript: "transcripts/a.words.json", speaker: "s1" }] });
    const host = person("p_ana", "Ana", { faces: [{ asset: "assets/a.mp4", at: 5, x: 0.3, y: 0.4 }] });
    expect(suggest([both]).suggestions.filter((suggestion) => suggestion.speaker?.speaker === "s2")).toEqual([]);
    expect(suggest([ben, host]).suggestions.filter((suggestion) => suggestion.speaker?.speaker === "s1")).toEqual([]);
  });

  it("face-speaker: needs one face over 60% of the speech, and a transcript of the content scanned", () => {
    const crowd = [scanned("assets/a.mp4", [track("t1", 0, 24, 0.3, print(0)), track("t2", 0, 24, 0.7, print(1))])];
    expect(suggest([], crowd).suggestions.filter((suggestion) => suggestion.kind === "face-speaker")).toEqual([]);
    const stale = suggest([], scans, new Map([["transcripts/a.words.json", interview("assets/a.mp4", "sha256:older")]]));
    expect(stale.suggestions.filter((suggestion) => suggestion.kind === "face-speaker")).toEqual([]);
    expect(stale.hints).toEqual(["transcripts/a.words.json is stale: assets/a.mp4 changed after it was transcribed: its speakers are not matched with faces."]);
  });

  it("face: asks who a face nobody has is once it is on screen long enough", () => {
    const faces = suggest([]).suggestions.filter((suggestion) => suggestion.kind === "face");
    expect(faces).toHaveLength(2);
    expect(faces[0]).not.toHaveProperty("person");
    expect(faces[0]).not.toHaveProperty("score");
    expect(faces[0]!.face!.seconds).toBeGreaterThanOrEqual(FACE_MIN_SCREEN_S);
    expect(faces[0]!.reason).toMatch(/^Who is this\?/);
    const short = [scanned("assets/a.mp4", [track("t1", 0, 5, 0.3, print(0))])];
    expect(suggest([], short).suggestions).toEqual([]);
  });

  it("face: names the person a face nobody has looks like, when close and clearly ahead", () => {
    const ana = person("p_ana", "Ana", { faces: [{ asset: "assets/a.mp4", at: 2, x: 0.3, y: 0.4 }] });
    // Close to Ana's face, but under the clustering line, so not merged with it.
    const later = scanned("assets/b.mp4", [track("t1", 0, 15, 0.5, print(5, 0, 0.42))]);
    const faces = suggest([ana], [...scans, later]).suggestions.filter((suggestion) => suggestion.kind === "face");
    expect(faces.find((suggestion) => suggestion.face!.anchor.asset === "assets/b.mp4")).toMatchObject({ person: { name: "Ana" }, score: 0.42, links: ["face"] });
    // The suggestion id is stable while the face's longest track stays.
    const again = suggest([ana], [...scans, later]).suggestions.filter((suggestion) => suggestion.kind === "face");
    expect(again.map((suggestion) => suggestion.id)).toEqual(faces.map((suggestion) => suggestion.id));
  });
});

describe("on-screen spans from faces", () => {
  const timeline = {
    schemaVersion: 1,
    id: "main",
    revision: 0,
    tracks: [
      {
        id: "t_v",
        kind: "video",
        clips: [
          { id: "c1", type: "media", asset: "assets/a.mp4", start: 0, in: 0, out: 4 },
          { id: "c2", type: "media", asset: "assets/a.mp4", start: 4, in: 10, out: 14, speed: 2 },
        ],
      },
    ],
  } as unknown as Timeline;

  it("places each video's face spans through the clips that show it", () => {
    const faces = new Map([["assets/a.mp4", [{ start: 1, end: 3 }, { start: 3.5, end: 12 }]]]);
    expect(faceSpans(timeline, faces)).toEqual([
      { start: 1, end: 3 },
      { start: 3.5, end: 4 },
      { start: 4, end: 5 },
    ]);
  });

  it("joins personRanges onscreen with the warnings of anchors that name no face", async () => {
    const ana = person("p_ana", "Ana");
    const found = await personRanges(ana, "onscreen", timeline, {
      transcript: () => null,
      turns: async () => ({ turns: [], warnings: [] }),
      faces: async () => ({ spans: new Map([["assets/a.mp4", [{ start: 1, end: 3 }]]]), warnings: ["one anchor"] }),
    });
    expect(found).toEqual({ spans: [{ start: 1, end: 3 }], total: 2, warnings: ["one anchor"] });
    expect((await personRanges(ana, "speaks", timeline, { transcript: () => null, turns: async () => ({ turns: [], warnings: [] }), faces: async () => ({ spans: new Map([["assets/a.mp4", [{ start: 1, end: 3 }]]]), warnings: [] }) })).spans).toEqual([]);
  });
});
