/** Run roots older than this are from a killed run and removed; younger ones may belong to a parallel run. */
export const STALE_TEMP_MS: number;

/**
 * Remove the entries of `dir` whose name starts with `prefix` and that were last modified more than `staleMs`
 * before `now`. Shared by the vitest and Playwright global setups, which each sweep what a killed run left behind.
 * Returns the names swept (a removal that fails is not reported).
 */
export function sweepStaleTempDirs(dir: string, prefix: string, now: number, staleMs?: number): Promise<string[]>;
