import { parseShootScript, spellNumber } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { type HeardWord, compareTake } from "../src/shoot/compare.js";

// Pure comparison of a take against a shoot script (ADR 0023 decision 4), on synthetic transcripts.

const SCRIPT = [
  "---",
  "shoot: true",
  "---",
  "## Hook",
  "**Ana:** Cuántas pestañas tenés abiertas ahora mismo",
  "## Problem",
  "**Ana:** Son 23 y yo también",
  "**Juan:** Ninguna la vas a leer nunca",
].join("\n");

/**
 * Heard words, 0.4 s each: `_` adds 2 s of silence, `Name:` sets the speaker of the words after it.
 */
function say(text: string, start = 0): HeardWord[] {
  const words: HeardWord[] = [];
  let at = start;
  let speaker: string | null = null;
  for (const part of text.split(/\s+/).filter(Boolean)) {
    if (part === "_") at += 2;
    else if (part.endsWith(":")) speaker = part.slice(0, -1);
    else {
      words.push({ text: part, start: at, end: at + 0.35, speaker });
      at += 0.4;
    }
  }
  return words;
}

const compare = (heard: string, script = SCRIPT) => compareTake(parseShootScript(script), say(heard), "es");
const kinds = (heard: string, script = SCRIPT) => compare(heard, script).deviations.map((d) => [d.kind, d.expected, d.heard]);

describe("compareTake", () => {
  it("finds nothing to report when the take says the script", () => {
    const result = compare("Ana: cuántas pestañas tenés abiertas ahora mismo _ son veintitrés y yo también Juan: ninguna la vas a leer nunca");
    expect(result.deviations).toEqual([]);
    expect(result.scenes).toEqual(["hook", "problem"]);
    expect(result.lines.map((line) => line.status)).toEqual(["said", "said", "said"]);
    expect(result.lines[0]!.at).toEqual({ start: 0, end: expect.closeTo(2.35) });
  });

  it("reports missing, changed and added words, with numbers and short words maybe the transcription's", () => {
    expect(kinds("cuántas pestañas tenés abiertas mismo")).toEqual([["missing", "ahora", ""]]);
    const changed = compare("cuántas pestañas tenés cerradas ahora mismo").deviations;
    expect(changed).toMatchObject([{ kind: "changed", expected: "abiertas", heard: "cerradas", words: { from: 3, to: 3 }, at: { start: expect.closeTo(1.2), end: expect.closeTo(1.55) } }]);
    expect(kinds("cuántas pestañas tenés abiertas ahora mismo che")).toEqual([["added", "", "che"]]);
    expect(compare("son 23 y yo también ninguna la vas a leer nunca").deviations).toEqual([]);
    expect(compare("son veinte y yo también ninguna la vas a leer nunca").deviations).toMatchObject([{ kind: "changed", expected: "23", heard: "veinte", maybeTranscription: true }]);
  });

  it("uses the last complete attempt of a line and reports the earlier ones as restarts", () => {
    const result = compare("cuántas pestañas tenés _ cuántas pestañas tenés abiertas ahora mismo");
    expect(result.deviations.map((d) => [d.kind, d.heard])).toEqual([["restart", "cuántas pestañas tenés"]]);
    expect(result.lines[0]!.at).toEqual({ start: expect.closeTo(3.2), end: expect.closeTo(5.55) });
  });

  it("reports a line said out of order as moved, not as missing and added", () => {
    const result = compare("son veintitrés y yo también _ ninguna la vas _ ninguna la vas a leer nunca cuántas pestañas tenés abiertas ahora mismo", SCRIPT.replace("## Problem\n", ""));
    expect(result.deviations.map((d) => d.kind).sort()).toEqual(["moved", "restart"]);
    expect(result.deviations.find((d) => d.kind === "moved")).toMatchObject({ line: 5, expected: "Cuántas pestañas tenés abiertas ahora mismo" });
  });

  it("reports long pauses inside a line, the wrong speaker and a scene off its expected length", () => {
    const result = compare("Juan: cuántas pestañas tenés _ abiertas ahora mismo");
    expect(result.deviations.map((d) => [d.kind, d.expected, d.heard])).toEqual([
      ["speaker", "Ana", "Juan"],
      ["pause", "", ""],
    ]);
    expect(result.deviations[1]).toMatchObject({ words: { from: 2, to: 3 }, at: { start: expect.closeTo(1.15), end: expect.closeTo(3.2) } });
    const timed = SCRIPT.replace("## Hook", "## Hook (0:00–0:03)");
    expect(compare("cuántas pestañas tenés abiertas ahora mismo", timed).deviations).toEqual([]);
    const slow = compare("cuántas _ pestañas _ tenés abiertas ahora mismo", timed).deviations.filter((d) => d.kind === "length");
    expect(slow).toMatchObject([{ scene: "hook", line: null, expected: "3 s", heard: "6.4 s" }]);
  });

  it("checks a FREE slot for speech and its length only", () => {
    const script = ["---", "shoot: true", "---", "## Story", "**Juan:** Les cuento algo", "[FREE: how he lost a client]", "Y así fue"].join("\n");
    const long = "les cuento algo una vez un cliente me dijo que no lo había leído nunca y se fue con la competencia ese mismo día y así fue";
    expect(compare(long, script).deviations).toEqual([]);
    expect(kinds("les cuento algo perdí un cliente y así fue", script)).toEqual([["free", "how he lost a client", "perdí un cliente"]]);
  });

  it("only checks that each line was talked about when following topics", () => {
    const script = SCRIPT.replace("shoot: true", "shoot: true\nfollow: topics");
    expect(compare("bueno ahora mismo cuántas pestañas abiertas tenés vos _ en realidad son veintitrés", script).deviations.map((d) => [d.kind, d.line])).toEqual([]);
    expect(compare("cuántas pestañas abiertas tenés ahora _ ninguna la vas a leer nunca", script).deviations.map((d) => [d.kind, d.line])).toEqual([["missing", 8]]);
  });

  it("gives a deviation the same id while its line and heard words stay, and a new one when they change", () => {
    const once = compare("cuántas pestañas tenés cerradas ahora mismo").deviations[0]!;
    const again = compareTake(parseShootScript(`${SCRIPT}\n`), say("cuántas pestañas tenés cerradas ahora mismo", 10), "es").deviations[0]!;
    expect(again.id).toBe(once.id);
    expect(compare("cuántas pestañas tenés vacías ahora mismo").deviations[0]!.id).not.toBe(once.id);
    expect(compareTake(parseShootScript(SCRIPT.replace("ahora mismo", "ahora")), say("cuántas pestañas tenés cerradas ahora"), "es").deviations[0]!.id).not.toBe(once.id);
  });

  it("covers only the scenes the take reaches, and reports a take that matches nothing as added", () => {
    const part = compare("ninguna la vas a leer nunca");
    expect(part.scenes).toEqual(["problem"]);
    expect(part.lines.map((line) => line.status)).toEqual(["outside", "outside", "said"]);
    expect(part.deviations).toEqual([]);
    expect(kinds("hola hola probando")).toEqual([["added", "", "hola hola probando"]]);
  });
});

describe("spellNumber", () => {
  it("says numbers in Spanish and English", () => {
    expect(spellNumber("23", "es")).toEqual(["veintitrés"]);
    expect(spellNumber("101", "es")).toEqual(["ciento", "uno"]);
    expect(spellNumber("1.500", "es")).toEqual(["mil", "quinientos"]);
    expect(spellNumber("21000", "es")).toEqual(["veintiún", "mil"]);
    expect(spellNumber("2000000", "es")).toEqual(["dos", "millones"]);
    expect(spellNumber("1,5", "es")).toEqual(["uno", "coma", "cinco"]);
    expect(spellNumber("42", "en")).toEqual(["forty", "two"]);
    expect(spellNumber("1,500", "en")).toEqual(["one", "thousand", "five", "hundred"]);
    expect(spellNumber("abc", "en")).toBeNull();
  });
});
