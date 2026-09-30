import { ErrorCode, RpcError } from "@frameshell/protocol";
import type { Clip, MediaClip } from "@frameshell/schema";
import { ENERGY_HOP_S, type EnergyProfile, PAUSE_MIN_S, profileLevel, snapToPause } from "../media/energy.js";
import type { EditPoint, EditPointResolver } from "./engine.js";
import { FrameGrid } from "./grid.js";

/** Options for {@link energySnapper}. */
export interface EnergySnapperOptions {
  /** Project frame rate: results are on its grid. */
  fps: number;
  /** Whether a project-relative asset has an audio stream. */
  hasAudio(asset: string): Promise<boolean>;
  /** Energy profile of a project-relative asset; see `EnergyStore.profile`. */
  profile(asset: string): Promise<EnergyProfile>;
}

/** A media clip heard on the timeline, with its energy. */
interface Heard {
  clip: MediaClip;
  profile: EnergyProfile;
  /** Timeline end (exclusive). */
  end: number;
}

/**
 * {@link EditPointResolver} that moves cut and trim edges into audio pauses
 * (#12, ADR 0003). Trims use the trimmed clip's audio. Cuts use every
 * audible media clip of the cut tracks under the window: a timeline point is
 * quiet only when all of them are, and a gap with no clip is silence.
 * Declines (null) when no audible audio lies under the edge: video-only,
 * muted and generated clips keep exact edges.
 */
export function energySnapper(options: EnergySnapperOptions): EditPointResolver {
  const grid = new FrameGrid(options.fps);
  const audible = async (clip: MediaClip): Promise<boolean> => clip.audio?.muted !== true && (await options.hasAudio(clip.asset));
  const load = async (asset: string): Promise<EnergyProfile> => {
    try {
      return await options.profile(asset);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      const reason = `energy snapping could not read the audio of ${asset}: ${(error as Error).message}`;
      throw new RpcError(ErrorCode.InvalidOperation, `${reason}. Retry, or pass \`snap: false\` (CLI \`--no-snap\`) to cut exactly.`, {
        reason,
        field: "snap",
      });
    }
  };

  return async (point: EditPoint) => {
    const { time, window } = point;
    if (point.clip) {
      if (!isMedia(point.clip)) return null;
      const clip = point.clip;
      if (!(await audible(clip))) return null;
      const profile = await load(clip.asset);
      const duration = profile.db.length * ENERGY_HOP_S;
      if (point.clock === "source") {
        return snapToPause({ time, window, grid, level: (t) => profileLevel(profile, t), min: 0, max: duration });
      }
      const speed = clip.speed ?? 1;
      return snapToPause({
        time,
        window,
        grid,
        level: (t) => profileLevel(profile, clip.in + (t - clip.start) * speed),
        min: Math.max(0, clip.start - clip.in / speed),
        max: clip.start + (duration - clip.in) / speed,
        pauseMin: PAUSE_MIN_S / speed,
      });
    }

    const reach = window + PAUSE_MIN_S;
    const heard: Heard[] = [];
    for (const clip of point.clips ?? []) {
      if (!isMedia(clip)) continue;
      const media = clip;
      const end = media.start + (media.out - media.in) / (media.speed ?? 1);
      if (end <= time - reach || media.start >= time + reach) continue;
      if (!(await audible(media))) continue;
      heard.push({ clip: media, profile: await load(media.asset), end });
    }
    if (heard.length === 0) return null;
    const fastest = Math.max(...heard.map(({ clip }) => clip.speed ?? 1));
    return snapToPause({
      time,
      window,
      grid,
      min: 0,
      pauseMin: PAUSE_MIN_S / fastest,
      level: (t) => {
        let loudest = Number.NEGATIVE_INFINITY;
        for (const { clip, profile, end } of heard) {
          if (t < clip.start || t >= end) continue;
          loudest = Math.max(loudest, profileLevel(profile, clip.in + (t - clip.start) * (clip.speed ?? 1)));
        }
        return loudest;
      },
    });
  };
}

/** Adapter `type` is any string, so `clip.type === "media"` alone does not narrow. */
function isMedia(clip: Clip): clip is MediaClip {
  return clip.type === "media";
}
