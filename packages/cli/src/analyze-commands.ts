import { ANALYZE_EVENT_KINDS, type AnalyzeResult, type DaemonConnection } from "@frameshell/protocol";
import { UsageError } from "./timeline-commands.js";

/** Help text of `analyze` (#471), in `frameshell --help`. */
export const ANALYZE_USAGE = `  analyze <video> [--name n] [--threshold 0.3]
                               Measure a reference video: shot table (cuts, cuts per minute, shot lengths), contact sheet
                               at 2 frames a second and a frame per shot, dominant colours and look (brightness, contrast,
                               saturation, warmth, colour grid) per shot and overall, rhythm (shot-length spread, still
                               share, bursts), events (flashes, elements appearing or disappearing, holds, sound hits),
                               loudness (EBU R128) and tempo, into .frameshell/analysis/<name>/ (default: the file name; a
                               new run replaces it; project files untouched). Times are frame / fps, rounded down.
                               --threshold: scene score that opens a shot (0.05 to 0.95; lower finds softer cuts)
`;

/** Flags `analyze` takes besides the global ones. */
export const ANALYZE_FLAGS: Record<string, readonly string[]> = {
  analyze: ["name", "threshold"],
};

/** A parsed `analyze` command. */
export interface AnalyzeInvocation {
  kind: "analyze";
  file: string;
  name?: string;
  threshold?: number;
}

/** Flag values `analyze` reads. */
export interface AnalyzeOptions {
  name?: string | undefined;
  threshold?: string | undefined;
}

/** Parse `analyze`; null unless it has exactly one video. Throws `UsageError` for a bad flag value. */
export function parseAnalyze(rest: string[], options: AnalyzeOptions): AnalyzeInvocation | null {
  if (rest.length !== 1) return null;
  let threshold: number | undefined;
  if (options.threshold !== undefined) {
    threshold = Number(options.threshold);
    if (options.threshold.trim() === "" || !Number.isFinite(threshold) || threshold < 0.05 || threshold > 0.95) {
      throw new UsageError(`--threshold takes a scene score from 0.05 to 0.95, e.g. --threshold 0.3; got "${options.threshold}".`);
    }
  }
  if (options.name !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.name)) {
    throw new UsageError(`--name takes letters, digits, ".", "_" and "-" (at most 64, starting with a letter or digit); got "${options.name}".`);
  }
  return { kind: "analyze", file: rest[0]!, ...(options.name ? { name: options.name } : {}), ...(threshold !== undefined ? { threshold } : {}) };
}

/** Run a parsed `analyze`; human output unless `json`. */
export async function executeAnalyze(conn: DaemonConnection, inv: AnalyzeInvocation, cwd: string, json: boolean): Promise<string> {
  const { kind: _kind, ...params } = inv;
  const result = await conn.request("analyze", { cwd, ...params });
  return json ? `${JSON.stringify(result, null, 2)}\n` : formatAnalyze(result);
}

function formatAnalyze(result: AnalyzeResult): string {
  const { stats, rhythm } = result;
  const lines = [
    `Analysis ${result.name} of ${result.file}: ${result.duration} s, ${result.width}x${result.height} at ${result.fps} fps -> ${result.dir}`,
    `Cutting: ${stats.shotCount} shots, ${stats.cutsPerMinute} cuts a minute; length average ${stats.averageLength} s, median ${stats.medianLength} s, shortest ${stats.shortest} s, longest ${stats.longest} s`,
    `Palette: ${result.palette.map((color) => `${color.hex} ${Math.round(color.share * 100)}%`).join("  ") || "none"}`,
    `Look: brightness ${result.look.brightness}, contrast ${result.look.contrast}, saturation ${result.look.saturation}, warmth ${result.look.warmth}`,
    `Rhythm: shot-length CV ${rhythm.shotLengthCv}, ${Math.round(rhythm.stillShare * 100)}% still frames (longest hold ${rhythm.longestStill} s), ${rhythm.changeCount} big changes (${rhythm.changesPerMinute} a minute, largest gap ${rhythm.largestGap} s), ${rhythm.bursts.length} bursts${rhythm.bursts.length > 0 ? ` at ${rhythm.bursts.map((burst) => `${burst.start} s (${burst.count})`).join(", ")}` : ""}`,
    `Events: ${eventCounts(result)}`,
  ];
  if (result.loudness) {
    const { integrated, range, truePeak } = result.loudness;
    lines.push(`Loudness: ${integrated === null ? "silent" : `${integrated} LUFS, range ${range} LU, true peak ${truePeak} dBTP`}`);
  }
  if (result.tempo) {
    const { bpm, meter, confidence, low } = result.tempo;
    lines.push(`Tempo: ${bpm} BPM in ${meter}, confidence ${confidence}${low ? " (low: do not trust it)" : ""}`);
  }
  for (const sheet of result.sheets) lines.push(`  ${sheet.path}  ${sheet.width}x${sheet.height}  ${sheet.kind}, ${sheet.tiles.length} tiles`);
  lines.push("Shots (start s, length s):");
  for (const shot of result.shots) lines.push(`  #${shot.index}  ${shot.start}  ${shot.length}  ${shot.palette.slice(0, 3).map((color) => color.hex).join(" ")}`);
  const listed = result.events.filter((event) => event.kind !== "hold" && event.kind !== "hit");
  if (listed.length > 0) lines.push("Flashes and elements (start s, kind, region x y w h):");
  for (const event of listed) lines.push(`  ${event.start}  ${event.kind}${event.region ? `  ${[event.region.x, event.region.y, event.region.width, event.region.height].join(" ")}` : ""}`);
  lines.push(...result.warnings.map((warning) => `warning: ${warning}`));
  return `${lines.join("\n")}\n`;
}

/** `3 flash, 2 appear, 4 hold`: how many events of each kind, in the order of {@link ANALYZE_EVENT_KINDS}. */
function eventCounts(result: AnalyzeResult): string {
  const parts = ANALYZE_EVENT_KINDS.map((kind) => [kind, result.events.filter((event) => event.kind === kind).length] as const).filter(([, count]) => count > 0);
  return parts.map(([kind, count]) => `${count} ${kind}`).join(", ") || "none";
}
