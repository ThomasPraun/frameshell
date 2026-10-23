// SPIKE (#291): per-clip element adjustments of a generated clip, turned into one CSS sheet that the live page and
// the render both apply last. Throwaway prototype, not production code.

/** Move and scale of one composition element, in the composition's CSS pixels. */
export interface ElementAdjust {
  /** Horizontal move, CSS px; default 0. */
  x?: number | undefined;
  /** Vertical move, CSS px; default 0. */
  y?: number | undefined;
  /** Size factor about the element's centre; default 1. */
  scale?: number | undefined;
}

/** Characters that could end a rule or the `<style>` element: a selector carrying one is refused. */
const UNSAFE_SELECTOR = /[{}<>;]|\/\*/;

/**
 * CSS for `elements` (selector -> adjustment). Uses the individual `translate` and `scale` properties, which
 * compose with any `transform` the composition animates (GSAP, inline styles) instead of replacing it.
 */
export function elementStyles(elements: Readonly<Record<string, ElementAdjust>> | undefined): string {
  if (!elements) return "";
  const rules: string[] = [];
  for (const [selector, adjust] of Object.entries(elements).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (selector.trim() === "" || UNSAFE_SELECTOR.test(selector)) throw new Error(`Element selector ${JSON.stringify(selector)} is not a plain CSS selector.`);
    const x = adjust.x ?? 0;
    const y = adjust.y ?? 0;
    const scale = adjust.scale ?? 1;
    if (![x, y, scale].every(Number.isFinite) || scale <= 0) throw new Error(`Element ${selector}: x, y and scale must be finite numbers, scale > 0.`);
    const decl: string[] = [];
    if (x !== 0 || y !== 0) decl.push(`translate: ${x}px ${y}px !important;`);
    if (scale !== 1) decl.push(`scale: ${scale} !important;`);
    if (decl.length > 0) rules.push(`${selector} { ${decl.join(" ")} }`);
  }
  return rules.join("\n");
}
