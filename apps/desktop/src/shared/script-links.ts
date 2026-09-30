import { type ScriptScene, splitScriptRef } from "@frameshell/schema";

/** A scene of an open script with the timeline clips that realize it (SPEC §5.5). */
export interface SceneLink extends ScriptScene {
  /** Ids of clips whose `scriptRef` names this scene, timeline order. */
  clips: string[];
  /** True when one of those clips is selected. */
  selected: boolean;
}

/** An open script linked to the timeline: its scenes, and clips that reference the script as a whole. */
export interface ScriptLinks {
  scenes: SceneLink[];
  /**
   * Ids of clips whose `scriptRef` is the script path without `#anchor`
   * (the whole script, SPEC §5.5), timeline order. They cover no scene.
   */
  wholeClips: string[];
  /** True when one of {@link ScriptLinks.wholeClips} is selected: the whole script is highlighted. */
  wholeSelected: boolean;
}

/** Scripts get scene links: Markdown under `scripts/` (SPEC §4 layout). */
export function isScriptPath(path: string): boolean {
  return /^scripts\/.+\.md$/i.test(path);
}

/**
 * Join the scenes of `scriptPath` (project-relative) with the clips whose
 * `scriptRef` points at them; refs are compared after `splitScriptRef`
 * normalization, so `./scripts/a.md#x` matches too. A ref without anchor
 * goes to {@link ScriptLinks.wholeClips}; one naming a missing scene or
 * another script is ignored.
 */
export function linkScenes(
  scriptPath: string,
  scenes: readonly ScriptScene[],
  clips: readonly { id: string; scriptRef?: string | undefined }[],
  selected: readonly string[],
): ScriptLinks {
  const links = scenes.map((scene) => ({ ...scene, clips: [] as string[], selected: false }));
  const bySlug = new Map(links.map((link) => [link.slug, link]));
  const chosen = new Set(selected);
  const wholeClips: string[] = [];
  let wholeSelected = false;
  for (const clip of clips) {
    if (!clip.scriptRef) continue;
    const { path, anchor } = splitScriptRef(clip.scriptRef);
    if (path !== scriptPath) continue;
    if (anchor === null) {
      wholeClips.push(clip.id);
      if (chosen.has(clip.id)) wholeSelected = true;
      continue;
    }
    const link = bySlug.get(anchor);
    if (!link) continue;
    link.clips.push(clip.id);
    if (chosen.has(clip.id)) link.selected = true;
  }
  return { scenes: links, wholeClips, wholeSelected };
}
