import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

/**
 * The docs pages, one Markdown file per page and language: `src/content/docs/<lang>/<slug>.md`.
 * Every page exists in both languages with the same slug; the build fails otherwise (see `docs.ts`).
 */
const docs = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/docs" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    /** Sidebar group; the order of groups is `DOC_SECTIONS` in `src/docs.ts`. */
    section: z.enum(["start", "concepts", "guides", "reference", "help"]),
    /** Position inside its group, smallest first. */
    order: z.number(),
  }),
});

export const collections = { docs };
