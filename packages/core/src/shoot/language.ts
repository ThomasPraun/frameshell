// The language a shoot script is written in (#742): a take of it is transcribed in that language when the project
// sets none, so whisper's own guess (often wrong on a few seconds of speech) is not needed.
import type { ShootScript } from "@frameshell/schema";

/** Short, very common words of each language whisper is told: enough to tell a script's language apart. */
const MARKERS: Record<string, readonly string[]> = {
  es: ["el", "la", "los", "las", "de", "que", "y", "en", "un", "una", "es", "por", "para", "con", "no", "su", "lo", "como", "pero", "del", "al", "hoy", "muy", "este", "esta"],
  en: ["the", "and", "of", "to", "a", "in", "is", "it", "you", "that", "for", "on", "with", "this", "are", "be", "we", "your", "today", "what"],
  pt: ["o", "os", "as", "de", "que", "e", "em", "um", "uma", "é", "não", "para", "com", "do", "da", "no", "na", "você", "hoje", "muito"],
  fr: ["le", "la", "les", "de", "et", "en", "un", "une", "est", "que", "pour", "pas", "dans", "du", "des", "vous", "nous", "avec", "ce", "aujourd'hui"],
  de: ["der", "die", "das", "und", "ist", "nicht", "ein", "eine", "zu", "mit", "den", "auf", "ich", "sie", "wir", "es", "für", "von", "heute", "auch"],
};

/** Fewest spoken words before a guess is made. */
const MIN_WORDS = 12;
/** Share of the words the winning language's markers must cover, and how far ahead of the next it must be. */
const MIN_SHARE = 0.12;
const MIN_LEAD = 1.5;

/**
 * The ISO 639-1 code of the language `words` are in, among es, en, pt, fr, de; null when too few words or no clear
 * winner (whisper then detects it as before).
 */
export function guessLanguage(words: readonly string[]): string | null {
  const spoken = words.map((word) => word.toLowerCase().replace(/^[^\p{L}']+|[^\p{L}']+$/gu, "")).filter((word) => word !== "");
  if (spoken.length < MIN_WORDS) return null;
  const scores = Object.entries(MARKERS)
    .map(([language, markers]) => {
      const set = new Set(markers);
      return { language, hits: spoken.filter((word) => set.has(word)).length };
    })
    .sort((a, b) => b.hits - a.hits);
  const [best, next] = scores;
  if (!best || best.hits / spoken.length < MIN_SHARE) return null;
  if (next && next.hits > 0 && best.hits / next.hits < MIN_LEAD) return null;
  return best.language;
}

/** The language of a shoot script's spoken lines ({@link guessLanguage}). */
export function scriptLanguage(script: ShootScript): string | null {
  return guessLanguage(script.scenes.flatMap((scene) => scene.lines.flatMap((line) => line.words)));
}
