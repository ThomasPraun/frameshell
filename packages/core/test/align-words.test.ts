import { describe, expect, it } from "vitest";
import { type TimedWord, alignWords } from "../src/index.js";

/** Words at 0.5 s spacing from `from`, each 0.3 s long: whisper-like DTW onsets. */
function spoken(text: string, from = 0, step = 0.5): TimedWord[] {
  return text.split(" ").map((word, i) => ({ text: word, start: from + i * step, end: from + i * step + 0.3 }));
}

const statuses = (expected: TimedWord[], heard: TimedWord[]) => alignWords(expected, heard).map((word) => word.status);

describe("alignWords", () => {
  it("hears every word of an identical re-transcription", () => {
    const words = spoken("hola a todos bienvenidos al canal");
    const result = alignWords(words, words);
    expect(result.map((w) => w.status)).toEqual(Array(6).fill("heard"));
    expect(result.map((w) => (w.status === "heard" ? w.heard : null))).toEqual([[0], [1], [2], [3], [4], [5]]);
  });

  it("ignores case, punctuation, inverted marks and accents whisper varies between runs", () => {
    const expected = spoken("¿Qué tal? Está todo listo, ¿no?");
    const heard = spoken("que tal esta todo listo no");
    expect(statuses(expected, heard)).toEqual(Array(6).fill("heard"));
  });

  it("tolerates onset jitter between runs", () => {
    const expected = spoken("uno dos tres cuatro cinco", 1);
    // Onsets stay in order within one run; only the offset between runs varies.
    const jitter = [-0.3, -0.4, 0.2, 0.6, 0.7];
    const heard = expected.map((word, i) => ({ ...word, start: word.start + jitter[i]!, end: word.end + jitter[i]! }));
    expect(statuses(expected, heard)).toEqual(Array(5).fill("heard"));
  });

  it("matches words whisper splits or merges differently", () => {
    // Edited multi-word text, compound split, contraction merged.
    const expected = [
      { text: "a todos", start: 0, end: 0.4 },
      { text: "today", start: 1, end: 1.4 },
      { text: "can", start: 2, end: 2.2 },
      { text: "not", start: 2.2, end: 2.4 },
    ];
    const heard = [
      { text: "a", start: 0, end: 0.1 },
      { text: "todos", start: 0.1, end: 0.4 },
      { text: "to", start: 1, end: 1.2 },
      { text: "day", start: 1.2, end: 1.4 },
      { text: "cannot", start: 2, end: 2.4 },
    ];
    const result = alignWords(expected, heard);
    expect(result.map((w) => w.status)).toEqual(["heard", "heard", "heard", "heard"]);
    expect(result[0]).toMatchObject({ heard: [0, 1] });
    expect(result[1]).toMatchObject({ heard: [2, 3] });
    expect(result[2]).toMatchObject({ heard: [4] });
    expect(result[3]).toMatchObject({ heard: [4] });
  });

  it("matches close spellings with a similarity below 1", () => {
    const expected = spoken("Jimena dijo okay");
    const heard = spoken("Ximena dijo okey");
    const result = alignWords(expected, heard);
    expect(result.map((w) => w.status)).toEqual(["heard", "heard", "heard"]);
    expect(result[0]).toMatchObject({ similarity: expect.closeTo(0.83, 2) });
    expect(result[1]).toMatchObject({ similarity: 1 });
  });

  it("reports a word with no speech in its slot as missing", () => {
    const expected = spoken("esto es muy importante para todos");
    const heard = expected.filter((word) => word.text !== "importante");
    expect(statuses(expected, heard)).toEqual(["heard", "heard", "heard", "missing", "heard", "heard"]);
  });

  it("reports a word heard as other text in the same slot as different, not missing", () => {
    const expected = spoken("tengo veinte años");
    const heard = [expected[0]!, { ...expected[1]!, text: "20" }, expected[2]!];
    const result = alignWords(expected, heard);
    expect(result.map((w) => w.status)).toEqual(["heard", "different", "heard"]);
    expect(result[1]).toMatchObject({ heard: [1] });
  });

  it("gives a collapsed repeated phrase to the copy closest in time", () => {
    // Whisper can drop one copy of a repeated phrase (ADR 0003).
    const expected = spoken("vamos a ver vamos a ver ahora");
    const heard = spoken("vamos a ver ahora", 1.5);
    expect(statuses(expected, heard)).toEqual(["missing", "missing", "missing", "heard", "heard", "heard", "heard"]);
  });

  it("never matches the same text far away in time", () => {
    const expected = [{ text: "hola", start: 10, end: 10.3 }];
    const heard = [{ text: "hola", start: 30, end: 30.3 }];
    expect(statuses(expected, heard)).toEqual(["missing"]);
  });

  it("is not thrown off by words whisper adds", () => {
    const expected = spoken("buenos días a todos");
    const heard = [...spoken("buenos días"), { text: "eh", start: 0.9, end: 1.0 }, ...spoken("a todos", 1)];
    expect(statuses(expected, heard)).toEqual(Array(4).fill("heard"));
  });

  it("counts punctuation-only words as heard: there is nothing to hear", () => {
    const expected = [{ text: "—", start: 0, end: 0.1 }, ...spoken("fin", 0.5)];
    expect(statuses(expected, spoken("fin", 0.5))).toEqual(["heard", "heard"]);
  });

  it("aligns long transcripts in bounded time", () => {
    const vocabulary = ["de", "la", "que", "el", "en", "y", "a", "los", "se", "del", "las", "un", "por", "con", "no", "una"];
    const words = Array.from({ length: 6000 }, (_, i) => ({ text: vocabulary[(i * 7) % vocabulary.length]!, start: i * 0.35, end: i * 0.35 + 0.25 }));
    const heard = words.filter((_, i) => i % 97 !== 0);
    const started = performance.now();
    const result = alignWords(words, heard);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(result.filter((w) => w.status === "missing").length).toBe(Math.ceil(6000 / 97));
  });
});
