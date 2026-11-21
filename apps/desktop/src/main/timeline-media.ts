// Put project media on the timeline from the app (#738): the Files menu's "Add to timeline" and a drag from Files onto
// a track, the same `track.add` + `clip.add` the CLI uses, as one `ui` transaction.
import { basename } from "node:path";
import type { DaemonLink } from "./daemon-link.js";
import { isAudioFile, isImageFile, isVideoFile } from "./media-files.js";

/** Seconds a still image shows for when it is put on a video timeline (`clip.add` needs a length for one). */
export const STILL_SECONDS = 5;

/** What {@link addMediaClips} needs from the app; replaced in tests. */
export interface TimelineMediaDeps {
  /** The app's daemon connection (`ui` author). */
  request: DaemonLink["request"];
  /** Runs `work` with no gesture burst open around it (`TimelineEditor.alone`). */
  alone: <T>(work: () => Promise<T>) => Promise<T>;
}

/** Where a drop on the timeline puts the media: the track under the pointer and the time there. */
export interface MediaTarget {
  track: string;
  start: number;
}

/** What {@link addMediaClips} did: the new clip ids, and the assets it could not place with the daemon's reason. */
export interface AddedMedia {
  clips: string[];
  refused: { asset: string; message: string }[];
}

/** The track kind media goes on: sound on an audio track, pictures (videos, stills) on a video track; null for anything else. */
export function trackKindOf(asset: string): "video" | "audio" | null {
  if (isAudioFile(asset)) return "audio";
  if (isVideoFile(asset) || isImageFile(asset)) return "video";
  return null;
}

/**
 * Put `assets` (project-relative media) on `timeline` as one undoable step. With a `target`, the first goes there and
 * the rest follow it one after the other, when the target track takes their kind (sound on audio, pictures on video);
 * otherwise each goes to the end of the timeline's first track of its kind (the bottom video track, the first audio
 * track), and a track named "Video" or "Audio" is added when there is none. A still image lasts {@link STILL_SECONDS}.
 * Other files are skipped. An asset the daemon refuses (an overlap at the target) is reported, the others still go in.
 */
export async function addMediaClips(dir: string, timeline: string, assets: readonly string[], deps: TimelineMediaDeps, target?: MediaTarget): Promise<AddedMedia> {
  const media = assets.flatMap((asset) => {
    const kind = trackKindOf(asset);
    return kind ? [{ asset, kind }] : [];
  });
  const added: AddedMedia = { clips: [], refused: [] };
  if (media.length === 0) return added;
  return deps.alone(async () => {
    const label = media.length === 1 ? `Add ${basename(media[0]!.asset)}` : `Add ${media.length} clips`;
    await deps.request("tx.begin", { label, autoCommitAfter: 30 });
    try {
      const { tracks } = await deps.request("track.list", { cwd: dir, timeline });
      const targetKind = target ? tracks.find((track) => track.id === target.track)?.kind : undefined;
      const trackFor = new Map<string, string>();
      for (const track of tracks) if ((track.kind === "video" || track.kind === "audio") && !trackFor.has(track.kind)) trackFor.set(track.kind, track.id);
      let next = target?.start;
      for (const { asset, kind } of media) {
        const aimed = target && targetKind === kind;
        let track = aimed ? target.track : trackFor.get(kind);
        if (!track) {
          const made = await deps.request("track.add", { cwd: dir, timeline, kind, name: kind === "video" ? "Video" : "Audio" });
          track = made.changes.added[0];
          if (!track) continue;
          trackFor.set(kind, track);
        }
        try {
          const result = await deps.request("clip.add", {
            cwd: dir,
            timeline,
            track,
            asset,
            ...(aimed && next !== undefined ? { start: next } : {}),
            ...(isImageFile(asset) ? { duration: STILL_SECONDS } : {}),
          });
          added.clips.push(...result.changes.added);
          if (aimed) next = result.changes.range?.to ?? undefined;
        } catch (error) {
          added.refused.push({ asset, message: (error as Error).message ?? String(error) });
        }
      }
    } finally {
      await deps.request("tx.commit", {}).catch(() => undefined);
    }
    return added;
  });
}
