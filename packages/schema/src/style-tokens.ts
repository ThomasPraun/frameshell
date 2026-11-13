// The style tokens a generated clip's page reads (ADR 0028): CSS custom properties on `:root`, made by the host from
// the resolved `style.json` and inserted by an adapter that opts in (`styleTokens`), so a rebrand is a style edit.
import type { ResolvedStyle, StyleFont } from "./style.js";

/** Prefix of every token variable: `--fs-color-accent`, `--fs-motion-quick`. */
export const STYLE_TOKEN_PREFIX = "--fs-";

/** Font roles of a style, in the order their variables are written. */
const FONT_ROLES = ["display", "ui", "captions", "keyword"] as const;

/** A project font file's bytes for its `@font-face`, base64. */
export interface StyleTokenFace {
  /** Project-relative file, as `fonts.<role>.file` names it. */
  file: string;
  base64: string;
}

/** `@font-face` format and media type of a font file, by extension. */
const FORMATS: Record<string, { format: string; type: string }> = {
  ttf: { format: "truetype", type: "font/ttf" },
  otf: { format: "opentype", type: "font/otf" },
  woff: { format: "woff", type: "font/woff" },
  woff2: { format: "woff2", type: "font/woff2" },
};

/** A family name safe inside a quoted CSS string. */
function cssName(family: string): string {
  return family.replace(/["\\<>;{}\n\r]/g, "");
}

/** `n` with at most 6 decimals, no trailing zeros. */
function num(value: number): string {
  return String(Math.round(value * 1e6) / 1e6);
}

/**
 * The token sheet of a resolved style: `:root` variables for every colour the style sets (`--fs-color-<role>`),
 * every font role it names (`--fs-font-<role>` as a family stack, `-weight`, `-tracking` in em), the type sizes
 * (`--fs-type-hero`, `-card`, `-min-readable`, `-margin`, `-caption`: px on a 1080 short side), and the motion values
 * (`--fs-motion-quick`/`-standard`/`-slow`/`-stagger` and `-spring-response` in s, `-ease` a `cubic-bezier()`,
 * `-overshoot`, `-exit`, `-spring-damping`, `-highlight` 1 or 0, `-personality`), then one `@font-face` per font file
 * among `faces`. Pure: the same style and bytes give the same text, which the render key hashes.
 */
export function styleTokenCss(style: ResolvedStyle, faces: readonly StyleTokenFace[] = []): string {
  const vars: [string, string][] = [];
  const add = (name: string, value: string) => vars.push([`${STYLE_TOKEN_PREFIX}${name}`, value]);
  for (const [role, leaf] of Object.entries(style.colors)) if (leaf.value !== null) add(`color-${role}`, leaf.value.toLowerCase());
  const fonts: StyleFont[] = [];
  for (const role of FONT_ROLES) {
    const font = style.fonts[role].value;
    if (font === null) continue;
    fonts.push(font);
    add(`font-${role}`, `"${cssName(font.family)}", system-ui, sans-serif`);
    if (font.weight !== undefined) add(`font-${role}-weight`, String(font.weight));
    if (font.tracking !== undefined) add(`font-${role}-tracking`, `${num(font.tracking)}em`);
  }
  const { type, motion } = style;
  add("type-hero", `${num(type.hero.value)}px`);
  add("type-card", `${num(type.card.value)}px`);
  add("type-min-readable", `${num(type.minReadable.value)}px`);
  add("type-margin", `${num(type.margin.value)}px`);
  if (type.caption.value !== null) add("type-caption", `${num(type.caption.value)}px`);
  add("motion-personality", motion.personality.value);
  add("motion-quick", `${num(motion.duration.quick.value)}s`);
  add("motion-standard", `${num(motion.duration.standard.value)}s`);
  add("motion-slow", `${num(motion.duration.slow.value)}s`);
  add("motion-ease", `cubic-bezier(${motion.ease.value.map(num).join(", ")})`);
  add("motion-overshoot", num(motion.overshoot.value));
  add("motion-stagger", `${num(motion.stagger.value)}s`);
  add("motion-exit", num(motion.exit.value));
  add("motion-spring-response", `${num(motion.spring.response.value)}s`);
  add("motion-spring-damping", num(motion.spring.damping.value));
  add("motion-highlight", motion.highlight.value ? "1" : "0");
  const lines = [":root {", ...vars.map(([name, value]) => `  ${name}: ${value};`), "}"];
  const seen = new Set<string>();
  for (const font of fonts) {
    const face = font.file === undefined ? undefined : faces.find((candidate) => candidate.file === font.file);
    const kind = FORMATS[font.file?.slice(font.file.lastIndexOf(".") + 1).toLowerCase() ?? ""];
    const key = `${font.file}\0${font.weight ?? ""}`;
    if (!face || !kind || seen.has(key)) continue;
    seen.add(key);
    const weight = font.weight === undefined ? "" : ` font-weight: ${font.weight};`;
    lines.push(`@font-face { font-family: "${cssName(font.family)}"; src: url("data:${kind.type};base64,${face.base64}") format("${kind.format}");${weight} }`);
  }
  return `${lines.join("\n")}\n`;
}
