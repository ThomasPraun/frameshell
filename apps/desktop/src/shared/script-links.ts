import { type ScriptScene, splitScriptRef } from "@frameshell/schema";

/** A scene of an open script with the timeline clips that realize it (SPEC §5.5). */
export interface SceneLink extends ScriptScene {
  /** Ids of clips whose `scriptRef` names this scene, timeline order. */
  clips: string[];
  /** True when one of those clips is selected. */
  selected: boolean;
}

/** Scripts get scene links: Markdown under `scripts/` (SPEC §4 layout). */
export function isScriptPath(path: string): boolean {
  return /^scripts\/.+\.md$/i.test(path);
}

/**
 * Join the scenes of `scriptPath` (project-relative) with the clips whose
 * `scriptRef` points at them; refs are compared after `splitScriptRef`
 * normalization, so `./scripts/a.md#x` matches too.
 */
export function linkScenes(
  scriptPath: string,
  scenes: readonly ScriptScene[],
  clips: readonly { id: string; scriptRef?: string | undefined }[],
  selected: readonly string[],
): SceneLink[] {
  const links = scenes.map((scene) => ({ ...scene, clips: [] as string[], selected: false }));
  const bySlug = new Map(links.map((link) => [link.slug, link]));
  const chosen = new Set(selected);
  for (const clip of clips) {
    if (!clip.scriptRef) continue;
    const { path, anchor } = splitScriptRef(clip.scriptRef);
    const link = path === scriptPath && anchor !== null ? bySlug.get(anchor) : undefined;
    if (!link) continue;
    link.clips.push(clip.id);
    if (chosen.has(clip.id)) link.selected = true;
  }
  return links;
}
