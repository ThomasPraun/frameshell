/**
 * A small structural checker for OTIO JSON, so the tests need no Python: every object carries an `OTIO_SCHEMA`,
 * every time is a `RationalTime.1` with a whole-frame `value` and a positive `rate`, every range is a `TimeRange.1`, and a `Transition.1` sits between two clips with whole-frame offsets.
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
  if (schema === "Transition.1") {
    for (const key of ["in_offset", "out_offset"]) {
      if ((object[key] as { OTIO_SCHEMA?: string } | undefined)?.OTIO_SCHEMA !== "RationalTime.1") problems.push(`${path}.${key}: not a RationalTime.1`);
    }
  }
  if (schema === "Track.1" && Array.isArray(object["children"])) problems.push(...transitionProblems(object["children"] as { OTIO_SCHEMA?: string }[], path));
  for (const [key, child] of Object.entries(object)) {
    if (key === "metadata") continue;
    problems.push(...otioProblems(child, `${path}.${key}`));
  }
  return problems;
}

/** A `Transition.1` is never first or last in a track and has a `Clip.2` on both sides (no `Gap.1`, no other transition). */
function transitionProblems(children: { OTIO_SCHEMA?: string }[], path: string): string[] {
  const problems: string[] = [];
  children.forEach((child, index) => {
    if (child.OTIO_SCHEMA !== "Transition.1") return;
    for (const side of [children[index - 1], children[index + 1]]) {
      if (side?.OTIO_SCHEMA !== "Clip.2") problems.push(`${path}.children[${index}]: a Transition.1 needs a Clip.2 on both sides, found ${side?.OTIO_SCHEMA ?? "nothing"}`);
    }
  });
  return problems;
}
