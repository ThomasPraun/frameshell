import type { RenderTiming, RenderTimingKind } from "@frameshell/plugin-api";
import { scriptJson } from "./live.js";

/** `<meta name>` by which a composition asks for the timeline's timing (ADR 0029 decision 8). */
export const TIMING_META = "frameshell-timing";

/** Global the page reads the timing from, in renders and live pages alike. */
export const TIMING_GLOBAL = "frameshellTiming";

/**
 * Boolean prop by which a template clip asks for `beats` without a meta tag: true asks, false or unset does not, so a
 * plain template never re-renders when the music moves. Templates that schedule steps on beats declare it.
 */
export const ON_BEATS_PROP = "onBeats";

const KINDS: readonly RenderTimingKind[] = ["beats", "markers", "words"];

const META_TAG = /<meta\b[^>]*>/gi;

/** Value of attribute `name` of one tag, any quoting; null when absent. */
function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

/**
 * Kinds of timing a clip asks for: those of `<meta name="frameshell-timing" content="beats markers words">` in its
 * entry HTML (spaces or commas between kinds, any case), and `beats` when its props set {@link ON_BEATS_PROP} to
 * true. Unknown words are ignored; no tag and no such prop ask for nothing, so the clip's key stays as it was.
 */
export function timingKinds(html: string, props?: Readonly<Record<string, unknown>>): RenderTimingKind[] {
  const kinds = new Set<RenderTimingKind>();
  for (const [tag] of html.matchAll(META_TAG)) {
    if (attribute(tag, "name")?.trim().toLowerCase() !== TIMING_META) continue;
    for (const word of (attribute(tag, "content") ?? "").toLowerCase().split(/[\s,]+/)) {
      const kind = KINDS.find((known) => known === word);
      if (kind) kinds.add(kind);
    }
  }
  if (props?.[ON_BEATS_PROP] === true) kinds.add("beats");
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
