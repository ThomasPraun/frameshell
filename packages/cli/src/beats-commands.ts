import type { DaemonConnection, MethodResult, Progress } from "@frameshell/protocol";
import { UsageError } from "./timeline-commands.js";

/** Help text of the `beats` commands (ADR 0029), in `frameshell --help`. */
export const BEATS_USAGE = `  beats measure <asset> [--bpm n] [--reset-edits]
                               Measure the beat grid of a music file, locally, and write beats/<asset>.beats.json:
                               tempo, every beat in source seconds, which beat starts a bar, a confidence. About 5 s
                               for a 3-minute track. --bpm: the tempo you expect (a 60 BPM song stays 60, not 120).
                               Hand corrections in the file's edits are kept unless --reset-edits. Prints LOW when the grid may
                               be double time or a bar off, with the other tempi to try
  beats show <asset>           The grid with the file's edits applied: bpm, confidence, beats and bar starts
`;

/** Flags each `beats` command takes besides the global ones. */
export const BEATS_FLAGS: Record<string, readonly string[]> = {
  "beats measure": ["bpm", "reset-edits"],
  "beats show": [],
};

/** A parsed `beats` command. */
export type BeatsInvocation = { kind: "beats.measure"; asset: string; bpm?: number; resetEdits: boolean } | { kind: "beats.show"; asset: string };

/** Parse `beats <sub> <asset>`; null when the shape is wrong. Throws `UsageError` for a bad flag value. */
export function parseBeats(rest: string[], options: { bpm?: string | undefined; "reset-edits"?: boolean | undefined }): BeatsInvocation | null {
  const [sub, ...args] = rest;
  if ((sub !== "measure" && sub !== "show") || args.length !== 1) return null;
  if (sub === "show") return { kind: "beats.show", asset: args[0]! };
  let bpm: number | undefined;
  if (options.bpm !== undefined) {
    bpm = Number(options.bpm);
    if (options.bpm.trim() === "" || !Number.isFinite(bpm) || bpm < 20 || bpm > 400) throw new UsageError("--bpm: expected a tempo from 20 to 400, e.g. --bpm 120.");
  }
  return { kind: "beats.measure", asset: args[0]!, ...(bpm !== undefined ? { bpm } : {}), resetEdits: options["reset-edits"] === true };
}

/** Run a parsed `beats` command; human output unless `json`. */
export async function executeBeats(
  conn: DaemonConnection,
  inv: BeatsInvocation,
  cwd: string,
  json: boolean,
  progress: ((update: Progress) => void) | undefined,
): Promise<string> {
  if (inv.kind === "beats.show") {
    const result = await conn.request("beats.show", { cwd, asset: inv.asset });
    return json ? `${JSON.stringify(result, null, 2)}\n` : formatShow(result);
  }
  const { kind: _kind, ...params } = inv;
  const result = await conn.request("beats.measure", { cwd, ...params }, progress ? { onProgress: progress } : {});
  return json ? `${JSON.stringify(result, null, 2)}\n` : formatMeasure(result);
}

type Summary = MethodResult<"beats.measure"> | MethodResult<"beats.show">;

function headline(result: Summary): string {
  const facts = [`${result.bpm} BPM`, `${result.beatCount} beats`, `confidence ${result.confidence.toFixed(2)}${result.low ? " LOW" : ""}`];
  if (result.residualMs !== null) facts.push(`within ${result.residualMs} ms of the hits`);
  return `${result.file}  ${facts.join(", ")}`;
}

function warnings(result: Summary): string[] {
  const lines: string[] = [];
  if (result.low) {
    const tries = result.alternatives.map((alternative) => `${alternative.tempo} time (${alternative.bpm} BPM)`).join(", ");
    lines.push(`LOW confidence: the grid may be double time or a bar off. Try ${tries || "another tempo"}: set edits.tempo in ${result.file}, or measure again with --bpm.`);
  }
  if (result.sampleRate !== null && result.sampleRate < 44_100) lines.push(`Measured from ${result.sampleRate} Hz audio (the asset was not ingested yet): less precise. Measure again once its ingest is done.`);
  return lines;
}

function formatMeasure(result: MethodResult<"beats.measure">): string {
  const lines = [headline(result), `  ${result.asset}: ${result.onsetCount} hits, bars of ${result.meter}, ${result.cached ? "onsets reused" : `measured in ${result.seconds} s`}${result.keptEdits ? ", your edits kept" : ""}`];
  return `${[...lines, ...warnings(result).map((line) => `  ${line}`)].join("\n")}\n`;
}

function formatShow(result: MethodResult<"beats.show">): string {
  const lines = [headline(result), `  ${result.asset}: ${result.detector}, bars of ${result.meter}${result.current ? "" : ", the asset changed since: measure again"}`];
  const edits = Object.entries(result.edits).map(([key, value]) => `${key} ${value}`);
  if (edits.length > 0) lines.push(`  edits: ${edits.join(", ")}`);
  const list = (times: number[]) => (times.length > 12 ? `${times.slice(0, 12).join(" ")} … (${times.length} in all)` : times.join(" "));
  lines.push(`  beats: ${list(result.beats)}`, `  bar starts: ${list(result.downbeats)}`);
  return `${[...lines, ...warnings(result).map((line) => `  ${line}`)].join("\n")}\n`;
}
