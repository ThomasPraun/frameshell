/**
 * Whisper's language names (as `verbose_json` reports `language`, e.g. `spanish`) by ISO 639-1 code, from the
 * `LANGUAGES` table of openai/whisper's `tokenizer.py`. Transcripts store the code.
 */
const NAMES: Readonly<Record<string, string>> = {
  en: "english", zh: "chinese", de: "german", es: "spanish", ru: "russian", ko: "korean", fr: "french", ja: "japanese",
  pt: "portuguese", tr: "turkish", pl: "polish", ca: "catalan", nl: "dutch", ar: "arabic", sv: "swedish", it: "italian",
  id: "indonesian", hi: "hindi", fi: "finnish", vi: "vietnamese", he: "hebrew", uk: "ukrainian", el: "greek", ms: "malay",
  cs: "czech", ro: "romanian", da: "danish", hu: "hungarian", ta: "tamil", no: "norwegian", th: "thai", ur: "urdu",
  hr: "croatian", bg: "bulgarian", lt: "lithuanian", la: "latin", mi: "maori", ml: "malayalam", cy: "welsh", sk: "slovak",
  te: "telugu", fa: "persian", lv: "latvian", bn: "bengali", sr: "serbian", az: "azerbaijani", sl: "slovenian",
  kn: "kannada", et: "estonian", mk: "macedonian", br: "breton", eu: "basque", is: "icelandic", hy: "armenian",
  ne: "nepali", mn: "mongolian", bs: "bosnian", kk: "kazakh", sq: "albanian", sw: "swahili", gl: "galician",
  mr: "marathi", pa: "punjabi", si: "sinhala", km: "khmer", sn: "shona", yo: "yoruba", so: "somali", af: "afrikaans",
  oc: "occitan", ka: "georgian", be: "belarusian", tg: "tajik", sd: "sindhi", gu: "gujarati", am: "amharic",
  yi: "yiddish", lo: "lao", uz: "uzbek", fo: "faroese", ht: "haitian creole", ps: "pashto", tk: "turkmen",
  nn: "nynorsk", mt: "maltese", sa: "sanskrit", lb: "luxembourgish", my: "myanmar", bo: "tibetan", tl: "tagalog",
  mg: "malagasy", as: "assamese", tt: "tatar", haw: "hawaiian", ln: "lingala", ha: "hausa", ba: "bashkir",
  jw: "javanese", su: "sundanese", yue: "cantonese",
};

const CODES: ReadonlyMap<string, string> = new Map(Object.entries(NAMES).map(([code, name]) => [name, code]));

/** The code of a language the service reported by name or by code; undefined when it is neither. */
export function languageCode(reported: unknown): string | undefined {
  if (typeof reported !== "string") return undefined;
  const value = reported.trim().toLowerCase();
  if (Object.hasOwn(NAMES, value)) return value;
  return CODES.get(value);
}
