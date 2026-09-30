import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ErrorCode, RpcError, type ScriptOutlineResult } from "@frameshell/protocol";
import { type ScriptOutline, parseScript, parseTimeline, splitScriptRef } from "@frameshell/schema";

/**
 * Scripts on the daemon side (SPEC §5.5): outline with clip links for
 * `script.outline`, and the soft `scriptRef` check of clip operations.
 * Scripts are read fresh every call; the file is the source of truth.
 */

/**
 * Outline `file` (absolute, or relative to `cwd`, then to `root`) with the
 * clips of every `timelines/*.json` linked to each scene. Throws
 * `OutsideProject` or `ScriptNotFound`.
 */
export async function outlineScript(root: string, cwd: string, file: string): Promise<ScriptOutlineResult> {
  const path = await locateScript(root, cwd, file);
  const outline = parseScript(await readFile(join(root, ...path.split("/")), "utf8"));
  const { refs, warnings } = await clipRefs(root);
  const scenes = outline.scenes.map((scene) => ({ ...scene, ref: `${path}#${scene.slug}`, clips: [] as { timeline: string; clip: string }[] }));
  const bySlug = new Map(scenes.map((scene) => [scene.slug, scene]));
  const unresolved: ScriptOutlineResult["unresolved"] = [];
  for (const ref of refs) {
    const { path: target, anchor } = splitScriptRef(ref.scriptRef);
    if (target !== path) continue;
    const scene = anchor === null ? undefined : bySlug.get(anchor);
    if (scene) scene.clips.push({ timeline: ref.timeline, clip: ref.clip });
    else unresolved.push(ref);
  }
  return { path, meta: outline.meta, scenes, unresolved, warnings: [...outline.warnings, ...warnings] };
}

/**
 * Why `ref` points nowhere (no anchor, missing script, missing scene), or
 * null when it names an existing scene. Never throws for a bad ref: the
 * operation stores it anyway (the script may be written later).
 */
export async function checkScriptRef(root: string, ref: string): Promise<string | null> {
  const { path, anchor } = splitScriptRef(ref);
  const outline = `\`frameshell script outline ${path}\``;
  if (path === "" || isAbsolute(path) || path === ".." || path.startsWith("../")) {
    return `scriptRef "${ref}" must be a project-relative script path plus scene, e.g. \`scripts/script.md#intro\`.`;
  }
  let parsed: ScriptOutline;
  try {
    parsed = parseScript(await readFile(join(root, ...path.split("/")), "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EISDIR" && code !== "ENOTDIR") throw error;
    return `scriptRef "${ref}": ${path} does not exist. Stored anyway; create the script or fix the ref.`;
  }
  const slugs = parsed.scenes.map((scene) => scene.slug);
  if (anchor === null) return `scriptRef "${ref}" has no \`#scene\` anchor; use \`${path}#<scene>\` (scenes: see ${outline}).`;
  if (slugs.includes(anchor)) return null;
  const known = slugs.length > 0 ? slugs.join(", ") : "none (add `## ` headings)";
  return `scriptRef "${ref}": no scene "${anchor}" in ${path}; scenes: ${known}. Stored anyway.`;
}

/** Project-relative `/`-path of an existing script file. */
async function locateScript(root: string, cwd: string, file: string): Promise<string> {
  const candidates = isAbsolute(file) ? [file] : [resolve(cwd, file), resolve(root, file)];
  const inside = candidates.map((candidate) => relativeInside(root, candidate)).filter((rel): rel is string => rel !== null);
  if (inside.length === 0) {
    throw new RpcError(ErrorCode.OutsideProject, `${file} is outside the project ${root}. Scripts live under scripts/.`, { path: file });
  }
  for (const rel of inside) {
    const text = await readFile(join(root, ...rel.split("/")), "utf8").catch(() => null);
    if (text !== null) return rel;
  }
  const available = await listScripts(root);
  throw new RpcError(
    ErrorCode.ScriptNotFound,
    `No script ${inside[0]} in ${root}` + (available.length > 0 ? `; scripts: ${available.join(", ")}.` : "; scripts/ has no .md files."),
    { path: inside[0], available },
  );
}

function relativeInside(root: string, path: string): string | null {
  const rel = relative(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/** Every `scripts/**\/*.md`, project-relative, sorted. */
async function listScripts(root: string): Promise<string[]> {
  const entries = await readdir(join(root, "scripts"), { recursive: true }).catch(() => []);
  return entries
    .filter((entry) => entry.toLowerCase().endsWith(".md"))
    .map((entry) => `scripts/${entry.split(sep).join("/")}`)
    .sort();
}

/** `scriptRef` of every clip in every timeline file; unreadable files are skipped with a warning. */
async function clipRefs(root: string): Promise<{ refs: { timeline: string; clip: string; scriptRef: string }[]; warnings: string[] }> {
  const names = (await readdir(join(root, "timelines")).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
  const refs: { timeline: string; clip: string; scriptRef: string }[] = [];
  const warnings: string[] = [];
  for (const name of names) {
    const id = name.slice(0, -".json".length);
    let parsed;
    try {
      parsed = parseTimeline(JSON.parse(await readFile(join(root, "timelines", name), "utf8")));
    } catch (error) {
      parsed = { ok: false as const, error: (error as Error).message };
    }
    if (!parsed.ok) {
      warnings.push(`timelines/${name} is not a valid timeline, skipped when linking clips: ${parsed.error.split("\n")[0]}`);
      continue;
    }
    for (const track of parsed.value.tracks) {
      if (track.kind === "subtitles") continue;
      for (const clip of track.clips) if (clip.scriptRef) refs.push({ timeline: id, clip: clip.id, scriptRef: clip.scriptRef });
    }
  }
  return { refs, warnings };
}
