import { type DaemonConnection, type Progress, SECONDS_TEXT, type VoiceoverGenerateResult, type VoiceoverPlaceResult } from "@frameshell/protocol";
import { VOICEOVER_LINE_GAP_S } from "@frameshell/schema";
import { UsageError } from "./timeline-commands.js";

/** Help text of the `voiceover` commands (ADR 0034), in `frameshell --help`. */
export const VOICEOVER_USAGE = `  voiceover generate <script> [--lines id,id] [--provider p] [--voice v] [--yes] [--no-verify]
                               Say each line of a voiceover script (\`voiceover: true\`) into
                               assets/voiceover/<script>/<line>.wav and import the takes; unchanged lines are reused.
                               Reports each take's phrases (split at silences) and, through the project's transcription
                               plugin, the misreads (--no-verify skips that).
                               A paid provider needs --yes after the person confirmed the cost it reports
  voiceover place <script> [--lines id,id] [--at line=time,line.2=time,…] [--start t] [--gap s] [--track id]
                           [--replace] [--dry-run] [--timeline id]
                               Put the takes of a voiceover script on the timeline as phrase clips (one per phrase of each
                               take, cut at its silences) on the audio track Voiceover, in one transaction. Run
                               \`voiceover generate\` first. --at anchors a line (hook-1) or one phrase of it (hook-1.2) at a
                               time: seconds, a marker (hook, hook+0.5) or a beat or bar of the grid (beat:9, bar:3; commas
                               separate the entries, so a label with a comma needs its marker id). A line with no --at follows
                               the one before it by --gap seconds (default ${VOICEOVER_LINE_GAP_S}); the first starts at --start, else after the
                               track's last clip. Fails when voice would overlap, or when clips already play the takes
                               (--replace removes them first: use it after the takes changed)
`;

/** Flags each `voiceover` command takes besides the global ones. */
export const VOICEOVER_FLAGS: Record<string, readonly string[]> = {
  "voiceover generate": ["lines", "provider", "voice", "yes", "no-verify"],
  "voiceover place": ["lines", "at", "start", "gap", "track", "replace", "dry-run", "timeline"],
};

/** A parsed `voiceover` command. */
export type VoiceoverInvocation =
  | {
      kind: "voiceover.generate";
      script: string;
      lines?: string[];
      provider?: string;
      voice?: string;
      yes: boolean;
      verify: boolean;
    }
  | {
      kind: "voiceover.place";
      script: string;
      timeline: string;
      lines?: string[];
      at?: Record<string, number | string>;
      start?: number | string;
      gap?: number;
      track?: string;
      replace: boolean;
      dryRun: boolean;
    };

/** Parse `voiceover <sub> …`; null when the shape is wrong. Throws `UsageError` for a bad flag value. */
export function parseVoiceover(
  rest: string[],
  options: {
    lines?: string | undefined;
    provider?: string | undefined;
    voice?: string | boolean | undefined;
    yes?: boolean | undefined;
    "no-verify"?: boolean | undefined;
    timeline?: string | undefined;
    at?: string | undefined;
    start?: string | undefined;
    gap?: string | string[] | undefined;
    track?: string | string[] | undefined;
    replace?: boolean | undefined;
    "dry-run"?: boolean | undefined;
  },
): VoiceoverInvocation | null {
  const [sub, ...args] = rest;
  if ((sub !== "generate" && sub !== "place") || args.length !== 1) return null;
  let lines: string[] | undefined;
  if (options.lines !== undefined) {
    lines = options.lines.split(",").map((id) => id.trim()).filter((id) => id !== "");
    if (lines.length === 0) throw new UsageError("--lines: expected line ids separated by commas, e.g. --lines hook-1,problem-2.");
  }
  if (sub === "place") return parsePlace(args[0]!, lines, options);
  return {
    kind: "voiceover.generate",
    script: args[0]!,
    ...(lines ? { lines } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(typeof options.voice === "string" ? { voice: options.voice } : {}),
    yes: options.yes === true,
    verify: options["no-verify"] !== true,
  };
}

/** `hook-1=hook+0.5,hook-2.2=beat:9` as `{ "hook-1": "hook+0.5", "hook-2.2": "beat:9" }`; seconds become numbers, anything else is left to the daemon's TimeRef rules. */
function anchors(raw: string): Record<string, number | string> {
  const found: Record<string, number | string> = {};
  for (const entry of raw.split(",")) {
    const cut = entry.indexOf("=");
    const key = cut < 0 ? "" : entry.slice(0, cut).trim();
    const ref = cut < 0 ? "" : entry.slice(cut + 1).trim();
    if (key === "" || ref === "") throw new UsageError(`--at: expected line=time entries separated by commas (hook-1=hook+0.5,hook-2=beat:9), got "${entry.trim()}".`);
    if (key in found) throw new UsageError(`--at: ${key} is given twice.`);
    found[key] = SECONDS_TEXT.test(ref) ? Number(ref) : ref;
  }
  return found;
}

function parsePlace(script: string, lines: string[] | undefined, options: Parameters<typeof parseVoiceover>[1]): VoiceoverInvocation {
  const single = (value: string | string[] | undefined, flag: string): string | undefined => {
    if (value === undefined) return undefined;
    const given = ([] as string[]).concat(value);
    if (given.length > 1) throw new UsageError(`--${flag} was given several times; \`voiceover place\` takes one.`);
    return given[0];
  };
  const gapRaw = single(options.gap, "gap");
  const gap = gapRaw === undefined ? undefined : Number(gapRaw);
  if (gap !== undefined && (gapRaw!.trim() === "" || !Number.isFinite(gap) || gap < 0 || gap > 30)) throw new UsageError(`--gap: expected seconds from 0 to 30, got "${gapRaw}".`);
  const start = options.start?.trim();
  if (options.start !== undefined && start === "") throw new UsageError(`--start: expected seconds, a marker id or label, or beat:N / bar:N, got "${options.start}".`);
  const track = single(options.track, "track");
  return {
    kind: "voiceover.place",
    script,
    timeline: options.timeline ?? "main",
    ...(lines ? { lines } : {}),
    ...(options.at !== undefined ? { at: anchors(options.at) } : {}),
    ...(start !== undefined ? { start: SECONDS_TEXT.test(start) ? Number(start) : start } : {}),
    ...(gap !== undefined ? { gap } : {}),
    ...(track !== undefined ? { track } : {}),
    replace: options.replace === true,
    dryRun: options["dry-run"] === true,
  };
}

/** Run a parsed `voiceover` command; human output unless `json`. */
export async function executeVoiceover(
  conn: DaemonConnection,
  inv: VoiceoverInvocation,
  cwd: string,
  json: boolean,
  progress: ((update: Progress) => void) | undefined,
): Promise<string> {
  if (inv.kind === "voiceover.place") {
    const { kind: _place, ...params } = inv;
    const placed = await conn.request("voiceover.place", { cwd, ...params });
    return json ? `${JSON.stringify(placed, null, 2)}\n` : formatPlace(placed);
  }
  const { kind: _kind, ...params } = inv;
  const result = await conn.request("voiceover.generate", { cwd, ...params }, progress ? { onProgress: progress } : {});
  return json ? `${JSON.stringify(result, null, 2)}\n` : formatGenerate(result);
}

function formatPlace(result: VoiceoverPlaceResult): string {
  const lines = result.lines.map((line) => `${line.id}  ${line.start.toFixed(3)} to ${line.end.toFixed(3)} s  ${line.anchor}`);
  const phrases = result.placed.length;
  const verb = result.dryRun ? "Would place" : "Placed";
  const made = result.track.created ? (result.dryRun ? ", to be made" : ", new") : "";
  lines.unshift(`${verb} ${phrases} phrase${phrases === 1 ? "" : "s"} of ${result.lines.length} line${result.lines.length === 1 ? "" : "s"} of ${result.script} on ${result.track.id ?? "a new track"} (${result.track.name})${made}`);
  if (result.replaced.length > 0) lines.push(`  ${result.dryRun ? "would remove" : "removed"} ${result.replaced.join(", ")}`);
  for (const warning of result.warnings) lines.push(`  warning: ${warning}`);
  if (result.tx) lines.push(`  transaction ${result.tx}`);
  return `${lines.join("\n")}\n`;
}

function formatGenerate(result: VoiceoverGenerateResult): string {
  const counts = (["generated", "copied", "cached"] as const)
    .map((state) => [state, result.lines.filter((line) => line.state === state).length] as const)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${count} ${state}`);
  const cost = result.cost ? ` · about ${result.cost.amount} ${result.cost.currency}` : "";
  const lines = [`Voiceover ${result.script} -> ${result.dir}/ (${result.provider}, voice ${result.voice}): ${counts.join(", ")}${cost}`];
  for (const line of result.lines) {
    const phrases = line.phrases.length === 1 ? "" : `  ${line.phrases.length} phrases`;
    const check = line.check && line.check.status !== "clean" ? `  ${line.check.status}` : "";
    lines.push(`  ${line.id}  ${line.state}  ${line.duration.toFixed(2)} s${phrases}${check}  "${line.display}"`);
    for (const misread of line.check?.misreads ?? []) {
      const doubt = misread.maybeTranscription ? " (maybe the transcription)" : "";
      lines.push(`      ${misread.kind}: expected "${misread.expected}"${misread.heard ? `, heard "${misread.heard}"` : ""}${doubt}`);
    }
  }
  const { verification } = result;
  if (verification.status === "checked") lines.push(`Checked with ${verification.provider}: ${verification.misread} misread, ${verification.doubtful} doubtful.`);
  else if (verification.reason) lines.push(verification.reason);
  lines.push(...result.warnings.map((warning) => `warning: ${warning}`));
  return `${lines.join("\n")}\n`;
}
