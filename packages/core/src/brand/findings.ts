// Pure judgements over what the capture page script measured: colours by use, the accent, and the style patch
// the agent may apply with `style set` after showing the findings to the person (ADR 0044 decision 7).
import { BRAND_COLOR_ROLES, type BrandCapture } from "@frameshell/schema";
import { weightSpan } from "./fonts.js";

/** A colour role. */
export type ColorRole = (typeof BRAND_COLOR_ROLES)[number];

/** A colour as the page script counts it: elements per role. */
export interface CountedColor {
  hex: string;
  roles: Partial<Record<ColorRole, number>>;
}

/** Browser default link colours (unvisited, visited, plain blue): a site that never styled its links. */
const LINK_DEFAULTS = new Set(["#0000ee", "#551a8b", "#0000ff"]);

/** Hue in degrees, saturation and lightness 0-1 of `#rrggbb`. */
export function hsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) * 60 : max === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60;
  return { h, s, l };
}

/** Grays, near black and near white: never an accent. */
export function isNeutral(hex: string): boolean {
  const { s, l } = hsl(hex);
  return s < 0.18 || l < 0.08 || l > 0.95;
}

/** Colours most used first, each with its roles most used first. */
export function rankColors(colors: CountedColor[]): BrandCapture["colors"] {
  return colors
    .map((color) => {
      const roles = (Object.entries(color.roles) as [ColorRole, number][]).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
      return { hex: color.hex, count: roles.reduce((sum, [, count]) => sum + count, 0), roles: roles.map(([role]) => role) };
    })
    .filter((color) => color.count > 0)
    .sort((a, b) => b.count - a.count || (a.hex < b.hex ? -1 : 1));
}

/**
 * The accent: the non-neutral colour seen in the most roles, then the most used. Never a browser default link
 * colour, and never a strong red used only for text or borders (an error or status colour, not the brand's).
 */
export function pickAccent(colors: BrandCapture["colors"]): string | null {
  const candidates = colors.filter((color) => {
    if (isNeutral(color.hex) || LINK_DEFAULTS.has(color.hex)) return false;
    const { h, s } = hsl(color.hex);
    const red = (h <= 12 || h >= 348) && s >= 0.5;
    return !(red && color.roles.every((role) => role === "text" || role === "border"));
  });
  candidates.sort((a, b) => b.roles.length - a.roles.length || b.count - a.count);
  return candidates[0]?.hex ?? null;
}

/** One `style set` the agent may run: the path and value as `style.set` takes them. */
export interface StyleSuggestion {
  path: string;
  value: unknown;
  why: string;
}

/**
 * `style.set` calls that would carry the capture into `style.json`. Only suggested: capture never writes the
 * style, the agent lists the findings to the person and applies what they agree to.
 */
export function suggestStyle(capture: Pick<BrandCapture, "colors" | "accent" | "fonts" | "files" | "headings" | "title" | "finalUrl">, siteName: string | null, pageBackground: string | null): StyleSuggestion[] {
  const out: StyleSuggestion[] = [];
  const background = pageBackground ?? capture.colors.find((color) => color.roles[0] === "background")?.hex ?? null;
  if (background) out.push({ path: "colors.bg", value: background, why: "page background" });
  const ink = capture.colors.find((color) => color.roles[0] === "text" && color.hex !== background)?.hex;
  if (ink) out.push({ path: "colors.ink", value: ink, why: "most used text colour" });
  if (capture.accent) out.push({ path: "colors.accent", value: capture.accent, why: "the colour seen in the most roles" });
  const text = capture.fonts.filter((font) => !font.generic && !font.icon);
  const headingFamily = capture.headings.map((heading) => heading.family).find((family) => text.some((font) => font.family === family));
  const display = text.find((font) => font.family === headingFamily) ?? text[0];
  const ui = text.find((font) => font !== display) ?? null;
  const fontValue = (font: BrandCapture["fonts"][number], weight: number | undefined) => {
    // Only a face drawing the suggested weight: a file of another weight would not match the suggestion.
    const file = font.faces.find((face) => {
      const [low, high] = weightSpan(face.weight);
      return face.file && (weight === undefined || (low <= weight && weight <= high));
    })?.file;
    return { family: font.family, ...(file ? { file } : {}), ...(weight !== undefined ? { weight } : {}) };
  };
  if (display) {
    const weight = capture.headings.find((heading) => heading.family === display.family)?.weight ?? display.weights[0];
    out.push({ path: "fonts.display", value: fontValue(display, weight), why: headingFamily === display.family ? "the headings' family" : "the most used family" });
  }
  if (ui) out.push({ path: "fonts.ui", value: fontValue(ui, ui.weights[0]), why: "the body text's family" });
  const product = (siteName ?? capture.title?.split(/\s+[|·–—-]\s+/)[0] ?? "").trim();
  if (product) out.push({ path: "brand.product", value: product, why: siteName ? "og:site_name" : "page title" });
  out.push({ path: "brand.url", value: new URL(capture.finalUrl).hostname.replace(/^www\./, ""), why: "the captured site" });
  if (capture.files.some((file) => file.role === "logo")) out.push({ path: "brand.mustShow", value: ["logo"], why: "a logo was captured (this replaces the list: merge it with what is there)" });
  return out;
}
