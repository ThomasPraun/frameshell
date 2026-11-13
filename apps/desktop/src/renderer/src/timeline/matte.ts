// Track-header side of subject mattes (ADR 0032): which plates a track can go behind, and how their mattes are doing. Pure.
import type { MatteStateInfo } from "@frameshell/protocol";
import type { TimelineLayout, TrackRow } from "./layout.js";

/**
 * Video tracks `row` can go `behind` the person of, nearest first: lower video tracks holding a media clip (ADR 0032
 * decision 6: no program, nested or generated plates). Empty for any track that is not a video track.
 */
export function plateChoices(layout: TimelineLayout, row: TrackRow): TrackRow[] {
  if (row.kind !== "video") return [];
  const videos = layout.rows.filter((candidate) => candidate.kind === "video");
  return videos.slice(videos.indexOf(row) + 1).filter((plate) => plate.clips.some((clip) => clip.kind === "media"));
}

/** What a `behind` track's header says about its matte. */
export type MatteBadge =
  /** `idle`: no matte is asked for (no read yet, or nothing is behind the person right now); `ready`: all made. */
  | { state: "idle" | "ready"; plate: string }
  /** `progress` is the mean fraction done, or null while no matte job runs yet (queued, or waiting for a proxy). */
  | { state: "preparing"; plate: string; progress: number | null }
  | { state: "failed"; plate: string; error: string };

/**
 * The matte status of a track that is `behind` a plate, from the `matte.status` list (null: not read yet): the mattes
 * of the plate's media assets. Failed wins over preparing, so a problem is never hidden by a job still running.
 * Null for a track that is not behind anything.
 */
export function matteBadge(layout: TimelineLayout, row: TrackRow, mattes: readonly MatteStateInfo[] | null): MatteBadge | null {
  if (row.behind === null) return null;
  const plateRow = layout.rows.find((candidate) => candidate.id === row.behind);
  const plate = plateRow?.label ?? row.behind;
  const assets = new Set((plateRow?.clips ?? []).flatMap((clip) => (clip.kind === "media" && clip.asset ? [clip.asset] : [])));
  const own = (mattes ?? []).filter((matte) => assets.has(matte.asset));
  if (own.length === 0) return { state: "idle", plate };
  const failed = own.find((matte) => matte.state === "failed");
  if (failed) return { state: "failed", plate, error: failed.error ?? "" };
  const pending = own.filter((matte) => matte.state !== "ready");
  if (pending.length === 0) return { state: "ready", plate };
  const progress = pending.some((matte) => matte.state === "making") ? own.reduce((sum, matte) => sum + matte.progress, 0) / own.length : null;
  return { state: "preparing", plate, progress };
}
