import { constants } from "node:fs";
import { open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ErrorCode, RpcError, type ScriptOutlineResult } from "@frameshell/protocol";
import { type ScriptOutline, isScriptPath, parseScript, parseTimeline, scriptRefPathProblem, splitScriptRef } from "@frameshell/schema";

/** Largest script read (1 MiB, ~150k words). Bigger files are refused, never loaded whole. */
export const MAX_SCRIPT_BYTES = 1024 * 1024;

/**
 * Scripts on the daemon side (SPEC §5.5): outline with clip links for
 * `script.outline`, and the soft `scriptRef` check of clip operations.
 * Scripts are read fresh every call; the file is the source of truth.
 */

/**
 * Outline `file` (absolute, or relative to `cwd`, then to `root`) with the
 * clips of every `timelines/*.json` linked to each scene, and those linked
 * to the whole script (`scriptRef` without `#anchor`). Throws
 * `OutsideProject` or `ScriptNotFound`.
 */
export async function outlineScript(root: string, cwd: string, file: string): Promise<ScriptOutlineResult> {
  const { path, text } = await locateScript(root, cwd, file);
  const outline = parseScript(text);
  const { refs, warnings } = await clipRefs(root);
  const scenes = outline.scenes.map((scene) => ({ ...scene, ref: `${path}#${scene.slug}`, clips: [] as { timeline: string; clip: string }[] }));
  const bySlug = new Map(scenes.map((scene) => [scene.slug, scene]));
  const clips: ScriptOutlineResult["clips"] = [];
  const unresolved: ScriptOutlineResult["unresolved"] = [];
  for (const ref of refs) {
    const { path: target, anchor } = splitScriptRef(ref.scriptRef);
    if (target !== path) continue;
    const location = { timeline: ref.timeline, clip: ref.clip };
    if (anchor === null) {
      clips.push(location);
      continue;
    }
    const scene = bySlug.get(anchor);
    if (scene) scene.clips.push(location);
    else unresolved.push(ref);
  }
  return { path, meta: outline.meta, clips, scenes, unresolved, warnings: [...outline.warnings, ...warnings] };
}

/**
 * Why `ref` points nowhere (bad path, missing or unreadable script, missing
 * scene, whole-script ref to a file that is no `scripts/**\/*.md`), or null
 * when it names an existing scene, or an existing script when it has no
 * `#anchor` (whole script, SPEC §5.5). Never throws and never blocks: only
 * regular files inside the project (after symlinks) are considered; a
 * whole-script ref is only stat'ed, a scene ref reads the script up to
 * {@link MAX_SCRIPT_BYTES}; any error becomes the returned warning. The
 * operation stores the ref anyway (the script may be written later).
 */
export async function checkScriptRef(root: string, ref: string): Promise<string | null> {
  const { path, anchor } = splitScriptRef(ref);
  const shape = scriptRefPathProblem(path);
  if (shape) return `scriptRef "${ref}" ${shape}; use a project-relative script path, plus \`#scene\` to name one scene, e.g. \`scripts/script.md#intro\`.`;
  const unavailable = (failure: ScriptFailure) =>
    failure.missing
      ? `scriptRef "${ref}": ${path} does not exist. Stored anyway; create the script or fix the ref.`
      : `scriptRef "${ref}": ${path} ${failure.reason}. Stored anyway; fix the script or the ref.`;
  if (anchor === null) {
    if (!isScriptPath(path)) {
      return `scriptRef "${ref}": ${path} is not a script (scripts live at \`scripts/**/*.md\`). Stored anyway; fix the ref.`;
    }
    const failure = await statScript(root, path);
    return failure ? unavailable(failure) : null;
  }
  const read = await readScript(root, path);
  if (!read.ok) return unavailable(read);
  const parsed: ScriptOutline = parseScript(read.text);
  const slugs = parsed.scenes.map((scene) => scene.slug);
  if (slugs.includes(anchor)) return null;
  const known = slugs.length > 0 ? slugs.join(", ") : "none (add `## ` headings)";
  return `scriptRef "${ref}": no scene "${anchor}" in ${path}; scenes: ${known}. Stored anyway.`;
}

/** Project-relative `/`-path and text of an existing, readable script file. */
async function locateScript(root: string, cwd: string, file: string): Promise<{ path: string; text: string }> {
  const candidates = isAbsolute(file) ? [file] : [resolve(cwd, file), resolve(root, file)];
  const inside = candidates.map((candidate) => relativeInside(root, candidate)).filter((rel): rel is string => rel !== null);
  if (inside.length === 0) {
    throw new RpcError(ErrorCode.OutsideProject, `${file} is outside the project ${root}. Scripts live under scripts/.`, { path: file });
  }
  let unreadable: { path: string; reason: string } | undefined;
  for (const rel of inside) {
    const read = await readScript(root, rel);
    if (read.ok) return { path: rel, text: read.text };
    if (!read.missing) unreadable ??= { path: rel, reason: read.reason };
  }
  const available = await listScripts(root);
  const listing = available.length > 0 ? `; scripts: ${available.join(", ")}.` : "; scripts/ has no .md files.";
  const path = unreadable?.path ?? inside[0]!;
  const message = unreadable ? `Script ${path} ${unreadable.reason}` : `No script ${path} in ${root}`;
  throw new RpcError(ErrorCode.ScriptNotFound, message + listing, { path, available });
}

type ScriptFailure = { ok: false; missing: boolean; reason: string };
type ScriptRead = { ok: true; text: string } | ScriptFailure;

function failed(error: unknown): ScriptFailure {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, missing: true, reason: "does not exist" };
  if (code === "EISDIR") return { ok: false, missing: false, reason: "is a directory, not a script" };
  return { ok: false, missing: false, reason: `could not be read (${code ?? (error as Error).message})` };
}

/** Real path of project-relative `rel`, refused when symlinks take it outside `root`. Never throws. */
async function realInside(root: string, rel: string): Promise<{ ok: true; real: string } | ScriptFailure> {
  try {
    const real = await realpath(join(root, ...rel.split("/")));
    if (relativeInside(await realpath(root), real) === null) return { ok: false, missing: false, reason: "resolves outside the project" };
    return { ok: true, real };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Whether script `rel` exists as a regular file inside the project, by
 * `stat` only (a whole-script ref needs no content). Null when it does;
 * never throws, and `stat` of a FIFO does not block.
 */
async function statScript(root: string, rel: string): Promise<ScriptFailure | null> {
  const located = await realInside(root, rel);
  if (!located.ok) return located;
  try {
    const stats = await stat(located.real);
    if (stats.isDirectory()) return { ok: false, missing: false, reason: "is a directory, not a script" };
    if (!stats.isFile()) return { ok: false, missing: false, reason: "is not a regular file" };
    return null;
  } catch (error) {
    return failed(error);
  }
}

/**
 * Read project-relative script `rel` without ever throwing or blocking.
 * Refuses (not `missing`) a path whose real location (symlinks resolved)
 * is outside `root`, anything but a regular file (FIFO, device, directory)
 * and files over {@link MAX_SCRIPT_BYTES}. Opens non-blocking and checks
 * the opened handle, so a file swapped for a FIFO after the path check
 * cannot hang the read.
 */
async function readScript(root: string, rel: string): Promise<ScriptRead> {
  const located = await realInside(root, rel);
  if (!located.ok) return located;
  const { real } = located;
  // O_NONBLOCK: opening a FIFO with no writer must not wait. Absent on Windows (no such FIFOs there).
  const handle = await open(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)).catch((error: unknown) => error as Error);
  if (handle instanceof Error) return failed(handle);
  try {
    const stats = await handle.stat();
    if (stats.isDirectory()) return { ok: false, missing: false, reason: "is a directory, not a script" };
    if (!stats.isFile()) return { ok: false, missing: false, reason: "is not a regular file" };
    if (stats.size > MAX_SCRIPT_BYTES) {
      return { ok: false, missing: false, reason: `is ${stats.size} bytes; scripts are at most ${MAX_SCRIPT_BYTES}` };
    }
    // Read at most the limit plus one byte: a file growing meanwhile is caught, never loaded whole.
    const buffer = Buffer.alloc(MAX_SCRIPT_BYTES + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > MAX_SCRIPT_BYTES) return { ok: false, missing: false, reason: `is over ${MAX_SCRIPT_BYTES} bytes, too big for a script` };
    }
    return { ok: true, text: buffer.toString("utf8", 0, length) };
  } catch (error) {
    return failed(error);
  } finally {
    await handle.close().catch(() => undefined);
  }
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
