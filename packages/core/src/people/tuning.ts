// Tuning harness for the suggestion thresholds (ADR 0020 decision 15): replays the voice and face matching on
// material people confirmed, at many thresholds. Pure and read-only; it never changes a constant.
import type { TuneClusterRow, TuneDistribution, TuneFaces, TuneSweepRow, TuneVoice, TuneWrong } from "@frameshell/protocol";
import { FACE_CLUSTER_MATCH } from "./face-clusters.js";
import { FACE_PERSON_MARGIN, FACE_PERSON_MATCH } from "./face-suggest.js";
import { SPEAKER_MARGIN, SPEAKER_MATCH } from "./suggest.js";
import { clearMatch, cosine, cutLinkage, linkageMerges, meanDirection } from "./vector.js";
import { meanPrint } from "./voices.js";

/** A person as the harness reports them. */
export interface TuneWho {
  id: string;
  name: string;
}

/** A transcript speaker (or whole transcript) a person is linked to, with its cached voice print. */
export interface VoiceTuneSample {
  /** For reports, e.g. `transcripts/ep1.words.json:s1`. */
  key: string;
  person: TuneWho;
  print: readonly number[];
  /** Seconds of speech the print was made of: its weight in a person's voice, as in `people.suggest`. */
  seconds: number;
}

/** A face track with a print; `person` is the one whose face anchor names it, else null (it still shapes the clusters). */
export interface FaceTuneSample {
  /** For reports, e.g. `assets/ep1.mp4#t3`. */
  key: string;
  person: TuneWho | null;
  mean: Float32Array;
}

/** The thresholds a sweep tries. */
export interface TuneGrid {
  speakerMatch: readonly number[];
  speakerMargin: readonly number[];
  faceCluster: readonly number[];
  facePersonMatch: readonly number[];
  facePersonMargin: readonly number[];
}

const steps = (from: number, to: number, step: number): number[] => {
  const out: number[] = [];
  for (let i = 0; from + i * step <= to + 1e-9; i++) out.push(round(from + i * step, 2));
  return out;
};

/** Every constant's current value is on its line. */
export const DEFAULT_TUNE_GRID: TuneGrid = {
  speakerMatch: steps(0.3, 0.95, 0.05),
  speakerMargin: [0, 0.05, 0.1, 0.15, 0.2],
  faceCluster: steps(0.2, 0.8, 0.05),
  facePersonMatch: steps(0.2, 0.8, 0.05),
  facePersonMargin: [0, 0.05, 0.1, 0.15, 0.2],
};

/** One thing to match: its labelled person and every candidate person's score, best first. */
interface Case {
  subject: string;
  truth: TuneWho;
  ranked: { who: TuneWho; score: number }[];
}

/**
 * Voice matching on the linked speakers: each is matched the way `people.suggest` would match an unlinked one,
 * against every person's voice made of their other prints. A person with no other print is not among the
 * candidates, so any suggestion for that speaker is wrong.
 */
export function tuneVoices(samples: readonly VoiceTuneSample[], grid: Pick<TuneGrid, "speakerMatch" | "speakerMargin"> = DEFAULT_TUNE_GRID): TuneVoice | null {
  const people = new Set(samples.map((sample) => sample.person.id));
  if (people.size < 2) return null;
  const cases: Case[] = samples.map((sample) => {
    const byPerson = new Map<string, { who: TuneWho; others: VoiceTuneSample[] }>();
    for (const other of samples) {
      if (other === sample) continue;
      const entry = byPerson.get(other.person.id) ?? { who: other.person, others: [] };
      entry.others.push(other);
      byPerson.set(other.person.id, entry);
    }
    const ranked = [...byPerson.values()].flatMap(({ who, others }) => {
      const print = meanPrint(others.map((other) => other.print), others.map((other) => other.seconds));
      return print ? [{ who, score: cosine(print, sample.print) }] : [];
    });
    return { subject: sample.key, truth: sample.person, ranked: ranked.sort((a, b) => b.score - a.score) };
  });
  const pairs = scorePairs(samples.map((sample) => ({ person: sample.person.id, print: sample.print })));
  const current = { match: SPEAKER_MATCH, margin: SPEAKER_MARGIN };
  return {
    speakers: samples.length,
    people: people.size,
    usable: cases.filter(hasTruth).length,
    same: distribution(pairs.same),
    different: distribution(pairs.different),
    gap: gapOf(pairs),
    margin: distribution(truthMargins(cases)),
    current,
    rows: sweep(cases, grid.speakerMatch, grid.speakerMargin),
    wrong: wrongAt(cases, current),
  };
}

/**
 * Face matching on the tracks a face anchor names. Clusters: all tracks are linked once, then cut at every
 * `faceCluster` line, and the labelled tracks say how pure the clusters are and how many pieces a person falls
 * into. Suggestions: at the current {@link FACE_CLUSTER_MATCH}, each cluster holding one person's labelled tracks
 * is matched, as a cluster nobody has is in `people.suggest`, against everyone's labelled tracks outside it.
 */
export function tuneFaces(
  samples: readonly FaceTuneSample[],
  grid: Pick<TuneGrid, "faceCluster" | "facePersonMatch" | "facePersonMargin"> = DEFAULT_TUNE_GRID,
): TuneFaces | null {
  const labelled = samples.flatMap((sample, index) => (sample.person ? [{ index, person: sample.person }] : []));
  const people = new Set(labelled.map((entry) => entry.person.id));
  if (people.size < 2) return null;
  const merges = linkageMerges(samples.map((sample) => sample.mean));
  const clusterRows: TuneClusterRow[] = grid.faceCluster.map((match) => clusterRow(match, cutLinkage(samples.length, merges, { threshold: match }), samples));
  const pairs = scorePairs(labelled.map((entry) => ({ person: entry.person.id, print: samples[entry.index]!.mean })));

  const cases: Case[] = [];
  for (const group of cutLinkage(samples.length, merges, { threshold: FACE_CLUSTER_MATCH })) {
    const owners = new Map(group.flatMap((index) => (samples[index]!.person ? [[samples[index]!.person!.id, samples[index]!.person!] as const] : [])));
    if (owners.size !== 1) continue;
    const truth = [...owners.values()][0]!;
    const mean = meanDirection(group.map((index) => samples[index]!.mean));
    if (!mean) continue;
    const inside = new Set(group);
    const outside = new Map<string, { who: TuneWho; means: Float32Array[] }>();
    for (const { index, person } of labelled) {
      if (inside.has(index)) continue;
      const entry = outside.get(person.id) ?? { who: person, means: [] };
      entry.means.push(samples[index]!.mean);
      outside.set(person.id, entry);
    }
    const ranked = [...outside.values()].flatMap(({ who, means }) => {
      const print = meanDirection(means);
      return print ? [{ who, score: cosine(mean, print) }] : [];
    });
    const anchored = group.find((index) => samples[index]!.person)!;
    cases.push({ subject: `${samples[anchored]!.key} (+${group.length - 1} tracks)`, truth, ranked: ranked.sort((a, b) => b.score - a.score) });
  }
  const current = { match: FACE_PERSON_MATCH, margin: FACE_PERSON_MARGIN };
  return {
    tracks: labelled.length,
    people: people.size,
    same: distribution(pairs.same),
    different: distribution(pairs.different),
    gap: gapOf(pairs),
    clusterCurrent: FACE_CLUSTER_MATCH,
    clusterRows,
    person: {
      clusters: cases.length,
      usable: cases.filter(hasTruth).length,
      margin: distribution(truthMargins(cases)),
      current,
      rows: sweep(cases, grid.facePersonMatch, grid.facePersonMargin),
      wrong: wrongAt(cases, current),
    },
  };
}

function hasTruth(entry: Case): boolean {
  return entry.ranked.some((candidate) => candidate.who.id === entry.truth.id);
}

/** Per match and margin: what suggesting at those lines would have done (the rule of `people.suggest`, {@link clearMatch}). */
function sweep(cases: readonly Case[], matches: readonly number[], margins: readonly number[]): TuneSweepRow[] {
  const usable = cases.filter(hasTruth).length;
  const rows: TuneSweepRow[] = [];
  for (const match of matches) {
    for (const margin of margins) {
      let correct = 0;
      let wrong = 0;
      for (const entry of cases) {
        const [best, second] = entry.ranked;
        if (!best || !clearMatch(best.score, second?.score, match, margin)) continue;
        if (best.who.id === entry.truth.id) correct++;
        else wrong++;
      }
      const suggested = correct + wrong;
      rows.push({
        match,
        margin,
        suggested,
        correct,
        wrong,
        precision: suggested === 0 ? null : round(correct / suggested, 4),
        recall: usable === 0 ? null : round(correct / usable, 4),
      });
    }
  }
  return rows;
}

function wrongAt(cases: readonly Case[], line: { match: number; margin: number }): TuneWrong[] {
  const wrong: TuneWrong[] = [];
  for (const entry of cases) {
    const [best, second] = entry.ranked;
    if (!best || !clearMatch(best.score, second?.score, line.match, line.margin) || best.who.id === entry.truth.id) continue;
    wrong.push({ subject: entry.subject, expected: hasTruth(entry) ? entry.truth.name : "nobody", suggested: best.who.name, score: round(best.score, 4) });
  }
  return wrong.sort((a, b) => b.score - a.score);
}

/** For each case where the labelled person is a candidate and has a rival: their score minus the best rival's. */
function truthMargins(cases: readonly Case[]): number[] {
  return cases.flatMap((entry) => {
    const own = entry.ranked.find((candidate) => candidate.who.id === entry.truth.id);
    const rival = entry.ranked.find((candidate) => candidate.who.id !== entry.truth.id);
    return own && rival ? [own.score - rival.score] : [];
  });
}

function clusterRow(match: number, groups: readonly (readonly number[])[], samples: readonly FaceTuneSample[]): TuneClusterRow {
  let inBiggest = 0;
  let total = 0;
  let mixed = 0;
  const pieces = new Map<string, number>();
  for (const group of groups) {
    const counts = new Map<string, number>();
    for (const index of group) {
      const person = samples[index]!.person;
      if (person) counts.set(person.id, (counts.get(person.id) ?? 0) + 1);
    }
    if (counts.size === 0) continue;
    inBiggest += Math.max(...counts.values());
    total += [...counts.values()].reduce((sum, count) => sum + count, 0);
    if (counts.size > 1) mixed++;
    for (const id of counts.keys()) pieces.set(id, (pieces.get(id) ?? 0) + 1);
  }
  const splits = [...pieces.values()].reduce((sum, count) => sum + count - 1, 0);
  return { match, clusters: groups.length, purity: total === 0 ? null : round(inBiggest / total, 4), mixed, splits };
}

/** Cosine of every pair of prints, split by whether both are one person's. */
function scorePairs(items: readonly { person: string; print: ArrayLike<number> }[]): { same: number[]; different: number[] } {
  const same: number[] = [];
  const different: number[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) (items[i]!.person === items[j]!.person ? same : different).push(cosine(items[i]!.print, items[j]!.print));
  }
  return { same, different };
}

/** Lowest same-person score minus highest different-person score; null without both. */
function gapOf(pairs: { same: readonly number[]; different: readonly number[] }): number | null {
  if (pairs.same.length === 0 || pairs.different.length === 0) return null;
  return round(Math.min(...pairs.same) - Math.max(...pairs.different), 4);
}

/** Spread of `values` (linear-interpolated percentiles); null when empty. */
export function distribution(values: readonly number[]): TuneDistribution | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) => {
    const position = fraction * (sorted.length - 1);
    const low = Math.floor(position);
    const high = Math.ceil(position);
    return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
  };
  return {
    count: sorted.length,
    min: round(sorted[0]!, 4),
    p10: round(at(0.1), 4),
    median: round(at(0.5), 4),
    p90: round(at(0.9), 4),
    max: round(sorted[sorted.length - 1]!, 4),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length, 4),
  };
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
