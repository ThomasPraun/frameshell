import { Fragment, type ReactNode, createElement } from "react";
import { type Lang, strings } from "../../shared/i18n/index.js";

/**
 * The window's UI language, chosen by main (OS language or the View > Language menu). Main reloads the
 * windows when it changes, so a module-level value stays right. English where no preload runs (unit tests).
 */
export const lang: Lang = (typeof window !== "undefined" && window.frameshell?.lang) || "en";

/** UI strings in the window's language. */
export const t = strings(lang);

/**
 * A string with `{name}` slots filled with elements, for text that mixes markup (`<code>`) into a sentence:
 * `rich(t.welcome.notProject, { dir: <code>{dir}</code> })`. Plain values go through dictionary functions instead.
 */
export function rich(template: string, slots: Record<string, ReactNode>): ReactNode {
  return template
    .split(/\{(\w+)\}/)
    .map((part, index) => (index % 2 === 1 ? createElement(Fragment, { key: index }, slots[part] ?? `{${part}}`) : part));
}
