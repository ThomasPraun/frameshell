// Media from Files onto the timeline (#738): what a drag from the Explorer carries, and the one call that puts it there.
import { SELECTION_TIMELINE } from "../selection.js";
import { t } from "../i18n.js";

/** Drag data type of project media dragged from Files; the value is a JSON array of project-relative paths. */
export const MEDIA_DRAG_TYPE = "application/x-frameshell-assets";

const MEDIA = /\.(mp4|mov|m4v|mkv|webm|avi|mts|wav|mp3|m4a|aac|flac|ogg|opus|png|jpe?g|gif|webp)$/i;

/** `path` is media the timeline takes: a video, a sound or a still image, by its extension. */
export function isTimelineMedia(path: string): boolean {
  return MEDIA.test(path);
}

/** Put `paths` (project-relative) on a drag from Files, keeping only media. False when none is media: nothing to drag. */
export function startMediaDrag(data: DataTransfer, paths: readonly string[]): boolean {
  const media = paths.filter(isTimelineMedia);
  if (media.length === 0) return false;
  data.setData(MEDIA_DRAG_TYPE, JSON.stringify(media));
  data.effectAllowed = "copy";
  return true;
}

/** The drag carries media from Files (its paths can only be read on drop). */
export function carriesMedia(data: DataTransfer | null): boolean {
  return data?.types.includes(MEDIA_DRAG_TYPE) === true;
}

/** The paths a drop from Files carries; [] for anything else. */
export function droppedMedia(data: DataTransfer | null): string[] {
  try {
    const value: unknown = JSON.parse(data?.getData(MEDIA_DRAG_TYPE) || "[]");
    return Array.isArray(value) ? value.filter((path): path is string => typeof path === "string" && isTimelineMedia(path)) : [];
  } catch {
    return [];
  }
}

/** The status line for what {@link addToTimeline} did: how many clips went in, then what was refused and why. */
export function addedText(result: { clips: string[]; refused: { asset: string; message: string }[] }): AddedLine {
  const name = (path: string) => path.split(/[\\/]/).pop() ?? path;
  const parts = [...(result.clips.length > 0 ? [t.timeline.mediaAdded(result.clips.length)] : [])];
  for (const { asset, message } of result.refused) parts.push(t.timeline.mediaRefused(name(asset), message));
  return { text: parts.join(" "), error: result.refused.length > 0 };
}

/** A status line {@link addToTimeline} reports. */
export interface AddedLine {
  text: string;
  error: boolean;
}

const listeners = new Set<(line: AddedLine) => void>();

/** Hear every status line {@link addToTimeline} reports in this window (the timeline panel shows it). Returns the unsubscribe. */
export function onMediaAdded(listener: (line: AddedLine) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Put media `paths` on the main timeline as one undoable step: at `target` (a drop on a track) or at the end of the
 * first track of each kind. Reports the status line to {@link onMediaAdded} listeners; a failed call is its message.
 */
export async function addToTimeline(paths: readonly string[], target?: { track: string; start: number }): Promise<void> {
  let line: AddedLine;
  try {
    line = addedText(await window.frameshell.timeline.addMedia(SELECTION_TIMELINE, paths.filter(isTimelineMedia), target));
  } catch (error) {
    line = { text: (error as Error).message ?? String(error), error: true };
  }
  for (const listener of listeners) listener(line);
}
