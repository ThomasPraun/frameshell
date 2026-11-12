import { type DaemonConnection, REVIEW_SHEETS, type ReviewResult, type ReviewSheetKind } from "@frameshell/protocol";
import { FormatIdSchema } from "@frameshell/schema";
import { UsageError } from "./timeline-commands.js";

/** Help text of `review` (#457), in `frameshell --help`. */
export const REVIEW_USAGE = `  review [--timeline id] [--file video] [--range a,b] [--sheets contact,phone,motion,seam] [--every s] [--format id]
                               Look at the film before showing it: write contact sheets and strips into
                               .frameshell/review/<n>/ (last 10 kept; project files untouched) and print their paths.
                               contact = frames at clip starts and ends, cuts, markers, subtitle cues and the deepest
                               zoom plus one every --every s (default 0.5), labelled with their time; phone = one frame
                               per second at 360 px wide; motion = the two fastest moments as 12 consecutive frames;
                               seam = the last 6 and first 6 frames. --file reviews an exported video (the file
                               people get) instead of the timeline; --range limits it to seconds a to b;
                               --format lays a timeline out as that format of the project (9x16)
`;

/** Flags `review` takes besides the global ones. */
export const REVIEW_FLAGS: Record<string, readonly string[]> = {
  review: ["timeline", "file", "range", "sheets", "every", "format"],
};

/** A parsed `review` command. */
export interface ReviewInvocation {
  kind: "review";
  timeline?: string;
  file?: string;
  from?: number;
  to?: number;
  sheets?: ReviewSheetKind[];
  every?: number;
  projectFormat?: string;
}

/** Flag values `review` reads. */
export interface ReviewOptions {
  timeline?: string | undefined;
  file?: string | undefined;
  range?: string | undefined;
  sheets?: string | undefined;
  every?: string | undefined;
  format?: string | undefined;
}

/** Parse `review`; null when it has arguments. Throws `UsageError` for a bad flag value. */
export function parseReview(rest: string[], options: ReviewOptions): ReviewInvocation | null {
  if (rest.length > 0) return null;
  let from: number | undefined;
  let to: number | undefined;
  if (options.range !== undefined) {
    const parts = options.range.split(",").map((part) => (part.trim() === "" ? Number.NaN : Number(part)));
    if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part) || part < 0) || parts[1]! <= parts[0]!) {
      throw new UsageError(`--range takes two seconds, the second after the first, e.g. --range 5,12; got "${options.range}".`);
    }
    [from, to] = parts as [number, number];
  }
  let sheets: ReviewSheetKind[] | undefined;
  if (options.sheets !== undefined) {
    const names = options.sheets.split(",").map((name) => name.trim()).filter((name) => name !== "");
    const unknown = names.filter((name) => !(REVIEW_SHEETS as readonly string[]).includes(name));
    if (names.length === 0 || unknown.length > 0) {
      throw new UsageError(`--sheets takes ${REVIEW_SHEETS.join(", ")} separated by commas${unknown.length > 0 ? `; unknown: ${unknown.join(", ")}` : ""}.`);
    }
    sheets = names as ReviewSheetKind[];
  }
  const every = options.every === undefined ? undefined : Number(options.every);
  if (every !== undefined && (!Number.isFinite(every) || every <= 0)) throw new UsageError(`--every takes seconds above 0, got "${options.every}".`);
  if (options.format !== undefined && !FormatIdSchema.safeParse(options.format).success) {
    throw new UsageError(`--format: expected a format id of the project (e.g. 9x16), got "${options.format}".`);
  }
  return {
    kind: "review",
    ...(options.timeline ? { timeline: options.timeline } : {}),
    ...(options.file ? { file: options.file } : {}),
    ...(from !== undefined ? { from, to: to! } : {}),
    ...(sheets ? { sheets } : {}),
    ...(every !== undefined ? { every } : {}),
    ...(options.format ? { projectFormat: options.format } : {}),
  };
}

/** Run a parsed `review`; human output unless `json`. */
export async function executeReview(conn: DaemonConnection, inv: ReviewInvocation, cwd: string, json: boolean): Promise<string> {
  const { kind: _kind, ...params } = inv;
  const result = await conn.request("review", { cwd, ...params });
  return json ? `${JSON.stringify(result, null, 2)}\n` : formatReview(result);
}

function formatReview(result: ReviewResult): string {
  const what = result.source === "file" ? result.file! : `timeline ${result.timeline}`;
  const lines = [`Review ${result.run} of ${what}: ${result.range.from} to ${result.range.to} s, ${result.width}x${result.height} at ${result.fps} fps -> ${result.dir}`];
  for (const sheet of result.sheets) lines.push(`  ${sheet.path}  ${sheet.width}x${sheet.height}  ${sheet.kind}, ${sheet.tiles.length} tiles`);
  if (result.peaks.length > 0) lines.push(`Fastest moments: ${result.peaks.map((peak) => `${peak.at} s (${peak.energy})`).join(", ")}`);
  lines.push(...result.warnings.map((warning) => `warning: ${warning}`));
  return `${lines.join("\n")}\n`;
}
