import { describe, expect, it } from "vitest";
import { ENERGY_HOP_S, type SpeechAudio, type SpeechWord, planCleanup, profileLevel } from "../src/index.js";

// Seam under test: planCleanup(words, audio, options) on a synthetic envelope: voiced stretches at -20 dB, the rest
// at -70 dB, quiet threshold -45 dB. Word times are written by hand, so each case knows what the audio says.

const FPS = 30;
const TOTAL_S = 12;

/** Audio that is loud exactly inside `voiced` (timeline seconds) and quiet elsewhere in [0, TOTAL_S). */
function audioOf(voiced: [number, number][], covered: [number, number] = [0, TOTAL_S]): SpeechAudio {
  const db = new Float32Array(Math.round(TOTAL_S / ENERGY_HOP_S));
  for (let i = 0; i < db.length; i++) {
    const t = (i + 0.5) * ENERGY_HOP_S;
    db[i] = voiced.some(([a, b]) => t >= a && t < b) ? -20 : -70;
  }
  const profile = { db, threshold: -45 };
  return {
    level: (t) => (t >= covered[0] && t < covered[1] ? profileLevel(profile, t) : Number.POSITIVE_INFINITY),
    covers: (from, to) => from >= covered[0] - 1e-6 && to <= covered[1] + 1e-6,
  };
}

let next = 0;
const word = (text: string, at: number, end: number, extra: Partial<SpeechWord> = {}): SpeechWord => ({
  id: `w_${String(++next).padStart(6, "0")}`,
  text,
  transcript: "transcripts/talk.words.json",
  speaker: null,
  at,
  end,
  speechInside: false,
  ...extra,
});

/** Words and the audio that voices exactly them. */
function said(words: SpeechWord[]) {
  return { words, audio: audioOf(words.map((w) => [w.at, w.end])) };
}

describe("planCleanup pauses", () => {
  it("cuts a pause confirmed by the audio and leaves a breath on each side, on the frame grid", () => {
    const { words, audio } = said([word("hola", 1.0, 1.5), word("mundo", 2.5, 3.0)]);
    const { cuts, skipped } = planCleanup(words, audio, { fps: FPS });
    expect(skipped).toEqual([]);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toMatchObject({ kind: "pause", start: 1.6, end: 2.4, duration: 0.8, words: [], clean: true, confidence: 1 });
    expect(cuts[0]!.reason).toContain("hola");
    expect(cuts[0]!.reason).toContain("mundo");
    expect(Math.round(cuts[0]!.start * FPS)).toBeCloseTo(cuts[0]!.start * FPS, 6);
  });

  it("takes the edges from the audio when the word times are off", () => {
    // whisper holds "hola" until 1.9; the voice stops at 1.5 and starts again at 2.3.
    const words = [word("hola", 1.0, 1.9), word("mundo", 2.4, 3.0)];
    const { cuts } = planCleanup(words, audioOf([[1.0, 1.5], [2.3, 3.0]]), { fps: FPS });
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.start).toBeGreaterThanOrEqual(1.6 - 1 / FPS);
    expect(cuts[0]!.start).toBeLessThan(1.9);
    expect(cuts[0]!.end).toBeLessThanOrEqual(2.2 + 1 / FPS);
  });

  it("honours --pauses and --breath", () => {
    const { words, audio } = said([word("uno", 1.0, 1.5), word("dos", 2.0, 2.5), word("tres", 3.5, 4.0)]);
    expect(planCleanup(words, audio, { fps: FPS, pauses: 0.4 }).cuts).toHaveLength(2);
    const longer = planCleanup(words, audio, { fps: FPS, pauses: 0.8 });
    expect(longer.cuts).toHaveLength(1);
    expect(longer.cuts[0]!.start).toBeGreaterThan(2.5);
    const tight = planCleanup(words, audio, { fps: FPS, pauses: 0.8, breath: 0.3 }).cuts[0]!;
    const loose = planCleanup(words, audio, { fps: FPS, pauses: 0.8, breath: 0.05 }).cuts[0]!;
    expect(tight.duration).toBeLessThan(loose.duration);
    expect(tight.start - 2.5).toBeGreaterThanOrEqual(0.3 - 1 / FPS);
    expect(3.5 - tight.end).toBeGreaterThanOrEqual(0.3 - 1 / FPS);
  });

  it("leaves a gap alone when the audio there is not quiet", () => {
    const words = [word("hola", 1.0, 1.5), word("mundo", 2.5, 3.0)];
    const music = audioOf([[1.0, 3.0]]);
    const plan = planCleanup(words, music, { fps: FPS });
    expect(plan.cuts).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]).toMatchObject({ kind: "pause" });
    expect(plan.skipped[0]!.reason).toContain("not quiet");
  });

  it("leaves a gap alone when the speech clips do not cover it", () => {
    const words = [word("hola", 1.0, 1.5), word("mundo", 2.5, 3.0)];
    const audio = audioOf([[1.0, 1.5], [2.5, 3.0]]);
    const plan = planCleanup(words, { ...audio, covers: () => false }, { fps: FPS });
    expect(plan.cuts).toEqual([]);
    expect(plan.skipped[0]!.reason).toContain("other material");
  });

  it("never cuts beside a word that hides speech", () => {
    const { words, audio } = said([word("hola", 1.0, 1.5, { speechInside: true }), word("mundo", 2.5, 3.0)]);
    const plan = planCleanup(words, audio, { fps: FPS });
    expect(plan.cuts).toEqual([]);
    expect(plan.skipped[0]!.reason).toContain("hides speech");
  });

  it("ignores gaps under the threshold", () => {
    const { words, audio } = said([word("a", 1.0, 1.4), word("b", 1.7, 2.0)]);
    expect(planCleanup(words, audio, { fps: FPS }).cuts).toEqual([]);
  });

  it("measures a gap from the word that ends last when speakers overlap", () => {
    const { words, audio } = said([word("largo", 1.0, 3.0, { speaker: "s1" }), word("si", 1.2, 1.4, { speaker: "s2" }), word("fin", 3.1, 3.5, { speaker: "s1" })]);
    const plan = planCleanup(words, audio, { fps: FPS });
    expect(plan.cuts).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  it("cuts after the word that ends last, not the one before the gap", () => {
    // "largo" runs to 3.0 under "si"; the voice is quiet from 3.0 to 4.0, so the pause starts at 3.0, not at 1.4.
    const words = [word("largo", 1.0, 3.0, { speaker: "s1" }), word("si", 1.2, 1.4, { speaker: "s2" }), word("fin", 4.0, 4.4, { speaker: "s1" })];
    const { cuts } = planCleanup(words, audioOf([[1.0, 3.0], [4.0, 4.4]]), { fps: FPS });
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.start).toBeGreaterThanOrEqual(3.0);
  });
});

describe("planCleanup retakes", () => {
  // okay | pause | so the key | pause | so the key idea
  const say = () =>
    said([
      word("okay", 0.0, 0.3),
      word("so", 0.8, 1.0),
      word("the", 1.0, 1.2),
      word("key", 1.2, 1.5),
      word("so", 2.1, 2.3),
      word("the", 2.3, 2.5),
      word("key", 2.5, 2.8),
      word("idea", 2.8, 3.2),
    ]);

  it("is off unless asked for", () => {
    const { words, audio } = say();
    expect(planCleanup(words, audio, { fps: FPS }).cuts.map((cut) => cut.kind)).toEqual(["pause", "pause"]);
  });

  it("cuts the earlier attempt and keeps the last, edges in the pauses around it", () => {
    const { words, audio } = say();
    const { cuts } = planCleanup(words, audio, { fps: FPS, retakes: true });
    expect(cuts).toHaveLength(1);
    const [cut] = cuts;
    expect(cut).toMatchObject({ kind: "retake", clean: true });
    expect(cut!.words.map((w) => w.text)).toEqual(["so", "the", "key"]);
    expect(cut!.transcript).toBe("transcripts/talk.words.json");
    // The breath of the pause before the first attempt (0.3 to 0.8) and of the one before the kept one (1.5 to 2.1).
    expect(cut!.start).toBeCloseTo(0.4, 2);
    expect(cut!.end).toBeCloseTo(2.0, 2);
    expect(cut!.confidence).toBeGreaterThanOrEqual(0.8);
    expect(cut!.reason).toContain("so the key");
  });

  it("drops the pauses a retake covers and keeps the others", () => {
    const { words, audio } = said([...say().words, word("fin", 5.0, 5.4)]);
    const kinds = planCleanup(words, audio, { fps: FPS, retakes: true }).cuts.map((cut) => cut.kind);
    expect(kinds).toEqual(["retake", "pause"]);
  });

  it("reports the pauses a retake covers under it, for a caller that drops the retake", () => {
    const { words, audio } = say();
    const { cuts, absorbed } = planCleanup(words, audio, { fps: FPS, retakes: true });
    const retake = cuts.find((cut) => cut.kind === "retake")!;
    expect(absorbed.get(retake)).toHaveLength(2);
    expect(absorbed.get(retake)!.every((pause) => pause.kind === "pause")).toBe(true);
  });

  it("keeps the pauses around a retake that is under the confidence floor", () => {
    // A lone "muy" said again with no stop between: 0.35, under the default floor of 0.5.
    const { words, audio } = said([word("okay", 0, 0.3), word("muy", 1.0, 1.3), word("muy", 1.4, 1.7), word("bien", 3.0, 3.4)]);
    const plan = planCleanup(words, audio, { fps: FPS, retakes: true });
    expect(plan.cuts.map((cut) => cut.kind)).toEqual(["pause", "pause"]);
    expect(plan.skipped.some((entry) => entry.kind === "retake" && entry.reason.includes("confidence"))).toBe(true);
    const without = planCleanup(words, audio, { fps: FPS });
    expect(plan.cuts).toEqual(without.cuts);
  });

  it("leaves a retake out when its words come from two transcripts", () => {
    const { words, audio } = said([
      word("okay", 0, 0.3),
      word("la", 0.8, 1.0),
      word("idea", 1.0, 1.4, { transcript: "transcripts/other.words.json" }),
      word("la", 1.9, 2.1),
      word("idea", 2.1, 2.5),
    ]);
    const plan = planCleanup(words, audio, { fps: FPS, retakes: true, pauses: false });
    expect(plan.cuts).toEqual([]);
    expect(plan.skipped[0]!.reason).toContain("two transcripts");
  });

  it("can run without pauses", () => {
    const { words, audio } = say();
    expect(planCleanup(words, audio, { fps: FPS, retakes: true, pauses: false }).cuts.map((cut) => cut.kind)).toEqual(["retake"]);
  });

  it("matches spelling variants and a cut-off last word", () => {
    const { words, audio } = said([
      word("Okay,", 0.0, 0.3),
      word("Hola", 0.8, 1.0),
      word("a", 1.0, 1.1),
      word("to-", 1.1, 1.3),
      word("hola", 2.0, 2.2),
      word("a", 2.2, 2.3),
      word("todos", 2.3, 2.8),
    ]);
    const cut = planCleanup(words, audio, { fps: FPS, retakes: true, pauses: false }).cuts[0];
    expect(cut?.words.map((w) => w.text)).toEqual(["Hola", "a", "to-"]);
  });

  it("allows a word between the attempts, at a lower confidence", () => {
    const { words, audio } = said([word("okay", 0, 0.3), word("la", 0.8, 1.0), word("idea", 1.0, 1.4), word("eh", 1.5, 1.6), word("la", 1.9, 2.1), word("idea", 2.1, 2.5), word("es", 2.5, 2.7)]);
    const plan = planCleanup(words, audio, { fps: FPS, retakes: true, pauses: false });
    const cut = plan.cuts[0];
    expect(cut?.words.map((w) => w.text)).toEqual(["la", "idea", "eh"]);
    expect(cut!.confidence).toBeLessThan(0.85);
  });

  it("does not take a lone repeated word for a retake unless a stop separates the attempts", () => {
    const flowing = said([word("okay", 0, 0.3), word("muy", 0.8, 1.1), word("muy", 1.1, 1.4), word("bien", 1.4, 1.8)]);
    const plan = planCleanup(flowing.words, flowing.audio, { fps: FPS, retakes: true, pauses: false });
    expect(plan.cuts).toEqual([]);
    expect(plan.skipped[0]).toMatchObject({ kind: "retake" });
    expect(plan.skipped[0]!.reason).toContain("confidence");
    const stopped = said([word("okay", 0, 0.3), word("muy", 0.8, 1.1), word("muy", 1.6, 1.9), word("bien", 1.9, 2.3)]);
    expect(planCleanup(stopped.words, stopped.audio, { fps: FPS, retakes: true, pauses: false }).cuts).toHaveLength(1);
    expect(planCleanup(flowing.words, flowing.audio, { fps: FPS, retakes: true, pauses: false, minConfidence: 0 }).cuts).toHaveLength(1);
  });

  it("ignores a phrase two speakers say", () => {
    const { words, audio } = said([
      word("okay", 0, 0.3),
      word("la", 0.8, 1.0, { speaker: "s1" }),
      word("idea", 1.0, 1.4, { speaker: "s1" }),
      word("la", 1.9, 2.1, { speaker: "s2" }),
      word("idea", 2.1, 2.5, { speaker: "s2" }),
    ]);
    expect(planCleanup(words, audio, { fps: FPS, retakes: true, pauses: false }).cuts).toEqual([]);
  });

  it("does not look across a long silence", () => {
    const { words, audio } = said([word("okay", 0, 0.3), word("la", 0.8, 1.0), word("idea", 1.0, 1.4), word("la", 5.0, 5.2), word("idea", 5.2, 5.6)]);
    expect(planCleanup(words, audio, { fps: FPS, retakes: true, pauses: false }).cuts).toEqual([]);
  });

  it("makes one cut of a phrase said three times", () => {
    const { words, audio } = said([
      word("okay", 0, 0.3),
      word("la", 0.8, 1.0),
      word("idea", 1.0, 1.4),
      word("la", 1.9, 2.1),
      word("idea", 2.1, 2.5),
      word("la", 3.0, 3.2),
      word("idea", 3.2, 3.6),
      word("es", 3.6, 3.8),
    ]);
    const cuts = planCleanup(words, audio, { fps: FPS, retakes: true, pauses: false }).cuts;
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.words.map((w) => w.text)).toEqual(["la", "idea", "la", "idea"]);
    expect(cuts[0]!.end).toBeGreaterThan(2.5);
    expect(cuts[0]!.end).toBeLessThan(3.0);
  });

  it("marks an edge that found no pause as unclean and less sure", () => {
    // No silence anywhere: the attempts run into each other.
    const words = [word("okay", 0, 0.3), word("la", 0.3, 0.5), word("idea", 0.5, 0.9), word("la", 0.9, 1.1), word("idea", 1.1, 1.5)];
    const cut = planCleanup(words, audioOf([[0, 1.5]]), { fps: FPS, retakes: true, pauses: false, minConfidence: 0 }).cuts[0];
    expect(cut).toMatchObject({ kind: "retake", clean: false });
    expect(cut!.confidence).toBeLessThan(0.6);
  });

  it("returns the cuts in timeline order", () => {
    const { words, audio } = said([...say().words, word("fin", 5.0, 5.4), word("fin", 6.5, 6.9), word("de", 6.9, 7.1)]);
    const starts = planCleanup(words, audio, { fps: FPS, retakes: true }).cuts.map((cut) => cut.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});
