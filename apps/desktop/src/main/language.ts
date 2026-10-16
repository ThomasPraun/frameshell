import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Lang, isLang, langOf } from "../shared/i18n/index.js";

/** The UI language the user picked in View > Language, or `system` to follow the OS (#189). */
export type LanguageChoice = Lang | "system";

/** The choice saved in `file`; `system` when there is none or it is unreadable. */
export function readLanguageChoice(file: string): LanguageChoice {
  try {
    const { language } = JSON.parse(readFileSync(file, "utf8")) as { language?: unknown };
    return isLang(language) ? language : "system";
  } catch {
    return "system";
  }
}

/** Save `choice` to `file`. */
export async function writeLanguageChoice(file: string, choice: LanguageChoice): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ language: choice }, null, 2)}\n`);
}

/** The UI language for `choice`, with the OS `locale` (`app.getLocale()`) deciding for `system`. */
export function uiLanguage(choice: LanguageChoice, locale: string): Lang {
  return choice === "system" ? langOf(locale) : choice;
}
