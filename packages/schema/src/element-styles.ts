import { z } from "zod";

/** Adjustment of one composition element (ADR 0021): a move and a scale in the composition's CSS pixels. */
export const ElementAdjustSchema = z.strictObject({
  x: z.number().optional().describe("Horizontal move in composition CSS px. Default 0."),
  y: z.number().optional().describe("Vertical move in composition CSS px. Default 0."),
  scale: z.number().positive().optional().describe("Uniform factor about the element's centre. Default 1."),
});

/** Move and scale of one composition element. */
export type ElementAdjust = z.infer<typeof ElementAdjustSchema>;

/** Clip field `elements`: CSS selector to adjustment. */
export const ElementsSchema = z
  .record(z.string().min(1), ElementAdjustSchema)
  .describe(
    "Moves and scales of elements inside the composition, by CSS selector (composition CSS px), applied over the source file. " +
      'E.g. `{"#title": {"y": -40, "scale": 1.2}}`.',
  );

/** `<` could start `</style>`, even escaped (HTML ends the element first); `>` is the child combinator. */
const UNSAFE_HTML = /</;
/** Unescaped characters that could end a rule or open a comment (`CSS.escape` output like `#a\{b` is fine). */
const UNSAFE_CSS = /[{};]|\/\*/;

/** No `<`, no unescaped rule end or comment, and every string and bracket closed. */
function plain(selector: string): boolean {
  return !UNSAFE_HTML.test(selector) && !UNSAFE_CSS.test(selector.replace(/\\[\s\S]/g, "")) && balanced(selector);
}

/**
 * True when `selector` closes every string, `(` and `[` and does not end in an
 * escape. An open one would swallow the rules after it, so one bad entry would
 * undo every other adjustment of the sheet.
 */
function balanced(selector: string): boolean {
  const open: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i]!;
    if (char === "\\") {
      if (++i >= selector.length) return false;
    } else if (quote) {
      if (char === quote) quote = null;
      else if (char === "\n") return false;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(") open.push(")");
    else if (char === "[") open.push("]");
    else if ((char === ")" || char === "]") && open.pop() !== char) return false;
  }
  return quote === null && open.length === 0;
}

/**
 * CSS sheet for a clip's `elements`, rules sorted by selector; empty when
 * nothing moves. Uses the separate `translate` and `scale` properties, which add
 * to any `transform` the composition animates. Throws on a selector holding
 * `<`, an unescaped `{ } ;` or `/*`, starting with `@` or leaving a quote, `(` or `[` open,
 * and on a non-finite number.
 */
export function elementStyles(elements: Readonly<Record<string, ElementAdjust>> | undefined): string {
  if (!elements) return "";
  const rules: string[] = [];
  for (const [selector, adjust] of Object.entries(elements).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (selector.trim() === "" || selector.trimStart().startsWith("@") || !plain(selector)) {
      throw new Error(
        `Element selector ${JSON.stringify(selector)} is not a plain CSS selector (no { } < ;, at-rules, comments, or unclosed quotes or brackets).`,
      );
    }
    const { x = 0, y = 0, scale = 1 } = adjust;
    if (![x, y, scale].every(Number.isFinite) || scale <= 0) {
      throw new Error(`Element ${selector}: x, y and scale must be finite numbers, scale > 0.`);
    }
    const declarations: string[] = [];
    if (x !== 0 || y !== 0) declarations.push(`translate: ${x}px ${y}px !important;`);
    if (scale !== 1) declarations.push(`scale: ${scale} !important;`);
    if (declarations.length > 0) rules.push(`${selector} { ${declarations.join(" ")} }`);
  }
  return rules.join("\n");
}
