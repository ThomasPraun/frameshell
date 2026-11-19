import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorCode, type MediaProbe } from "@frameshell/protocol";
import { type Timeline, type Transcript, createProjectConfig, createTimeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import type { OperationRequest } from "../src/timeline/engine.js";
import { TimelineService } from "../src/timeline/service.js";
import { snapRequest } from "../src/timeline/tempo.js";
import { TimeRefError, type TimelineWord, type TimelineWords, resolveTimeRef, resolveTimeRefAsync, resolveTimeRefs } from "../src/timeline/time-ref.js";
import { placeWords, readTimelineWords } from "../src/transcripts/timeline-words.js";
import { tempDir } from "./helpers.js";

// Seam under test: `word:` time references (ADR 0029), read by the one TimeRef resolver from the words a
// timeline plays, and that word list as `placeWords` (cleanup's placement) builds it.

const timeline = { id: "main" };

let nextId = 0;
function word(text: string, at: number, extra: Partial<TimelineWord> = {}): TimelineWord {
  return { id: `w_${String(++nextId).padStart(6, "0")}`, text, asset: "assets/a.mp4", clip: "c_1", language: "en", at, end: at + 0.3, ...extra };
}

function plays(words: TimelineWord[], unchecked: TimelineWords["unchecked"] = []) {
  return { timeline, words: { words, unchecked } };
}

function failure(run: () => unknown): TimeRefError {
  try {
    run();
  } catch (error) {
    if (error instanceof TimeRefError) return error;
    throw error;
  }
  throw new Error("expected a TimeRefError");
}

describe("word: in the resolver", () => {
  const talk = plays([word("This", 1), word("is", 1.3), word("this,", 2), word("over", 3), word("¡Está!", 4), word("this", 5)]);

  it("is the start of the first time a word is said, case, accents and punctuation ignored", () => {
    expect(resolveTimeRef("word:this", talk)).toBe(1);
    expect(resolveTimeRef("WORD:This", talk)).toBe(1);
    expect(resolveTimeRef("word:esta", talk)).toBe(4);
    expect(resolveTimeRef("word: over ", talk)).toBe(3);
  });

  it("counts occurrences from 1 on the timeline clock with #n, and adds an offset", () => {
    expect(resolveTimeRef("word:this#2", talk)).toBe(2);
    expect(resolveTimeRef("word:this#3", talk)).toBe(5);
    expect(resolveTimeRef("word:over+0.2", talk)).toBe(3.2);
    expect(resolveTimeRef("word:this#2-0.5", talk)).toBe(1.5);
    expect(resolveTimeRef("word:this # 2 + 0.25", talk)).toBe(2.25);
  });

  it("refuses an occurrence past the last one, listing when it is said, and #0", () => {
    const past = failure(() => resolveTimeRef("word:this#4", talk));
    expect(past.message).toContain('"this" is said 3 times on timeline main (at 1 s, 2 s, 5 s)');
    expect(past.hint).toBe("Use #1 to #3.");
    expect(failure(() => resolveTimeRef("word:this#0", talk)).message).toContain("occurrences count from 1");
  });

  it("refuses a time before the timeline starts", () => {
    expect(failure(() => resolveTimeRef("word:this-2", talk)).message).toContain("before the start of the timeline");
  });

  it("names the closest words the timeline plays for one it does not", () => {
    const missing = failure(() => resolveTimeRef("word:thus", talk));
    expect(missing.message).toContain('"word:thus": "thus" is not said on timeline main.');
    expect(missing.hint).toContain('Closest words it plays: "This" (3×).');
    expect(missing.hint).toContain("Words removed by a cut are not played.");
    expect(failure(() => resolveTimeRef("word:", talk)).message).toContain("names no word");
  });

  it("matches digits and spelled numbers both ways in the transcript's language", () => {
    const counted = plays([word("twenty", 1), word("20", 2), word("twenty-three", 3), word("veintitrés", 4, { language: "es" }), word("twenty", 5), word("three", 5.3)]);
    expect(resolveTimeRef("word:20", counted)).toBe(1);
    expect(resolveTimeRef("word:twenty#2", counted)).toBe(2);
    expect(resolveTimeRef("word:23", counted)).toBe(3);
    expect(resolveTimeRef("word:23#2", counted)).toBe(4);
    // A run of words matches as one: "twenty three" said as two words.
    expect(resolveTimeRef("word:23#3", counted)).toBe(5);
    expect(resolveTimeRef("word:twenty three", counted)).toBe(3);
  });

  it("compares words token for token, so a compound never meets its parts", () => {
    const maybe = plays([word("maybe", 1), word("it", 2), word("may", 2.3), word("be", 2.6), word("maybe", 4)]);
    expect(resolveTimeRef("word:maybe#2", maybe)).toBe(4);
    expect(resolveTimeRef("word:may be", maybe)).toBe(2.3);
    expect(failure(() => resolveTimeRef("word:maybe#3", maybe)).message).toContain('"maybe" is said 2 times');
    const twentyThree = plays([word("twenty-three", 1), word("twenty", 2), word("three", 2.3), word("23", 3), word("twenty", 4)]);
    expect([1, 2, 3].map((n) => resolveTimeRef(`word:23#${n}`, twentyThree))).toEqual([1, 2, 3]);
    expect(failure(() => resolveTimeRef("word:23#4", twentyThree)).hint).toBe("Use #1 to #3.");
  });

  it("reads a word with a hyphen and digits whole, and refuses text that also reads as a word and an offset", () => {
    expect(resolveTimeRef("word:covid-19", plays([word("COVID-19", 2)]))).toBe(2);
    expect(resolveTimeRef("word:covid-19", plays([word("covid", 2), word("19", 2.3)]))).toBe(2);
    const talk = plays([word("chapter", 3), word("chapter", 5), word("two", 5.3)]);
    const both = failure(() => resolveTimeRef("word:chapter - 2", talk));
    expect(both.message).toContain('"word:chapter - 2" reads two ways on timeline main: the words "chapter - 2" (at 5 s), and "chapter" (at 3 s) - 2 s.');
    expect(both.hint).toBe("For the words write `word:chapter 2`; for the offset name the occurrence first (`word:chapter#1-2`).");
    // An offset reading before the timeline starts gives no time, so the words win.
    expect(resolveTimeRef("word:chapter - 2", plays([word("chapter", 1), word("chapter", 5), word("two", 5.3)]))).toBe(5);
    expect(resolveTimeRef("word:chapter 2", talk)).toBe(5);
    expect(resolveTimeRef("word:chapter#1-2", talk)).toBe(1);
  });

  it("names both readings of text with an offset that is not said", () => {
    const missing = failure(() => resolveTimeRef("word:covid-19", plays([word("cove", 1)])));
    expect(missing.message).toContain('"word:covid-19": "covid-19" nor "covid" (with -19 s) is not said on timeline main.');
    expect(missing.hint).toContain('Closest words it plays: "cove".');
  });

  it("matches a phrase of consecutive words at its first word", () => {
    const thanks = plays([word("thank", 1), word("you", 1.3), word("thank", 4), word("god", 4.3), word("Thank", 6), word("you.", 6.2)]);
    expect(resolveTimeRef("word:thank you", thanks)).toBe(1);
    expect(resolveTimeRef("word:thank you#2", thanks)).toBe(6);
  });

  it("counts the same speech heard on two tracks once", () => {
    const twoMics = plays([word("hello", 1, { asset: "assets/mic.wav", clip: "c_2" }), word("hello", 1.02), word("hello", 3)]);
    expect(resolveTimeRef("word:hello#2", twoMics)).toBe(3);
    // A phrase is matched within each track before the copies fold, so the interleaved copies never break it.
    const mic = { asset: "assets/mic.wav", clip: "c_2", track: "t_a" };
    const phrase = plays([
      ...[["thank", 1], ["you", 1.3], ["all", 1.6]].flatMap(([text, at]) => [word(text as string, at as number, { track: "t_v" }), word(text as string, (at as number) + 0.02, mic)]),
      word("thank", 5, { track: "t_v" }),
      word("you", 5.3, { track: "t_v" }),
      word("all", 5.6, { track: "t_v" }),
    ]);
    expect(resolveTimeRef("word:thank you all", phrase)).toBe(1);
    expect(resolveTimeRef("word:thank you all#2", phrase)).toBe(5);
  });

  it("takes a transcript word id, and refuses one two assets share", () => {
    const words = [word("first", 1, { id: "w_000007" }), word("again", 2, { id: "w_000008" }), word("first", 6, { id: "w_000007", clip: "c_3" })];
    expect(resolveTimeRef("word:w_000008", plays(words))).toBe(2);
    expect(resolveTimeRef("word:W_000007#2", plays(words))).toBe(6);
    const shared = plays([...words, word("other", 8, { id: "w_000008", asset: "assets/b.mp4", clip: "c_4" })]);
    expect(failure(() => resolveTimeRef("word:w_000008", shared)).message).toContain("w_000008 is a word id in the transcripts of assets/a.mp4 and assets/b.mp4");
    expect(failure(() => resolveTimeRef("word:w_000099", plays(words))).message).toContain('"w_000099" is not said');
  });

  it("refuses when a clip's transcript is stale, and names untranscribed clips for a word it cannot find", () => {
    const stale = failure(() => resolveTimeRef("word:this", plays([word("this", 1)], [{ clip: "c_9", asset: "assets/old.mp4", reason: "stale-transcript" }])));
    expect(stale.message).toContain("the transcript of clip c_9 (assets/old.mp4) is older than its file");
    expect(stale.hint).toContain("`frameshell transcribe assets/old.mp4`");
    const silent = failure(() => resolveTimeRef("word:hello", plays([word("this", 1)], [{ clip: "c_8", asset: "assets/b.mp4", reason: "no-transcript" }])));
    expect(silent.hint).toContain("Clips without a transcript are not searched: c_8 (assets/b.mp4)");
    // A clip with no transcript holds no words to count: a word found elsewhere resolves.
    expect(resolveTimeRef("word:this", plays([word("this", 1)], [{ clip: "c_8", asset: "assets/b.mp4", reason: "no-transcript" }]))).toBe(1);
    const none = failure(() => resolveTimeRef("word:this", plays([], [{ clip: "c_8", asset: "assets/b.mp4", reason: "no-transcript" }])));
    expect(none.message).toContain("plays no transcribed words");
    expect(failure(() => resolveTimeRef("word:this", plays([]))).hint).toContain("Words inside a nested timeline clip are not read.");
    // `#n` past the words found names the clips it could not search.
    const past = failure(() => resolveTimeRef("word:this#2", plays([word("this", 1)], [{ clip: "c_8", asset: "assets/b.mp4", reason: "no-transcript" }])));
    expect(past.hint).toContain("Clips without a transcript are not searched: c_8 (assets/b.mp4)");
  });

  it("is never shadowed by a marker labelled like it", () => {
    const marked = { timeline: { id: "main", markers: [{ id: "m_a", at: 9, label: "word:this" }] }, words: { words: [word("this", 1)], unchecked: [] } };
    expect(resolveTimeRef("word:this", marked)).toBe(1);
  });

  it("loads the words once per request, only when a field names a word, and refuses plainly without a loader", async () => {
    let loads = 0;
    const load = async () => {
      loads++;
      return { words: [word("so", 1), word("so", 3), word("okay", 6)], unchecked: [] };
    };
    const cut = await resolveTimeRefs({ op: "cut", args: { from: "word:so#2", to: "word:okay+0.5" } }, timeline, undefined, load);
    expect(cut.args).toMatchObject({ from: 3, to: 6.5 });
    expect(loads).toBe(1);
    await resolveTimeRefs({ op: "cut", args: { from: 1, to: 2 } }, timeline, undefined, load);
    expect(loads).toBe(1);
    await expect(resolveTimeRefs({ op: "cut", args: { from: "word:so", to: 2 } }, timeline)).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining("cut: from: This reference needs the words the timeline plays"),
    });
    await expect(resolveTimeRefAsync("word:so", timeline, undefined, load)).resolves.toBe(1);
  });

  it("resolves words before --snap-to moves them to the grid, reading them once", async () => {
    let loads = 0;
    const wordsOf = async () => {
      loads++;
      return { words: [word("so", 1.1), word("idea", 2.62)], unchecked: [] };
    };
    const context = { timeline: { ...createTimeline("main"), tempo: { bpm: 120 } }, fps: 30, snapTo: "beat" as const, beatsOf: async () => null, wordsOf };
    const snapped = await snapRequest({ op: "cut", args: { from: "word:so", to: "word:idea" } } as unknown as OperationRequest, context);
    expect(snapped.args).toMatchObject({ from: 1, to: 2.5 });
    expect(loads).toBe(1);
  });
});

const transcriptOf = (asset: string, words: [string, number, number][], language = "en"): Transcript => ({
  schemaVersion: 1,
  asset,
  assetHash: `sha256:${"0".repeat(64)}`,
  provider: "test",
  model: "test",
  language,
  words: words.map(([text, start, end], index) => ({ id: `w_${String(index + 1).padStart(6, "0")}`, text, start, end })),
  edits: {},
});

const TALK: [string, number, number][] = [
  ["so", 1.0, 1.3],
  ["the", 1.3, 1.6],
  ["key", 1.6, 2.0],
  ["so", 3.0, 3.3],
  ["the", 3.3, 3.6],
  ["key", 3.6, 4.0],
  ["idea", 4.0, 4.5],
  ["twenty", 5.0, 5.4],
  ["okay", 6.0, 6.5],
];

function media(id: string, start: number, inS: number, out: number, extra: Record<string, unknown> = {}) {
  return { id, type: "media", asset: "assets/a.mp4", start, in: inS, out, ...extra };
}

describe("placeWords", () => {
  const transcripts = new Map([["assets/a.mp4", { rel: "transcripts/a.words.json", transcript: transcriptOf("assets/a.mp4", TALK) }]]);
  const on = (clips: unknown[]): Timeline => ({ ...createTimeline("main"), tracks: [{ id: "t_v", kind: "video", clips }] }) as unknown as Timeline;

  it("places the words each clip plays on the timeline clock and drops the ones a cut removed", async () => {
    // The first take (1.0-3.0 of the source) is cut out: the second clip picks up at 3.0.
    const { words } = await placeWords(on([media("c_1", 0, 0, 1), media("c_2", 1, 3, 8)]), 30, transcripts);
    expect(words.map((w) => [w.text, Math.round(w.at * 1000) / 1000, w.clip])).toEqual([
      ["so", 1, "c_2"],
      ["the", 1.3, "c_2"],
      ["key", 1.6, "c_2"],
      ["idea", 2, "c_2"],
      ["twenty", 3, "c_2"],
      ["okay", 4, "c_2"],
    ]);
    expect(words[0]).toMatchObject({ id: "w_000004", asset: "assets/a.mp4", language: "en", transcript: "transcripts/a.words.json" });
  });

  it("follows clip speed and leaves muted clips and clips without a transcript out", async () => {
    const fast = await placeWords(on([media("c_1", 10, 4, 6, { speed: 2 })]), 30, transcripts);
    expect(fast.words.map((w) => [w.text, Math.round(w.at * 1000) / 1000])).toEqual([
      ["idea", 10],
      ["twenty", 10.5],
    ]);
    const muted = await placeWords(on([media("c_1", 0, 0, 8, { audio: { muted: true } })]), 30, transcripts);
    expect(muted.words).toEqual([]);
    const none = await placeWords(on([media("c_1", 0, 0, 8)]), 30, new Map([["assets/a.mp4", { unchecked: "no-transcript" as const }]]));
    expect(none.left).toEqual([{ clip: "c_1", asset: "assets/a.mp4", reason: "it has no transcript", transcript: "no-transcript" }]);
  });
});

const PROBE: MediaProbe = {
  duration: 8,
  format: "mov,mp4",
  video: { codec: "h264", width: 320, height: 240, fps: 30, vfr: false, still: false },
  audio: null,
};

function session() {
  const root = tempDir();
  mkdirSync(join(root, "timelines"));
  mkdirSync(join(root, "assets"), { recursive: true });
  mkdirSync(join(root, "transcripts"), { recursive: true });
  writeFileSync(join(root, "assets", "a.mp4"), "not really media");
  writeFileSync(join(root, "transcripts", "a.words.json"), JSON.stringify(transcriptOf("assets/a.mp4", TALK)));
  writeFileSync(join(root, "frameshell.json"), JSON.stringify(createProjectConfig("Test")));
  writeFileSync(join(root, "timelines", "main.json"), JSON.stringify({ ...createTimeline("main"), tracks: [{ id: "t_v", kind: "video", clips: [] }] }));
  let next = 0;
  const timelines = new TimelineService({
    probe: async () => PROBE,
    clipTypes: async () => new Map(),
    newId: (prefix) => `${prefix}_${++next}`,
    // No hash check: the fixture's transcript is never stale.
    wordsOf: (dir, state, fps) => readTimelineWords(dir, state, fps, undefined),
  });
  const run = (op: string, args: Record<string, unknown>) =>
    timelines.apply({ root, cwd: root, timeline: "main", author: "cli", tx: { id: "tx_1", label: null }, request: { op, args } as never });
  return { timelines, run, root };
}

describe("word: in operations", () => {
  it("resolves against the timeline as the operation sees it, and the journal keeps the seconds a later cut does not move", async () => {
    const { run, timelines, root } = session();
    await run("clip.add", { track: "t_v", type: "media", asset: "assets/a.mp4", start: 0 });
    const before = await run("marker.add", { at: "word:idea", label: "idea" });
    expect(before.operation.args).toMatchObject({ at: 4 });

    // Cut the first take: from the first "so" to the second one.
    const cut = await run("cut", { from: "word:so", to: "word:so#2", snap: false });
    expect(cut.operation.args).toMatchObject({ from: 1, to: 3 });

    // The same name now means the time the word plays after the cut; the recorded marker.add keeps its seconds.
    const after = await run("marker.add", { at: "word:idea", label: "idea again" });
    expect(after.operation.args).toMatchObject({ at: 2 });
    expect(before.operation.args).toMatchObject({ at: 4 });
    // "so" was said twice; after the cut it plays once.
    await expect(run("marker.add", { at: "word:so#2", label: "gone" })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining('marker.add: at: "word:so#2": "so" is said 1 time on timeline main (at 1 s)'),
    });
    const markers = (await timelines.markers(root, "main")).markers.map((m) => [m.label, m.at]);
    expect(markers).toHaveLength(2);
    expect(markers).toEqual(expect.arrayContaining([
      ["idea", 2],
      ["idea again", 2],
    ]));
  });

  it("finds a number said in words, and refuses a word the timeline does not play before the engine runs", async () => {
    const { run, timelines, root } = session();
    await run("clip.add", { track: "t_v", type: "media", asset: "assets/a.mp4", start: 0 });
    const split = await run("clip.split", { clip: "c_1", at: "word:20" });
    expect(split.operation.args).toMatchObject({ at: 5 });
    const revision = (await timelines.show(root, "main")).revision;
    await expect(run("clip.split", { clip: "c_1", at: "word:ideas" })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining('Closest words it plays: "idea"'),
    });
    expect((await timelines.show(root, "main")).revision).toBe(revision);
  });
});
