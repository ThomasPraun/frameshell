import { type DaemonConnection, ErrorCode, type Progress, RpcError, SECONDS_TEXT, type VoiceoverCaptionsResult, type VoiceoverGenerateResult, type VoiceoverPlaceResult, timeRefOf } from "@frameshell/protocol";
import { VOICEOVER_LINE_GAP_S, VOICEOVER_TEMPO_RANGE } from "@frameshell/schema";
import { UsageError } from "./timeline-commands.js";

/** Help text of the `voiceover` commands (ADR 0034), in `frameshell --help`. */
export const VOICEOVER_USAGE = `  voiceover generate <script> [--lines id,id] [--provider p] [--voice v] [--yes [--confirmation token]] [--no-verify]
                               Say each line of a voiceover script (\`voiceover: true\`) into
                               assets/voiceover/<script>/<line>.wav and import the takes; unchanged lines are reused.
                               Reports each take's phrases (split at silences) and, through the project's transcription
                               plugin, the misreads (--no-verify skips that).
                               A paid provider needs --yes after the person confirmed the cost it reports; the refusal
                               prints a --confirmation token: pass it back so the run stays what the person saw (a script
                               or price that changed meanwhile fails with ConfirmationStale and generates nothing)
  voiceover place <script> [--lines id,id] [--at line=time,line.2=time,…] [--tempo line.2=1.1,…] [--start t] [--gap s]
                           [--track id] [--replace] [--dry-run] [--timeline id]
                               Put the takes of a voiceover script on the timeline as phrase clips (one per phrase of each
                               take, cut at its silences) on the audio track Voiceover, in one transaction. Run
                               \`voiceover generate\` first. --at anchors a line (hook-1) or one phrase of it (hook-1.2) at a
                               time on the timeline clock, in any form the timeline help's time paragraph lists (hook+0.5;
                               commas separate the entries, so a label with a comma needs its marker id). A line with no --at follows
                               the one before it by --gap seconds (default ${VOICEOVER_LINE_GAP_S}); the first starts at --start, else after the
                               track's last clip. --tempo sets the speed of single phrases (line.N, or a line id = its phrase 1 only:
                               ${VOICEOVER_TEMPO_RANGE.min} to ${VOICEOVER_TEMPO_RANGE.max}, 1 = as spoken, pitch kept): the clip plays at that speed and the effective length is
                               reported. Fails when voice would overlap, or when clips already play the takes
                               (--replace removes them first: use it after the takes changed)
  voiceover captions <script> [--lines id,id] [--track id] [--dry-run] [--timeline id]
                               Caption the placed takes in the display form (digits, names as written), timed by the words
                               the project's transcription hears in each take (spread over the phrases when it cannot run):
                               the words become each take's transcript and a subtitle track following the voice track gets
                               one phrase per phrase of the take, in one transaction. Run \`voiceover place\` first
`;

/** Flags each `voiceover` command takes besides the global ones. */
export const VOICEOVER_FLAGS: Record<string, readonly string[]> = {
  "voiceover generate": ["lines", "provider", "voice", "yes", "confirmation", "no-verify"],
  "voiceover place": ["lines", "at", "tempo", "start", "gap", "track", "replace", "dry-run", "timeline"],
  "voiceover captions": ["lines", "track", "dry-run", "timeline"],
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
      /** Token of the ask the person confirmed (`ConfirmationRequired` data); only with `yes`. */
      confirmation?: string;
      verify: boolean;
    }
  | {
      kind: "voiceover.place";
      script: string;
      timeline: string;
      lines?: string[];
      at?: Record<string, number | string>;
      tempo?: Record<string, number>;
      start?: number | string;
      gap?: number;
      track?: string;
      replace: boolean;
      dryRun: boolean;
    }
  | {
      kind: "voiceover.captions";
      script: string;
      timeline: string;
      lines?: string[];
      track?: string;
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
    confirmation?: string | undefined;
    "no-verify"?: boolean | undefined;
    timeline?: string | undefined;
    at?: string | undefined;
    tempo?: string | undefined;
    start?: string | undefined;
    gap?: string | string[] | undefined;
    track?: string | string[] | undefined;
    replace?: boolean | undefined;
    "dry-run"?: boolean | undefined;
  },
): VoiceoverInvocation | null {
  const [sub, ...args] = rest;
  if ((sub !== "generate" && sub !== "place" && sub !== "captions") || args.length !== 1) return null;
  let lines: string[] | undefined;
  if (options.lines !== undefined) {
    lines = options.lines.split(",").map((id) => id.trim()).filter((id) => id !== "");
    if (lines.length === 0) throw new UsageError("--lines: expected line ids separated by commas, e.g. --lines hook-1,problem-2.");
  }
  if (sub === "place") return parsePlace(args[0]!, lines, options);
  if (sub === "captions") {
    const track = single(options.track, "track", sub);
    return {
      kind: "voiceover.captions",
      script: args[0]!,
      timeline: options.timeline ?? "main",
      ...(lines ? { lines } : {}),
      ...(track !== undefined ? { track } : {}),
      dryRun: options["dry-run"] === true,
    };
  }
  const confirmation = options.confirmation?.trim();
  if (options.confirmation !== undefined && confirmation === "") throw new UsageError("--confirmation: expected the token the ConfirmationRequired refusal printed.");
  if (confirmation !== undefined && options.yes !== true) throw new UsageError("--confirmation goes with --yes: it binds the confirmation to the ask the person saw.");
  return {
    kind: "voiceover.generate",
    script: args[0]!,
    ...(lines ? { lines } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(typeof options.voice === "string" ? { voice: options.voice } : {}),
    yes: options.yes === true,
    ...(confirmation !== undefined ? { confirmation } : {}),
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
    found[key] = timeRefOf(ref);
  }
  return found;
}

/** `hook-1.2=1.1,hook-2=0.9` as `{ "hook-1.2": 1.1, "hook-2": 0.9 }`; which phrases exist is the daemon's to check. */
function tempos(raw: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const entry of raw.split(",")) {
    const cut = entry.indexOf("=");
    const key = cut < 0 ? "" : entry.slice(0, cut).trim();
    const text = cut < 0 ? "" : entry.slice(cut + 1).trim();
    const value = SECONDS_TEXT.test(text) ? Number(text) : Number.NaN;
    if (key === "" || !(value >= VOICEOVER_TEMPO_RANGE.min && value <= VOICEOVER_TEMPO_RANGE.max)) {
      throw new UsageError(`--tempo: expected line=speed entries separated by commas (hook-1.2=1.1), speed ${VOICEOVER_TEMPO_RANGE.min} to ${VOICEOVER_TEMPO_RANGE.max}, got "${entry.trim()}".`);
    }
    if (key in found) throw new UsageError(`--tempo: ${key} is given twice.`);
    found[key] = value;
  }
  return found;
}

/** The one value of a flag that may only be given once. */
function single(value: string | string[] | undefined, flag: string, sub: string): string | undefined {
  if (value === undefined) return undefined;
  const given = ([] as string[]).concat(value);
  if (given.length > 1) throw new UsageError(`--${flag} was given several times; \`voiceover ${sub}\` takes one.`);
  return given[0];
}

function parsePlace(script: string, lines: string[] | undefined, options: Parameters<typeof parseVoiceover>[1]): VoiceoverInvocation {
  const gapRaw = single(options.gap, "gap", "place");
  const gap = gapRaw === undefined ? undefined : Number(gapRaw);
  if (gap !== undefined && (gapRaw!.trim() === "" || !Number.isFinite(gap) || gap < 0 || gap > 30)) throw new UsageError(`--gap: expected seconds from 0 to 30, got "${gapRaw}".`);
  const start = options.start?.trim();
  if (options.start !== undefined && start === "") throw new UsageError(`--start: expected seconds, a marker id or label, or beat:N / bar:N, got "${options.start}".`);
  const track = single(options.track, "track", "place");
  return {
    kind: "voiceover.place",
    script,
    timeline: options.timeline ?? "main",
    ...(lines ? { lines } : {}),
    ...(options.at !== undefined ? { at: anchors(options.at) } : {}),
    ...(options.tempo !== undefined ? { tempo: tempos(options.tempo) } : {}),
    ...(start !== undefined ? { start: timeRefOf(start) } : {}),
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
  if (inv.kind === "voiceover.captions") {
    const { kind: _captions, ...params } = inv;
    const captioned = await conn.request("voiceover.captions", { cwd, ...params }, progress ? { onProgress: progress } : {});
    return json ? `${JSON.stringify(captioned, null, 2)}\n` : formatCaptions(captioned);
  }
  if (inv.kind === "voiceover.place") {
    const { kind: _place, ...params } = inv;
    const placed = await conn.request("voiceover.place", { cwd, ...params });
    return json ? `${JSON.stringify(placed, null, 2)}\n` : formatPlace(placed);
  }
  const { kind: _kind, ...params } = inv;
  const result = await conn.request("voiceover.generate", { cwd, ...params }, progress ? { onProgress: progress } : {}).catch((error: unknown) => {
    throw withConfirmationHint(error, inv);
  });
  return json ? `${JSON.stringify(result, null, 2)}\n` : formatGenerate(result);
}

/**
 * A `ConfirmationRequired` or `ConfirmationStale` refusal with the command that confirms it: the human output of an
 * error is its message only, so the `confirmation` token the person's `--yes` must carry is printed there (JSON keeps it in `data`).
 */
function withConfirmationHint(error: unknown, inv: Extract<VoiceoverInvocation, { kind: "voiceover.generate" }>): unknown {
  if (!(error instanceof RpcError) || (error.code !== ErrorCode.ConfirmationRequired && error.code !== ErrorCode.ConfirmationStale)) return error;
  const token = (error.data as { confirmation?: unknown } | undefined)?.confirmation;
  if (typeof token !== "string") return error;
  const command = confirmCommand(inv, token);
  if (command === null) return error;
  return new RpcError(error.code, `${error.message}\nOnce the person confirmed this cost: ${command}`, error.data);
}

/**
 * The command that confirms the ask of `inv`: the same script, lines, provider, voice and `--no-verify`, so the run it
 * confirms is the one the person saw priced, plus `--yes --confirmation <token>`. Null when a word holds a line break,
 * which no quoting carries alike across shells: the refusal then keeps its message without a command. Meant for sh and PowerShell, not cmd.exe.
 */
export function confirmCommand(
  inv: Extract<VoiceoverInvocation, { kind: "voiceover.generate" }>,
  token: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const parts = ["frameshell", "voiceover", "generate"];
  const flags: [string | null, string | undefined][] = [
    [null, inv.script],
    ["--lines", inv.lines?.join(",")],
    ["--provider", inv.provider],
    ["--voice", inv.voice],
  ];
  for (const [flag, text] of flags) {
    if (text === undefined) continue;
    const word = shellWord(text, platform);
    if (word === null) return null;
    parts.push(...(flag === null ? [word] : [flag, word]));
  }
  if (!inv.verify) parts.push("--no-verify");
  parts.push("--yes", "--confirmation", token);
  return parts.join(" ");
}

/**
 * `text` as one shell word: bare when plain, else in single quotes, where only the quote itself is special (`'\''` in
 * sh, `''` in PowerShell on win32, where a leading `@` is quoted too: bare it is a splat). Null for a line break, and on
 * win32 for a `"`, which PowerShell's legacy argument passing splits out of a quoted word.
 */
export function shellWord(text: string, platform: NodeJS.Platform = process.platform): string | null {
  const windows = platform === "win32";
  if (/^[\w./:@%+=,-]+$/.test(text) && !(windows && text.startsWith("@"))) return text;
  if (/[\r\n\0]/.test(text) || (windows && text.includes('"'))) return null;
  if (windows) return `'${text.replace(/['‘-‛]/g, (quote) => quote + quote)}'`;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function formatPlace(result: VoiceoverPlaceResult): string {
  const lines = result.lines.map((line) => `${line.id}  ${line.start.toFixed(3)} to ${line.end.toFixed(3)} s  ${line.anchor}`);
  for (const phrase of result.placed.filter((placed) => placed.speed !== 1)) {
    lines.push(`  ${phrase.line}.${phrase.phrase}  speed ${phrase.speed}: ${phrase.duration.toFixed(3)} s on the timeline`);
  }
  const phrases = result.placed.length;
  const verb = result.dryRun ? "Would place" : "Placed";
  const made = result.track.created ? (result.dryRun ? ", to be made" : ", new") : "";
  lines.unshift(`${verb} ${phrases} phrase${phrases === 1 ? "" : "s"} of ${result.lines.length} line${result.lines.length === 1 ? "" : "s"} of ${result.script} on ${result.track.id ?? "a new track"} (${result.track.name})${made}`);
  if (result.replaced.length > 0) lines.push(`  ${result.dryRun ? "would remove" : "removed"} ${result.replaced.join(", ")}`);
  for (const warning of result.warnings) lines.push(`  warning: ${warning}`);
  if (result.tx) lines.push(`  transaction ${result.tx}`);
  return `${lines.join("\n")}\n`;
}

function formatCaptions(result: VoiceoverCaptionsResult): string {
  const verb = result.dryRun ? "Would caption" : "Captioned";
  const made = result.track.created ? (result.dryRun ? ", to be made" : ", new") : "";
  const how = result.timing.status === "heard" ? `timed by ${result.timing.provider}` : "spread over the phrases";
  const lines = [`${verb} ${result.lines.length} line${result.lines.length === 1 ? "" : "s"} of ${result.script} on ${result.track.id ?? "a new track"} (${result.track.name}${made}), ${how}`];
  for (const line of result.lines) {
    const timing = line.timing === "heard" ? "" : `  ${line.timing}`;
    lines.push(`  ${line.id}${timing}  ${line.chunks.map((chunk) => `[${chunk}]`).join(" ")}`);
    if (line.missing.length > 0) lines.push(`      not heard: ${line.missing.join(", ")}`);
  }
  if (result.timing.reason) lines.push(`  ${result.timing.reason}`);
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
