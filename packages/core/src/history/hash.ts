import { createHash } from "node:crypto";
import type { Timeline } from "@frameshell/schema";

/**
 * Content hash of a timeline for the journal (SPEC §6.2): sha256 of its JSON
 * with object keys sorted, so key order and `undefined` fields do not count.
 * Equal hashes mean the file holds what the journal last wrote; `revision`
 * alone misses edits that keep it (a hand edit made while no daemon watched).
 */
export function timelineHash(timeline: Timeline): string {
  return `sha256:${createHash("sha256").update(canonical(timeline)).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonical(item))).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
