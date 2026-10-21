// Layers of an image project (ADR 0017): its video tracks, topmost first, each showing the clip at frame 0.
import type { TimelineView } from "@frameshell/protocol";
import type { TimelineEdit } from "../../../shared/api.js";

type TrackView = TimelineView["tracks"][number];
type ClipView = TrackView["clips"][number];

/** One row of the Layers panel. */
export interface Layer {
  track: string;
  /** Track name; null when unnamed (the row then names the clip's file). */
  name: string | null;
  /** The clip showing at frame 0; null when the layer shows nothing then. */
  clip: ClipView | null;
  /** Project-relative image or video the clip shows; null for generated and nested clips. */
  asset: string | null;
  /** The clip's type: `media`, `timeline` or an adapter type such as `hyperframes`. */
  type: string | null;
  /** Can move up (or down): another layer lies above (below) it. */
  up: boolean;
  down: boolean;
}

/** The layers of `view`, topmost first: every video track, with the clip it shows at frame 0. */
export function layersOf(view: TimelineView): Layer[] {
  const videos = view.tracks.filter((track) => track.kind === "video");
  return videos
    .map((track, index) => {
      const clip = track.clips.find((candidate) => candidate.start <= 0 && (candidate.end === null || candidate.end > 0)) ?? null;
      const asset = clip && typeof clip["asset"] === "string" ? clip["asset"] : null;
      return { track: track.id, name: track.name, clip, asset, type: clip?.type ?? null, up: index < videos.length - 1, down: index > 0 };
    })
    .reverse();
}

/** Name to show for `layer`: its track name, else its file's name, else its clip type. */
export function layerLabel(layer: Layer): string | null {
  if (layer.name) return layer.name;
  if (layer.asset) return layer.asset.split("/").pop() ?? layer.asset;
  const source = layer.clip?.["source"];
  return typeof source === "string" ? (source.split("/").pop() ?? source) : null;
}

/**
 * The `track.set` edit moving `track` one layer up (`1`) or down (`-1`): past the next video track that way,
 * whatever audio or subtitle tracks lie between. Null when it is already the top (bottom) layer.
 */
export function moveLayer(view: TimelineView, track: string, direction: 1 | -1): TimelineEdit | null {
  const from = view.tracks.findIndex((candidate) => candidate.id === track);
  if (from < 0) return null;
  for (let at = from + direction; at >= 0 && at < view.tracks.length; at += direction) {
    // `track.set` takes the track out before inserting it, so the index of the layer passed is where it lands next to it.
    if (view.tracks[at]!.kind === "video") return { op: "track.set", args: { track, index: at } };
  }
  return null;
}
