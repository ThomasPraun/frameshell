import { createHash } from "node:crypto";
import type { AdapterClip } from "@frameshell/schema";

/** Bumped when the key recipe or the cache entry layout changes, so old entries are never reused. */
const CACHE_LAYOUT_VERSION = 1;

/** Everything that decides a generated clip's pixels (SPEC §6.5). */
export interface ClipKeyInput {
  /** Plugin providing the adapter, as installed. */
  plugin: { name: string; version: string };
  /** The timeline clip. Only `type`, `source` and `props` count: placement never re-renders. */
  clip: Pick<AdapterClip, "type" | "source" | "props">;
  /** Files the adapter declared (`inputs`), with content hash; null = missing. Order does not matter. */
  inputs: readonly { path: string; hash: string | null }[];
  /** Project frame rate and resolution. */
  format: { fps: number; width: number; height: number };
}

/**
 * Render cache key of a generated clip: 32 hex digits of a SHA-256 over a
 * canonical form of {@link ClipKeyInput} (object keys sorted, inputs sorted
 * by path), so equal inputs give equal keys on every machine and run.
 */
export function clipCacheKey(input: ClipKeyInput): string {
  const inputs = [...input.inputs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const canonical = canonicalJson({
    v: CACHE_LAYOUT_VERSION,
    plugin: input.plugin,
    type: input.clip.type,
    source: input.clip.source ?? null,
    props: input.clip.props ?? {},
    inputs,
    format: input.format,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/** JSON with object keys sorted at every level; `undefined` members dropped like `JSON.stringify` does. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
