import type { RenderTiming, RenderTimingKind } from "@frameshell/plugin-api";
import { scriptJson } from "./live.js";

/** `<meta name>` by which a composition asks for the timeline's timing (ADR 0029 decision 8). */
export const TIMING_META = "frameshell-timing";

/** Global the page reads the timing from, in renders and live pages alike. */
export const TIMING_GLOBAL = "frameshellTiming";

const META_TAG = /<meta\b[^>]*>/gi;

/** Value of attribute `name` of one tag, any quoting; null when absent. */
function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

/**
 * Kinds of timing an entry HTML asks for: `<meta name="frameshell-timing" content="beats markers">` (spaces or commas
 * between kinds, any case). Unknown words are ignored; no such tag asks for nothing, so the clip's key stays as it was.
 */
export function timingKinds(html: string): RenderTimingKind[] {
  const kinds = new Set<RenderTimingKind>();
  for (const [tag] of html.matchAll(META_TAG)) {
    if (attribute(tag, "name")?.trim().toLowerCase() !== TIMING_META) continue;
    for (const word of (attribute(tag, "content") ?? "").toLowerCase().split(/[\s,]+/)) {
      if (word === "beats" || word === "markers") kinds.add(word);
    }
  }
  return [...kinds].sort();
}

/** Script text that sets `window.frameshellTiming`; safe inside an inline `<script>`. */
export function timingScript(timing: RenderTiming): string {
  return `window.${TIMING_GLOBAL} = ${scriptJson(timing)};`;
}

/** `<script>` element of {@link timingScript}, tagged so a reader of the render copy can find it. */
export function timingTag(timing: RenderTiming): string {
  return `<script data-frameshell-timing>${timingScript(timing)}</script>`;
}
