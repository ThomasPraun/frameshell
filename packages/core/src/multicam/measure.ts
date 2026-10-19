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
import { type PlannedOffset, correlateProfiles, planSync } from "./sync.js";

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
  /** Cameras, as the caller named them. */
  assets: readonly string[];
  /** Same order as `assets`; absent = names are left to the engine (file names). */
  names?: readonly string[] | undefined;
  /** Separate sound files, as the caller named them. */
  mics?: readonly string[] | undefined;
  /** Same order as `mics`; absent = file names. */
  micNames?: readonly string[] | undefined;
  /** One entry per camera: a 1-based mic index, `none` or `camera`; absent = {@link resolveSoundOf} defaults. */
  soundOf?: readonly string[] | undefined;
}

/** Output of {@link measureAngles}. */
export interface MeasuredAngles {
  /** Cameras, project-relative, `/`-separated, in the order given. */
  assets: string[];
  /** Mics, project-relative, in the order given. */
  mics: string[];
  /** Per camera: undefined = its own file's sound, null = no sound, a number = 0-based index into `mics`. */
  soundOf: (number | null | undefined)[];
  /** One per file, cameras then mics: its offset, confidence and whether the match is trusted. */
  plan: PlannedOffset[];
}

/**
 * Which sound each camera carries: `given` has one entry per camera (a
 * 1-based mic index, `none`, `camera`); without it camera n takes mic n while
 * there are mics and the rest keep their own file. Throws InvalidOperation
 * for a wrong count or an index without a mic.
 */
export function resolveSoundOf(given: readonly string[] | undefined, cameras: number, mics: number): (number | null | undefined)[] {
  const op = "multicam.create";
  if (given === undefined) return Array.from({ length: cameras }, (_, i) => (i < mics ? i : undefined));
  if (given.length !== cameras) {
    throw new RpcError(ErrorCode.InvalidOperation, `${op}: ${given.length} soundOf entries for ${cameras} camera(s); give one per camera, in the same order.`, {
      op,
      reason: "soundOf",
      field: "soundOf",
    });
  }
  return given.map((entry) => {
    if (entry === "camera") return undefined;
    if (entry === "none") return null;
    const index = /^[1-9]\d*$/.test(entry) ? Number(entry) : 0;
    if (index < 1 || index > mics) {
      throw new RpcError(ErrorCode.InvalidOperation, `${op}: soundOf "${entry}" is not \`camera\`, \`none\` or the number of a mic (1 to ${mics}).`, {
        op,
        reason: "soundOf",
        field: "soundOf",
        hint: mics === 0 ? "No mics were given." : `Mics: 1 to ${mics}, in the order given.`,
      });
    }
    return index - 1;
  });
}

/**
 * Resolve the files and measure every file's offset against all the others
 * (ADR 0016, {@link planSync}). Throws InvalidOperation naming the file and
 * the fix when a file is outside the project, a camera has no picture, a mic
 * has no sound, a file cannot be decoded, listed twice, or no file has sound
 * at all, and AssetNotFound when it does not exist.
 */
export async function measureAngles(source: MeasureSource, request: MeasureRequest): Promise<MeasuredAngles> {
  const { root, cwd, names } = request;
  const op = "multicam.create";
  const mics = request.mics ?? [];
  for (const [given, list, field] of [
    [names, request.assets, "names"],
    [request.micNames, mics, "micNames"],
  ] as const) {
    if (given !== undefined && given.length !== list.length) {
      throw new RpcError(
        ErrorCode.InvalidOperation,
        `${op}: ${given.length} name(s) for ${list.length} file(s); give one name per file, in the same order.`,
        { op, reason: "names", field },
      );
    }
  }
  const soundOf = resolveSoundOf(request.soundOf, request.assets.length, mics.length);
  const assets = request.assets.map((asset) => projectPath(root, cwd, asset, "asset", op));
  const micAssets = mics.map((asset) => projectPath(root, cwd, asset, "asset", op));
  const all = [...assets, ...micAssets];
  if (new Set(all).size !== all.length) {
    throw new RpcError(ErrorCode.InvalidOperation, `${op}: a file is listed twice. Give each file once, as a camera or as a mic.`, {
      op,
      reason: "duplicate",
      field: "assets",
    });
  }
  const profiles: (EnergyProfile | null)[] = [];
  for (const [i, asset] of all.entries()) {
    const camera = i < assets.length;
    const probe = await source.probe(root, asset).catch((error: unknown) => {
      if (error instanceof RpcError) throw error;
      throw new RpcError(ErrorCode.InvalidOperation, `${op}: ${asset} is not a media file ffprobe can read.`, {
        op,
        reason: "unreadable media",
        field: camera ? "assets" : "mics",
      });
    });
    if (camera && (!probe.video || probe.video.still)) {
      throw new RpcError(ErrorCode.InvalidOperation, `${op}: ${asset} has no moving picture; each camera needs a video file.`, {
        op,
        reason: "no streams",
        field: "assets",
        hint: "Give audio files as mics.",
      });
    }
    if (!camera && !probe.audio) {
      throw new RpcError(ErrorCode.InvalidOperation, `${op}: ${asset} has no sound; a mic needs an audio stream.`, { op, reason: "no streams", field: "mics" });
    }
    // A silent camera has nothing to match: unsynced, it starts with the reference and gets the usual warning.
    profiles.push(probe.audio ? await profileOf(source, root, asset) : null);
  }
  if (profiles.every((profile) => profile === null)) {
    throw new RpcError(ErrorCode.InvalidOperation, `${op}: none of the files has sound, so there is nothing to sync them by.`, {
      op,
      reason: "no streams",
      field: "assets",
      hint: "Add a mic file or a camera with sound.",
    });
  }
  return { assets, mics: micAssets, soundOf, plan: planSync(profiles, correlateProfiles) };
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

/** Sync entries and warnings for the created `group`, whose cameras then mics follow the order of `plan`. */
export function syncReport(
  group: MulticamGroup,
  plan: readonly PlannedOffset[],
): { sync: z.output<typeof AngleSyncSchema>[]; warnings: string[] } {
  const files = [
    ...group.angles.map((angle) => ({ kind: "camera" as const, ...angle })),
    ...(group.mics ?? []).map((mic) => ({ kind: "mic" as const, ...mic })),
  ];
  const reference = files[plan.findIndex((planned) => planned.confidence === null)];
  const warnings: string[] = [];
  const sync = files.map((file, i) => {
    const planned = plan[i]!;
    if (!planned.synced) {
      const percent = Math.round((planned.confidence ?? 0) * 100);
      const fix = file.kind === "mic" ? `multicam mic ${group.id} ${file.id} --offset <seconds>` : `multicam offset ${group.id} ${file.id} <seconds>`;
      warnings.push(
        `${file.name} (${file.asset}): no shared sound with the other files found (best confidence ${percent}% < ${SYNC_LOW_CONFIDENCE * 100}%), ` +
          `so it starts together with ${reference?.name ?? "the first file"}. Check it, then fix it with \`frameshell ${fix}\`.`,
      );
    }
    return {
      kind: file.kind,
      angle: file.id,
      name: file.name,
      asset: file.asset,
      offset: file.offset,
      confidence: planned.confidence === null ? null : Math.round(planned.confidence * 1000) / 1000,
      against: planned.against === null ? null : files[planned.against]!.id,
      synced: planned.synced,
    };
  });
  return { sync, warnings };
}
