// Words as they are compared with speech: one normalization for the transcript aligner, the take comparison
// (ADR 0023) and the teleprompter's live follower (ADR 0024), in the daemon and in the app.
import { type NumberLanguage, spellNumber } from "./numbers.js";

/** Lowercase, accents and punctuation gone: `¿Está?` → `esta`. Whisper varies all three between runs. */
export function normalizeToken(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, "");
}

/** 1 - edit distance / longer length. Tokens of up to 2 characters must be equal: `de` vs `el` is not a spelling variant. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const longer = Math.max(a.length, b.length);
  if (longer <= 2) return 0;
  return 1 - editDistance(a, b) / longer;
}

/** Levenshtein distance of two strings: insertions, deletions and substitutions of one UTF-16 unit each. */
export function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, k) => k);
  for (let x = 1; x <= a.length; x++) {
    const next = [x];
    for (let y = 1; y <= b.length; y++) {
      next[y] = Math.min(row[y]! + 1, next[y - 1]! + 1, row[y - 1]! + (a[x - 1] === b[y - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length]!;
}

/**
 * Comparable tokens of `text` as it is said: split at spaces, numbers written with digits spelled out in
 * `language` (`23` → `veintitrés`; kept as digits without one), each token normalized by {@link normalizeToken}.
 */
export function spokenTokens(text: string, language: NumberLanguage | null): string[] {
  return text.split(/\s+/).flatMap((part) => {
    const bare = part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    const spelled = language ? spellNumber(bare, language) : null;
    return (spelled ?? [part]).map(normalizeToken).filter((token) => token.length > 0);
  });
}
