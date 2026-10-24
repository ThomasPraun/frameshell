// Digits as they are said, so a script's `23` meets a transcript's `veintitrés` (ADR 0023). Spanish and English only.

const ES_UNITS = ["cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once", "doce", "trece", "catorce", "quince", "dieciséis", "diecisiete", "dieciocho", "diecinueve", "veinte", "veintiuno", "veintidós", "veintitrés", "veinticuatro", "veinticinco", "veintiséis", "veintisiete", "veintiocho", "veintinueve"];
const ES_TENS = ["", "", "", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];
const ES_HUNDREDS = ["", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos"];
const EN_UNITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** Largest integer spelled out; bigger ones stay digits. */
const MAX_SPELLED = 999_999_999;

/** Languages {@link spellNumber} knows, by the transcript's language code (`es`, `es-AR`, `en`…). */
export type NumberLanguage = "es" | "en";

/** `es`/`en` from a language code; null for any other or none. */
export function numberLanguage(code: string | null | undefined): NumberLanguage | null {
  const base = code?.toLowerCase().split(/[-_]/)[0];
  return base === "es" || base === "en" ? base : null;
}

/**
 * The words a number written with digits is said as: `23` → `veintitrés`,
 * `1.500` (es) / `1,500` (en) → thousands, `1,5` / `1.5` → decimals said digit
 * by digit after `coma` / `point`. Null when `token` is not such a number.
 */
export function spellNumber(token: string, language: NumberLanguage): string[] | null {
  const match = /^(\d+)((?:[.,]\d+)*)$/.exec(token);
  if (!match) return null;
  const groups = token.split(/[.,]/);
  const thousands = groups.length > 1 && groups.slice(1).every((group) => group.length === 3);
  if (thousands) return integer(Number(groups.join("")), language);
  if (groups.length > 2) return null;
  const whole = integer(Number(groups[0]), language);
  if (groups.length === 1 || whole === null) return whole;
  const digits = [...groups[1]!].flatMap((digit) => integer(Number(digit), language)!);
  return [...whole, language === "es" ? "coma" : "point", ...digits];
}

function integer(value: number, language: NumberLanguage): string[] | null {
  if (!Number.isSafeInteger(value) || value > MAX_SPELLED) return null;
  return language === "es" ? spanish(value) : english(value);
}

function spanish(value: number): string[] {
  if (value < 30) return [ES_UNITS[value]!];
  if (value < 100) {
    const unit = value % 10;
    return unit === 0 ? [ES_TENS[Math.floor(value / 10)]!] : [ES_TENS[Math.floor(value / 10)]!, "y", ES_UNITS[unit]!];
  }
  if (value === 100) return ["cien"];
  if (value < 1000) {
    const rest = value % 100;
    return [ES_HUNDREDS[Math.floor(value / 100)]!, ...(rest > 0 ? spanish(rest) : [])];
  }
  if (value < 1_000_000) {
    const high = Math.floor(value / 1000);
    const rest = value % 1000;
    // `veintiún mil`, `un mil` is said `mil`.
    const head = high === 1 ? [] : spanish(high).map((word, index, all) => (index === all.length - 1 ? apocope(word) : word));
    return [...head, "mil", ...(rest > 0 ? spanish(rest) : [])];
  }
  const high = Math.floor(value / 1_000_000);
  const rest = value % 1_000_000;
  const head = high === 1 ? ["un", "millón"] : [...spanish(high).map((word, index, all) => (index === all.length - 1 ? apocope(word) : word)), "millones"];
  return [...head, ...(rest > 0 ? spanish(rest) : [])];
}

/** `uno` before a noun: `veintiuno` → `veintiún`, `uno` → `un`. */
function apocope(word: string): string {
  if (word === "uno") return "un";
  if (word === "veintiuno") return "veintiún";
  return word;
}

function english(value: number): string[] {
  if (value < 20) return [EN_UNITS[value]!];
  if (value < 100) {
    const unit = value % 10;
    return unit === 0 ? [EN_TENS[Math.floor(value / 10)]!] : [EN_TENS[Math.floor(value / 10)]!, EN_UNITS[unit]!];
  }
  if (value < 1000) {
    const rest = value % 100;
    return [EN_UNITS[Math.floor(value / 100)]!, "hundred", ...(rest > 0 ? english(rest) : [])];
  }
  if (value < 1_000_000) {
    const rest = value % 1000;
    return [...english(Math.floor(value / 1000)), "thousand", ...(rest > 0 ? english(rest) : [])];
  }
  const rest = value % 1_000_000;
  return [...english(Math.floor(value / 1_000_000)), "million", ...(rest > 0 ? english(rest) : [])];
}
