import { ANALYZE_CUT_KINDS, ANALYZE_EVENT_KINDS, type AnalyzeDiffResult, type AnalyzeResult, type DaemonConnection, labelOf } from "@frameshell/protocol";
import { UsageError } from "./timeline-commands.js";

/** Help text of `analyze` (#471), in `frameshell --help`. */
export const ANALYZE_USAGE = `  analyze <video> [--name n] [--threshold 0.3]
                               Measure a reference video: shot table (cuts, cuts per minute, shot lengths), contact sheet
                               at 2 frames a second and a frame per shot, dominant colours and look (brightness, contrast,
                               saturation, warmth, colour grid) per shot and overall, rhythm (shot-length spread, still
                               share, bursts), cuts told apart (new scene, jump cut, punch-in or out with its scale: the
                               ones the scene score misses are marked), events (flashes, elements appearing or disappearing, holds, sound hits),
                               the activity curve and its moves (start, duration, closest ease), ink (how much of the
                               picture graphics and text cover), mouth against voice (needs a people scan of the file),
                               loudness (EBU R128) and tempo, into .frameshell/analysis/<name>/ (default: the file name; a
                               new run replaces it; project files untouched). Times are frame / fps, rounded down. Every
                               value is labelled MEASURED, ESTIMATED or DECISION (--json: "labels").
                               --threshold: scene score that opens a shot (0.05 to 0.95; lower finds softer cuts)
  analyze diff <film> <reference> [--name n] [--lag s] [--max-lag s] [--every s] [--snapshots n]
                               Compare our film with a reference: the two are lined up by activity curve, then SSIM at
                               matched times, the energy of each and a side-by-side sheet (ours left), into
                               .frameshell/analysis/<name>/ (default <film>-vs-<reference>). A distance, not a pass or fail.
                               --lag: seconds to add to a time of the film to find the same moment of the reference (skips
                               the alignment); --max-lag: how far the alignment looks either way (default 3 s);
                               --every: seconds between SSIM readings (default 0.5); --snapshots: pairs on the sheet (8)
`;

/** Flags `analyze` takes besides the global ones. */
export const ANALYZE_FLAGS: Record<string, readonly string[]> = {
  analyze: ["name", "threshold", "lag", "max-lag", "every", "snapshots"],
};

/** A parsed `analyze` command. */
export interface AnalyzeInvocation {
  kind: "analyze";
  file: string;
  name?: string;
  threshold?: number;
}

/** A parsed `analyze diff` command. */
export interface AnalyzeDiffInvocation {
  kind: "analyze.diff";
  file: string;
  reference: string;
  name?: string;
  lag?: number;
  maxLag?: number;
  every?: number;
  snapshots?: number;
}

/** Flag values `analyze` reads. */
export interface AnalyzeOptions {
  name?: string | undefined;
  threshold?: string | undefined;
  lag?: string | undefined;
  "max-lag"?: string | undefined;
  every?: string | undefined;
  snapshots?: string | undefined;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A number flag in `[min, max]`; throws `UsageError` naming `expected` otherwise. */
function numberFlag(raw: string | undefined, flag: string, expected: string, min: number, max: number, whole = false): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value) || value < min || value > max || (whole && !Number.isInteger(value))) {
    throw new UsageError(`--${flag} takes ${expected}; got "${raw}".`);
  }
  return value;
}

/** Parse `analyze diff <film> <reference>`; null when the arguments are not two files. */
function parseDiff(files: string[], options: AnalyzeOptions): AnalyzeDiffInvocation | null {
  if (files.length !== 2) return null;
  if (options.threshold !== undefined) throw new UsageError("`frameshell analyze diff` does not take --threshold (it cuts no shots).");
  if (options.name !== undefined && !NAME_PATTERN.test(options.name)) {
    throw new UsageError(`--name takes letters, digits, ".", "_" and "-" (at most 64, starting with a letter or digit); got "${options.name}".`);
  }
  const lag = numberFlag(options.lag, "lag", "seconds, e.g. --lag 0.4 or --lag -1", -3600, 3600);
  const maxLag = numberFlag(options["max-lag"], "max-lag", "seconds from 0.5 to 30, e.g. --max-lag 3", 0.5, 30);
  const every = numberFlag(options.every, "every", "seconds from 0.1 to 30, e.g. --every 0.5", 0.1, 30);
  const snapshots = numberFlag(options.snapshots, "snapshots", "a whole number from 1 to 24", 1, 24, true);
  return {
    kind: "analyze.diff",
    file: files[0]!,
    reference: files[1]!,
    ...(options.name ? { name: options.name } : {}),
    ...(lag !== undefined ? { lag } : {}),
    ...(maxLag !== undefined ? { maxLag } : {}),
    ...(every !== undefined ? { every } : {}),
    ...(snapshots !== undefined ? { snapshots } : {}),
  };
}

/** Parse `analyze`; null unless it has exactly one video (or `diff` and two). Throws `UsageError` for a bad flag value. */
export function parseAnalyze(rest: string[], options: AnalyzeOptions): AnalyzeInvocation | AnalyzeDiffInvocation | null {
  if (rest[0] === "diff" && rest.length === 3) return parseDiff(rest.slice(1), options);
  if (rest.length !== 1) return null;
  const foreign = (["lag", "max-lag", "every", "snapshots"] as const).filter((flag) => options[flag] !== undefined);
  if (foreign.length > 0) throw new UsageError(`\`frameshell analyze <video>\` does not take ${foreign.map((flag) => `--${flag}`).join(", ")}: they belong to \`analyze diff\`.`);
  let threshold: number | undefined;
  if (options.threshold !== undefined) {
    threshold = Number(options.threshold);
    if (options.threshold.trim() === "" || !Number.isFinite(threshold) || threshold < 0.05 || threshold > 0.95) {
      throw new UsageError(`--threshold takes a scene score from 0.05 to 0.95, e.g. --threshold 0.3; got "${options.threshold}".`);
    }
  }
  if (options.name !== undefined && !NAME_PATTERN.test(options.name)) {
    throw new UsageError(`--name takes letters, digits, ".", "_" and "-" (at most 64, starting with a letter or digit); got "${options.name}".`);
  }
  return { kind: "analyze", file: rest[0]!, ...(options.name ? { name: options.name } : {}), ...(threshold !== undefined ? { threshold } : {}) };
}

/** Run a parsed `analyze` or `analyze diff`; human output unless `json`. */
export async function executeAnalyze(conn: DaemonConnection, inv: AnalyzeInvocation | AnalyzeDiffInvocation, cwd: string, json: boolean): Promise<string> {
  if (inv.kind === "analyze.diff") {
    const { kind: _kind, ...params } = inv;
    const result = await conn.request("analyze.diff", { cwd, ...params });
    return json ? `${JSON.stringify(result, null, 2)}\n` : formatDiff(result);
  }
  const { kind: _kind, ...params } = inv;
  const result = await conn.request("analyze", { cwd, ...params });
  return json ? `${JSON.stringify(result, null, 2)}\n` : formatAnalyze(result);
}

/** `[MEASURED]`, `[ESTIMATED]` or `[DECISION]` for the value at `path` of a result. */
function tag(result: { labels: AnalyzeResult["labels"] }, path: string): string {
  return `[${labelOf(result.labels, path) ?? "?"}]`;
}

function formatAnalyze(result: AnalyzeResult): string {
  const { stats, rhythm, curve, ink, sync } = result;
  const lines = [
    `Analysis ${result.name} of ${result.file}: ${result.duration} s, ${result.width}x${result.height} at ${result.fps} fps -> ${result.dir}`,
    `${tag(result, "stats")} Cutting: ${stats.shotCount} shots, ${stats.cutsPerMinute} cuts a minute; length average ${stats.averageLength} s, median ${stats.medianLength} s, shortest ${stats.shortest} s, longest ${stats.longest} s`,
    `${tag(result, "palette")} Palette: ${result.palette.map((color) => `${color.hex} ${Math.round(color.share * 100)}%`).join("  ") || "none"}`,
    `${tag(result, "look")} Look: brightness ${result.look.brightness}, contrast ${result.look.contrast}, saturation ${result.look.saturation}, warmth ${result.look.warmth}`,
    `${tag(result, "rhythm")} Rhythm: shot-length CV ${rhythm.shotLengthCv}, ${Math.round(rhythm.stillShare * 100)}% still frames (longest hold ${rhythm.longestStill} s), ${rhythm.changeCount} big changes (${rhythm.changesPerMinute} a minute, largest gap ${rhythm.largestGap} s), ${rhythm.bursts.length} bursts${rhythm.bursts.length > 0 ? ` at ${rhythm.bursts.map((burst) => `${burst.start} s (${burst.count})`).join(", ")}` : ""}`,
    `${tag(result, "cuts")} Cuts: ${cutCounts(result)}; ${result.cuts.jumpsPerMinute} jump cuts and punches a minute`,
    `${tag(result, "events")} Events: ${eventCounts(result)}`,
    `${tag(result, "curve")} Curve: mean change ${curve.mean}, peak ${curve.peak} at ${curve.peakAt} s, ${curve.moves.length} moves (${curve.values.length} values, one per ${curve.step} s)`,
    `${tag(result, "ink")} Ink: ${Math.round(ink.mean * 100)}% of the picture on average${ink.peakAt === null || ink.region === null ? ", none found" : `, up to ${Math.round(ink.peak * 100)}% at ${ink.peakAt} s (box ${[ink.region.x, ink.region.y, ink.region.width, ink.region.height].join(" ")})`}`,
    `${tag(result, "sync")} Sync: ${sync.offset === null ? `skipped, ${sync.reason}` : `mouth ${sync.offset >= 0 ? "after" : "before"} the voice by ${Math.abs(sync.offset)} s (${tag(result, "sync.offset")} confidence ${sync.confidence}, face ${sync.track})`}`,
  ];
  if (result.loudness) {
    const { integrated, range, truePeak } = result.loudness;
    lines.push(`${tag(result, "loudness")} Loudness: ${integrated === null ? "silent" : `${integrated} LUFS, range ${range} LU, true peak ${truePeak} dBTP`}`);
  }
  if (result.tempo) {
    const { bpm, meter, confidence, low } = result.tempo;
    lines.push(`${tag(result, "tempo")} Tempo: ${bpm} BPM in ${meter}, confidence ${confidence}${low ? " (low: do not trust it)" : ""}`);
  }
  for (const sheet of result.sheets) lines.push(`  ${sheet.path}  ${sheet.width}x${sheet.height}  ${sheet.kind}, ${sheet.tiles.length} tiles`);
  lines.push("Shots (start s, length s, palette, ink peak):");
  for (const shot of result.shots) lines.push(`  #${shot.index}  ${shot.start}  ${shot.length}  ${shot.palette.slice(0, 3).map((color) => color.hex).join(" ")}  ${shot.ink.peak > 0 ? `${Math.round(shot.ink.peak * 100)}%` : "-"}`);
  const unshot = result.cuts.list.filter((cut) => cut.kind !== "cut" && cut.kind !== "change");
  if (unshot.length > 0) lines.push("Jump cuts and punches (start s, kind, scale, similarity, scene cut found):");
  for (const cut of unshot.slice(0, 60)) lines.push(`  ${cut.time}  ${cut.kind}  ${cut.scale ?? "-"}  ${cut.similarity}  ${cut.opensShot ? "yes" : "no"}`);
  if (unshot.length > 60) lines.push(`  … ${unshot.length - 60} more (--json)`);
  const listed = result.events.filter((event) => event.kind !== "hold" && event.kind !== "hit");
  if (listed.length > 0) lines.push("Flashes and elements (start s, kind, region x y w h):");
  for (const event of listed) lines.push(`  ${event.start}  ${event.kind}${event.region ? `  ${[event.region.x, event.region.y, event.region.width, event.region.height].join(" ")}` : ""}`);
  if (curve.moves.length > 0) lines.push("Moves (start s, duration s, ease, fit):");
  for (const move of curve.moves.slice(0, 40)) lines.push(`  ${move.start}  ${move.duration}  ${move.ease ?? "-"}  ${move.fit ?? "-"}`);
  if (curve.moves.length > 40) lines.push(`  … ${curve.moves.length - 40} more (--json)`);
  lines.push(...result.warnings.map((warning) => `warning: ${warning}`));
  return `${lines.join("\n")}\n`;
}

function formatDiff(result: AnalyzeDiffResult): string {
  const { film, reference, alignment, energy, diff } = result;
  const lines = [
    `Comparison ${result.name}: ${film.file} (${film.duration} s, ${film.width}x${film.height}) against ${reference.file} (${reference.duration} s, ${reference.width}x${reference.height}) -> ${result.dir}`,
    `${tag(result, "alignment.lag")} Alignment: the reference is ${alignment.lag >= 0 ? "later" : "earlier"} by ${Math.abs(alignment.lag)} s (${alignment.source}${alignment.correlation === null ? "" : `, correlation ${alignment.correlation}`})`,
    `${tag(result, "energy")} Energy: film ${energy.film.mean} (p95 ${energy.film.p95}), reference ${energy.reference.mean} (p95 ${energy.reference.p95})${energy.ratio === null ? "" : `, ratio ${energy.ratio}`}`,
    `${tag(result, "diff")} SSIM every ${diff.every} s: mean ${diff.mean}, lowest ${diff.min} at ${diff.minAt} s, ${Math.round(diff.below * 100)}% of readings under 0.5`,
  ];
  for (const sheet of result.sheets) lines.push(`  ${sheet.path}  ${sheet.width}x${sheet.height}  ${sheet.kind}, ${sheet.tiles.length / 2} pairs`);
  lines.push("Windows (film s, film motion, reference motion):");
  for (const window of energy.windows.slice(0, 60)) lines.push(`  ${window.at}  ${window.film}  ${window.reference}`);
  if (energy.windows.length > 60) lines.push(`  … ${energy.windows.length - 60} more (--json)`);
  lines.push(...result.warnings.map((warning) => `warning: ${warning}`));
  return `${lines.join("\n")}\n`;
}

/** `5 cut, 3 jump, 2 punch-in`: how many big changes of each kind, in the order of {@link ANALYZE_CUT_KINDS}. */
function cutCounts(result: AnalyzeResult): string {
  const parts = ANALYZE_CUT_KINDS.filter((kind) => result.cuts.counts[kind] > 0).map((kind) => `${result.cuts.counts[kind]} ${kind}`);
  return parts.join(", ") || "none";
}

/** `3 flash, 2 appear, 4 hold`: how many events of each kind, in the order of {@link ANALYZE_EVENT_KINDS}. */
function eventCounts(result: AnalyzeResult): string {
  const parts = ANALYZE_EVENT_KINDS.map((kind) => [kind, result.events.filter((event) => event.kind === kind).length] as const).filter(([, count]) => count > 0);
  return parts.map(([kind, count]) => `${count} ${kind}`).join(", ") || "none";
}
