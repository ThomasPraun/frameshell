// UI strings of the desktop app (#189), shared by main (menus, dialogs) and the renderer. One file per area holds
// both languages: English is the source, the Spanish object is typed by it, so a missing key fails typecheck.
import { agents } from "./agents.js";
import { angles } from "./angles.js";
import { app } from "./app.js";
import { editor } from "./editor.js";
import { history } from "./history.js";
import { inspector } from "./inspector.js";
import { layers } from "./layers.js";
import { people } from "./people.js";
import { preview } from "./preview.js";
import { review } from "./review.js";
import { shoot } from "./shoot.js";
import { terminal } from "./terminal.js";
import { timeline } from "./timeline.js";
import { transcript } from "./transcript.js";
import { welcome } from "./welcome.js";
import { workspace } from "./workspace.js";

/** Languages the UI speaks. */
export type Lang = "en" | "es";

/** The languages, with their names in their own language (the language menu shows these). */
export const LANGUAGES: readonly { id: Lang; name: string }[] = [
  { id: "en", name: "English" },
  { id: "es", name: "Español" },
];

/** Every area's strings in both languages; the parity test walks it. */
export const AREAS = { agents, angles, app, editor, history, inspector, layers, people, preview, review, shoot, terminal, timeline, transcript, welcome, workspace };

/** All UI strings of one language, by area. */
export type Dict = { [Area in keyof typeof AREAS]: (typeof AREAS)[Area]["en"] };

const cache = new Map<Lang, Dict>();

/** The UI strings in `lang`. */
export function strings(lang: Lang): Dict {
  let dict = cache.get(lang);
  if (!dict) {
    dict = Object.fromEntries(Object.entries(AREAS).map(([area, both]) => [area, both[lang]])) as Dict;
    cache.set(lang, dict);
  }
  return dict;
}

/** UI language for an OS locale such as `es-AR` or `en-US`: Spanish for any Spanish locale, else English. */
export function langOf(locale: string): Lang {
  return locale.toLowerCase().split(/[-_]/)[0] === "es" ? "es" : "en";
}

/** Whether `value` names a UI language. */
export function isLang(value: unknown): value is Lang {
  return LANGUAGES.some(({ id }) => id === value);
}
