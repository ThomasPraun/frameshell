import {
  type AngleSyncSchema,
  ErrorCode,
  type MediaProbe,
  RpcError,
  SYNC_LOW_CONFIDENCE,
} from "@frameshell/protocol";
import type { MulticamGroup } from "@frameshell/schema";
import type { z } from "zod";
import type { EnergyProfile } from "../media/energy.js";
import { projectPath } from "../timeline/service.js";
import { type PlannedOffset, correlateProfiles, planOffsets } from "./sync.js";

/** Where `multicam.create` finds the media facts it needs; the daemon wires these to its services. */
export interface MeasureSource {
  /** Probe of a project-relative asset; see `MediaService.probe`. */
  probe(root: string, asset: string): Promise<MediaProbe>;
  /** Energy envelope of a project-relative asset; see `EnergyStore.profile`. */
  profile(root: string, asset: string): Promise<EnergyProfile>;
}

/** Input of {@link measureAngles}. */
export interface MeasureRequest {
  root: string;
  /** Caller's directory: relative assets resolve against it first. */
  cwd: string;
  /** As the caller named them; the first sets the clock. */
  assets: readonly string[];
  /** Same order as `assets`; absent = names are left to the engine (file names). */
  names?: readonly string[] | undefined;
}

/** Output of {@link measureAngles}. */
export interface MeasuredAngles {
  /** Project-relative, `/`-separated, in the order given. */
  assets: string[];
  /** One per asset: its offset, confidence and whether the match is trusted. */
  plan: PlannedOffset[];
}

/**
 * Resolve the files and measure every file's offset against the first
 * (ADR 0016). Throws InvalidOperation naming the file and the fix when a
 * file is outside the project, has no picture or no sound, or cannot be
 * decoded, and AssetNotFound when it does not exist.
 */
export async function measureAngles(source: MeasureSource, request: MeasureRequest): Promise<MeasuredAngles> {
  const { root, cwd, names } = request;
  const op = "multicam.create";
  if (names !== undefined && names.length !== request.assets.length) {
    throw new RpcError(
      ErrorCode.InvalidOperation,
      `${op}: ${names.length} name(s) for ${request.assets.length} file(s); give one name per file, in the same order.`,
      { op, reason: "names", field: "names" },
    );
  }
  const assets = request.assets.map((asset) => projectPath(root, cwd, asset, "asset", op));
  if (new Set(assets).size !== assets.length) {
    throw new RpcError(ErrorCode.InvalidOperation, `${op}: a file is listed twice. Give each person's file once.`, {
      op,
      reason: "duplicate",
      field: "assets",
    });
  }
  for (const asset of assets) {
    const probe = await source.probe(root, asset).catch((error: unknown) => {
      if (error instanceof RpcError) throw error;
      throw new RpcError(ErrorCode.InvalidOperation, `${op}: ${asset} is not a media file ffprobe can read.`, {
        op,
        reason: "unreadable media",
        field: "assets",
      });
    });
    if (!probe.video || probe.video.still || !probe.audio) {
      const lacks = !probe.audio ? "sound" : "a moving picture";
      throw new RpcError(
        ErrorCode.InvalidOperation,
        `${op}: ${asset} has no ${lacks}; each angle needs a video file with sound to be synced by its audio.`,
        { op, reason: "no streams", field: "assets", hint: "Sync a file without sound by hand with `multicam.offset` after adding the others." },
      );
    }
  }
  const reference = await profileOf(source, root, assets[0]!);
  const estimates = [];
  for (const asset of assets.slice(1)) estimates.push(correlateProfiles(reference, await profileOf(source, root, asset)));
  return { assets, plan: planOffsets(estimates) };
}

async function profileOf(source: MeasureSource, root: string, asset: string): Promise<EnergyProfile> {
  try {
    return await source.profile(root, asset);
  } catch (error) {
    if (error instanceof RpcError) throw error;
    throw new RpcError(
      ErrorCode.InvalidOperation,
      `multicam.create: could not read the sound of ${asset}: ${(error as Error).message}`,
      { op: "multicam.create", reason: "undecodable audio", field: "assets" },
    );
  }
}

/** Sync entries and warnings for the created `group`, whose angles follow the order of `plan`. */
export function syncReport(
  group: MulticamGroup,
  plan: readonly PlannedOffset[],
): { sync: z.output<typeof AngleSyncSchema>[]; warnings: string[] } {
  const first = group.angles[0]!;
  const warnings: string[] = [];
  const sync = group.angles.map((angle, i) => {
    const planned = plan[i]!;
    if (!planned.synced) {
      const percent = Math.round((planned.confidence ?? 0) * 100);
      warnings.push(
        `${angle.name} (${angle.asset}): no shared sound with ${first.name} found (confidence ${percent}% < ${SYNC_LOW_CONFIDENCE * 100}%), ` +
          `so it starts together with ${first.name}. Check it, then fix it with ` +
          `\`frameshell multicam offset ${group.id} ${angle.id} <seconds>\`.`,
      );
    }
    return {
      angle: angle.id,
      name: angle.name,
      asset: angle.asset,
      offset: angle.offset,
      confidence: planned.confidence === null ? null : Math.round(planned.confidence * 1000) / 1000,
      synced: planned.synced,
    };
  });
  return { sync, warnings };
}
