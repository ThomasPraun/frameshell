import { type DaemonConnection, REVIEW_OUTPUTS, type ReviewMetrics, type ReviewOutput, type ReviewResult } from "@frameshell/protocol";
import { FormatIdSchema, PLATFORM_IDS, type PlatformId } from "@frameshell/schema";
import { UsageError } from "./timeline-commands.js";

/** Help text of `review` (#457), in `frameshell --help`. */
export const REVIEW_USAGE = `  review [--timeline id] [--file video] [--range a,b] [--sheets contact,safe,phone,motion,seam,metrics] [--platform p] [--every s] [--format id]
                               Look at the film before showing it: write contact sheets and strips into
                               .frameshell/review/<n>/ (last 10 kept; project files untouched) and print their paths.
                               contact = frames at clip starts and ends, cuts, markers, subtitle cues and the deepest
                               zoom plus one every --every s (default 0.5), labelled with their time; phone = one frame
                               per second at 360 px wide; motion = the two fastest moments as 12 consecutive frames;
                               seam = the last 6 and first 6 frames; safe = up to 36 frames with the UI zones of
                               --platform (instagram, tiktok, shorts, youtube) shaded red and captions that cross them
                               marked !subtitle (--platform alone adds it; vertical films use the style guide's platforms).
                               metrics = metrics.json and a summary: longest still stretch, largest gap between visual
                               events, near-blank frames, empty frame 0, subtitle cues too short to read, loudness of a
                               --file (LUFS, LRA, true peak, phone band) and craft warnings; written without --sheets.
                               --file reviews an exported video (the file
                               people get) instead of the timeline; --range limits it to seconds a to b;
                               --format lays a timeline out as that format of the project (9x16)
`;

/** Flags `review` takes besides the global ones. */
export const REVIEW_FLAGS: Record<string, readonly string[]> = {
  review: ["timeline", "file", "range", "sheets", "platform", "every", "format"],
};

/** A parsed `review` command. */
export interface ReviewInvocation {
  kind: "review";
  timeline?: string;
  file?: string;
  from?: number;
  to?: number;
  sheets?: ReviewOutput[];
  platform?: PlatformId;
  every?: number;
  projectFormat?: string;
}

/** Flag values `review` reads. */
export interface ReviewOptions {
  timeline?: string | undefined;
  file?: string | undefined;
  range?: string | undefined;
  sheets?: string | undefined;
  platform?: string | undefined;
  every?: string | undefined;
  format?: string | undefined;
}

/** Names `--platform` takes besides the platform ids themselves. */
const PLATFORM_ALIASES: Record<string, PlatformId> = { instagram: "instagram-reels", reels: "instagram-reels", shorts: "youtube-shorts" };

/** The platform `name` stands for (an id or an alias); throws `UsageError` for any other. */
export function parsePlatform(name: string): PlatformId {
  const id = PLATFORM_ALIASES[name] ?? (PLATFORM_IDS as readonly string[]).find((candidate) => candidate === name);
  if (!id) throw new UsageError(`--platform takes ${PLATFORM_IDS.join(", ")} (or instagram, reels, shorts); got "${name}".`);
  return id as PlatformId;
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
  let sheets: ReviewOutput[] | undefined;
  if (options.sheets !== undefined) {
    const names = options.sheets.split(",").map((name) => name.trim()).filter((name) => name !== "");
    const unknown = names.filter((name) => !(REVIEW_OUTPUTS as readonly string[]).includes(name));
    if (names.length === 0 || unknown.length > 0) {
      throw new UsageError(`--sheets takes ${REVIEW_OUTPUTS.join(", ")} separated by commas${unknown.length > 0 ? `; unknown: ${unknown.join(", ")}` : ""}.`);
    }
    sheets = names as ReviewOutput[];
  }
  const platform = options.platform === undefined ? undefined : parsePlatform(options.platform);
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
    ...(platform ? { platform } : {}),
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
  for (const zone of result.safeZones) {
    const { top, right, bottom, left } = zone.insets;
    lines.push(`Safe zones ${zone.platform} (${zone.measured ? "measured" : "from editing guides"}): top ${top}, right ${right}, bottom ${bottom}, left ${left} px`);
    for (const flag of zone.flags) {
      lines.push(`  ${flag.subject} ${flag.track} reaches into the ${flag.zone} zone by up to ${flag.reach} px: ${flag.cues} cues from ${flag.first} to ${flag.last} s`);
    }
  }
  if (result.metrics) lines.push(...formatMetrics(result.metrics));
  if (result.peaks.length > 0) lines.push(`Fastest moments: ${result.peaks.map((peak) => `${peak.at} s (${peak.energy})`).join(", ")}`);
  lines.push(...result.warnings.map((warning) => `warning: ${warning}`));
  return `${lines.join("\n")}\n`;
}

/** The lines `review` prints for `metrics`: the numbers, then the craft warnings. */
function formatMetrics(metrics: ReviewMetrics): string[] {
  const { picture, subtitles, loudness } = metrics;
  const span = (found: { from: number; to: number; seconds: number } | null) => (found ? `${found.seconds} s (${found.from} to ${found.to})` : "none");
  const lines = [
    `Metrics (${picture.samples} samples, ${picture.spacing} s apart): longest still ${span(picture.longestStatic)}, largest gap between visual events ${span(picture.largestGap)} (${picture.events} events), ` +
      `${picture.blank.length} near-blank stretches, frame 0 ${picture.firstFrameEmpty === null ? "not measured" : picture.firstFrameEmpty ? "empty" : "not empty"}`,
  ];
  if (subtitles) lines.push(`  subtitles: ${subtitles.cues} cues, ${subtitles.shortCues.length} on screen for less than they take to read`);
  if (loudness) {
    lines.push(`  loudness: ${loudness.integrated ?? "silent"} LUFS, range ${loudness.range ?? "-"} LU, true peak ${loudness.truePeak ?? "-"} dBTP, phone band ${loudness.phoneBand ?? "-"} LUFS`);
  }
  lines.push(...metrics.craft.map((warning) => `  craft ${warning.check}: ${warning.message}`));
  return lines;
}
