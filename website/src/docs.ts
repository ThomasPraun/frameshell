import { getCollection, type CollectionEntry } from "astro:content";
import type { Lang } from "./i18n";

/** Sidebar groups, in order. Their titles are `docs.sections` in the dictionaries. */
export const DOC_SECTIONS = ["start", "concepts", "guides", "reference", "help"] as const;

export type DocSection = (typeof DOC_SECTIONS)[number];

/** One docs page in one language. */
export interface Doc {
  slug: string;
  entry: CollectionEntry<"docs">;
}

/**
 * Docs pages of `lang`, in sidebar order. Throws when a page has no twin in the other language,
 * so the language switch never lands on a missing page.
 */
export async function docsFor(lang: Lang): Promise<Doc[]> {
  const all = await getCollection("docs");
  const slugs = (l: Lang) => new Set(all.filter((e) => e.id.startsWith(`${l}/`)).map((e) => e.id.slice(l.length + 1)));
  const en = slugs("en");
  const es = slugs("es");
  for (const s of en) if (!es.has(s)) throw new Error(`docs: es/${s}.md is missing`);
  for (const s of es) if (!en.has(s)) throw new Error(`docs: en/${s}.md is missing`);
  return all
    .filter((e) => e.id.startsWith(`${lang}/`))
    .map((entry) => ({ slug: entry.id.slice(lang.length + 1), entry }))
    .sort(
      (a, b) =>
        DOC_SECTIONS.indexOf(a.entry.data.section) - DOC_SECTIONS.indexOf(b.entry.data.section) ||
        a.entry.data.order - b.entry.data.order,
    );
}
