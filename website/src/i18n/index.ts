import { en, type Dict } from "./en";
import { es } from "./es";

export type Lang = "en" | "es";

const dicts: Record<Lang, Dict> = { en, es };

/** Strings for the page's locale (`Astro.currentLocale`); English when unknown. */
export function strings(locale: string | undefined): Dict {
  return dicts[locale as Lang] ?? en;
}

/** Pages of the site, each in every language. */
export type Page = "home" | "agents";

/** Path of `page` in `lang`: English at the root, Spanish under /es/. */
export function pathFor(lang: Lang, page: Page = "home"): string {
  const root = lang === "en" ? "/" : `/${lang}/`;
  return page === "home" ? root : `${root}${page}/`;
}

// The markup indexes lists by position (tabs, replies, layer colours), so a translation with a
// missing or extra item renders wrong without a type error. Fail the build instead.
const FREE_LENGTH = new Set(["features.transcript.words"]);

function sameShape(a: unknown, b: unknown, path: string): void {
  if (FREE_LENGTH.has(path)) return;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length)
      throw new Error(`i18n: es ${path} has ${Array.isArray(b) ? b.length : "no"} items, en has ${a.length}`);
    a.forEach((x, i) => sameShape(x, b[i], `${path}.${i}`));
  } else if (a && typeof a === "object") {
    const o = b as Record<string, unknown>;
    for (const [k, v] of Object.entries(a)) sameShape(v, o[k], path ? `${path}.${k}` : k);
  }
}
sameShape(en, es, "");
