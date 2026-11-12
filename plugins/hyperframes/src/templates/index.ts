import { endCard } from "./end-card.js";
import type { Template } from "./kit.js";
import { kineticHeadline } from "./kinetic-headline.js";

export { type FontSetup, type Template, type TemplateInput, type TemplateVariable, fontSetup } from "./kit.js";
export { type BrandTokens, type FontToken, readTokens } from "./tokens.js";

/** The templates `frameshell hyperframes new --template <id>` scaffolds, in the order the docs list them (#466 first set). */
export const TEMPLATES: readonly Template[] = [kineticHeadline, endCard];

/** The template with id `id`, if any. */
export function findTemplate(id: string): Template | undefined {
  return TEMPLATES.find((template) => template.id === id);
}
