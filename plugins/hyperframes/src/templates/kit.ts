import { MOTION_RUNTIME_FILE } from "../motion-runtime.js";
import { ON_BEATS_PROP } from "../timing.js";
import { type BrandTokens, type FontToken, fontCopyName } from "./tokens.js";

/** One typed prop of a template: a HyperFrames composition variable with its bounds. */
export type TemplateVariable =
  | { id: string; type: "string"; label: string; default: string; maxLength?: number }
  | { id: string; type: "number"; label: string; default: number; min: number; max: number; step?: number; unit?: string }
  | { id: string; type: "color"; label: string; default: string }
  | { id: string; type: "boolean"; label: string; default: boolean }
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
  /** Image props filled with a brand component (`--component`): prop id → path inside the composition directory. */
  components?: Readonly<Record<string, string>>;
}

/** A scaffoldable motion composition (ADR 0033). */
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

/** `variables` with the image props named in `components` defaulting to that file instead of their placeholder. */
export function withComponents(variables: readonly TemplateVariable[], components: TemplateInput["components"]): TemplateVariable[] {
  return variables.map((variable) => {
    const file = components?.[variable.id];
    return variable.type === "image" && file !== undefined ? { ...variable, default: file } : variable;
  });
}

/** Everything up to `<body>`: document head with the variables, the runtime script and the shared reset. */
export function pageHead(input: TemplateInput, variables: readonly TemplateVariable[], css: string): string {
  const fonts = fontSetup(input.tokens);
  return `<!doctype html>
<html lang="en" data-composition-variables='${variablesAttribute(withComponents(variables, input.components))}'>
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
      // Colour with alpha, for hairlines and washes.
      function alpha(hex, a) {
        var c = rgb(hex);
        return "rgba(" + c[0] + ", " + c[1] + ", " + c[2] + ", " + a + ")";
      }
      // Black or white text, whichever reads on the colour (relative luminance, sRGB).
      function onColor(hex) {
        var lin = rgb(hex).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
        return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2] > 0.4 ? "#0b1020" : "#ffffff";
      }`;

/**
 * Page-script helpers `flat` and `put`: a scale within about 0.6 % of 1 is written as exactly 1 (Chrome keeps the
 * earlier raster of a layer there, so a frame would depend on the seek order). `put` is `M.write` with every scale
 * made flat; use it for filled or masked shapes.
 */
export const FLAT_HELPERS = String.raw`
      // Chrome keeps a layer's earlier raster for a scale within about 0.6 % of 1, so the same time would paint one pixel
      // differently depending on where the player came from. A scale that close to 1 is written as exactly 1.
      function flat(scale) {
        return scale !== undefined && Math.abs(scale - 1) < 0.006 ? 1 : scale;
      }
      // M.write with every scale made flat.
      function put(element, pose) {
        M.write(element, { x: pose.x, y: pose.y, rotate: pose.rotate, scale: flat(pose.scale), scaleX: flat(pose.scaleX), scaleY: flat(pose.scaleY), opacity: pose.opacity });
      }`;

/**
 * Page-script helpers of the seeded templates (`emphasis-marker`, `scene-background`, `light-leak`): `seedOf(text)`
 * turns a `seed` prop into an integer 0..9972 (a small string hash), and `jitter(seed, k)` is a repeatable value
 * -1..1 for the k-th choice of that seed. Same seed and k, same value, so every seek paints the same frame. Written
 * on one line each, so a composition stays under the lint's 300-line warning.
 */
export const SEED_HELPERS = String.raw`
      function seedOf(text) { var s = 0; String(text).split("").forEach(function (ch) { s = (s * 31 + ch.charCodeAt(0)) % 9973; }); return s; }
      function jitter(seed, k) { var x = Math.imul(seed * 977 + k * 7919 + 1, 2654435761) >>> 0; x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0; x ^= x >>> 13; return ((x >>> 0) % 2001) / 1000 - 1; }`;

/** The `grouping` prop of a template that prints a number: where the thousands separator goes. Pairs with {@link NUMBER_FORMAT}. */
export const GROUPING_VARIABLE: TemplateVariable = {
  id: "grouping",
  type: "enum",
  label: "Thousands separator",
  default: "comma",
  options: [
    { value: "comma", label: "Comma: 12,840" },
    { value: "space", label: "Space: 12 840" },
    { value: "none", label: "None: 12840" },
  ],
};

/** Page-script `format(value)`: one text for one value (fixed `P.decimals`, a `P.grouping` separator every three digits). */
export const NUMBER_FORMAT = String.raw`
      // Same text for the same value everywhere: fixed decimals, then a separator every three digits.
      var SEP = P.grouping === "comma" ? "," : P.grouping === "space" ? String.fromCharCode(160) : "";
      function format(value) {
        var fixed = Math.abs(value).toFixed(P.decimals).split(".");
        var whole = SEP ? fixed[0].replace(/\B(?=(\d{3})+(?!\d))/g, SEP) : fixed[0];
        var negative = value < 0 && Number(fixed.join(".")) !== 0;
        return (negative ? "-" : "") + whole + (fixed[1] ? "." + fixed[1] : "");
      }`;

/** The two props of a template that can sit on its own background: a colour and how solid it is (0 = transparent over footage). */
export function backdropVariables(tokens: BrandTokens): TemplateVariable[] {
  return [
    { id: "bg", type: "color", label: "Background colour", default: tokens.colors.bg ?? PLACEHOLDER.bg },
    { id: "backdrop", type: "number", label: "Solid background behind it, 0 = transparent over footage, 1 = opaque", default: 0, min: 0, max: 1, step: 0.05 },
  ];
}

/**
 * The {@link ON_BEATS_PROP} prop of a template with a stepped schedule: true asks the adapter for the music's beats
 * (no meta tag needed) and puts the steps on them. `steps` names the steps in the label (`the ticks`).
 */
export function onBeatsVariable(steps: string, from: string): TemplateVariable {
  return { id: ON_BEATS_PROP, type: "boolean", label: `Put ${steps} on the music's beats from ${from}`, default: false };
}

/**
 * Page-script `stepTimes(start, gap, count, onBeats, latest, minGap, holdFixed)`: the times of `count` steps from `start`, `gap`
 * apart, or with `onBeats` the clip's beats from the first one at or after `start` (motion runtime 0.5.0, ADR 0029
 * decision 8). Without a usable grid the beats fall back to those same steps (the nominal grid), so `onBeats` never
 * changes a clip that has none. With `latest` (a template that pulls a short clip's schedule in; a negative one is
 * ignored) and beat-placed times, or with `holdFixed` also the fixed ones, the times keep their order and step `i` of
 * `count` is held to `latest - (count - 1 - i) * minGap` (default 0.08 s) and never before `start`, so the last never
 * passes `latest`; steps left unclamped may sit closer than `minGap`. Otherwise (no `latest`, or fixed steps without
 * `holdFixed`) the steps are never moved. Needs `M`.
 */
export const STEP_TIMES = String.raw`
      function stepTimes(start, gap, count, onBeats, latest, minGap, holdFixed) {
        var steps = { bpm: 60 / gap, offset: start };
        var beatPlaced = onBeats && M.hasBeats();
        var from = onBeats ? M.beatAt(start, steps) : null;
        var first = from ? (from.phase > 1e-6 ? from.index + 1 : from.index) : 0;
        var floor = minGap || 0.08;
        var times = [];
        for (var i = 0; i < count; i++) {
          var time = onBeats ? M.beatTime(first + i, steps) : start + i * gap;
          times.push((beatPlaced || holdFixed) && latest !== undefined && latest >= 0 ? Math.max(start, Math.min(time, latest - (count - 1 - i) * floor)) : time);
        }
        return times;
      }`;

/** CSS of the optional background element `<div id="backdrop">`, the first child of the clip. */
export const BACKDROP_CSS = "#backdrop { position: absolute; inset: 0; }";

/** Page-script setup of `#backdrop` (needs {@link COLOR_HELPERS}); the template writes its opacity as `P.backdrop` times its fade. */
export const BACKDROP_SETUP = String.raw`
      var backdrop = document.getElementById("backdrop");
      backdrop.style.background = "radial-gradient(ellipse at 50% 40%, " + mix(P.bg, "#ffffff", 0.09) + " 0%, " + P.bg + " 72%)";`;

/**
 * Shared page-script text of a kit (cursor, typing, camera): drops whole-line `//`
 * comments and blank lines, and writes each top-level function on one line (a
 * function carrying a trailing comment keeps its lines). The explanation lives
 * in the kit's source, and `hyperframes check` warns on a composition file over
 * 300 lines, which the kit would otherwise fill by itself.
 */
export function kitScript(code: string): string {
  const out: string[] = [];
  let open: string[] | null = null;
  const flush = (lines: string[]): void => {
    out.push(lines.some((line) => line.includes("//")) ? lines.join("\n") : `      ${lines.map((line) => line.trim()).join(" ")}`);
  };
  for (const line of code.split("\n")) {
    const text = line.trim();
    if (text === "" || text.startsWith("//")) continue;
    if (open) {
      open.push(line);
      if (line === "      }") {
        flush(open);
        open = null;
      }
    } else if (line.startsWith("      function ") && !text.endsWith("}")) {
      open = [line];
    } else out.push(line);
  }
  if (open) out.push(...open);
  return out.join("\n");
}

/**
 * The page script of `html` without whole-line `//` comments and blank lines: for a
 * template whose own script is long enough to draw the lint warning on a
 * composition file over 300 lines. The explanation stays in the template's source.
 */
export function trimScript(html: string): string {
  return html.replace(/<script>([\s\S]*?)<\/script>/, (_all, body: string) => {
    const kept = body.split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("//"));
    return `<script>\n${kept.join("\n")}\n    </script>`;
  });
}
