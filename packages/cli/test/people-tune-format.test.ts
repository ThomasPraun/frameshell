import { type PeopleTuneResult, TuneDistributionSchema } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { formatTune } from "../src/people-commands.js";

// The text of `frameshell people tune` from a hand-made result: no daemon.

const spread = TuneDistributionSchema.parse({ count: 4, min: 0.5, p10: 0.55, median: 0.7, p90: 0.9, max: 0.95, mean: 0.72 });
const row = (match: number, margin: number, correct: number, wrong: number) => ({
  match,
  margin,
  suggested: correct + wrong,
  correct,
  wrong,
  precision: correct + wrong === 0 ? null : correct / (correct + wrong),
  recall: correct / 4,
});

const result: PeopleTuneResult = {
  dir: "/p",
  voice: {
    speakers: 5,
    people: 2,
    usable: 4,
    same: spread,
    different: { ...spread, max: 0.4 },
    gap: 0.1,
    margin: spread,
    current: { match: 0.7, margin: 0.1 },
    rows: [row(0.7, 0, 4, 1), row(0.7, 0.1, 3, 0), row(0.9, 0, 1, 0), row(0.9, 0.1, 0, 0)],
    wrong: [{ subject: "transcripts/ep2.words.json:s2", expected: "nobody", suggested: "Ana", score: 0.74 }],
  },
  faces: {
    tracks: 6,
    people: 2,
    same: spread,
    different: null,
    gap: null,
    clusterCurrent: 0.45,
    clusterRows: [
      { match: 0.45, clusters: 3, purity: 1, mixed: 0, splits: 1 },
      { match: 0.6, clusters: 5, purity: null, mixed: 0, splits: 0 },
    ],
    person: { clusters: 3, usable: 2, margin: spread, current: { match: 0.4, margin: 0.1 }, rows: [row(0.4, 0.1, 2, 0)], wrong: [] },
  },
  timings: { voicesMs: 12, facesMs: 340, sweepMs: 8 },
  hints: ["No video has a face scan: frameshell people scan"],
};

describe("formatTune", () => {
  const text = formatTune(result);

  it("shows the spreads, the wrong suggestions of the current constants and a grid with the current cell marked", () => {
    expect(text).toContain("Voices: 5 linked speakers of 2 people (4 with another print of their person to match)");
    expect(text).toContain("same       n=4  min 0.50  p10 0.55  median 0.70  p90 0.90  max 0.95");
    expect(text).toContain("different  none");
    expect(text).toContain("now: SPEAKER_MATCH 0.7, SPEAKER_MARGIN 0.1; 1 wrong suggestion");
    expect(text).toContain("transcripts/ep2.words.json:s2 is nobody, suggested Ana (0.74)");
    expect(text).toMatch(/0\.70 +4\/1 +3\/0\*/);
    expect(text).toMatch(/0\.90 +1\/0 +0\/0/);
  });

  it("shows the cluster sweep with the current cut starred, the hints and the timings", () => {
    expect(text).toContain("Faces: 6 anchored face tracks of 2 people");
    expect(text).toMatch(/\* 0\.45 +3 +1\.000 +0 +1/);
    expect(text).toMatch(/ 0\.60 +5 +n\/a +0 +0/);
    expect(text).toContain("hint: No video has a face scan: frameshell people scan");
    expect(text).toContain("Read in 12 ms (voices), 340 ms (faces); sweeps 8 ms. Nothing was changed.");
  });

  it("says there is nothing to tune when neither part could be compared", () => {
    expect(formatTune({ ...result, voice: null, faces: null })).toContain("Nothing to tune yet.");
  });
});
