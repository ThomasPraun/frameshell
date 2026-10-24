import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ScriptCheckResult } from "@frameshell/protocol";
import { parseShootScript, personNameKey } from "@frameshell/schema";
import { locateScript } from "./outline.js";

/** People to match speaker names against; `warning` when `people.json` could not be read. */
export type PeopleNames = { people: readonly { id: string; name: string }[]; warning?: string };

/**
 * `script.check` (ADR 0023): {@link parseShootScript} of `file` plus what
 * needs the project: speakers matched to `people.json` by name, the source
 * hashed to tell a stale shoot script. Throws `OutsideProject` or `ScriptNotFound`.
 */
export async function checkScript(root: string, cwd: string, file: string, people: PeopleNames): Promise<ScriptCheckResult> {
  const { path, text } = await locateScript(root, cwd, file);
  const script = parseShootScript(text);
  const warnings = [...script.warnings];
  if (people.warning) warnings.push(people.warning);

  const byName = new Map(people.people.map((person) => [personNameKey(person.name), person.id]));
  const counts = new Map<string, number>();
  for (const scene of script.scenes) {
    for (const line of scene.lines) if (line.speaker !== null) counts.set(personNameKey(line.speaker), (counts.get(personNameKey(line.speaker)) ?? 0) + 1);
  }
  const speakers = script.speakers.map((name) => ({ name, person: byName.get(personNameKey(name)) ?? null, lines: counts.get(personNameKey(name)) ?? 0 }));
  const unknown = speakers.filter((speaker) => speaker.person === null).map((speaker) => speaker.name);
  if (people.people.length > 0 && unknown.length > 0) {
    warnings.push(
      `Speaker${unknown.length === 1 ? "" : "s"} ${unknown.map((name) => `"${name}"`).join(", ")} match${unknown.length === 1 ? "es" : ""} no person in people.json ` +
        `(people: ${people.people.map((person) => person.name).join(", ")}). Use their names, or add them with \`frameshell people add\`.`,
    );
  }

  let source: ScriptCheckResult["source"] = null;
  if (script.shoot.source !== null) {
    const absolute = isAbsolute(script.shoot.source) ? script.shoot.source : resolve(root, script.shoot.source);
    const hash = await sourceHash(absolute);
    const stale = hash === null || script.shoot.sourceHash === null ? null : hash !== script.shoot.sourceHash;
    source = { path: absolute, found: hash !== null, hash, stale };
    if (hash === null) warnings.push(`Source ${script.shoot.source} was not found or could not be read: a changed original cannot be noticed.`);
    else if (stale) {
      warnings.push(`Stale: ${script.shoot.source} changed since this script was written (hash ${hash}, script says ${script.shoot.sourceHash}). Write the shoot script again from it, then set \`source_hash: ${hash}\`.`);
    }
  }

  return {
    path,
    meta: script.meta,
    shoot: script.shoot,
    source,
    speakers,
    scenes: script.scenes.map((scene) => ({ ...scene, ref: `${path}#${scene.slug}` })),
    warnings,
  };
}

/** First 12 hex digits of the file's SHA-256, streamed; null when it cannot be read. */
async function sourceHash(path: string): Promise<string | null> {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}
