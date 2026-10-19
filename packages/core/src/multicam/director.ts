import type { DirectorRules, ShotLayout } from "@frameshell/schema";

/**
 * The rule-based director (ADR 0016 decision 4): speaking turns on the group
 * clock in, shots out. Pure and deterministic: the same angles, turns, rules
 * and span always give the same shots. Steps, in order: laughter and long
 * overlaps; who speaks, silences; short overlaps and pauses keep the shot that
 * was on; quick exchanges; cut lead; minimum shot length; cutaways in long
 * solos; frame grid.
 */

/** One angle of the group as the director sees it, in group order. */
export interface DirectorAngle {
  /** Angle id in the group. */
  id: string;
  /** False: the file has no video stream, so no shot can show it. */
  picture: boolean;
}

/** A stretch of speech of one angle, group-clock seconds; see `Turn`. */
export interface DirectorTurn {
  /** Angle id in the group. */
  angle: string;
  /** Group-clock seconds. */
  start: number;
  /** Group-clock seconds; greater than `start`. */
  end: number;
}

/** What {@link directShots} works on. */
export interface DirectorInput {
  /** Every angle of the group, in group order. */
  angles: readonly DirectorAngle[];
  /** Speaking turns of the group's angles, any order; turns of unknown angles are ignored. */
  turns: readonly DirectorTurn[];
  /** Resolved rules (`resolveDirectorRules`). */
  rules: DirectorRules;
  /** Group-clock seconds where the span to fill starts. */
  from: number;
  /** Group-clock seconds where it ends; greater than `from`. */
  to: number;
  /** Puts a cut on the frame grid (group-clock seconds in, same clock out). Default: cuts stay where the rules put them. */
  snap?: (time: number) => number;
}

/** One shot the director chose, group-clock seconds. */
export interface DirectedShot {
  /** Group-clock seconds of the first frame. */
  in: number;
  /** Group-clock seconds just after the last frame. */
  out: number;
  /** Layout: `solo`, `two-up` or `grid`. */
  shot: ShotLayout;
  /** Angle ids in layout order (group order). */
  angles: string[];
  /** 0 (a guess) to 1 (sure), two decimals; see {@link directShots}. */
  confidence: number;
  /** Why, in a few words, e.g. `ana speaks`. */
  reason: string;
}

type Why = "speaks" | "exchange" | "overlap" | "laughter" | "silence" | "listener" | "wide" | "unclear" | "only";

interface Run {
  from: number;
  to: number;
  /** Null: no decision of its own; it keeps the shot that was on. */
  shot: ShotLayout | null;
  angles: string[];
  why: Why;
}

const EPSILON = 1e-6;

/**
 * Base confidence per reason, scaled by how much of the shot's speech the
 * shown people speak. A cutaway or a guess is low on purpose: rules cannot
 * see a reaction worth holding, so the agent reviews those.
 */
const BASE_CONFIDENCE: Record<Why, number> = {
  speaks: 0.95,
  exchange: 0.85,
  overlap: 0.85,
  laughter: 0.55,
  silence: 0.8,
  listener: 0.4,
  wide: 0.45,
  unclear: 0.3,
  only: 1,
};

/**
 * Shots covering `[from, to)` of the group clock without gaps, sorted.
 * Confidence: for a solo or two-up, the base for its reason times the share
 * of the speech in the shot that the shown people speak; for a silence wide,
 * times the share of the shot nobody speaks in. Throws when no angle has a picture.
 */
export function directShots(input: DirectorInput): DirectedShot[] {
  const { rules, from, to } = input;
  const pictured = input.angles.filter((angle) => angle.picture).map((angle) => angle.id);
  if (pictured.length === 0) throw new Error("no angle of the group has a picture");
  if (to - from <= EPSILON) return [];
  const order = new Map(input.angles.map((angle, index) => [angle.id, index]));
  const weight = (id: string) => rules.weights[id] ?? 1;
  const turns = input.turns
    .filter((turn) => order.has(turn.angle) && turn.end > from + EPSILON && turn.start < to - EPSILON)
    .map((turn) => ({ angle: turn.angle, start: Math.max(turn.start, from), end: Math.min(turn.end, to) }));
  if (pictured.length === 1) {
    return finish([{ from, to, shot: "solo", angles: pictured, why: "only" }], turns, input);
  }
  const eligible = new Set(pictured.filter((id) => weight(id) > 0));
  const byPreference = (ids: Iterable<string>) => [...ids].sort((a, b) => weight(b) - weight(a) || order.get(a)! - order.get(b)!);
  const inGroupOrder = (ids: string[]) => [...ids].sort((a, b) => order.get(a)! - order.get(b)!);

  // Elementary segments: who speaks is constant inside each.
  const cuts = [...new Set([from, to, ...turns.flatMap((turn) => [turn.start, turn.end])])].sort((a, b) => a - b);
  const index = new Map(cuts.map((time, i) => [time, i]));
  const segments = cuts.slice(0, -1).map((start, i) => ({ from: start, to: cuts[i + 1]!, talking: [] as string[] }));
  for (const turn of turns) for (let i = index.get(turn.start)!; i < index.get(turn.end)!; i++) segments[i]!.talking.push(turn.angle);
  for (const segment of segments) segment.talking = inGroupOrder(segment.talking);

  // Laughter or cross-talk first: it wins over every per-person rule.
  const together = Math.min(rules.wide.together, pictured.length);
  const laughing = segments.map(() => false);
  if (rules.wide.laughter !== null) {
    for (const [first, last] of spans(segments.map((segment) => segment.talking.length >= together))) {
      if (segments[last]!.to - segments[first]!.from >= rules.wide.laughter - EPSILON) for (let i = first; i <= last; i++) laughing[i] = true;
    }
  }
  const intents: Run[] = segments.map((segment, i) => {
    if (laughing[i]) return { from: segment.from, to: segment.to, shot: "grid", angles: pictured, why: "laughter" };
    const shown = segment.talking.filter((id) => eligible.has(id));
    if (shown.length >= 2) return { from: segment.from, to: segment.to, shot: "two-up", angles: inGroupOrder(byPreference(shown).slice(0, 2)), why: "overlap" };
    if (shown.length === 1) return { from: segment.from, to: segment.to, shot: "solo", angles: shown, why: "speaks" };
    if (segment.talking.length === 0) return { from: segment.from, to: segment.to, shot: "grid", angles: pictured, why: "silence" };
    return { from: segment.from, to: segment.to, shot: null, angles: [], why: "unclear" };
  });
  let runs = mergeSame(intents);

  // Short overlaps and pauses keep the shot that was on.
  for (const run of runs) {
    const length = run.to - run.from;
    if (run.why === "overlap" && (rules.twoShot.overlap === null || length < rules.twoShot.overlap - EPSILON)) run.shot = null;
    if (run.why === "silence" && (rules.wide.silence === null || length < rules.wide.silence - EPSILON)) run.shot = null;
  }
  runs = holdPrevious(runs, pictured);

  if (rules.twoShot.exchange !== null) runs = mergeSame(exchanges(runs, rules.twoShot.exchange, inGroupOrder));

  if (rules.cutLead > 0) {
    for (let i = 1; i < runs.length; i++) {
      const run = runs[i]!;
      if (run.shot !== "solo" && run.shot !== "two-up") continue;
      const shift = Math.min(rules.cutLead, (run.to - run.from) / 2);
      run.from += shift;
      runs[i - 1]!.to = run.from;
    }
  }

  runs = absorbShort(runs, rules.minShot);
  if (rules.maxShot !== null) runs = cutaways(runs, rules, pictured, (speaker) => byPreference([...eligible].filter((id) => id !== speaker))[0]);
  return finish(runs, turns, input);
}

/** `[first, last]` index ranges of consecutive trues. */
function spans(flags: boolean[]): [number, number][] {
  const out: [number, number][] = [];
  flags.forEach((flag, i) => {
    if (!flag) return;
    const last = out.at(-1);
    if (last && last[1] === i - 1) last[1] = i;
    else out.push([i, i]);
  });
  return out;
}

const samePicture = (a: Run, b: Run) => a.shot === b.shot && a.angles.length === b.angles.length && a.angles.every((id, i) => b.angles[i] === id);

/** Neighbours showing the same picture become one run; it keeps the reason of the longer part. */
function mergeSame(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    const last = out.at(-1);
    if (last && samePicture(last, run)) {
      if (run.to - run.from > last.to - last.from) last.why = run.why;
      last.to = run.to;
    } else {
      out.push({ ...run, angles: [...run.angles] });
    }
  }
  return out;
}

/** Runs without a decision join the run before them (the first ones the run after); all undecided: one guessed wide. */
function holdPrevious(runs: Run[], pictured: string[]): Run[] {
  const decided = runs.filter((run) => run.shot !== null);
  if (decided.length === 0) return [{ from: runs[0]!.from, to: runs.at(-1)!.to, shot: "grid", angles: pictured, why: "unclear" }];
  const out: Run[] = [];
  for (const run of runs) {
    const last = out.at(-1);
    if (run.shot !== null) out.push({ ...run, from: last ? run.from : runs[0]!.from });
    else if (last) last.to = run.to;
  }
  return mergeSame(out);
}

/** Three or more solos in a row alternating between the same two people, each shorter than `under`: one two-up. */
function exchanges(runs: Run[], under: number, inGroupOrder: (ids: string[]) => string[]): Run[] {
  const quick = (run: Run | undefined) => run !== undefined && run.shot === "solo" && run.to - run.from < under - EPSILON;
  const out: Run[] = [];
  let i = 0;
  while (i < runs.length) {
    let j = i;
    if (quick(runs[i])) {
      const pair = new Set([runs[i]!.angles[0]!]);
      while (quick(runs[j + 1]) && runs[j + 1]!.angles[0] !== runs[j]!.angles[0]) {
        pair.add(runs[j + 1]!.angles[0]!);
        if (pair.size > 2) {
          pair.delete(runs[j + 1]!.angles[0]!);
          break;
        }
        j++;
      }
      if (j - i >= 2) {
        out.push({ from: runs[i]!.from, to: runs[j]!.to, shot: "two-up", angles: inGroupOrder([...pair]), why: "exchange" });
        i = j + 1;
        continue;
      }
    }
    out.push(runs[i]!);
    i++;
  }
  return out;
}

/** Shortest first, every run under `min` joins the run before it (the first one the run after), until none is left or one run remains. */
function absorbShort(input: Run[], min: number): Run[] {
  let runs = input;
  while (runs.length > 1) {
    let shortest = -1;
    for (const [i, run] of runs.entries()) {
      const length = run.to - run.from;
      if (length < min - EPSILON && (shortest < 0 || length < runs[shortest]!.to - runs[shortest]!.from - EPSILON)) shortest = i;
    }
    if (shortest < 0) break;
    const run = runs[shortest]!;
    if (shortest > 0) runs[shortest - 1]!.to = run.to;
    else runs[1]!.from = run.from;
    runs = mergeSame(runs.filter((_, i) => i !== shortest));
  }
  return runs;
}

/** Solos longer than `maxShot` cut away every `maxShot` seconds, unless what follows the cutaway would be shorter than `minShot`. */
function cutaways(runs: Run[], rules: DirectorRules, pictured: string[], listenerOf: (speaker: string) => string | undefined): Run[] {
  const max = rules.maxShot!;
  const { length } = rules.cutaway;
  const out: Run[] = [];
  for (const run of runs) {
    if (run.shot !== "solo" || run.to - run.from <= max + EPSILON) {
      out.push(run);
      continue;
    }
    const speaker = run.angles[0]!;
    const listener = rules.cutaway.to === "listener" ? listenerOf(speaker) : undefined;
    const away: Pick<Run, "shot" | "angles" | "why"> = listener
      ? { shot: "solo", angles: [listener], why: "listener" }
      : { shot: "grid", angles: pictured, why: "wide" };
    let at = run.from;
    while (run.to - (at + max + length) >= Math.max(rules.minShot, EPSILON)) {
      out.push({ ...run, from: at, to: at + max });
      out.push({ ...away, from: at + max, to: at + max + length });
      at += max + length;
    }
    out.push({ ...run, from: at });
  }
  return out;
}

/** Cuts on the frame grid, then confidence and reason per shot. */
function finish(runs: Run[], turns: DirectorTurn[], input: DirectorInput): DirectedShot[] {
  const snap = input.snap ?? ((time: number) => time);
  const edges = runs.map((run, i) => (i === 0 ? input.from : Math.min(Math.max(snap(run.from), input.from), input.to)));
  edges.push(input.to);
  for (let i = 1; i < edges.length; i++) edges[i] = Math.max(edges[i]!, edges[i - 1]!);
  const placed: Run[] = [];
  for (const [i, run] of runs.entries()) {
    if (edges[i + 1]! - edges[i]! <= EPSILON) continue;
    const last = placed.at(-1);
    if (last) last.to = edges[i]!;
    placed.push({ ...run, from: placed.length === 0 ? input.from : edges[i]!, to: edges[i + 1]! });
  }
  return mergeSame(placed).map((run) => ({
    in: run.from,
    out: run.to,
    shot: run.shot!,
    angles: run.angles,
    confidence: confidenceOf(run, turns),
    reason: reasonOf(run),
  }));
}

function confidenceOf(run: Run, turns: DirectorTurn[]): number {
  const base = BASE_CONFIDENCE[run.why];
  const speech = new Map<string, number>();
  const pieces: [number, number][] = [];
  for (const turn of turns) {
    const start = Math.max(turn.start, run.from);
    const end = Math.min(turn.end, run.to);
    if (end <= start) continue;
    speech.set(turn.angle, (speech.get(turn.angle) ?? 0) + end - start);
    pieces.push([start, end]);
  }
  const total = [...speech.values()].reduce((sum, value) => sum + value, 0);
  let share = 1;
  if (run.why === "speaks" || run.why === "exchange" || run.why === "overlap") {
    share = total > 0 ? run.angles.reduce((sum, id) => sum + (speech.get(id) ?? 0), 0) / total : 0.5;
  } else if (run.why === "silence") {
    share = 1 - covered(pieces) / (run.to - run.from);
  }
  return Math.round(Math.min(1, Math.max(0, base * share)) * 100) / 100;
}

/** Length of the union of `pieces`. */
function covered(pieces: [number, number][]): number {
  let sum = 0;
  let reach = Number.NEGATIVE_INFINITY;
  for (const [start, end] of [...pieces].sort((a, b) => a[0] - b[0])) {
    if (end <= reach) continue;
    sum += end - Math.max(start, reach);
    reach = end;
  }
  return sum;
}

function reasonOf(run: Run): string {
  const [a, b] = run.angles;
  switch (run.why) {
    case "speaks":
      return `${a} speaks`;
    case "exchange":
      return `quick exchange ${a}/${b}`;
    case "overlap":
      return `${a} and ${b} talk at once`;
    case "laughter":
      return "laughter or cross-talk";
    case "silence":
      return "silence";
    case "listener":
      return `long turn: ${a} listens`;
    case "wide":
      return "long turn: wide";
    case "unclear":
      return "no clear speaker";
    case "only":
      return "only angle with a picture";
  }
}
