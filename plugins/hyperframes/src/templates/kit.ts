import { MOTION_RUNTIME_FILE } from "../motion-runtime.js";
import { type BrandTokens, type FontToken, fontCopyName } from "./tokens.js";

/** One typed prop of a template: a HyperFrames composition variable with its bounds. */
export type TemplateVariable =
  | { id: string; type: "string"; label: string; default: string; maxLength?: number }
  | { id: string; type: "number"; label: string; default: number; min: number; max: number; step?: number; unit?: string }
  | { id: string; type: "color"; label: string; default: string }
  | { id: string; type: "image"; label: string; default: string; description?: string }
  | { id: string; type: "enum"; label: string; default: string; options: { value: string; label: string }[] };

/** What a template renders into HTML. */
export interface TemplateInput {
  /** Composition id and directory name. */
  id: string;
  width: number;
  height: number;
  /** Seconds. */
  duration: number;
  tokens: BrandTokens;
}

/** A scaffoldable motion composition (ADR 0033, #466). */
export interface Template {
  id: string;
  description: string;
  /** Seconds the clip plays unless `--duration` says otherwise. */
  defaultDuration: number;
  /** True when the picture is transparent by default (meant over footage); false when it paints its own background. */
  overlay: boolean;
  /** The typed props, with defaults already taken from the brand tokens. */
  variables(input: TemplateInput): TemplateVariable[];
  /** The composition's `index.html`. */
  render(input: TemplateInput): string;
}

/** Placeholder palette used where `style.json` names no colour (ADR 0028: null = not decided). */
export const PLACEHOLDER = { bg: "#0b1020", ink: "#ffffff", accent: "#ffb400" } as const;

/** HTML-escapes text for element content and quoted attributes. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** The array `data-composition-variables` takes, escaped for a single-quoted attribute. */
export function variablesAttribute(variables: readonly TemplateVariable[]): string {
  return JSON.stringify(variables).replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/</g, "&lt;");
}

/** A font family as a CSS value: the quoted brand family, then a system fallback. */
function stack(font: FontToken | undefined, fallback: string): string {
  if (!font) return fallback;
  return `"${font.family.replace(/["\\<>;{}\n\r]/g, "")}", ${fallback}`;
}

/** Fonts of a template: `@font-face` rules, the two CSS stacks and the project files to copy next to the composition. */
export interface FontSetup {
  faces: string;
  display: string;
  ui: string;
  /** Font weight of the display role. */
  displayWeight: number;
  copies: { from: string; to: string }[];
}

/**
 * The fonts of `tokens`: a style font with a project file is copied into the
 * composition (`fonts/<name>`) and declared with `@font-face`, so the render is
 * offline and the live page sees the same face. A family without a file only
 * names the family, which renders only if the machine has it.
 */
export function fontSetup(tokens: BrandTokens): FontSetup {
  const faces: string[] = [];
  const copies: FontSetup["copies"] = [];
  const seen = new Set<string>();
  for (const font of [tokens.display, tokens.ui]) {
    if (!font?.file || seen.has(font.file)) continue;
    seen.add(font.file);
    copies.push({ from: font.file, to: fontCopyName(font.file) });
    const family = font.family.replace(/["\\<>;{}\n\r]/g, "");
    faces.push(`@font-face { font-family: "${family}"; src: url("${fontCopyName(font.file)}"); font-weight: ${font.weight ?? 400}; }`);
  }
  const system = "system-ui, -apple-system, 'Segoe UI', sans-serif";
  return {
    faces: faces.join("\n      "),
    display: stack(tokens.display, system),
    ui: stack(tokens.ui ?? tokens.display, system),
    displayWeight: tokens.display?.weight ?? 800,
    copies,
  };
}

/** Everything up to `<body>`: document head with the variables, the runtime script and the shared reset. */
export function pageHead(input: TemplateInput, variables: readonly TemplateVariable[], css: string): string {
  const fonts = fontSetup(input.tokens);
  return `<!doctype html>
<html lang="en" data-composition-variables='${variablesAttribute(variables)}'>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${input.width}, height=${input.height}" />
    <title>${escapeHtml(input.id)}</title>
    <style>
      ${fonts.faces}
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${input.width}px; height: ${input.height}px; overflow: hidden; }
      #stage { position: relative; width: 100%; height: 100%; }
      .clip { position: absolute; inset: 0; }
      ${css}
    </style>
    <script src="${MOTION_RUNTIME_FILE}"></script>
  </head>`;
}

/** Page-script helpers shared by templates: hex colours to mix and to judge contrast. */
export const COLOR_HELPERS = String.raw`
      function rgb(hex) {
        var h = hex.slice(1, 7);
        if (hex.length === 4 || hex.length === 5) h = hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
      }
      // Mixes hex colour a toward b by amount (0..1), as a hex string.
      function mix(a, b, amount) {
        var x = rgb(a), y = rgb(b);
        return "#" + [0, 1, 2].map(function (i) {
          return ("0" + Math.round(x[i] + (y[i] - x[i]) * amount).toString(16)).slice(-2);
        }).join("");
      }
      // Black or white text, whichever reads on the colour (relative luminance, sRGB).
      function onColor(hex) {
        var lin = rgb(hex).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
        return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2] > 0.4 ? "#0b1020" : "#ffffff";
      }`;

/** The two props of a template that can sit on its own background: a colour and how solid it is (0 = transparent over footage). */
export function backdropVariables(tokens: BrandTokens): TemplateVariable[] {
  return [
    { id: "bg", type: "color", label: "Background colour", default: tokens.colors.bg ?? PLACEHOLDER.bg },
    { id: "backdrop", type: "number", label: "Solid background behind it, 0 = transparent over footage, 1 = opaque", default: 0, min: 0, max: 1, step: 0.05 },
  ];
}

/** CSS of the optional background element `<div id="backdrop">`, the first child of the clip. */
export const BACKDROP_CSS = "#backdrop { position: absolute; inset: 0; }";

/** Page-script setup of `#backdrop` (needs {@link COLOR_HELPERS}); the template writes its opacity as `P.backdrop` times its fade. */
export const BACKDROP_SETUP = String.raw`
      var backdrop = document.getElementById("backdrop");
      backdrop.style.background = "radial-gradient(ellipse at 50% 40%, " + mix(P.bg, "#ffffff", 0.09) + " 0%, " + P.bg + " 72%)";`;
