/**
 * A small structural checker for OTIO JSON, so the tests need no Python: every object carries an `OTIO_SCHEMA`,
 * every time is a `RationalTime.1` with a whole-frame `value` and a positive `rate`, every range is a `TimeRange.1`.
 * Returns the problems found, each with the path it was found at.
 */
export function otioProblems(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => otioProblems(entry, `${path}[${index}]`));
  if (value === null || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const problems: string[] = [];
  const schema = object["OTIO_SCHEMA"];
  const isDictionary = path.endsWith(".metadata") || path.endsWith(".frameshell") || path.endsWith(".media_references");
  if (typeof schema !== "string" && !isDictionary) problems.push(`${path}: no OTIO_SCHEMA`);
  if (schema === "RationalTime.1") {
    const { value: frames, rate } = object;
    if (typeof frames !== "number" || !Number.isInteger(frames)) problems.push(`${path}: value ${String(frames)} is not a whole frame`);
    if (typeof rate !== "number" || !(rate > 0)) problems.push(`${path}: rate ${String(rate)} is not positive`);
  }
  if (schema === "TimeRange.1") {
    for (const key of ["start_time", "duration"]) {
      if ((object[key] as { OTIO_SCHEMA?: string } | undefined)?.OTIO_SCHEMA !== "RationalTime.1") problems.push(`${path}.${key}: not a RationalTime.1`);
    }
  }
  for (const [key, child] of Object.entries(object)) {
    if (key === "metadata") continue;
    problems.push(...otioProblems(child, `${path}.${key}`));
  }
  return problems;
}
