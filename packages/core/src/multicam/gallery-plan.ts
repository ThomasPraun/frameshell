import { ErrorCode, type MediaProbe, RpcError } from "@frameshell/protocol";
import type { AngleCrop, MulticamGroup } from "@frameshell/schema";
import { projectPath } from "../timeline/service.js";
import { type GalleryAnalysis, tileCrop } from "./gallery.js";

/** Below this a tile is reported as worth a look. */
export const GALLERY_LOW_CONFIDENCE = 0.5;

/** Where `multicam.gallery` finds the media facts it needs; the daemon wires these to its services. */
export interface GallerySource {
  /** Probe of a project-relative asset; see `MediaService.probe`. */
  probe(root: string, asset: string): Promise<MediaProbe>;
  /** `analyseGallery` of a project-relative asset. */
  analyse(root: string, asset: string, picture: { width: number; height: number; duration: number }): Promise<GalleryAnalysis>;
}

/** Input of {@link planGallery}. */
export interface GalleryRequest {
  root: string;
  /** Caller's directory: a relative asset resolves against it first. */
  cwd: string;
  asset: string;
  /** One per tile in reading order; absent = `Tile <n>`. */
  names?: readonly string[] | undefined;
  /** File second whose layout to use; absent = the layout held longest. */
  at?: number | undefined;
}

/** Output of {@link planGallery}: the operation's args and what the report needs. */
export interface GalleryPlan {
  /** Project-relative, `/`-separated. */
  asset: string;
  /** Args of the `multicam.gallery` operation, in reading order. */
  tiles: { name?: string; crop: AngleCrop }[];
  analysis: GalleryAnalysis;
  /** Index into `analysis.layouts` of the layout the tiles come from. */
  layout: number;
}

/**
 * Resolve the recording, find its tile grids and pick one: the layout
 * playing at `at`, else the one held longest (the earliest on a tie). Throws
 * InvalidOperation naming the fix when the file is outside the project, has
 * no picture or no tile grid, `at` falls where there is none or past the end, or `names`
 * does not have one name per tile; AssetNotFound when it does not exist.
 */
export async function planGallery(source: GallerySource, request: GalleryRequest): Promise<GalleryPlan> {
  const op = "multicam.gallery";
  const asset = projectPath(request.root, request.cwd, request.asset, "asset", op);
  const probe = await source.probe(request.root, asset).catch((error: unknown) => {
    if (error instanceof RpcError) throw error;
    throw new RpcError(ErrorCode.InvalidOperation, `${op}: ${asset} is not a media file ffprobe can read.`, { op, reason: "unreadable media", field: "asset" });
  });
  if (!probe.video || probe.video.still || probe.duration === null) {
    throw new RpcError(ErrorCode.InvalidOperation, `${op}: ${asset} has no moving picture; a gallery recording is a video file.`, {
      op,
      reason: "no streams",
      field: "asset",
    });
  }
  let analysis: GalleryAnalysis;
  try {
    analysis = await source.analyse(request.root, asset, { width: probe.video.width, height: probe.video.height, duration: probe.duration });
  } catch (error) {
    if (error instanceof RpcError || (error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new RpcError(ErrorCode.InvalidOperation, `${op}: could not read the picture of ${asset}: ${(error as Error).message}`, {
      op,
      reason: "undecodable video",
      field: "asset",
    });
  }
  const layout = request.at === undefined ? longestLayout(analysis, asset) : layoutAt(analysis, asset, request.at);
  const tiles = analysis.layouts[layout]!.tiles;
  if (request.names !== undefined && request.names.length !== tiles.length) {
    throw new RpcError(ErrorCode.InvalidOperation, `${op}: ${request.names.length} name(s) for ${tiles.length} tiles; give one name per tile, in reading order.`, {
      op,
      reason: "names",
      field: "names",
      tiles: tiles.length,
      hint: "Tiles are numbered by rows, top to bottom, each left to right. Omit names to get `Tile 1`, `Tile 2`, …",
    });
  }
  return {
    asset,
    tiles: tiles.map((tile, i) => ({ ...(request.names ? { name: request.names[i]! } : {}), crop: tileCrop(tile, analysis.width, analysis.height) })),
    analysis,
    layout,
  };
}

function longestLayout(analysis: GalleryAnalysis, asset: string): number {
  const layout = analysis.layouts.reduce((best, candidate, i) => (best < 0 || candidate.duration > analysis.layouts[best]!.duration ? i : best), -1);
  if (layout < 0) {
    throw new RpcError(ErrorCode.InvalidOperation, `multicam.gallery: found no tile grid in ${asset} (${analysis.samples} frames looked at).`, {
      op: "multicam.gallery",
      reason: "no grid",
      field: "asset",
      hint:
        "A gallery view has two or more tiles split by gutters of one colour. A speaker-view or single-camera file has one picture: " +
        "add it to a group with `multicam.create`, or cut tiles by hand with `multicam.angle` crops.",
    });
  }
  return layout;
}

function layoutAt(analysis: GalleryAnalysis, asset: string, at: number): number {
  const last = analysis.stretches.at(-1);
  if (last && at > last.end) {
    throw new RpcError(ErrorCode.InvalidOperation, `multicam.gallery: ${at} s is past the end of ${asset} (${last.end} s).`, {
      op: "multicam.gallery",
      reason: "no grid",
      field: "at",
      hint: `Pick a time inside a stretch with tiles: ${describeStretches(analysis)}.`,
    });
  }
  // `at` equal to the end belongs to the last stretch, whose `end` is exclusive.
  const stretch = analysis.stretches.find((candidate) => at >= candidate.start && at < candidate.end) ?? (at === last?.end ? last : undefined);
  if (!stretch || stretch.layout === null) {
    throw new RpcError(ErrorCode.InvalidOperation, `multicam.gallery: no tile grid at ${at} s of ${asset}.`, {
      op: "multicam.gallery",
      reason: "no grid",
      field: "at",
      hint: `Pick a time inside a stretch with tiles: ${describeStretches(analysis) || "none was found"}.`,
    });
  }
  return stretch.layout;
}

/** `0–62.5 s: 4 tiles, 62.5–180 s: no tile grid`. */
function describeStretches(analysis: GalleryAnalysis): string {
  return analysis.stretches.map((stretch) => `${stretch.start}–${stretch.end} s: ${tileCount(analysis, stretch.layout)}`).join(", ");
}

function tileCount(analysis: GalleryAnalysis, layout: number | null): string {
  return layout === null ? "no tile grid" : `${analysis.layouts[layout]!.tiles.length} tiles`;
}

/** What `multicam.gallery` reports beyond the operation. */
export interface GalleryReport {
  /** One per angle, in the group's order, with the confidence of the tile it was cut from. */
  tiles: { angle: string; name: string; crop: AngleCrop; confidence: number }[];
  /** The recording's stretches: tile count (0: no grid) and whether the angles were cut from that layout. */
  layouts: { start: number; end: number; tiles: number; used: boolean }[];
  /** Lowest tile confidence. */
  confidence: number;
  warnings: string[];
}

/** Per-tile report, stretches and warnings for the created `group`, whose angles follow the plan's tiles in order. */
export function galleryReport(group: MulticamGroup, plan: GalleryPlan): GalleryReport {
  const { analysis, layout } = plan;
  const found = analysis.layouts[layout]!.tiles;
  const tiles = group.angles.map((angle, i) => ({ angle: angle.id, name: angle.name, crop: angle.crop ?? {}, confidence: found[i]!.confidence }));
  const layouts = analysis.stretches.map((stretch) => ({
    start: stretch.start,
    end: stretch.end,
    tiles: stretch.layout === null ? 0 : analysis.layouts[stretch.layout]!.tiles.length,
    used: stretch.layout === layout,
  }));
  const warnings: string[] = [];
  const fix = `\`frameshell multicam angle ${group.id} <angle> --crop-left <f> --crop-top <f> --crop-right <f> --crop-bottom <f>\``;
  analysis.stretches.slice(1).forEach((stretch, i) => {
    const before = analysis.stretches[i]!;
    warnings.push(`the call layout changes at ${stretch.start} s: ${tileCount(analysis, before.layout)} before, ${tileCount(analysis, stretch.layout)} after.`);
  });
  if (analysis.stretches.length > 1) {
    const used = analysis.stretches.filter((stretch) => stretch.layout === layout).map((stretch) => `${stretch.start}–${stretch.end} s`);
    warnings.push(
      `the tiles follow the layout of ${used.join(", ")} (${found.length} tiles); elsewhere a tile may show another person or a gutter. ` +
        `Fix a tile with ${fix}, or make another group with \`frameshell multicam gallery ${plan.asset} --at <s>\` for another stretch.`,
    );
  }
  const low = tiles.filter((tile) => tile.confidence < GALLERY_LOW_CONFIDENCE);
  if (low.length > 0) {
    warnings.push(
      `${low.map((tile) => `${tile.angle} (${Math.round(tile.confidence * 100)}%)`).join(", ")}: unsure of ${low.length === 1 ? "this tile" : "these tiles"}. ` +
        `Look at a frame (\`frameshell frame --at <s> --out <file.png>\`) and fix it with ${fix}.`,
    );
  }
  const mic = group.mics?.[0];
  warnings.push(
    mic
      ? `every tile hears the call's one mixed track (mic ${mic.id}), so they speak together for \`multicam turns\` until it has speakers: ` +
          `\`frameshell transcribe ${plan.asset}\`, then \`frameshell transcribe --speakers ${plan.asset} --people ${tiles.length}\`, then ` +
          `\`frameshell multicam angle ${group.id} <angle> --speaker <s1…>\` for each tile.`
      : `${plan.asset} has no sound: the tiles have no speaking turns, so \`direct\` cannot tell who speaks.`,
  );
  return { tiles, layouts, confidence: Math.min(...tiles.map((tile) => tile.confidence)), warnings };
}
