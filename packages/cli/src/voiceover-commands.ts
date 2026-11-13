import type { DaemonConnection, Progress, VoiceoverGenerateResult } from "@frameshell/protocol";
import { UsageError } from "./timeline-commands.js";

/** Help text of the `voiceover` commands (ADR 0034), in `frameshell --help`. */
export const VOICEOVER_USAGE = `  voiceover generate <script> [--lines id,id] [--provider p] [--voice v] [--yes] [--no-verify]
                               Say each line of a voiceover script (\`voiceover: true\`) into
                               assets/voiceover/<script>/<line>.wav and import the takes; unchanged lines are reused.
                               Reports each take's phrases (split at silences) and, through the project's transcription
                               plugin, the misreads (--no-verify skips that).
                               A paid provider needs --yes after the person confirmed the cost it reports
`;

/** Flags each `voiceover` command takes besides the global ones. */
export const VOICEOVER_FLAGS: Record<string, readonly string[]> = {
  "voiceover generate": ["lines", "provider", "voice", "yes", "no-verify"],
};

/** A parsed `voiceover` command. */
export type VoiceoverInvocation = {
  kind: "voiceover.generate";
  script: string;
  lines?: string[];
  provider?: string;
  voice?: string;
  yes: boolean;
  verify: boolean;
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
  },
): VoiceoverInvocation | null {
  const [sub, ...args] = rest;
  if (sub !== "generate" || args.length !== 1) return null;
  let lines: string[] | undefined;
  if (options.lines !== undefined) {
    lines = options.lines.split(",").map((id) => id.trim()).filter((id) => id !== "");
    if (lines.length === 0) throw new UsageError("--lines: expected line ids separated by commas, e.g. --lines hook-1,problem-2.");
  }
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

/** Run a parsed `voiceover` command; human output unless `json`. */
export async function executeVoiceover(
  conn: DaemonConnection,
  inv: VoiceoverInvocation,
  cwd: string,
  json: boolean,
  progress: ((update: Progress) => void) | undefined,
): Promise<string> {
  const { kind: _kind, ...params } = inv;
  const result = await conn.request("voiceover.generate", { cwd, ...params }, progress ? { onProgress: progress } : {});
  return json ? `${JSON.stringify(result, null, 2)}\n` : formatGenerate(result);
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
