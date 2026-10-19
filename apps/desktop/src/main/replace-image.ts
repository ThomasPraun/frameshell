import { extname } from "node:path";
import type { TimelineEdit } from "../shared/api.js";
import type { DaemonLink } from "./daemon-link.js";
import { IMAGE_EXTENSIONS } from "./media-files.js";

/** What {@link replaceClipImage} needs from the app; replaced in tests. */
export interface ReplaceImageDeps {
  /** The app's daemon connection (`ui` author). */
  request: DaemonLink["request"];
  /** Applies `edits` in order as one labelled undoable step (`TimelineEditor.apply`). */
  apply: (edits: TimelineEdit[], label: string) => Promise<unknown>;
}

/**
 * Show the image `file` in a media clip of a video track instead of what it shows
 * (the generated background of an audio project, ADR 0015): the file is imported
 * into `assets/`, then the clip is removed and added again with the same track,
 * start and length (and placement), as one undo step. Rejects when `file` is not
 * an image or the clip is not a media clip on a video track; nothing changes then.
 */
export async function replaceClipImage(dir: string, timeline: string, clipId: string, file: string, deps: ReplaceImageDeps): Promise<void> {
  if (!(IMAGE_EXTENSIONS as readonly string[]).includes(extname(file).slice(1).toLowerCase())) {
    throw new Error(`${file} is not an image (${IMAGE_EXTENSIONS.join(", ")}).`);
  }
  const view = await deps.request("timeline.show", { cwd: dir, timeline });
  const track = view.tracks.find((candidate) => candidate.clips.some((clip) => clip.id === clipId));
  const clip = track?.clips.find((candidate) => candidate.id === clipId);
  if (!track || !clip) throw new Error(`There is no clip ${clipId} on the timeline.`);
  if (track.kind !== "video" || clip.type !== "media") throw new Error("Only a media clip on a video track can show another image.");
  if (clip.end === null) throw new Error("The clip's length is unknown.");
  const { imported } = await deps.request("asset.import", { cwd: dir, files: [file], mode: "copy" });
  const asset = imported[0]?.asset;
  if (!asset) throw new Error("The image could not be imported.");
  const transform = clip["transform"] as Extract<TimelineEdit, { op: "clip.add" }>["args"]["transform"];
  await deps.apply(
    [
      { op: "clip.remove", args: { clip: clipId } },
      {
        op: "clip.add",
        args: { track: track.id, asset, start: clip.start, duration: Math.round((clip.end - clip.start) * 1000) / 1000, ...(transform ? { transform } : {}) },
      },
    ],
    "Replace image",
  );
}
