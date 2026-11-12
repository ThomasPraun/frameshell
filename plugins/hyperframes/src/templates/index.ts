import { appWindow } from "./app-window.js";
import { bigWord } from "./big-word.js";
import { checklist } from "./checklist.js";
import { commentBox } from "./comment-box.js";
import { comparison } from "./comparison.js";
import { counter } from "./counter.js";
import { cursorClick } from "./cursor-click.js";
import { cursorDragDrop } from "./cursor-drag-drop.js";
import { cursorMarquee } from "./cursor-marquee.js";
import { cursorTextSelect } from "./cursor-text-select.js";
import { endCard } from "./end-card.js";
import type { Template } from "./kit.js";
import { kineticHeadline } from "./kinetic-headline.js";
import { logoLockup } from "./logo-lockup.js";
import { lowerThird } from "./lower-third.js";
import { typingField } from "./typing-field.js";

export { type FontSetup, type Template, type TemplateInput, type TemplateVariable, fontSetup } from "./kit.js";
export { type BrandTokens, type FontToken, readTokens } from "./tokens.js";

/** The templates `frameshell hyperframes new --template <id>` scaffolds, in the order the docs list them (#466). */
export const TEMPLATES: readonly Template[] = [kineticHeadline, endCard, lowerThird, logoLockup, checklist, comparison, counter, bigWord, cursorClick, cursorDragDrop, cursorMarquee, cursorTextSelect, appWindow, typingField, commentBox];

/** The template with id `id`, if any. */
export function findTemplate(id: string): Template | undefined {
  return TEMPLATES.find((template) => template.id === id);
}
