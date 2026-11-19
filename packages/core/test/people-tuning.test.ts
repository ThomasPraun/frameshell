import { describe, expect, it } from "vitest";
import { FACE_CLUSTER_MATCH, SPEAKER_MARGIN, SPEAKER_MATCH, type FaceTuneSample, type VoiceTuneSample, averageLinkage, cutLinkage, distribution, linkageMerges, tuneFaces, tuneVoices } from "../src/index.js";

// The tuning harness (ADR 0020 decision 15) on hand-made vectors whose cosines are known: unit vectors in the plane
// at an angle, so two of them are `cos(difference)` apart.

const at = (degrees: number): number[] => [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180), 0, 0];

const A = { id: "p_a", name: "Ana" };
const B = { id: "p_b", name: "Beto" };
const C = { id: "p_c", name: "Cleo" };

function voice(key: string, person: { id: string; name: string }, degrees: number): VoiceTuneSample {
  return { key, person, print: at(degrees), seconds: 10 };
}

function face(key: string, person: { id: string; name: string } | null, degrees: number): FaceTuneSample {
  return { key, person, mean: Float32Array.from(at(degrees)) };
}

const row = <T extends { match: number; margin?: number }>(rows: readonly T[], match: number, margin = 0): T => rows.find((r) => r.match === match && (r.margin ?? 0) === margin)!;

describe("tuneVoices", () => {
  const apart = [voice("a0", A, 0), voice("a1", A, 10), voice("a2", A, 20), voice("b0", B, 90), voice("b1", B, 100), voice("b2", B, 110)];

  it("separates two clear voices and says where the line can go", () => {
    const result = tuneVoices(apart, { speakerMatch: [0.5, 0.95, 0.98], speakerMargin: [0] })!;
    expect(result.speakers).toBe(6);
    expect(result.people).toBe(2);
    expect(result.usable).toBe(6);
    // Same-person prints are at most 20 degrees apart, different ones at least 70: cos 0.94 against 0.34.
    expect(result.same!.count).toBe(6);
    expect(result.different!.count).toBe(9);
    expect(result.same!.min).toBeCloseTo(Math.cos((20 * Math.PI) / 180), 3);
    expect(result.different!.max).toBeCloseTo(Math.cos((70 * Math.PI) / 180), 3);
    expect(result.gap).toBeGreaterThan(0.5);
    // Each print against the mean of its person's other two: 5 or 15 degrees away.
    expect(row(result.rows, 0.5)).toMatchObject({ suggested: 6, correct: 6, wrong: 0, precision: 1, recall: 1 });
    expect(row(result.rows, 0.95)).toMatchObject({ suggested: 6, correct: 6, wrong: 0 });
    // Above cos 15 degrees (0.966) only the middle print of each person still matches.
    expect(row(result.rows, 0.98)).toMatchObject({ suggested: 2, correct: 2, wrong: 0, precision: 1, recall: 0.3333 });
    expect(result.wrong).toEqual([]);
  });

  it("finds the line that keeps an impostor out: wrong below it, none above", () => {
    // Cleo has one print, so no voice of hers exists to match: any suggestion for it is wrong. It sounds like Ana (30 degrees).
    const result = tuneVoices([...apart, voice("c0", C, 40)], { speakerMatch: [0.5, 0.8, 0.9], speakerMargin: [0, 0.2] })!;
    expect(result.speakers).toBe(7);
    expect(result.usable).toBe(6);
    expect(row(result.rows, 0.8)).toMatchObject({ suggested: 7, correct: 6, wrong: 1, precision: 0.8571, recall: 1 });
    expect(row(result.rows, 0.9)).toMatchObject({ suggested: 6, correct: 6, wrong: 0, precision: 1, recall: 1 });
    // A margin of 0.2 also drops the Ana print that is not far enough ahead of Cleo.
    expect(row(result.rows, 0.9, 0.2).recall).toBeLessThan(1);
    expect(row(result.rows, 0.9, 0.2).wrong).toBe(0);
  });

  it("reports the wrong suggestions of the current constants, with the person it should have been", () => {
    const result = tuneVoices([...apart, voice("c0", C, 20)], { speakerMatch: [SPEAKER_MATCH], speakerMargin: [SPEAKER_MARGIN] })!;
    expect(result.current).toEqual({ match: SPEAKER_MATCH, margin: SPEAKER_MARGIN });
    // c0 (20 degrees) is as close to Ana as her own prints: 0.88 and up for her mean, B far.
    expect(result.wrong).toHaveLength(1);
    expect(result.wrong[0]).toMatchObject({ subject: "c0", expected: "nobody", suggested: "Ana" });
    expect(result.wrong[0]!.score).toBeGreaterThan(SPEAKER_MATCH);
  });

  it("gives the margin of each print's person over the best other person", () => {
    const result = tuneVoices(apart, { speakerMatch: [0.5], speakerMargin: [0] })!;
    expect(result.margin!.count).toBe(6);
    expect(result.margin!.min).toBeGreaterThan(0.7);
  });

  it("is null with fewer than two people", () => {
    expect(tuneVoices([voice("a0", A, 0), voice("a1", A, 10)])).toBeNull();
    expect(tuneVoices([])).toBeNull();
  });

  it("weights a person's other prints by their seconds, as the suggestion does", () => {
    const heavy: VoiceTuneSample[] = [
      { key: "a0", person: A, print: at(0), seconds: 1 },
      { key: "a1", person: A, print: at(60), seconds: 1 },
      { key: "a2", person: A, print: at(0), seconds: 100 },
      voice("b0", B, 150),
      voice("b1", B, 160),
    ];
    // a0 is matched against a1 (60 degrees, 1 s) and a2 (0 degrees, 100 s): weighted, about 0 degrees away; unweighted, 30.
    const result = tuneVoices(heavy, { speakerMatch: [0.95], speakerMargin: [0] })!;
    expect(row(result.rows, 0.95).correct).toBe(3);
  });
});

describe("tuneFaces", () => {
  const faces = [face("a0", A, 0), face("a1", A, 5), face("a2", A, 10), face("b0", B, 90), face("b1", B, 95), face("b2", B, 100), face("u", null, 45)];

  it("sweeps the cluster cut: purity, mixed clusters and split people", () => {
    const result = tuneFaces(faces, { faceCluster: [0.1, 0.5, 0.999], facePersonMatch: [0.5], facePersonMargin: [0] })!;
    expect(result.tracks).toBe(6);
    expect(result.people).toBe(2);
    expect(result.clusterCurrent).toBe(FACE_CLUSTER_MATCH);
    // Everything one cluster: Ana and Beto merged, half of the labelled tracks sit in the biggest person.
    expect(row(result.clusterRows, 0.1)).toMatchObject({ clusters: 1, mixed: 1, purity: 0.5, splits: 0 });
    // Between: the unlabelled middle track joins one side, nobody is mixed or split.
    expect(row(result.clusterRows, 0.5)).toMatchObject({ clusters: 2, mixed: 0, purity: 1, splits: 0 });
    // Above any pair's similarity: every track alone, each person in three pieces.
    expect(row(result.clusterRows, 0.999)).toMatchObject({ clusters: 7, mixed: 0, purity: 1, splits: 4 });
  });

  it("matches the same clusters as averageLinkage does at every cut", () => {
    const vectors = faces.map((sample) => sample.mean);
    const merges = linkageMerges(vectors);
    for (const threshold of [0.1, 0.3, 0.5, 0.9, 0.999]) {
      expect(cutLinkage(vectors.length, merges, { threshold })).toEqual(averageLinkage(vectors, { threshold }));
    }
    expect(cutLinkage(vectors.length, merges, { count: 2 })).toEqual(averageLinkage(vectors, { count: 2 }));
  });

  it("matches each cluster to a person from the labelled tracks outside it", () => {
    // Ana looks different in two shots (80 degrees apart, cos 0.17), Beto is the other way round.
    const split = [face("a0", A, 0), face("a1", A, 2), face("a2", A, 78), face("a3", A, 80), face("b0", B, 170), face("b1", B, 172)];
    const result = tuneFaces(split, { faceCluster: [FACE_CLUSTER_MATCH], facePersonMatch: [0.1, 0.3], facePersonMargin: [0] })!;
    expect(result.person.clusters).toBe(3);
    // Beto's cluster has no other track of his to be matched with.
    expect(result.person.usable).toBe(2);
    expect(row(result.person.rows, 0.1)).toMatchObject({ suggested: 2, correct: 2, wrong: 0, precision: 1, recall: 1 });
    expect(row(result.person.rows, 0.3)).toMatchObject({ suggested: 0, correct: 0, recall: 0 });
    expect(result.person.margin!.count).toBe(2);
    expect(result.person.margin!.min).toBeGreaterThan(0.2);
  });

  it("counts a suggestion for someone with nothing else to match as wrong", () => {
    const result = tuneFaces(faces, { faceCluster: [FACE_CLUSTER_MATCH], facePersonMatch: [0.1], facePersonMargin: [0] })!;
    // Ana's cluster has only Beto to match, and Beto's only Ana: nobody is the right answer, any name is wrong.
    // Ana's cluster is 85 degrees from Beto's tracks (0.17 and up) and Beto's 90 from Ana's (0): only the first is suggested.
    expect(result.person.usable).toBe(0);
    expect(row(result.person.rows, 0.1)).toMatchObject({ suggested: 1, correct: 0, wrong: 1, precision: 0, recall: null });
  });

  it("is null with fewer than two labelled people", () => {
    expect(tuneFaces([face("a0", A, 0), face("a1", A, 5), face("u", null, 50)])).toBeNull();
  });
});

describe("distribution", () => {
  it("reads the spread of a list, null when empty", () => {
    expect(distribution([])).toBeNull();
    expect(distribution([5, 1, 3, 2, 4])).toEqual({ count: 5, min: 1, p10: 1.4, median: 3, p90: 4.6, max: 5, mean: 3 });
  });
});
