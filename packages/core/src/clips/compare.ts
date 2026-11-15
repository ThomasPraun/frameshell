import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { type ClipCompareResultShape, type ClipLook, ErrorCode, RpcError } from "@frameshell/protocol";
import type { AdapterClip, Timeline } from "@frameshell/schema";
import { type ExportService, type LoadedTimeline, pool } from "../export/service.js";
import { columnsFor, compareFrame, evenHeight } from "../grade/compare.js";
import { round } from "../grade/levels.js";
import { captureParallelism } from "../review/source.js";
import { type SheetTile, writeSheet } from "../review/sheet.js";

// `clip.compare` (#482 slice 3, ADR 0035): one frame of a generated clip under several props or sources, each rendered by
// the `frame` export path on a copy of the loaded timeline whose clip carries that variant, tiled into one labelled
// sheet with the sheet writer `grade.compare` and `review` share. Never edits the timeline.

/** Where compare sheets go by default, project-relative: regenerable, gitignored with the rest of `.frameshell/`. */
export const CLIP_COMPARE_DIR = [".frameshell", "looks"] as const;

/** What {@link ClipComparer} needs from the daemon. */
export interface ClipComparerOptions {
  exports: Pick<ExportService, "frame">;
  /** Absolute path of the managed ffmpeg. */
  ffmpeg(root: string): Promise<string>;
}

/** One `clip.compare` call, params validated. */
export interface ClipCompareRequest {
  clip: string;
  looks: readonly ClipLook[];
  /** Timeline seconds inside the clip; default its middle frame. */
  at?: number | undefined;
  /** Absolute PNG path; default under {@link CLIP_COMPARE_DIR}. */
  out?: string | undefined;
  tileWidth: number;
  projectFormat?: string | undefined;
}

type Tile = ClipCompareResultShape["tiles"][number];

/** The variant a tile draws: the clip's `source` and whole `props`. */
export interface ClipVariant {
  source: string | undefined;
  props: Record<string, unknown> | undefined;
}

/** Renders variants of one generated clip's frame side by side; writes the sheet only. */
export class ClipComparer {
  readonly #options: ClipComparerOptions;

  constructor(options: ClipComparerOptions) {
    this.#options = options;
  }

  /** The sheet of `request` for clip `request.clip` of `loaded` (an adapter clip on a video track). Throws `ClipNotFound` or `InvalidOperation`. */
  async compare(root: string, loaded: LoadedTimeline, request: ClipCompareRequest): Promise<ClipCompareResultShape> {
    const { timeline, fps } = loaded;
    const found = timeline.tracks.flatMap((track) => (track.kind === "video" ? track.clips.map((clip) => ({ track, clip })) : [])).find((entry) => entry.clip.id === request.clip);
    if (!found) {
      throw new RpcError(ErrorCode.ClipNotFound, `clip.compare: no clip "${request.clip}" on a video track of timeline ${timeline.id}. List clip ids with "frameshell timeline show".`, { clip: request.clip });
    }
    const { track, clip } = found;
    if (clip.type === "media" || clip.type === "timeline" || clip.type === "shot") {
      throw invalid("not-generated", `clip ${clip.id} is a ${clip.type} clip: only generated clips (blender, hyperframes, ...) have props and a source to vary; use \`grade compare\` for a media clip's colour.`, "clip");
    }
    const generated = clip as AdapterClip;
    const frame = compareFrame(generated.id, generated.start, generated.start + generated.duration, fps, request.at, "clip.compare");

    const current: ClipVariant = { source: generated.source, props: generated.props };
    const warnings: string[] = [];
    if (track.hidden) warnings.push(`Track ${track.id} is hidden: the frame does not show clip ${clip.id}, so every tile looks the same.`);
    const tiles: Tile[] = [{ label: "", kind: "current", source: current.source ?? null, props: current.props ?? null, flags: "" }];
    const variants: ClipVariant[] = [current];
    const names = ["current"];
    for (const [i, look] of request.looks.entries()) {
      const label = look.name ?? `look ${i + 1}`;
      if (look.source === undefined && look.props === undefined) throw invalid("empty-look", `look "${label}" sets neither \`source\` nor \`props\`.`, "looks");
      if (look.source !== undefined && !insideProject(look.source)) {
        throw invalid("source-outside-project", `look "${label}": source "${look.source}" must be a path inside the project (relative, no \`..\`).`, "looks");
      }
      const variant = applyLook(current, look);
      if (same(variant, current)) warnings.push(`Look "${label}" changes nothing: its tile is the clip as it is.`);
      variants.push(variant);
      tiles.push({ label: "", kind: "look", source: variant.source ?? null, props: variant.props ?? null, flags: propsFlags(variant, current) });
      names.push(label);
    }
    for (const [i, tile] of tiles.entries()) tile.label = `${i + 1} ${names[i]}`;

    const out = request.out ?? join(root, ...CLIP_COMPARE_DIR, `compare-${clip.id}-${frame}.png`);
    const scratch = join(root, ".frameshell", "cache", "clip-compare", randomBytes(6).toString("hex"));
    try {
      const paths = tiles.map((_, i) => join(scratch, `tile-${i}.png`));
      const render = async (i: number) => {
        try {
          const shot = await this.#options.exports.frame(
            root,
            { timeline: timeline.id, at: frame / fps, out: paths[i]!, projectFormat: request.projectFormat },
            { ...loaded, timeline: withVariant(timeline, clip.id, variants[i]!) },
          );
          for (const warning of shot.warnings) if (!warnings.includes(warning)) warnings.push(warning);
          return shot;
        } catch (error) {
          throw tileError(tiles[i]!.label, error);
        }
      };
      // The first frame alone: it makes the layers and mattes the others share, and the first render the queue runs.
      const first = await render(0);
      await pool(tiles.slice(1), captureParallelism(), async (_, i) => void (await render(i + 1)));
      const tile = { width: request.tileWidth, height: evenHeight(request.tileWidth, first.width, first.height) };
      const size = await writeSheet(await this.#options.ffmpeg(root), tiles.map((entry, i) => ({ path: paths[i]!, label: entry.label }) satisfies SheetTile), {
        out,
        columns: columnsFor(tiles.length),
        tile,
        scratch: join(scratch, "sheet"),
      });
      return {
        timeline: timeline.id,
        clip: clip.id,
        type: generated.type,
        frame,
        at: round(frame / fps, 3),
        path: out,
        width: size.width,
        height: size.height,
        columns: size.columns,
        rows: size.rows,
        tiles,
        warnings,
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

const invalid = (reason: string, message: string, field: string) =>
  new RpcError(ErrorCode.InvalidOperation, `clip.compare: ${message}`, { op: "clip.compare", reason, field });

/** `error` with the tile that failed named; an `RpcError` keeps its code and data. */
function tileError(label: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RpcError) return new RpcError(error.code, `clip.compare: tile "${label}": ${message}`, error.data);
  return new Error(`clip.compare: tile "${label}": ${message}`);
}

/** True for a project-relative path that stays inside the project. */
function insideProject(path: string): boolean {
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path)) return false;
  const clean = normalize(path).replaceAll("\\", "/");
  return clean !== ".." && !clean.startsWith("../");
}

/** `current` with the look's source, and the look's props merged over its own (a null value drops the key). */
export function applyLook(current: ClipVariant, look: ClipLook): ClipVariant {
  const props = { ...current.props };
  for (const [key, value] of Object.entries(look.props ?? {})) {
    if (value === null) delete props[key];
    else props[key] = value;
  }
  return { source: look.source ?? current.source, props: Object.keys(props).length > 0 ? props : undefined };
}

/** True when both draw the same source with equal props (key order aside). */
function same(a: ClipVariant, b: ClipVariant): boolean {
  return a.source === b.source && canonical(a.props ?? {}) === canonical(b.props ?? {});
}

/** JSON with object keys sorted, so equal props compare equal whatever their key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1))) : item,
  );
}

/** `timeline` with clip `id`'s source and props replaced by `variant`; the rest shared, never mutated. */
export function withVariant(timeline: Timeline, id: string, variant: ClipVariant): Timeline {
  return {
    ...timeline,
    tracks: timeline.tracks.map((track) =>
      track.kind !== "video" || !track.clips.some((clip) => clip.id === id)
        ? track
        : {
            ...track,
            clips: track.clips.map((clip) => {
              if (clip.id !== id) return clip;
              const { source: _source, props: _props, ...rest } = clip as AdapterClip;
              return { ...rest, ...(variant.source !== undefined ? { source: variant.source } : {}), ...(variant.props ? { props: variant.props } : {}) } as typeof clip;
            }),
          },
    ),
  };
}

/** The `clip set` flag that gives the clip `variant`'s props; empty when its props are the clip's own. */
export function propsFlags(variant: ClipVariant, current: ClipVariant): string {
  if (canonical(variant.props ?? {}) === canonical(current.props ?? {})) return "";
  return `--props ${shellQuote(JSON.stringify(variant.props ?? {}))}`;
}

/** `text` as one POSIX shell word in single quotes. */
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}
