import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { MethodResult } from "@frameshell/protocol";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import type { Timeline } from "@frameshell/schema";
import { listTimelineIds } from "./clips/renderer.js";
import { readEnclosingProject } from "./projects.js";
import { readTimelineFile } from "./timeline/service.js";

/** One place a timeline names a project file. */
export type FileUse = MethodResult<"file.uses">["uses"][number];

/** Every clip, angle and mic of `timeline` (id `id`) naming `rel` or a path under it. */
export function timelineUses(id: string, timeline: Timeline, rel: string): FileUse[] {
  const names = (ref: string | undefined) => ref !== undefined && (ref === rel || ref.startsWith(`${rel}/`));
  const uses: FileUse[] = [];
  for (const track of timeline.tracks) {
    if (track.kind === "subtitles") continue;
    for (const clip of track.clips) {
      const ref = "asset" in clip ? clip.asset : "source" in clip ? clip.source : undefined;
      if (names(ref)) uses.push({ timeline: id, id: clip.id, ref: ref! });
    }
  }
  for (const group of timeline.groups ?? []) {
    for (const part of [...group.angles, ...(group.mics ?? [])]) {
      if (names(part.asset)) uses.push({ timeline: id, id: group.id, ref: part.asset });
    }
  }
  return uses;
}

/**
 * `file.uses`: what the timelines of the project enclosing `path` name it.
 * Unreadable timelines are skipped: their clips cannot play either way.
 */
export async function fileUses(path: string): Promise<MethodResult<"file.uses">> {
  const target = resolve(path);
  const found = await readEnclosingProject(dirname(target));
  const rel = found ? relative(found.dir, target) : "";
  if (!found || rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new RpcError(ErrorCode.OutsideProject, `${target} is not inside a Frameshell project.`, { path: target });
  }
  const project = found.dir;
  const relPath = rel.split(sep).join("/");
  const uses: FileUse[] = [];
  for (const id of (await listTimelineIds(project)).sort()) {
    const timeline = await readTimelineFile(project, `timelines/${id}.json`).catch(() => null);
    if (timeline) uses.push(...timelineUses(id, timeline, relPath));
  }
  // Timelines are already in order; a group with several matching angles lists once per angle.
  uses.sort((a, b) => (a.timeline === b.timeline ? a.id.localeCompare(b.id) : 0));
  return { project, path: relPath, uses };
}
