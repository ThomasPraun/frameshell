import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLanguageChoice, uiLanguage, writeLanguageChoice } from "../src/main/language.js";
import { AREAS, langOf, strings } from "../src/shared/i18n/index.js";

const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

/** Every leaf of `en` paired with `es` at the same path; functions called with sample arguments. */
function* leaves(en: unknown, es: unknown, path: string): Generator<{ path: string; en: unknown; es: unknown }> {
  if (typeof en === "function") {
    const args = Array.from({ length: en.length }, () => "2");
    yield { path, en: (en as (...a: unknown[]) => unknown)(...args), es: typeof es === "function" ? (es as (...a: unknown[]) => unknown)(...args) : es };
    yield { path: `${path}.length`, en: en.length, es: typeof es === "function" ? es.length : es };
  } else if (en && typeof en === "object") {
    expect(Object.keys(es as object).sort(), path).toEqual(Object.keys(en).sort());
    for (const [key, value] of Object.entries(en)) yield* leaves(value, (es as Record<string, unknown>)[key], `${path}.${key}`);
  } else yield { path, en, es };
}

describe("UI dictionary", () => {
  it("has every English key in Spanish, with the same parameters and markup slots", () => {
    for (const [area, { en, es }] of Object.entries(AREAS)) {
      for (const leaf of leaves(en, es, area)) {
        if (typeof leaf.en === "number") expect(leaf.es, leaf.path).toBe(leaf.en);
        else {
          expect(typeof leaf.es, leaf.path).toBe("string");
          expect((leaf.es as string).trim(), leaf.path).not.toBe("");
          expect(slots(leaf.es as string), leaf.path).toEqual(slots(leaf.en as string));
        }
      }
    }
  });

  it("speaks Spanish for any Spanish locale and English otherwise", () => {
    expect(langOf("es")).toBe("es");
    expect(langOf("es-419")).toBe("es");
    expect(langOf("es_AR")).toBe("es");
    expect(langOf("en-US")).toBe("en");
    expect(langOf("pt-BR")).toBe("en");
    expect(strings("es").welcome.cancel).toBe("Cancelar");
  });
});

describe("language choice", () => {
  it("follows the system until the user picks a language, and keeps the pick", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "fs-lang-")), "config", "language.json");
    expect(readLanguageChoice(file)).toBe("system");
    expect(uiLanguage("system", "es-MX")).toBe("es");
    await writeLanguageChoice(file, "en");
    expect(readLanguageChoice(file)).toBe("en");
    expect(uiLanguage(readLanguageChoice(file), "es-MX")).toBe("en");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ language: "en" });
  });

  it("falls back to the system for an unreadable or unknown choice", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "fs-lang-")), "language.json");
    await writeFile(file, "{ not json");
    expect(readLanguageChoice(file)).toBe("system");
    await writeFile(file, JSON.stringify({ language: "fr" }));
    expect(readLanguageChoice(file)).toBe("system");
  });
});
