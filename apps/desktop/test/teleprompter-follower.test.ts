import { parseShootScript, spokenTokens } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import {
  type FollowState,
  type HeardWindow,
  follow,
  followAt,
  followScript,
  followStop,
  isLoop,
  tokenScore,
} from "../src/renderer/src/teleprompter/follower.js";
import { promptStream } from "../src/renderer/src/teleprompter/model.js";

// Seam under test: the live follower (#393), on the spike's fixtures (spikes/shoot-capture/scripts/speech-data.mjs,
// follower.test.mjs): the script, and the variant read with sentence 3 skipped, extra words, a misread word, a restart.

const SCRIPT = [
  "Hola a todos, bienvenidos a este vídeo sobre cómo grabar un buen rodaje.",
  "Hoy vamos a ver tres consejos muy sencillos para mejorar la luz.",
  "El primero es colocar la ventana a un lado de la cámara.",
  "El segundo consejo es evitar las luces mixtas de distintos colores.",
  "Por último, graba siempre treinta segundos de silencio en la sala.",
  "Con esto tendrás un material limpio y listo para editar.",
  "Gracias por ver el vídeo, nos vemos en el siguiente.",
];
const SPOKEN_B = [
  SCRIPT[0]!,
  "Hoy vamos a ver, bueno, la verdad es que son tres consejos muy sencillos para mejorar la luz.",
  SCRIPT[3]!.replace("mixtas", "mezcladas"),
  "Por último, graba siempre",
  SCRIPT[4]!,
  SCRIPT[5]!,
  SCRIPT[6]!,
];

const stream = promptStream(parseShootScript(`---\nshoot: true\n---\n## Luz\n**Ana:** ${SCRIPT.join(" ")}\n`));
const script = followScript(stream, "es");
const start = (): FollowState => ({ last: -1, floor: 0, hold: null });
const hear = (words: string, silence = 0): HeardWindow => ({ words: words.split(" "), silence });
const run = (windows: readonly string[], state = start()) => windows.reduce((current, words) => follow(stream, script, current, hear(words), "es").state, state);
const sentenceOf = (state: FollowState) => stream.stops[script.stops[state.last]!]!.sentence;

describe("live follower", () => {
  it("spells numbers and drops accents and case on the script side", () => {
    expect(script.tokens.slice(0, 9)).toEqual(["hola", "a", "todos", "bienvenidos", "a", "este", "video", "sobre", "como"]);
    expect(script.tokens).toContain("treinta");
    expect(follow(stream, script, run(["por ultimo graba siempre"], followAt(stream, script, 40)), hear("graba siempre 30 segundos"), "es").state.last).toBe(
      script.tokens.indexOf("segundos"),
    );
  });

  it("follows in order", () => {
    expect(script.tokens[run(["hola a todos", "bienvenidos a este video"]).last]).toBe("video");
  });

  it("ignores a recognizer loop, unrelated speech and one lone common word", () => {
    const at = run(["hola a todos bienvenidos"]);
    expect(run(["la fecha de la fecha de la fecha de la fecha"], at)).toEqual(at);
    expect(run(["mañana compramos pan y leche"], at)).toEqual(at);
    expect(run(["de"], at)).toEqual(at);
    expect(isLoop(["la", "fecha", "de", "la", "fecha", "de", "la", "fecha", "de"])).toBe(true);
    expect(isLoop(["hola", "a", "todos"])).toBe(false);
  });

  it("skips a whole sentence after 3 or more matching words, and marks it skipped", () => {
    const at = run(["hola a todos bienvenidos a este video sobre como grabar un buen rodaje"]);
    const step = follow(stream, script, at, hear("el primero es colocar la ventana"), "es");
    expect(sentenceOf(step.state)).toBe(2);
    expect(step.skipped).toEqual([1]);
  });

  it("moves back for a restart only with 3 or more words", () => {
    const at = run(["hola a todos bienvenidos a este video sobre como grabar"]);
    expect(run(["hola a todos bienvenidos"], at).last).toBeLessThan(at.last);
    expect(run(["hola a"], at)).toEqual(at);
  });

  it("tolerates a misrecognized word and an extra word", () => {
    const at = run(["hola a todos bueno bienvenidos a este vídeo sobre cobrada"]);
    expect(["sobre", "como"]).toContain(script.tokens[at.last]);
  });

  it("scores equal, near and cut words", () => {
    expect(tokenScore("video", "video")).toBe(2);
    expect(tokenScore("mixta", "mixtas")).toBe(1.3);
    expect(tokenScore("ventan", "ventana")).toBe(1.3);
    expect(tokenScore("cons", "consejos")).toBe(1);
    expect(tokenScore("de", "el")).toBeLessThan(0);
  });

  it.each([
    ["the script as written", SCRIPT, [0, 1, 2, 3, 4, 5, 6], []],
    ["sentence 3 skipped, words added, one misread, a restart", SPOKEN_B, [0, 1, 3, 4, 4, 5, 6], [2]],
  ])("follows %s window by window: never ahead of the speaker, to the end", (_, sentences, says, skips) => {
    const run = readThrough(sentences, says);
    expect(run.last).toBe(script.tokens.length - 1);
    expect(run.skipped).toEqual(skips);
    expect(run.worstAhead).toBeLessThanOrEqual(1);
  });
});

/**
 * Read `sentences` aloud and follow them: words timed in proportion to their letters, heard in 3.5 s windows every
 * 0.5 s (ADR 0024 decision 5). Each spoken word knows the script token it says (`says`: the script sentence of each
 * spoken one; null for an added word), so `worstAhead` is how far the reader ever got past the word being said.
 */
function readThrough(sentences: readonly string[], says: readonly number[]): { last: number; skipped: number[]; worstAhead: number } {
  const spoken: { text: string; start: number; end: number; token: number | null }[] = [];
  let clock = 0;
  sentences.forEach((sentence, index) => {
    const range = script.tokens.flatMap((_, token) => (stream.stops[script.stops[token]!]!.sentence === says[index] ? [token] : []));
    let cursor = 0;
    for (const text of sentence.split(" ")) {
      const length = 0.05 * text.length + 0.12;
      const said = spokenTokens(text, "es").at(-1);
      const found = range.slice(cursor).findIndex((token) => script.tokens[token] === said);
      if (found !== -1) cursor += found + 1;
      spoken.push({ text, start: clock, end: clock + length, token: found === -1 ? null : range[cursor - 1]! });
      clock += length;
    }
    clock += 0.4;
  });
  let state = start();
  const skipped = new Set<number>();
  let worstAhead = -Infinity;
  for (let end = 0.5; end <= clock + 1; end += 0.5) {
    const heard = spoken.filter((word) => word.end > end - 3.5 && word.start < end);
    const step = follow(stream, script, state, { words: heard.map((word) => word.text), silence: end - (heard.at(-1)?.end ?? end - 3.5) }, "es");
    state = step.state;
    for (const sentence of step.skipped) skipped.add(sentence);
    const truth = Math.max(-1, ...spoken.filter((word) => word.start < end && word.token !== null).map((word) => word.token!));
    worstAhead = Math.max(worstAhead, state.last - truth);
  }
  return { last: state.last, skipped: [...skipped], worstAhead };
}

describe("follower in a FREE slot", () => {
  const free = promptStream(parseShootScript("---\nshoot: true\n---\n## A\n**Ana:** Hola a todos, esto es el principio.\n[FREE: cuenta cómo nos conocimos]\nY ahora seguimos con el guion.\n"));
  const words = followScript(free, "es");
  const slot = free.stops.findIndex((stop) => stop.kind === "free");

  it("waits on the slot until speech was heard and then stopped, then goes on with the script", () => {
    let state = follow(free, words, followAt(free, words, 0), hear("hola a todos esto es el principio"), "es").state;
    expect(followStop(free, words, state)).toBe(slot);
    expect(state.hold).toEqual({ stop: slot, heard: false, windows: 0 });
    // Silence before any free speech keeps it waiting; unscripted words that touch the script do not move it.
    state = follow(free, words, state, { words: [], silence: 3 }, "es").state;
    expect(followStop(free, words, state)).toBe(slot);
    state = follow(free, words, state, hear("nos conocimos en el principio de todo"), "es").state;
    expect(followStop(free, words, state)).toBe(slot);
    for (let window = 0; window < 8; window++) state = follow(free, words, state, hear("y fue genial", 1), "es").state;
    const done = follow(free, words, state, hear("y fue genial", 2.5), "es");
    expect(done.moved).toBe(true);
    expect(free.stops[followStop(free, words, done.state)]!.text).toBe("Y");
    expect(free.stops[followStop(free, words, follow(free, words, done.state, hear("y ahora seguimos con"), "es").state)]!.text).toBe("el");
  });

  it("holds through a thinking pause and through a pause soon after the first words", () => {
    const placed = followAt(free, words, slot);
    // First words, then a long silence at once: under 4 s of speech in the slot, so it stays.
    let early = follow(free, words, placed, hear("nos conocimos en"), "es").state;
    for (let window = 0; window < 4; window++) early = follow(free, words, early, { words: [], silence: 3.5 }, "es").state;
    expect(followStop(free, words, early)).toBe(slot);
    // Past 4 s: a 2 s thinking pause stays, a 2.5 s one leaves.
    for (let window = 0; window < 4; window++) early = follow(free, words, early, { words: [], silence: 1 }, "es").state;
    expect(follow(free, words, early, hear("y luego", 2), "es").moved).toBe(false);
    expect(follow(free, words, early, { words: [], silence: 2.5 }, "es").moved).toBe(true);
  });

  it("starts held when placed on the slot", () => {
    expect(followAt(free, words, slot)).toMatchObject({ hold: { stop: slot, heard: false, windows: 0 }, floor: slot });
  });
});
