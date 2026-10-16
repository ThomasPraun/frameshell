import type { Runtime } from "../i18n/en";

let cached: Runtime | undefined;

/** Client-side strings, embedded by Base.astro as JSON in #i18n for the page's language. */
export function runtime(): Runtime {
  cached ??= JSON.parse(document.getElementById("i18n")?.textContent ?? "{}") as Runtime;
  return cached;
}
