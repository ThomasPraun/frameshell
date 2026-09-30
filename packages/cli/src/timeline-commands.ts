import type {
  DaemonConnection,
  HistoryResult,
  MethodName,
  MethodResult,
  OperationResult,
  TimelineProblem,
  TimelineView,
  TrackSummary,
} from "@frameshell/protocol";

/** Usage text of the timeline commands, appended to the CLI help. */
export const TIMELINE_USAGE = `Timeline (all accept --timeline <id>, default main; times in seconds, snapped to the frame grid;
mutations print the new revision):
  timeline show [--json]       Tracks and clips with ids, start/end, in/out (--json: compact dump)
  track list                   Tracks in stacking order (first video track = bottom layer)
  track add <video|audio|subtitles> [--name n] [--follows <track>] [--index n]
  track remove <track> [--force]
  clip add <track> [asset] [--start s] [--in s] [--out s | --duration s] [--speed x]
           [--type media|timeline|<adapter>] [--source path] [--props json]
           [--gain dB] [--muted] [--x px] [--y px] [--scale k] [--opacity 0-1] [--script-ref ref]
  clip move <clip> [--start s] [--track <track>]
  clip trim <clip> [--in s | --start s] [--out s | --end s] [--no-snap] [--snap-window s]
  clip split <clip> --at s
  clip remove <clip>
  clip set <clip> [--speed x] [--gain dB] [--muted | --unmuted] [--x px] [--y px] [--scale k]
           [--opacity 0-1] [--props json] [--script-ref ref | --clear-script-ref]
  cut [track…] --from s --to s [--no-snap] [--snap-window s]
                               Remove a timeline range and close the gap on every (or the given) track
  cut and clip trim move edges on media with audio into the nearest pause (±0.5 s, --snap-window up to 10);
  the output lists requested vs applied times. --no-snap uses the exact times.
  Negative values need =, e.g. --gain=-6.

History (per terminal session, FRAMESHELL_SESSION; mutations print their op and tx ids):
  tx begin "<label>"           Group the following operations until commit/abort (else grouped until ~10 s idle)
  tx commit | tx abort         Keep, or undo, the open transaction's changes
  history [--since <tx>]       Operations grouped by transaction; --since: only what came after <tx>
  revert <tx|op>               Undo a transaction or one operation, as a new operation
`;

/** Timeline command words handled here. */
export const TIMELINE_COMMANDS = new Set(["timeline", "track", "clip", "cut", "tx", "history", "revert"]);

/** Flags these commands read; declared once for `parseArgs`. */
export const TIMELINE_OPTIONS = {
  timeline: { type: "string" },
  name: { type: "string" },
  follows: { type: "string" },
  index: { type: "string" },
  force: { type: "boolean" },
  type: { type: "string" },
  source: { type: "string" },
  start: { type: "string" },
  end: { type: "string" },
  in: { type: "string" },
  out: { type: "string" },
  duration: { type: "string" },
  speed: { type: "string" },
  gain: { type: "string" },
  muted: { type: "boolean" },
  unmuted: { type: "boolean" },
  x: { type: "string" },
  y: { type: "string" },
  scale: { type: "string" },
  opacity: { type: "string" },
  props: { type: "string" },
  "script-ref": { type: "string" },
  "clear-script-ref": { type: "boolean" },
  track: { type: "string" },
  at: { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  since: { type: "string" },
  "no-snap": { type: "boolean" },
  "snap-window": { type: "string" },
} as const;

type Values = Record<string, string | boolean | undefined>;

/** Parsed timeline invocation: one daemon method and its params minus `cwd`. */
export interface TimelineInvocation {
  kind: "timeline";
  method: MethodName;
  params: Record<string, unknown>;
  /** False for `tx.*`: session-scoped, no project directory. */
  withCwd: boolean;
}

/** Bad arguments; the message says which and how to fix. Exit code 2. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** Flags allowed per command besides `--json`/`--timeline`. */
const ALLOWED: Record<string, string[]> = {
  "timeline show": [],
  "track list": [],
  "track add": ["name", "follows", "index"],
  "track remove": ["force"],
  "clip add": ["type", "source", "start", "in", "out", "duration", "speed", "gain", "muted", "x", "y", "scale", "opacity", "props", "script-ref"],
  "clip move": ["start", "track"],
  "clip trim": ["in", "out", "start", "end", "no-snap", "snap-window"],
  "clip split": ["at"],
  "clip remove": [],
  "clip set": ["speed", "gain", "muted", "unmuted", "x", "y", "scale", "opacity", "props", "script-ref", "clear-script-ref"],
  cut: ["from", "to", "no-snap", "snap-window"],
  "tx begin": [],
  "tx commit": [],
  "tx abort": [],
  "history ": ["since"],
  "revert ": [],
};

/** Positional count per command: [min, max]. */
const ARITY: Record<string, [number, number]> = {
  "timeline show": [0, 0],
  "track list": [0, 0],
  "track add": [1, 1],
  "track remove": [1, 1],
  "clip add": [1, 2],
  "clip move": [1, 1],
  "clip trim": [1, 1],
  "clip split": [1, 1],
  "clip remove": [1, 1],
  "clip set": [1, 1],
  cut: [0, Number.POSITIVE_INFINITY],
  "tx begin": [1, 1],
  "tx commit": [0, 0],
  "tx abort": [0, 0],
  "history ": [0, 0],
  "revert ": [1, 1],
};

/**
 * Parse `timeline|track|clip|cut …`. Returns null for an unknown
 * subcommand; throws {@link UsageError} for bad flags or values.
 */
export function parseTimelineCommand(positionals: string[], values: Values): TimelineInvocation | null {
  const [group, ...rest] = positionals;
  // `history` and `revert` take no subcommand: key them as "<group> " so ALLOWED/ARITY stay one table.
  const flat = group === "cut" || group === "history" || group === "revert";
  const command = group === "cut" ? "cut" : flat ? `${group} ` : `${group} ${rest[0] ?? ""}`;
  const args = flat ? rest : rest.slice(1);
  const allowed = ALLOWED[command];
  const arity = ARITY[command];
  if (!allowed || !arity) return null;
  if (args.length < arity[0] || args.length > arity[1]) {
    throw new UsageError(`\`frameshell ${command.trim()}\` takes ${arity[0] === arity[1] ? arity[0] : `${arity[0]}+`} argument(s), got ${args.length}.`);
  }
  const given = Object.keys(TIMELINE_OPTIONS).filter((flag) => values[flag] !== undefined && values[flag] !== false && flag !== "timeline");
  const extra = given.filter((flag) => !allowed.includes(flag));
  if (extra.length > 0) {
    throw new UsageError(`\`frameshell ${command.trim()}\` does not take ${extra.map((f) => `--${f}`).join(", ")}.`);
  }
  if (group === "tx") {
    if (values["timeline"] !== undefined) throw new UsageError("`frameshell tx` spans every timeline; it does not take --timeline.");
    const method = `tx.${rest[0]}` as "tx.begin" | "tx.commit" | "tx.abort";
    return { kind: "timeline", method, params: method === "tx.begin" ? { label: args[0] } : {}, withCwd: false };
  }
  const num = (flag: string): number | undefined => {
    const raw = values[flag];
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (typeof raw !== "string" || raw.trim() === "" || !Number.isFinite(value)) {
      throw new UsageError(`--${flag}: expected a number, got "${String(raw)}".`);
    }
    return value;
  };
  const str = (flag: string) => values[flag] as string | undefined;
  const json = (flag: string): Record<string, unknown> | undefined => {
    const raw = str(flag);
    if (raw === undefined) return undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Reported below.
    }
    throw new UsageError(`--${flag}: expected a JSON object, e.g. '{"title":"Hola"}'.`);
  };
  const transform = () => {
    const t = { x: num("x"), y: num("y"), scale: num("scale"), opacity: num("opacity") };
    return Object.values(t).some((v) => v !== undefined) ? t : undefined;
  };
  const snap = () => {
    if (values["no-snap"] === true && values["snap-window"] !== undefined) throw new UsageError("Pass --no-snap or --snap-window, not both.");
    return { snap: values["no-snap"] === true ? false : undefined, snapWindow: num("snap-window") };
  };
  const params: Record<string, unknown> = { timeline: str("timeline") };
  let method: MethodName;
  switch (command) {
    case "timeline show":
      method = "timeline.show";
      break;
    case "track list":
      method = "track.list";
      break;
    case "track add": {
      method = "track.add";
      const index = num("index");
      if (index !== undefined && (!Number.isInteger(index) || index < 0)) throw new UsageError("--index: expected an integer >= 0.");
      Object.assign(params, { kind: args[0], name: str("name"), follows: str("follows"), index });
      break;
    }
    case "track remove":
      method = "track.remove";
      Object.assign(params, { track: args[0], force: values["force"] === true });
      break;
    case "clip add":
      method = "clip.add";
      Object.assign(params, {
        track: args[0],
        asset: args[1],
        type: str("type"),
        source: str("source"),
        start: num("start"),
        in: num("in"),
        out: num("out"),
        duration: num("duration"),
        speed: num("speed"),
        gain: num("gain"),
        muted: values["muted"] === true ? true : undefined,
        transform: transform(),
        props: json("props"),
        scriptRef: str("script-ref"),
      });
      break;
    case "clip move":
      method = "clip.move";
      Object.assign(params, { clip: args[0], start: num("start"), track: str("track") });
      break;
    case "clip trim":
      method = "clip.trim";
      Object.assign(params, { clip: args[0], in: num("in"), out: num("out"), start: num("start"), end: num("end"), ...snap() });
      break;
    case "clip split":
      method = "clip.split";
      if (values["at"] === undefined) throw new UsageError("`frameshell clip split <clip>` needs --at <seconds>.");
      Object.assign(params, { clip: args[0], at: num("at") });
      break;
    case "clip remove":
      method = "clip.remove";
      params["clip"] = args[0];
      break;
    case "clip set": {
      method = "clip.set";
      if (values["muted"] === true && values["unmuted"] === true) throw new UsageError("Pass --muted or --unmuted, not both.");
      if (str("script-ref") !== undefined && values["clear-script-ref"] === true) {
        throw new UsageError("Pass --script-ref or --clear-script-ref, not both.");
      }
      Object.assign(params, {
        clip: args[0],
        speed: num("speed"),
        gain: num("gain"),
        muted: values["muted"] === true ? true : values["unmuted"] === true ? false : undefined,
        transform: transform(),
        props: json("props"),
        scriptRef: values["clear-script-ref"] === true ? null : str("script-ref"),
      });
      break;
    }
    case "history ":
      method = "history";
      params["since"] = str("since");
      break;
    case "revert ":
      method = "revert";
      params["target"] = args[0];
      break;
    default:
      method = "cut";
      if (values["from"] === undefined || values["to"] === undefined) throw new UsageError("`frameshell cut` needs --from <s> and --to <s>.");
      Object.assign(params, { from: num("from"), to: num("to"), tracks: args.length > 0 ? args : undefined, ...snap() });
  }
  const clean = (value: Record<string, unknown> | undefined) =>
    value && Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
  if (params["transform"]) params["transform"] = clean(params["transform"] as Record<string, unknown>);
  return { kind: "timeline", method, params: clean(params)!, withCwd: true };
}

/** Run a parsed timeline command; returns stdout text. */
export async function executeTimeline(conn: DaemonConnection, inv: TimelineInvocation, cwd: string, json: boolean): Promise<string> {
  const params = inv.withCwd ? { cwd, ...inv.params } : inv.params;
  // Params are validated by the daemon against the method registry.
  const result = (await conn.request(inv.method, params as never)) as unknown;
  if (inv.method === "timeline.show") {
    // Compact on purpose: agents read this, and indentation roughly doubles its tokens.
    return json ? `${JSON.stringify(result)}\n` : formatTimeline(result as TimelineView);
  }
  if (json) return `${JSON.stringify(result, null, 2)}\n`;
  if (inv.method === "track.list") return formatTracks(result as Parameters<typeof formatTracks>[0]);
  if (inv.method === "history") return formatHistory(result as HistoryResult);
  if (inv.method === "tx.begin") {
    const { tx, label } = result as MethodResult<"tx.begin">;
    return `Began ${tx} "${label}"\n`;
  }
  if (inv.method === "tx.commit") {
    const { tx, label, operations } = result as MethodResult<"tx.commit">;
    return `Committed ${tx} "${label}" (${operations} operation${operations === 1 ? "" : "s"})\n`;
  }
  if (inv.method === "tx.abort") {
    const { tx, label, reverted } = result as MethodResult<"tx.abort">;
    const lines = reverted.map((r) => `  ${r.timeline}: revision ${r.revision} · op ${r.operation.id}`);
    return `Aborted ${tx} "${label}"${reverted.length === 0 ? " (nothing to undo)" : ", changes undone:"}\n${lines.map((l) => `${l}\n`).join("")}`;
  }
  return formatOperation(result as OperationResult);
}

function formatHistory(result: HistoryResult): string {
  const since = result.since ? ` since ${result.since}` : "";
  if (result.transactions.length === 0) return `No operations on timeline ${result.timeline}${since}.\n`;
  const lines = [`Timeline ${result.timeline}${since} · revision ${result.revision}:`];
  for (const tx of result.transactions) {
    const label = tx.label ? ` "${tx.label}"` : "";
    const count = `${tx.operations.length} op${tx.operations.length === 1 ? "" : "s"}`;
    lines.push(`${tx.tx}  ${tx.author}${label}  ${count}  ${tx.at}`);
    for (const op of tx.operations) {
      const target = op.op === "revert" ? ` ${String(op.args["target"])}` : "";
      const touched = op.touched.length > 0 ? `  ${op.touched.join(", ")}` : "";
      lines.push(`  ${op.id}  ${op.op}${target}${touched}  (revision ${op.revision})`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatOperation(result: OperationResult): string {
  const { added, updated, removed, range } = result.changes;
  const parts = [
    ...(added.length > 0 ? [`added ${added.join(", ")}`] : []),
    ...(updated.length > 0 ? [`updated ${updated.join(", ")}`] : []),
    ...(removed.length > 0 ? [`removed ${removed.join(", ")}`] : []),
    ...(range ? [`${range.from}–${range.to ?? "?"} s`] : []),
  ];
  const window = (result.operation.args["snapWindow"] as number | undefined) ?? 0.5;
  const snaps = result.snaps.map(
    (snap) =>
      `snapped ${snap.field}${snap.clip ? ` of ${snap.clip}` : ""} ${snap.requested} -> ${snap.applied} ` +
      (snap.clean ? "(in a pause)" : `(no pause within ±${window} s: quietest frame, speech may be clipped)`),
  );
  return [`${result.operation.op}: ${parts.join(" · ") || "no change"}`, ...snaps, `revision ${result.revision} · op ${result.operation.id} · tx ${result.operation.tx}`, ""].join("\n");
}

function formatTracks(result: { timeline: string; revision: number; tracks: TrackSummary[]; problems: TimelineProblem[] }): string {
  if (result.tracks.length === 0) {
    return `Timeline ${result.timeline} (revision ${result.revision}) has no tracks. Add one: \`frameshell track add video\`.\n`;
  }
  const lines = [`Timeline ${result.timeline} · revision ${result.revision} · bottom to top:`];
  for (const track of result.tracks) {
    const name = track.name ? ` "${track.name}"` : "";
    const ends = track.end === null ? "end unknown" : `ends ${track.end} s`;
    const detail = track.kind === "subtitles" ? `follows ${track.follows}` : `${track.clips} clip(s), ${ends}`;
    lines.push(`  ${track.id}  ${track.kind}${name}  ${detail}`);
  }
  return `${[...lines, ...formatProblems(result.problems)].join("\n")}\n`;
}

/** Clips whose nested timeline is unavailable, with the fix; nothing when none. */
function formatProblems(problems: TimelineProblem[]): string[] {
  if (problems.length === 0) return [];
  return [`Problems (${problems.length}):`, ...problems.map((problem) => `  ${problem.message}`)];
}

function formatTimeline(view: TimelineView): string {
  const duration = view.duration === null ? "duration unknown" : `${view.duration} s`;
  const lines = [`Timeline ${view.timeline} · revision ${view.revision} · ${view.fps} fps · ${duration}`];
  if (view.tracks.length === 0) lines.push("  (no tracks: `frameshell track add video`)");
  for (const track of view.tracks) {
    const name = track.name ? ` "${track.name}"` : "";
    lines.push(`${track.id}  ${track.kind}${name}${track.follows ? `  follows ${track.follows}` : ""}`);
    for (const clip of track.clips) {
      const c = clip as Record<string, unknown> & { id: string; type: string; start: number; end: number | null };
      const what = typeof c["asset"] === "string" ? c["asset"] : typeof c["source"] === "string" ? c["source"] : "";
      const source =
        c["in"] !== undefined || c["out"] !== undefined
          ? `  in ${String(c["in"] ?? 0)}${c["out"] !== undefined ? ` out ${String(c["out"])}` : ""}`
          : "";
      const speed = c["speed"] !== undefined ? `  ×${String(c["speed"])}` : "";
      lines.push(`  ${c.id}  ${c.type} ${what}  ${c.start}–${c.end ?? "?"}${source}${speed}`);
    }
  }
  return `${[...lines, ...formatProblems(view.problems)].join("\n")}\n`;
}
