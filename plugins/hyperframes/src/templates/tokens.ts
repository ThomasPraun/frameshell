import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

/** A font role of `style.json` the templates use. */
export interface FontToken {
  family: string;
  /** Project-relative font file under `assets/fonts/`, when the style names one that exists. */
  file?: string;
  weight?: number;
}

/**
 * The brand values of a project's `style.json` (ADR 0028) that templates take
 * as defaults. Every field is optional: without a style the template keeps its
 * own placeholder.
 */
export interface BrandTokens {
  colors: { bg?: string; ink?: string; ink2?: string; accent?: string; card?: string };
  display?: FontToken;
  ui?: FontToken;
  brand: { product?: string; url?: string; cta?: string };
  /** Dotted names of the style values that were used, e.g. `colors.accent`. */
  used: string[];
  /** Why the style was not (fully) read; null when there was nothing to complain about. */
  problem: string | null;
}

const HEX = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;
const FONT_FILE = /^assets\/fonts\/[^\\/]+\.(?:ttf|otf|woff2?)$/i;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

async function readFont(projectDir: string, value: unknown): Promise<FontToken | undefined> {
  if (!isRecord(value) || typeof value["family"] !== "string" || value["family"].trim() === "") return undefined;
  const font: FontToken = { family: value["family"].trim() };
  if (typeof value["weight"] === "number" && value["weight"] >= 100 && value["weight"] <= 900) font.weight = value["weight"];
  const file = value["file"];
  if (typeof file === "string" && FONT_FILE.test(file) && (await isFile(join(projectDir, ...file.split("/"))))) font.file = file;
  return font;
}

/**
 * Reads the brand values templates start from out of `<project>/style.json`.
 * Lenient on purpose: core validates the file, here a missing or unreadable
 * file, or a value of the wrong shape, only means "keep the placeholder".
 */
export async function readTokens(projectDir: string): Promise<BrandTokens> {
  const tokens: BrandTokens = { colors: {}, brand: {}, used: [], problem: null };
  const raw = await readFile(join(projectDir, "style.json"), "utf8").catch(() => null);
  if (raw === null) return tokens;
  let style: unknown;
  try {
    style = JSON.parse(raw);
  } catch {
    tokens.problem = "style.json is not valid JSON; the template keeps its placeholder colours and fonts";
    return tokens;
  }
  if (!isRecord(style)) {
    tokens.problem = "style.json is not an object; the template keeps its placeholder colours and fonts";
    return tokens;
  }
  const colors = isRecord(style["colors"]) ? style["colors"] : {};
  for (const role of ["bg", "ink", "ink2", "accent", "card"] as const) {
    const value = colors[role];
    if (typeof value === "string" && HEX.test(value)) {
      tokens.colors[role] = value;
      tokens.used.push(`colors.${role}`);
    }
  }
  const fonts = isRecord(style["fonts"]) ? style["fonts"] : {};
  for (const role of ["display", "ui"] as const) {
    const font = await readFont(projectDir, fonts[role]);
    if (font) {
      tokens[role] = font;
      tokens.used.push(`fonts.${role}`);
    }
  }
  const brand = isRecord(style["brand"]) ? style["brand"] : {};
  for (const field of ["product", "url", "cta"] as const) {
    const value = brand[field];
    if (typeof value === "string" && value.trim() !== "") {
      tokens.brand[field] = value.trim();
      tokens.used.push(`brand.${field}`);
    }
  }
  return tokens;
}

/** Name of a font file inside the composition directory (copied from `assets/fonts/`). */
export const fontCopyName = (file: string): string => `fonts/${basename(file)}`;
