import { type DaemonConnection, REVIEW_OUTPUTS, type RequirementsChange, type ReviewMetrics, type ReviewOutput, type ReviewResult, type ReviewSound } from "@frameshell/protocol";
import { CRAFT_CHECKS, type CraftCheck, FormatIdSchema, PLATFORM_IDS, type PlatformId } from "@frameshell/schema";
import { styleValue } from "./style-commands.js";
import { UsageError } from "./timeline-commands.js";

/** Help text of `review` (#457), in `frameshell --help`. */
export const REVIEW_USAGE = `  review [--timeline id] [--file video] [--range a,b] [--sheets contact,safe,phone,motion,seam,beats,metrics] [--platform p] [--every s] [--format id] [--preset p] [--loop] [--crop-at x,y[,size] [--clip id]]
                               Look at the film before showing it: write contact sheets and strips into
                               .frameshell/review/<n>/ (last 10 kept; project files untouched) and print their paths.
                               contact = frames at clip starts and ends, cuts, markers, subtitle cues and the deepest
                               zoom plus one every --every s (default 0.5), labelled with their time; phone = one frame
                               per second at 360 px wide; motion = the two fastest moments as 12 consecutive frames;
                               beats (only when named) = one frame per beat of the tempo grid a quarter beat after the
                               hit, labelled bar N / beat N (needs tempo set, not a LOW-confidence grid, not --file);
                               seam = the last 6 and first 6 frames; safe = up to 36 frames with the UI zones of
                               --platform (instagram, tiktok, shorts, youtube) shaded red and captions that cross them
                               marked !subtitle (--platform alone adds it; vertical films use the style guide's platforms).
                               metrics = metrics.json and a summary: longest still stretch, largest gap between visual
                               events, near-blank frames, empty frame 0, subtitle cues too short to read, loudness of a
                               --file (LUFS, LRA, true peak, phone band), sounds against the picture events they belong
                               to (early over 45 ms, late over 75 ms, next to what random placement scores), the jump
                               from the last frame to the first, the sound review list (timeline: voice over the bed per
                               0.5 s window, effect files repeated, clips cut off loud, the music on the last frame;
                               --file: the end of the sound, its loudest moment, clicks), and craft warnings; written
                               without --sheets.
                               requirements.json (project root, set with review require / review waive; see its JSON
                               Schema): the film's expectations (length, longest still stretch, end card, loudness of a
                               --file, smallest captions, per clip appearsBy/before/keepsMoving/staysInFrame) are checked
                               into metrics, a craft check listed in "fail" is a failure, and a waiver (check, clip,
                               reason) moves its warnings to "waived" with the reason. Any failure makes review exit 1.
                               --loop: the film repeats, so a seam that holds a frame or jumps is a warning.
                               --crop-at x,y[,size]: crop every tile (not the safe sheet's) around a point, fractions
                               of the frame, size = crop width as a share of it (default 0.25); with --clip id the
                               point is in that clip's picture and the crop follows its keyed moves and scale.
                               --preset p (with --file): check the file against the export plan of --timeline (and
                               --format) with that preset: size, frame rate, length, codecs, loudness.
                               --file reviews an exported video (the file
                               people get) instead of the timeline; --range limits it to seconds a to b;
                               --format lays a timeline out as that format of the project (9x16)
  review require <path> <value> [--clip id]
                               Set one expectation of requirements.json; null removes it. Film: film.maxSeconds,
                               film.minSeconds, film.maxStatic, film.endCard '{"minSeconds":2}', film.loudness
                               '{"target":-14,"maxTruePeak":-1}', captions.minSize 0.026, fail '["static"]'. With --clip:
                               appearsBy 2 (or a marker, hook+0.5), before <clip>, keepsMoving '{"maxStatic":2}',
                               staysInFrame true or '{"margin":0.05}'. JSON, else text. Journaled (revert undoes it);
                               waits in the proposal in review mode
  review waive <check> <reason> [--clip id] | review waive <check> --remove [--clip id]
                               Accept the craft warnings of a check (static, reading, safe-zone...), on --clip only or
                               all of them, with the reason shown beside them; --remove takes the waiver back
`;

/** Flags `review` takes besides the global ones. */
export const REVIEW_FLAGS: Record<string, readonly string[]> = {
  review: ["timeline", "file", "range", "sheets", "platform", "every", "format", "preset", "loop", "crop-at", "clip"],
  "review require": ["clip"],
  "review waive": ["clip", "remove"],
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
  preset?: string;
  loop?: true;
  cropAt?: { x: number; y: number; size?: number; clip?: string };
}

/** A parsed `review require` or `review waive`. */
export type RequirementsInvocation =
  | { kind: "review.require"; path: string; clip?: string; value: unknown }
  | { kind: "review.waive"; check: CraftCheck; clip?: string; reason: string | null };

/** Flag values `review` reads. */
export interface ReviewOptions {
  timeline?: string | undefined;
  file?: string | undefined;
  range?: string | undefined;
  sheets?: string | undefined;
  platform?: string | undefined;
  every?: string | undefined;
  format?: string | undefined;
  preset?: string | undefined;
  loop?: boolean | undefined;
  "crop-at"?: string | undefined;
  clip?: string | undefined;
  remove?: boolean | undefined;
}

/** `--crop-at x,y[,size]` (with `--clip`): fractions 0 to 1, size above 0; throws `UsageError` for any other. */
export function parseCropAt(value: string | undefined, clip: string | undefined): ReviewInvocation["cropAt"] {
  if (value === undefined) {
    if (clip !== undefined) throw new UsageError("--clip on review names the clip --crop-at follows: pass --crop-at x,y too.");
    return undefined;
  }
  const parts = value.split(",").map((part) => (part.trim() === "" ? Number.NaN : Number(part)));
  const [x, y, size] = parts;
  const fraction = (n: number | undefined) => n !== undefined && Number.isFinite(n) && n >= 0 && n <= 1;
  if (parts.length < 2 || parts.length > 3 || !fraction(x) || !fraction(y) || (size !== undefined && (!fraction(size) || size === 0))) {
    throw new UsageError(`--crop-at takes x,y and an optional size, fractions of the frame from 0 to 1 (size above 0), e.g. --crop-at 0.5,0.8,0.25; got "${value}".`);
  }
  return { x: x!, y: y!, ...(size !== undefined ? { size } : {}), ...(clip !== undefined ? { clip } : {}) };
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
export function parseReview(rest: string[], options: ReviewOptions): ReviewInvocation | RequirementsInvocation | null {
  const [sub, ...args] = rest;
  const clip = options.clip ? { clip: options.clip } : {};
  if (sub === "require") {
    if (args.length > 2) throw new UsageError("review require takes one path and one value: quote a value with spaces, e.g. review require film.endCard '{\"minSeconds\": 2}'");
    return args.length === 2 ? { kind: "review.require", path: args[0]!, ...clip, value: styleValue(args[1]!) } : null;
  }
  if (sub === "waive") {
    const [check, reason, ...extra] = args;
    if (check === undefined) return null;
    if (!(CRAFT_CHECKS as readonly string[]).includes(check)) throw new UsageError(`review waive takes a craft check: ${CRAFT_CHECKS.join(", ")}; got "${check}".`);
    if (extra.length > 0) throw new UsageError('review waive takes one reason: quote it, e.g. review waive static "the hold is the joke"');
    if (options.remove === true) {
      if (reason !== undefined) throw new UsageError("review waive --remove takes the waiver back: give no reason.");
      return { kind: "review.waive", check: check as CraftCheck, ...clip, reason: null };
    }
    if (reason === undefined || reason.trim() === "") throw new UsageError('review waive needs the reason the warnings are accepted, e.g. review waive static "the hold is the joke"; --remove takes a waiver back.');
    return { kind: "review.waive", check: check as CraftCheck, ...clip, reason };
  }
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
  const cropAt = parseCropAt(options["crop-at"], options.clip);
  const every = options.every === undefined ? undefined : Number(options.every);
  if (every !== undefined && (!Number.isFinite(every) || every <= 0)) throw new UsageError(`--every takes seconds above 0, got "${options.every}".`);
  if (options.preset !== undefined && options.file === undefined) throw new UsageError("--preset checks an exported file against its export plan: pass --file too.");
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
    ...(options.preset ? { preset: options.preset } : {}),
    ...(options.loop ? { loop: true as const } : {}),
    ...(cropAt ? { cropAt } : {}),
  };
}

/** Run a parsed `review require` or `review waive`; human output unless `json`. */
export async function executeRequirements(conn: DaemonConnection, inv: RequirementsInvocation, cwd: string, json: boolean): Promise<string> {
  const clip = inv.clip ? { clip: inv.clip } : {};
  const result =
    inv.kind === "review.require"
      ? await conn.request("review.require", { cwd, path: inv.path, value: inv.value, ...clip })
      : await conn.request("review.waive", { cwd, check: inv.check, reason: inv.reason, ...clip });
  if (json) return `${JSON.stringify(result, null, 2)}\n`;
  const what = inv.kind === "review.require" ? `Required ${inv.clip ? `${inv.clip} ` : ""}${inv.path}` : `${inv.reason === null ? "Removed the waiver of" : "Waived"} ${inv.check}${inv.clip ? ` on ${inv.clip}` : ""}`;
  return requirementsChanged(what, result);
}

/** What changed in requirements.json, key by key, and the command that undoes it. */
function requirementsChanged(what: string, result: RequirementsChange): string {
  const shown = (value: unknown) => (value === null || value === undefined ? "none" : JSON.stringify(value));
  const lines = result.changes.map((change) => `  ${change.key}: ${shown(change.before)} -> ${shown(change.after)}`);
  const list = lines.length > 0 ? `\n${lines.join("\n")}` : " Nothing changed: the file already held it.";
  if (result.proposal) {
    return `${what} in proposal ${result.proposal} (${result.op}): review mode is on, so ${result.path} is unchanged until the person accepts it.${list}\n  next: frameshell proposal wait\n`;
  }
  return `${what} (${result.op}).${list}\n  undo: frameshell revert ${result.op}\n`;
}

/** Run a parsed `review`; human output unless `json`. */
export async function executeReview(conn: DaemonConnection, inv: ReviewInvocation, cwd: string, json: boolean, outcome: { code: number }): Promise<string> {
  const { kind: _kind, ...params } = inv;
  const result = await conn.request("review", { cwd, ...params });
  // What `requirements.json` states and the film misses fails the command; warnings alone never do.
  if (result.metrics?.requirements && result.metrics.requirements.failed > 0) outcome.code = 1;
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
      const what = flag.subject === "subtitle" ? `subtitle ${flag.track}` : `${flag.subject} of clip ${flag.clip} (track ${flag.track})`;
      lines.push(`  ${what} reaches into the ${flag.zone} zone by up to ${flag.reach} px: ${flag.cues} ${flag.subject === "subtitle" ? "cues" : "samples"} from ${flag.first} to ${flag.last} s`);
    }
  }
  if (result.metrics) lines.push(...formatMetrics(result.metrics));
  if (result.peaks.length > 0) lines.push(`Fastest moments: ${result.peaks.map((peak) => `${peak.at} s (${peak.energy})`).join(", ")}`);
  lines.push(...result.warnings.map((warning) => `warning: ${warning}`));
  return `${lines.join("\n")}\n`;
}

/** The lines `review` prints for the sound review list; its findings are printed with the craft warnings. */
function formatSound(sound: ReviewSound): string[] {
  const lines: string[] = [];
  if (sound.clips) {
    const { voice, music, sfx, other } = sound.clips;
    lines.push(`  sound (each clip from its asset): ${voice} voice, ${music} music, ${sfx} effect and ${other} other clips`);
  } else lines.push("  sound (the file's mix)");
  const { voice, ending, clicks } = sound;
  if (voice) {
    lines.push(
      `    voice over bed: ${voice.windows} windows of ${voice.window} s with the voice, ${voice.withBed} with a bed under it` +
        (voice.minMargin === null ? "" : `, margin ${voice.minMargin} dB at least, ${voice.medianMargin} dB median`),
    );
  }
  const repeated = (sound.repeats ?? []).map((repeat) => `${repeat.file} x${repeat.plays}`);
  if (repeated.length > 0) lines.push(`    effects heard more than once: ${repeated.join(", ")}`);
  if (ending?.measure === "music") {
    lines.push(
      ending.level === null
        ? `    ending: no music on the last frame${ending.musicEndsAt === null ? "" : ` (it ends at ${ending.musicEndsAt} s)`}`
        : `    ending: the music is ${Math.abs(ending.level)} dB under its loudest on the last frame`,
    );
  } else if (ending) {
    lines.push(`    ending: last 50 ms at ${ending.level ?? "silence"}${ending.level === null ? "" : " dBFS"}, loudest moment at ${ending.loudestAt ?? "-"} s (${ending.loudestShare === null ? "-" : `${Math.round(ending.loudestShare * 100)} %`})`);
  }
  if (clicks) lines.push(`    clicks: ${clicks.count}${clicks.count > 0 ? ` (${clicks.at.join(", ")} s)` : ""}`);
  return lines;
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
  const { sync, seam, delivery } = metrics;
  if (sync) {
    const rate = (share: number | null) => (share === null ? "-" : `${Math.round(share * 100)} %`);
    lines.push(
      `  sync (${sync.source === "takes" ? "generated sounds on the timeline" : "hits in the file's sound"}): ${sync.sounds} sounds scored${sync.excluded > 0 ? ` (${sync.excluded} whooshes, risers or ticks left out)` : ""}, ` +
        `${sync.hits} within 45 ms of a visual event; near an event (0.1 s) ${rate(sync.near)}, by chance ${rate(sync.chance)}` +
        `${sync.silentCuts.length > 0 ? `; cuts with no sound: ${sync.silentCuts.join(", ")} s` : ""}`,
    );
    for (const entry of sync.offsets.filter((candidate) => candidate.verdict !== "on")) {
      lines.push(`    ${entry.kind ?? "hit"} at ${entry.at} s: ${entry.verdict === "none" ? "no visual event within 0.12 s" : `${entry.verdict} by ${Math.round(Math.abs(entry.offset!) * 1000)} ms`}`);
    }
  }
  if (metrics.sound) lines.push(...formatSound(metrics.sound));
  if (seam) lines.push(`  loop seam: the last frame (${seam.last} s) differs from the first by ${seam.jump} of 255 (${seam.verdict})`);
  if (delivery) {
    lines.push(`  delivery against ${delivery.timeline} with ${delivery.preset} (${delivery.format}): ${delivery.checks.every((check) => check.ok) ? "as planned" : "differs"}`);
    for (const check of delivery.checks) lines.push(`    ${check.ok ? "ok " : "BAD"} ${check.field}: ${check.actual ?? "missing"} (plan ${check.expected})`);
  }
  lines.push(...metrics.craft.map((warning) => `  craft ${warning.check}${warning.severity === "fail" ? " FAIL" : ""}: ${warning.message}`));
  for (const warning of metrics.waived) lines.push(`  waived ${warning.check}${warning.clip ? ` (clip ${warning.clip})` : ""}: ${warning.message} Reason: ${warning.reason}`);
  const { requirements } = metrics;
  if (requirements) {
    lines.push(`  ${requirements.file}: ${requirements.failed === 0 ? "met" : `${requirements.failed} failed`}, ${requirements.checks.filter((check) => check.status === "pass").length} of ${requirements.checks.length} checks pass`);
    for (const check of requirements.checks) lines.push(`    ${check.status === "pass" ? "ok  " : check.status === "fail" ? "FAIL" : "skip"} ${check.id}${check.clip ? ` ${check.clip}` : ""}: ${check.message}`);
    for (const waiver of requirements.waivers.filter((candidate) => candidate.matched === 0)) lines.push(`    unused waiver of ${waiver.check}${waiver.clip ? ` on ${waiver.clip}` : ""}: ${waiver.reason}`);
  }
  return lines;
}
