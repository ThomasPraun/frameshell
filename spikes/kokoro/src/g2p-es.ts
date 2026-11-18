// Rule-based Spanish orthography -> phonemes in Kokoro's vocabulary (tokenizer.json). No dictionary, no eSpeak:
// Spanish spelling is close to phonemic, so letters + stress rules cover native words. Output follows the
// conventions Kokoro's Spanish voices were trained on (espeak-ng `es` through misaki): stress mark right before
// the stressed vowel, spaces between words, punctuation kept. Digits must be spelled before (spellNumbersIn).

/** Knobs measured by the spike (A/B through the whisper round trip). */
export interface EsOptions {
  /** c/z before e/i as `s` (Latin American) instead of `θ` (espeak `es` is Castilian). */
  seseo: boolean;
  /** b/d/g as `β ð ɣ` between vowels (what espeak `es` writes) instead of always stops. */
  allophones: boolean;
  /** ll as `ʝ` (yeísmo) instead of `ʎ`. */
  yeismo: boolean;
}

export const ES_DEFAULTS: EsOptions = { seseo: true, allophones: true, yeismo: true };

const VOWELS = "aeiou";
const ACCENTED: Record<string, string> = { á: "a", é: "e", í: "i", ó: "o", ú: "u", ü: "u" };

/** Clitic and function words said without stress (one syllable or proclitic). */
const UNSTRESSED = new Set([
  "el", "la", "lo", "los", "las", "de", "del", "a", "al", "en", "con", "por", "para", "sin", "y", "e", "o", "u", "ni",
  "que", "se", "me", "te", "le", "les", "nos", "os", "mi", "mis", "tu", "tus", "su", "sus", "si", "como", "cuando",
  "donde", "pero", "un", "una", "unos", "unas",
]);

/** Words whose x is a velar fricative (Mexican place names, old spelling). */
const X_AS_J = new Set(["méxico", "mexico", "mexicano", "mexicana", "mexicanos", "mexicanas", "oaxaca", "texas", "xavier"]);

interface Seg {
  ph: string;
  /** A vowel letter (may become a glide). */
  vowel?: boolean;
  accent?: boolean;
  glide?: boolean;
}

/** Phonemes of one lowercase word; B/D/G are resolved per phrase (allophones). */
function word(w: string, o: EsOptions): string {
  const segs: Seg[] = [];
  const at = (i: number) => w[i] ?? "";
  const front = (c: string) => "eiéí".includes(c) && c !== "";
  for (let i = 0; i < w.length; i++) {
    const c = w[i]!;
    const next = at(i + 1);
    // A doubled consonant of a loanword (WhatsApp, Gucci) is said once; cc, ll and rr are read below.
    if (c === at(i - 1) && "bdfgkmnpstvz".includes(c)) continue;
    if (VOWELS.includes(c)) segs.push({ ph: c, vowel: true });
    else if (c in ACCENTED) segs.push({ ph: ACCENTED[c]!, vowel: true, accent: c !== "ü" });
    else if (c === "c" && next === "h") { segs.push({ ph: "ʧ" }); i++; }
    else if (c === "c") segs.push({ ph: front(next) ? (o.seseo ? "s" : "θ") : "k" });
    else if (c === "z") segs.push({ ph: o.seseo ? "s" : "θ" });
    else if (c === "l" && next === "l") { segs.push({ ph: o.yeismo ? "ʝ" : "ʎ" }); i++; }
    else if (c === "r" && next === "r") { segs.push({ ph: "r" }); i++; }
    else if (c === "r") segs.push({ ph: i === 0 || "lns".includes(at(i - 1)) ? "r" : "ɾ" });
    else if (c === "q" && next === "u") { segs.push({ ph: "k" }); i++; }
    else if (c === "q") segs.push({ ph: "k" });
    else if (c === "g" && next === "u" && front(at(i + 2))) { segs.push({ ph: "G" }); i++; }
    else if (c === "g") segs.push({ ph: front(next) ? "x" : "G" });
    else if (c === "j") segs.push({ ph: "x" });
    else if (c === "h") continue;
    else if (c === "ñ") segs.push({ ph: "ɲ" });
    else if (c === "b" || c === "v") segs.push({ ph: "B" });
    else if (c === "d") segs.push({ ph: "D" });
    else if (c === "x") {
      if (X_AS_J.has(w)) segs.push({ ph: "x" });
      else if (i === 0) segs.push({ ph: "s" });
      else segs.push({ ph: "k" }, { ph: "s" });
    } else if (c === "y") {
      // Final y after a vowel (hoy, rey, muy) and the word "y" are vowels; elsewhere a consonant.
      if (w === "y" || (i === w.length - 1 && i > 0)) segs.push({ ph: "i", vowel: true });
      else segs.push({ ph: "ʝ" });
    } else if (c === "w") segs.push({ ph: "w" });
    else if (c === "k") segs.push({ ph: "k" });
    else if ("fmnpstl".includes(c)) segs.push({ ph: c });
    // Anything else (a stray letter of another script) is dropped.
  }

  // Glides: an unaccented i/u next to another vowel is not a syllable nucleus. "ui"/"iu": the first glides.
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (!s.vowel || s.accent || (s.ph !== "i" && s.ph !== "u")) continue;
    const next = segs[i + 1];
    const prev = segs[i - 1];
    if (next?.vowel && !next.glide) s.glide = true;
    else if (prev?.vowel && !prev.glide && prev.ph !== s.ph) s.glide = true;
  }
  const nuclei = segs.flatMap((s, i) => (s.vowel && !s.glide ? [i] : []));
  let stressed: number | null = null;
  const accented = nuclei.find((i) => segs[i]!.accent);
  if (accented !== undefined) stressed = accented;
  else if (nuclei.length === 1) stressed = UNSTRESSED.has(w) ? null : nuclei[0]!;
  else if (nuclei.length > 1 && !UNSTRESSED.has(w)) {
    const last = w.at(-1)!;
    const penult = VOWELS.includes(last) || last === "n" || last === "s";
    stressed = nuclei[penult ? nuclei.length - 2 : nuclei.length - 1]!;
  }
  return segs
    .map((s, i) => {
      // Rising glides (bueno, tiene) are j/w; falling ones (aire, auto) keep the vowel letter, as espeak writes them.
      const ph = s.glide ? (segs[i + 1]?.vowel ? (s.ph === "i" ? "j" : "w") : s.ph) : s.ph;
      return (i === stressed ? "ˈ" : "") + ph;
    })
    .join("");
}

/** Resolve B/D/G (stop after a pause or nasal, d also after l; fricative elsewhere) and n before labials/velars. */
function phrase(ps: string, o: EsOptions): string {
  const out: string[] = [];
  const chars = [...ps];
  let last = ""; // Last phoneme said in this phrase; "" = after a pause.
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === " " || c === "ˈ") { out.push(c); continue; }
    if (",.;:!?…—".includes(c)) { out.push(c); last = ""; continue; }
    const nasal = "mnŋ".includes(last);
    let ph = c;
    if (c === "B") ph = !o.allophones || last === "" || nasal ? "b" : "β";
    else if (c === "D") ph = !o.allophones || last === "" || nasal || last === "l" ? "d" : "ð";
    else if (c === "G") ph = !o.allophones || last === "" || nasal ? "ɡ" : "ɣ";
    if (c === "n") {
      const ahead = chars.slice(i + 1).find((x) => x !== " " && x !== "ˈ") ?? "";
      if ("Bbpm".includes(ahead)) ph = "m";
      else if ("kGx".includes(ahead)) ph = "ŋ";
    }
    out.push(ph);
    last = ph;
  }
  return out.join("");
}

/** Phonemes of Spanish `text` (digits already spelled). */
export function g2pEs(text: string, options: Partial<EsOptions> = {}): string {
  const o = { ...ES_DEFAULTS, ...options };
  const parts: string[] = [];
  for (const match of text.toLowerCase().normalize("NFC").matchAll(/(\p{L}+)|([,.;:!?…—])|[-\s]+/gu)) {
    if (match[1]) parts.push((parts.length > 0 ? " " : "") + word(match[1], o));
    else if (match[2]) parts.push(match[2]);
  }
  return phrase(parts.join("").trim(), o);
}
