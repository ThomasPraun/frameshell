// Scene spans of the timeline's scene band (ADR 0015): `script.outline` results of the project's scripts, joined for one timeline.
import type { ScriptOutlineResult } from "@frameshell/protocol";
import { isScriptPath } from "@frameshell/schema";
import { useEffect, useState } from "react";
import type { FileNode } from "../../../shared/api.js";
import type { SceneBox } from "./layout.js";

/**
 * Scene spans of `timeline` from script outlines: a scene with words placed on
 * that timeline gets a box from its first to its last placed word, in start order.
 * Scenes without a word range, or whose words that timeline does not place,
 * have no time to show and are left out. A box's `clips` are the clips of
 * that timeline linked to the scene, so a scene realized only on another
 * timeline still reads as unfilled here.
 */
export function sceneBoxes(outlines: readonly ScriptOutlineResult[], timeline: string): SceneBox[] {
  const boxes: SceneBox[] = [];
  for (const outline of outlines) {
    for (const scene of outline.scenes) {
      const span = scene.span.find((candidate) => candidate.timeline === timeline);
      if (!scene.wordRange || !span || !(span.end > span.start)) continue;
      boxes.push({
        script: outline.path,
        slug: scene.slug,
        title: scene.title,
        start: span.start,
        end: span.end,
        clips: scene.clips.filter((clip) => clip.timeline === timeline).map((clip) => clip.clip),
      });
    }
  }
  return boxes.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Project-relative paths of the scripts in an explorer tree. */
export function scriptFiles(nodes: readonly FileNode[]): string[] {
  return nodes.flatMap((node) => (node.kind === "dir" ? scriptFiles(node.children) : isScriptPath(node.path) ? [node.path] : []));
}

/** Files whose change can move a scene span besides the timeline, which its revision covers: scripts and transcripts. */
export function affectsScenes(paths: readonly string[]): boolean {
  return paths.some((path) => isScriptPath(path) || path.startsWith("transcripts/"));
}

/**
 * Scene spans of `timeline`, live: read again when the timeline's `revision`
 * changes or a script or transcript file does; the latest read wins. A
 * script the daemon cannot outline is skipped. Empty before the first read
 * and when the project cannot be read.
 */
export function useSceneSpans(timeline: string, revision: number | null): SceneBox[] {
  const [boxes, setBoxes] = useState<SceneBox[]>([]);
  const [changed, setChanged] = useState(0);

  useEffect(
    () =>
      window.frameshell.files.onChanged((paths) => {
        if (affectsScenes(paths)) setChanged((count) => count + 1);
      }),
    [],
  );

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const scripts = scriptFiles(await window.frameshell.files.tree());
        const outlines = await Promise.all(scripts.map((file) => window.frameshell.scripts.outline(file).catch(() => null)));
        const next = sceneBoxes(
          outlines.filter((outline): outline is ScriptOutlineResult => outline !== null),
          timeline,
        );
        if (current) setBoxes((previous) => (sameBoxes(previous, next) ? previous : next));
      } catch {
        if (current) setBoxes((previous) => (previous.length === 0 ? previous : []));
      }
    })();
    return () => {
      current = false;
    };
  }, [timeline, revision, changed]);

  return boxes;
}

/** Same boxes: lets a re-read that found nothing new keep the layout (and its repaint) as it is. */
export function sameBoxes(a: readonly SceneBox[], b: readonly SceneBox[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (box, index) =>
        box.script === b[index]!.script &&
        box.slug === b[index]!.slug &&
        box.title === b[index]!.title &&
        box.start === b[index]!.start &&
        box.end === b[index]!.end &&
        box.clips.length === b[index]!.clips.length &&
        box.clips.every((clip, k) => clip === b[index]!.clips[k]),
    )
  );
}
