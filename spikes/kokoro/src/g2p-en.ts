// English -> Kokoro phonemes: the misaki "gold" US dictionary (Apache-2.0, the phoneme set Kokoro's English voices
// were trained on), the -s/-ed/-ing endings misaki derives from a stem, and a crude letter-to-sound fallback for
// words in neither. Digits must be spelled before (spellNumbersIn).
import { readFileSync } from "node:fs";
import { local } from "./pins.ts";

type Entry = string | Record<string, string | null>;
let gold: Record<string, Entry> | null = null;

function dictionary(): Record<string, Entry> {
  gold ??= JSON.parse(readFileSync(local("misaki/us_gold.json"), "utf8")) as Record<string, Entry>;
  return gold;
}

/** Words not found (dictionary, endings) during this process: the fallback read them. */
export const OOV = new Set<string>();

function lookup(w: string): string | null {
  const d = dictionary();
  const entry = d[w] ?? d[w.toLowerCase()] ?? d[w[0]!.toUpperCase() + w.slice(1).toLowerCase()];
  if (entry === undefined) return null;
  if (typeof entry === "string") return entry;
  return entry.DEFAULT ?? Object.values(entry).find((v) => typeof v === "string") ?? null;
}

const VOICELESS = new Set(["p", "t", "k", "f", "θ"]);

/** -s, -ed, -ing on a dictionary stem, the way misaki's `stem_s`/`stem_ed`/`stem_ing` attach them. */
function withEnding(w: string): string | null {
  const lower = w.toLowerCase();
  const tries: [string, (stem: string) => string][] = [];
  if (lower.endsWith("'s") || lower.endsWith("s")) {
    const cut = lower.endsWith("'s") ? 2 : lower.endsWith("es") ? 2 : 1;
    const s = (stem: string) => {
      const end = stem.at(-1)!;
      if ("szʃʒʧʤ".includes(end)) return `${stem}ᵻz`;
      return stem + (VOICELESS.has(end) ? "s" : "z");
    };
    tries.push([lower.slice(0, -cut), s], [lower.slice(0, -1), s]);
  }
  if (lower.endsWith("ed")) {
    const ed = (stem: string) => {
      const end = stem.at(-1)!;
      if (end === "t" || end === "d") return `${stem}ᵻd`;
      return stem + (VOICELESS.has(end) || "sʃʧ".includes(end) ? "t" : "d");
    };
    tries.push([lower.slice(0, -2), ed], [lower.slice(0, -1), ed]);
  }
  if (lower.endsWith("ing")) {
    const ing = (stem: string) => `${stem}ɪŋ`;
    tries.push([lower.slice(0, -3), ing], [`${lower.slice(0, -3)}e`, ing]);
  }
  for (const [stem, attach] of tries) {
    if (stem.length < 2) continue;
    const ps = lookup(stem);
    if (ps) return attach(ps);
  }
  return null;
}

/** Last resort: letters to sounds, stress on the first vowel. Rough on purpose; OOV lists what needed it. */
const LETTERS: [RegExp, string][] = [
  [/^tion/, "ʃən"], [/^sh/, "ʃ"], [/^ch/, "ʧ"], [/^th/, "θ"], [/^ph/, "f"], [/^ck/, "k"], [/^ng/, "ŋ"], [/^qu/, "kw"],
  [/^ee/, "i"], [/^ea/, "i"], [/^oo/, "u"], [/^ai/, "A"], [/^ay/, "A"], [/^ow/, "O"], [/^ou/, "W"], [/^oa/, "O"],
  [/^a/, "æ"], [/^e$/, ""], [/^e/, "ɛ"], [/^i/, "ɪ"], [/^o/, "ɑ"], [/^u/, "ʌ"], [/^y$/, "i"], [/^y/, "j"],
  [/^c(?=[eiy])/, "s"], [/^c/, "k"], [/^g(?=[eiy])/, "ʤ"], [/^g/, "ɡ"], [/^j/, "ʤ"], [/^x/, "ks"], [/^r/, "ɹ"],
  [/^([bdfhklmnpstvwz])\1?/, "$1"],
];

function letters(w: string): string {
  let rest = w.toLowerCase().replace(/[^a-z]/g, "");
  let out = "";
  let stressed = false;
  while (rest.length > 0) {
    const rule = LETTERS.find(([re]) => re.test(rest));
    if (!rule) { rest = rest.slice(1); continue; }
    const [re, ph] = rule;
    const matched = rest.match(re)![0];
    const sound = matched.replace(re, ph);
    if (!stressed && /[æɛɪɑʌiuAOWə]/.test(sound)) { out += "ˈ"; stressed = true; }
    out += sound;
    rest = rest.slice(matched.length);
  }
  return out;
}

function word(w: string, nextStartsWithVowel: boolean): string {
  const lower = w.toLowerCase();
  // Context forms misaki sets apart from its dictionary.
  if (lower === "the") return nextStartsWithVowel ? "ði" : "ðə";
  if (lower === "a") return "ə";
  if (lower === "an") return "ən";
  const ps = lookup(w) ?? withEnding(w);
  if (ps) return ps;
  OOV.add(w);
  return letters(w);
}

/** Phonemes of English `text` (digits already spelled). */
export function g2pEn(text: string): string {
  const tokens = [...text.normalize("NFC").matchAll(/([A-Za-z]+(?:'[A-Za-z]+)?)|([,.;:!?…—])/g)];
  const parts: string[] = [];
  for (const [index, match] of tokens.entries()) {
    if (match[1]) {
      const next = tokens.slice(index + 1).find((t) => t[1])?.[1] ?? "";
      parts.push((parts.length > 0 ? " " : "") + word(match[1], /^[aeiouAEIOU]/.test(next)));
    } else parts.push(match[2]!);
  }
  return parts.join("");
}
