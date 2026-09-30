import type { z } from "zod";

/**
 * Current on-disk schema version. Every project file carries it (SPEC §5.6).
 * Bump only together with a forward migration.
 */
export const SCHEMA_VERSION = 1;

/** Outcome of validating untrusted input; `error` is human-readable. */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

type Issue = z.core.$ZodIssue;

/**
 * One line per issue, prefixed by the dotted field path. A failed union
 * (clip variants) reports the variant whose `type` matched, not a bare
 * "Invalid input".
 */
export function formatIssues(error: z.ZodError): string {
  return flatten(error.issues, [])
    .map(({ path, message }) => (path.length > 0 ? `${path.join(".")}: ${message}` : message))
    .join("\n");
}

function flatten(issues: readonly Issue[], prefix: PropertyKey[]): { path: string[]; message: string }[] {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path];
    if (issue.code === "invalid_union" && issue.errors.length > 0) {
      const branch = bestBranch(issue.errors);
      if (branch) return flatten(branch, path);
    }
    return [{ path: path.map(String), message: issue.message }];
  });
}

/** Branch whose discriminator (`type`/`kind`) matched, fewest issues first; null when every branch rejected it. */
function bestBranch(branches: Issue[][]): Issue[] | null {
  const matched = branches.filter(
    (issues) => !issues.some((i) => i.path.length === 1 && (i.path[0] === "type" || i.path[0] === "kind")),
  );
  if (matched.length === 0) return null;
  return matched.reduce((best, issues) => (issues.length < best.length ? issues : best));
}
