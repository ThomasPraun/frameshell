import type { z } from "zod";

/**
 * Current on-disk schema version. Every project file carries it (SPEC §5.6).
 * Bump only together with a forward migration.
 */
export const SCHEMA_VERSION = 1;

/** Outcome of validating untrusted input; `error` is human-readable. */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** One line per issue, prefixed by the dotted field path. */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("\n");
}
