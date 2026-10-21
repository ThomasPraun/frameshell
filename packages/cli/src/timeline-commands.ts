import type {
  DaemonConnection,
  HistoryResult,
  MulticamCreateResult,
  MulticamDirectResult,
  MulticamGalleryResult,
  MulticamTurnsResult,
  MethodName,
  MethodResult,
  OperationResult,
  TimelineProblem,
  TimelineView,
  TrackSummary,
} from "@frameshell/protocol";
import { resolveSubtitleStyle } from "@frameshell/schema";

/** Usage text of the timeline commands, appended to the CLI help. */
export const TIMELINE_USAGE = `Timeline (all accept --timeline <id>, default main; times in seconds, snapped to the frame grid;
mutations print the new revision):
  timeline show [--json]       Tracks and clips with ids, start/end, in/out (--json: compact dump)
  track list                   Tracks in stacking order (first video track = bottom layer)
  track add <video|audio|subtitles> [--name n] [--follows <track>] [--index n] [--preset p] [--position pos]
  track set <track> [--name n | --clear-name] [--index n] [--follows <track>] [--preset p] [--position pos]
  track remove <track> [--force]
  clip add <track> [asset] [--start s] [--in s] [--out s | --duration s] [--speed x]
           [--type media|timeline|<adapter>] [--source path] [--props json]
           [--gain dB] [--muted] [--x px] [--y px] [--scale k] [--opacity 0-1] [--script-ref ref]
           [--ripple [--ripple-track <track>…]] [--snap] [--snap-window s]
  clip move <clip> [--start s] [--track <track>]
  clip trim <clip> [--in s | --start s] [--out s | --end s] [--ripple [--ripple-track <track>…]]
           [--no-snap] [--snap-window s]
  clip split <clip> --at s
  clip remove <clip>
  clip set <clip> [--speed x] [--gain dB] [--muted | --unmuted] [--x px] [--y px] [--scale k]
           [--opacity 0-1] [--props json] [--script-ref ref | --clear-script-ref]
  multicam create <asset> <asset>… [--name <angle>…] [--mic-file <file>…] [--mic-name <n>…] [--sound <s>…]
                  [--group-name n]
                               One video file per camera or person: measures every file's offset against all the
                               others by audio cross-correlation, adds a group, a program track and one grid shot
                               over the cameras' length. Prints every file's confidence; below 0.5 the file is not
                               shifted and a warning says so. --name once per file, in order (default: file name).
                               Separate mic files: --mic-file once per mic (any start time; --mic-name names them).
                               --sound once per camera, in order: a mic number (1 = first --mic-file), none (wide
                               camera, no sound) or camera (its own file); default: camera n takes mic n. One mic
                               may serve several cameras
  multicam gallery <asset> [--name <tile>…] [--group-name n] [--at s]
                               One gallery-view call recording (Zoom, Meet, Teams): finds the tile grid by its
                               gutters on frames sampled over the whole file, adds one angle per tile (a crop of the
                               same file, rows top to bottom, each left to right), a program track and one grid shot.
                               The file's sound plays once, through one group mic all tiles share. Prints each tile's
                               crop and confidence and every layout change (someone joins, a screen share) with its
                               time; the tiles follow the layout held longest, or the one playing at --at. --name
                               once per tile, in that order (default Tile 1, Tile 2…). Fix a tile with multicam angle
                               --crop-*
  multicam offset <group> <angle> <seconds>
                               Fix one angle's sync by hand: the group second at which its file's time 0 plays
                               (absolute, >= 0; a smaller number plays the angle earlier)
  multicam angle <group> <angle> [--name n] [--crop-left f] [--crop-top f] [--crop-right f] [--crop-bottom f]
                 [--clear-crop] [--gain dB] [--muted | --unmuted] [--mic <mic id> | camera | none] [--screen | --no-screen]
                 [--speaker s1 | --clear-speaker]
                               Rename an angle, crop its picture (fractions cut off each side, 0 to below 1), set
                               its sound under every shot, pick where it is heard (a mic of the group, camera: its
                               own file, or none; with a mic, gain and mute belong to the mic) or mark it a screen
                               share (--screen: shown by screen and pip shots while it moves, never as a speaker), or
                               name the transcript speaker whose words are its turns (a file or mic people share;
                               transcribe --speakers on that sound's file first)
  multicam mic <group> <mic> [--name n] [--offset s] [--gain dB] [--muted | --unmuted]
                               Fix a separate mic: rename it, set the group second at which its file's time 0 plays
                               (absolute, >= 0) or its sound under every shot
  multicam reframe <group> <angle> (--time s | --at s) [--x f] [--y f] [--remove]
  multicam reframe <group> <angle> --clear
                               Keep a face in frame when a tile cuts the angle's picture (solo and two-up shots of a
                               9:16 export of 16:9 cameras): a key at timeline second --time (or group second --at)
                               centering the cut on --x/--y (fractions of the picture, 0 left/top, 1 right/bottom;
                               omitted: the point there now). The point moves in a straight line between keys and
                               holds outside them. --remove deletes the key in that frame, --clear every key
  multicam paint <group> [<angle>] --from s --to s (--speaking [--alone] | --silent | --measured)
                               Correct who speaks by hand, on the group clock: --speaking marks the angle as
                               speaking from --from to --to (--alone: everyone else that can speak is silent
                               there), --silent as not speaking, whatever its sound says; --measured takes the range
                               back to the measured turns (no <angle>: every angle). Painted turns replace the
                               measured ones for multicam turns and direct, and revert undoes them
  shot set <shot> [--layout solo|two-up|grid|screen|pip] [--angles a,b,…] [--corner top-left|top-right|bottom-left|bottom-right]
                               Change a shot's layout and the angles it shows, in layout order. Only --layout: the
                               angles are kept, cut or filled from the group; only --angles: the layout follows the
                               count when it does not fit (1 solo, 2 two-up, more grid). screen shows one angle whole,
                               with bars; pip takes the screen first, then the speaker as an inset in --corner (default
                               bottom-right)
  multicam turns <group>       Who speaks when: every angle's speaking turns on the group clock, from that angle's own
                               mic (a voice heard in another person's mic does not count; people talking at once
                               overlap), or from transcript speakers for angles sharing a file or naming a speaker.
                               Read-only; --json gives {turns: [{angle, name, start, end}], duration, warnings, speakers}
  direct <group> [--template interview|podcast-calm|panel-dynamic] [--rules file] [--from s] [--to s] [--replace-human]
                               Shots from who speaks, by rules (director.json at the project root on top of the
                               template, or --rules): written on the program track in one operation, each with a
                               confidence and reason. Same input, same shots. Keeps shots a person chose in the app
                               unless --replace-human. Lists the doubtful ones (--json: low)
  cut [track…] --from s --to s [--no-snap] [--snap-window s]
                               Remove a timeline range and close the gap on every (or the given) track
  cut and clip trim move edges on media with audio into the nearest pause (±0.5 s, or frameshell.json
  editing.snapWindow; --snap-window 0.5-10 overrides); the output lists requested vs applied times.
  --no-snap uses the exact times. clip add snaps media in/out only with --snap.
  --ripple (clip add, clip trim) moves later clips on every video, audio and program track by the length added or
  removed, the inverse of cut: restore removed material without overlapping the next clip.
  --ripple-track <track> (repeatable) limits that to the clip's own track plus the named ones.
  Subtitle tracks (--follows a video or audio track) show the transcript words of that track's clips: cuts
  update them, text corrections go in the transcript. --preset big-keyword (default: few large words, the
  spoken one highlighted) or plain; --position top, center or bottom. Preview and export look the same.
  Negative values need =, e.g. --gain=-6.

History (per terminal session; mutations print their op and tx ids). The session is FRAMESHELL_SESSION (set in
app terminals), else generated per shell (sh-<pid>-<hash>): calls from one shell share it. Harnesses that start a
new shell per command should export FRAMESHELL_SESSION to group across commands. History names the agent CLI
the app detects in its terminal (agent:<label>:<session>); FRAMESHELL_AGENT=<label> names it yourself, empty = none.
  tx begin "<label>"           Group the following operations until commit/abort (else grouped until ~10 s idle).
                               Survives daemon restarts
  tx commit | tx abort         Keep, or undo, the open transaction's changes. Abort undoes every timeline or,
                               on any conflict, none (listing every conflict)
  history [--since <tx>]       Operations grouped by transaction; --since: only what came after <tx>
  revert <tx|op>               Undo a transaction or one operation, as a new operation
`;

/** Timeline command words handled here. */
export const TIMELINE_COMMANDS = new Set(["timeline", "track", "clip", "multicam", "shot", "direct", "cut", "tx", "history", "revert"]);

/** Flags these commands read; declared once for `parseArgs`. */
export const TIMELINE_OPTIONS = {
  timeline: { type: "string" },
  name: { type: "string", multiple: true },
  "mic-file": { type: "string", multiple: true },
  "mic-name": { type: "string", multiple: true },
  sound: { type: "string", multiple: true },
  mic: { type: "string" },
  offset: { type: "string" },
  "group-name": { type: "string" },
  "clear-name": { type: "boolean" },
  follows: { type: "string" },
  preset: { type: "string" },
  position: { type: "string" },
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
  snap: { type: "boolean" },
  ripple: { type: "boolean" },
  "ripple-track": { type: "string", multiple: true },
  "snap-window": { type: "string" },
  "crop-left": { type: "string" },
  "crop-top": { type: "string" },
  "crop-right": { type: "string" },
  "crop-bottom": { type: "string" },
  "clear-crop": { type: "boolean" },
  speaker: { type: "string" },
  "clear-speaker": { type: "boolean" },
  layout: { type: "string" },
  angles: { type: "string" },
  corner: { type: "string" },
  screen: { type: "boolean" },
  "no-screen": { type: "boolean" },
  time: { type: "string" },
  remove: { type: "boolean" },
  clear: { type: "boolean" },
  speaking: { type: "boolean" },
  silent: { type: "boolean" },
  measured: { type: "boolean" },
  alone: { type: "boolean" },
  template: { type: "string" },
  rules: { type: "string" },
  "replace-human": { type: "boolean" },
} as const;

type Values = Record<string, string | boolean | string[] | undefined>;

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
  "track add": ["name", "follows", "index", "preset", "position"],
  "track set": ["name", "clear-name", "index", "follows", "preset", "position"],
  "track remove": ["force"],
  "clip add": ["type", "source", "start", "in", "out", "duration", "speed", "gain", "muted", "x", "y", "scale", "opacity", "props", "script-ref", "ripple", "ripple-track", "snap", "snap-window"],
  "clip move": ["start", "track"],
  "clip trim": ["in", "out", "start", "end", "ripple", "ripple-track", "no-snap", "snap-window"],
  "clip split": ["at"],
  "clip remove": [],
  "clip set": ["speed", "gain", "muted", "unmuted", "x", "y", "scale", "opacity", "props", "script-ref", "clear-script-ref"],
  "multicam create": ["name", "group-name", "mic-file", "mic-name", "sound"],
  "multicam gallery": ["name", "group-name", "at"],
  "multicam offset": [],
  "multicam angle": ["name", "crop-left", "crop-top", "crop-right", "crop-bottom", "clear-crop", "gain", "muted", "unmuted", "mic", "screen", "no-screen", "speaker", "clear-speaker"],
  "multicam mic": ["name", "offset", "gain", "muted", "unmuted"],
  "multicam reframe": ["time", "at", "x", "y", "remove", "clear"],
  "multicam paint": ["from", "to", "speaking", "silent", "measured", "alone"],
  "shot set": ["layout", "angles", "corner"],
  "multicam turns": [],
  "direct ": ["template", "rules", "from", "to", "replace-human"],
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
  "track set": [1, 1],
  "track remove": [1, 1],
  "clip add": [1, 2],
  "clip move": [1, 1],
  "clip trim": [1, 1],
  "clip split": [1, 1],
  "clip remove": [1, 1],
  "clip set": [1, 1],
  "multicam create": [2, Number.POSITIVE_INFINITY],
  "multicam gallery": [1, 1],
  "multicam offset": [3, 3],
  "multicam angle": [2, 2],
  "multicam mic": [2, 2],
  "multicam reframe": [2, 2],
  "multicam paint": [1, 2],
  "shot set": [1, 1],
  "multicam turns": [1, 1],
  "direct ": [1, 1],
  cut: [0, Number.POSITIVE_INFINITY],
  "tx begin": [1, 1],
  "tx commit": [0, 0],
  "tx abort": [0, 0],
  "history ": [0, 0],
  "revert ": [1, 1],
};

/**
 * Timeline commands (`clip add`, `cut`, `history`…) and the flags each
 * takes, `--timeline` included where it applies.
 */
export function timelineCommandFlags(): Map<string, string[]> {
  return new Map(
    Object.entries(ALLOWED).map(([command, flags]) => [command.trim(), command.startsWith("tx ") ? [...flags] : [...flags, "timeline"]]),
  );
}

/**
 * Parse `timeline|track|clip|cut …`. Returns null for an unknown
 * subcommand; throws {@link UsageError} for bad flags or values.
 */
export function parseTimelineCommand(positionals: string[], values: Values): TimelineInvocation | null {
  const [group, ...rest] = positionals;
  // `history`, `revert` and `direct` take no subcommand: key them as "<group> " so ALLOWED/ARITY stay one table.
  const flat = group === "cut" || group === "history" || group === "revert" || group === "direct";
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
  const list = (flag: string): string[] | undefined => {
    const raw = values[flag];
    return raw === undefined ? undefined : ([] as string[]).concat(raw as string | string[]);
  };
  const seconds = (raw: string, what: string): number => {
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(value)) throw new UsageError(`${what}: expected a number, got "${raw}".`);
    return value;
  };
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
  const style = () => {
    const s = { preset: str("preset"), position: str("position") };
    return s.preset !== undefined || s.position !== undefined ? s : undefined;
  };
  const snap = () => {
    if (values["no-snap"] === true && values["snap-window"] !== undefined) throw new UsageError("Pass --no-snap or --snap-window, not both.");
    return { snap: values["no-snap"] === true ? false : undefined, snapWindow: num("snap-window") };
  };
  /** `--ripple` and its `--ripple-track` scope, as `ripple` / `rippleTracks` params. */
  const ripple = () => {
    const tracks = values["ripple-track"] as string[] | undefined;
    if (tracks !== undefined && values["ripple"] !== true) throw new UsageError("--ripple-track needs --ripple.");
    return { ripple: values["ripple"] === true ? true : undefined, rippleTracks: tracks };
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
      Object.assign(params, { kind: args[0], name: str("name"), follows: str("follows"), index, style: style() });
      break;
    }
    case "track set": {
      method = "track.set";
      if (str("name") !== undefined && values["clear-name"] === true) throw new UsageError("Pass --name or --clear-name, not both.");
      const index = num("index");
      if (index !== undefined && (!Number.isInteger(index) || index < 0)) throw new UsageError("--index: expected an integer >= 0.");
      Object.assign(params, {
        track: args[0],
        name: values["clear-name"] === true ? null : str("name"),
        index,
        follows: str("follows"),
        style: style(),
      });
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
        ...ripple(),
        snap: values["snap"] === true ? true : undefined,
        snapWindow: num("snap-window"),
      });
      break;
    case "clip move":
      method = "clip.move";
      Object.assign(params, { clip: args[0], start: num("start"), track: str("track") });
      break;
    case "clip trim":
      method = "clip.trim";
      Object.assign(params, { clip: args[0], in: num("in"), out: num("out"), start: num("start"), end: num("end"), ...snap(), ...ripple() });
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
    case "multicam create": {
      method = "multicam.create";
      const names = list("name");
      if (names !== undefined && names.length !== args.length) {
        throw new UsageError(`--name: give one per file (${args.length}), in the same order as the files, got ${names.length}.`);
      }
      const micNames = list("mic-name");
      const micFiles = list("mic-file");
      if (micNames !== undefined && micNames.length !== (micFiles?.length ?? 0)) {
        throw new UsageError(`--mic-name: give one per --mic-file (${micFiles?.length ?? 0}), in the same order, got ${micNames.length}.`);
      }
      Object.assign(params, { assets: args, names, mics: micFiles, micNames, soundOf: list("sound"), name: str("group-name") });
      break;
    }
    case "multicam gallery":
      method = "multicam.gallery";
      Object.assign(params, { asset: args[0], names: list("name"), name: str("group-name"), at: num("at") });
      break;
    case "multicam offset":
      method = "multicam.offset";
      Object.assign(params, { group: args[0], angle: args[1], offset: seconds(args[2]!, "<seconds>") });
      break;
    case "multicam angle": {
      method = "multicam.angle";
      if (values["muted"] === true && values["unmuted"] === true) throw new UsageError("Pass --muted or --unmuted, not both.");
      const sides = { left: num("crop-left"), top: num("crop-top"), right: num("crop-right"), bottom: num("crop-bottom") };
      const cropped = Object.values(sides).some((value) => value !== undefined);
      if (cropped && values["clear-crop"] === true) throw new UsageError("Pass --crop-<side> or --clear-crop, not both.");
      if (str("speaker") !== undefined && values["clear-speaker"] === true) throw new UsageError("Pass --speaker or --clear-speaker, not both.");
      if (values["screen"] === true && values["no-screen"] === true) throw new UsageError("Pass --screen or --no-screen, not both.");
      Object.assign(params, {
        group: args[0],
        angle: args[1],
        name: str("name"),
        crop: values["clear-crop"] === true ? null : cropped ? sides : undefined,
        gain: num("gain"),
        muted: values["muted"] === true ? true : values["unmuted"] === true ? false : undefined,
        speaker: values["clear-speaker"] === true ? null : str("speaker"),
        mic: str("mic"),
        screen: values["screen"] === true ? true : values["no-screen"] === true ? false : undefined,
      });
      break;
    }
    case "multicam mic": {
      method = "multicam.mic";
      if (values["muted"] === true && values["unmuted"] === true) throw new UsageError("Pass --muted or --unmuted, not both.");
      const offset = str("offset");
      Object.assign(params, {
        group: args[0],
        mic: args[1],
        name: str("name"),
        offset: offset === undefined ? undefined : seconds(offset, "--offset"),
        gain: num("gain"),
        muted: values["muted"] === true ? true : values["unmuted"] === true ? false : undefined,
      });
      break;
    }
    case "multicam reframe": {
      method = "multicam.reframe";
      const at = str("at");
      const time = str("time");
      if (values["clear"] === true) {
        const other = ["time", "at", "x", "y", "remove"].find((flag) => values[flag] !== undefined);
        if (other) throw new UsageError(`--clear removes every key: pass it without --${other}.`);
      } else if ((at === undefined) === (time === undefined)) {
        throw new UsageError("Pass the key time: --time <timeline seconds> or --at <group seconds>, one of them (or --clear).");
      } else if (values["remove"] === true && (values["x"] !== undefined || values["y"] !== undefined)) {
        throw new UsageError("--remove deletes the key: pass it without --x or --y.");
      } else if (values["remove"] !== true && values["x"] === undefined && values["y"] === undefined) {
        throw new UsageError("Pass --x and/or --y (fractions of the picture, 0 to 1), --remove or --clear.");
      }
      Object.assign(params, {
        group: args[0],
        angle: args[1],
        at: at === undefined ? undefined : seconds(at, "--at"),
        time: time === undefined ? undefined : seconds(time, "--time"),
        x: num("x"),
        y: num("y"),
        remove: values["remove"] === true ? true : undefined,
        clear: values["clear"] === true ? true : undefined,
      });
      break;
    }
    case "multicam paint": {
      method = "multicam.paint";
      const kinds = ["speaking", "silent", "measured"].filter((flag) => values[flag] === true);
      if (kinds.length !== 1) throw new UsageError("Pass one of --speaking, --silent or --measured.");
      if (values["alone"] === true && values["speaking"] !== true) throw new UsageError("--alone goes with --speaking.");
      if (args.length === 1 && values["measured"] !== true) throw new UsageError("Name the angle: multicam paint <group> <angle> …");
      if (values["from"] === undefined || values["to"] === undefined) throw new UsageError("Pass --from <group seconds> and --to <group seconds>.");
      Object.assign(params, {
        group: args[0],
        angle: args[1],
        start: num("from"),
        end: num("to"),
        speaking: values["speaking"] === true ? true : values["silent"] === true ? false : null,
        alone: values["alone"] === true ? true : undefined,
      });
      break;
    }
    case "shot set": {
      method = "shot.set";
      const angles = str("angles")
        ?.split(",")
        .map((angle) => angle.trim())
        .filter((angle) => angle !== "");
      if (angles !== undefined && angles.length === 0) throw new UsageError("--angles: give angle ids separated by commas, e.g. --angles ana,ben.");
      Object.assign(params, { clip: args[0], shot: str("layout"), angles, corner: str("corner") });
      break;
    }
    case "multicam turns":
      method = "multicam.turns";
      params["group"] = args[0];
      break;
    case "direct ":
      method = "multicam.direct";
      Object.assign(params, {
        group: args[0],
        template: str("template"),
        rules: str("rules"),
        from: num("from"),
        to: num("to"),
        replaceHuman: values["replace-human"] === true ? true : undefined,
      });
      break;
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
  if (params["style"]) params["style"] = clean(params["style"] as Record<string, unknown>);
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
  if (inv.method === "multicam.create") return formatMulticamCreate(result as MulticamCreateResult);
  if (inv.method === "multicam.gallery") return formatMulticamGallery(result as MulticamGalleryResult);
  if (inv.method === "multicam.turns") return formatMulticamTurns(result as MulticamTurnsResult);
  if (inv.method === "multicam.direct") return formatMulticamDirect(result as MulticamDirectResult);
  return formatOperation(result as OperationResult);
}

function formatMulticamTurns(result: MulticamTurnsResult): string {
  const lines = [`Group ${result.group} · ${result.turns.length} turn${result.turns.length === 1 ? "" : "s"} over ${result.duration} s`];
  for (const turn of result.turns) lines.push(`  ${turn.start}–${turn.end} s  ${turn.angle}  ${turn.name}`);
  for (const { angle, speaker, transcript } of result.speakers) lines.push(`  ${angle}: turns from speaker ${speaker} of ${transcript}`);
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  return `${lines.join("\n")}\n`;
}

function formatMulticamDirect(result: MulticamDirectResult): string {
  const rules = result.rulesFile ? `${result.template} + ${result.rulesFile}` : result.template;
  const kept = result.kept.length > 0 ? ` · kept ${result.kept.length} shot${result.kept.length === 1 ? "" : "s"} a person chose` : "";
  const lines = [`Directed group ${result.group} on ${result.track} (${rules}): ${result.shots} shot${result.shots === 1 ? "" : "s"}${kept}`];
  if (result.low.length > 0) lines.push(`Low confidence (${result.low.length}), worth a look:`);
  for (const shot of result.low) {
    lines.push(`  ${shot.clip}  ${shot.start}–${shot.end} s  ${shot.shot} ${shot.angles.join(",")}  ${Math.round(shot.confidence * 100)}%  ${shot.reason}`);
  }
  return `${lines.join("\n")}\n${formatOperation(result)}`;
}

function formatMulticamCreate(result: MulticamCreateResult): string {
  const lines = [`Multicam group ${result.group} · program track ${result.track} · shot ${result.clip} (grid, whole length)`];
  for (const angle of result.sync) {
    const against = angle.against === null ? "" : ` with ${angle.against}`;
    const match = angle.confidence === null ? "reference" : `confidence ${Math.round(angle.confidence * 100)}%${angle.synced ? against : " (not synced)"}`;
    lines.push(`  ${angle.kind === "mic" ? "mic " : ""}${angle.angle}  ${angle.name}  ${angle.asset}  offset ${angle.offset} s  ${match}`);
  }
  return `${lines.join("\n")}\n${formatOperation(result)}`;
}

function formatMulticamGallery(result: MulticamGalleryResult): string {
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  const lines = [
    `Multicam group ${result.group} · program track ${result.track} · shot ${result.clip} (grid, whole length) · ` +
      `${result.tiles.length} tiles from ${result.samples} frames, confidence ${percent(result.confidence)}`,
  ];
  for (const tile of result.tiles) {
    const crop = (["left", "top", "right", "bottom"] as const).map((side) => `${side} ${tile.crop[side] ?? 0}`).join(" ");
    lines.push(`  ${tile.angle}  ${tile.name}  crop ${crop}  confidence ${percent(tile.confidence)}`);
  }
  if (result.layouts.length > 1) {
    lines.push("Layouts:");
    for (const layout of result.layouts) {
      lines.push(`  ${layout.start}–${layout.end} s  ${layout.tiles === 0 ? "no tile grid" : `${layout.tiles} tiles`}${layout.used ? "  (used)" : ""}`);
    }
  }
  if (result.mic) lines.push(`Sound: mic ${result.mic} (the recording's own track, once for every tile)`);
  return `${lines.join("\n")}\n${formatOperation(result)}`;
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
  const snaps = result.snaps.map(
    (snap) =>
      `snapped ${snap.field}${snap.clip ? ` of ${snap.clip}` : ""} ${snap.requested} -> ${snap.applied} ` +
      (snap.clean ? "(in a pause)" : `(no pause within ±${snap.window} s: quietest frame, speech may be clipped)`),
  );
  const warnings = result.warnings.map((warning) => `warning: ${warning}`);
  return [
    `${result.operation.op}: ${parts.join(" · ") || "no change"}`,
    ...snaps,
    `revision ${result.revision} · op ${result.operation.id} · tx ${result.operation.tx}`,
    ...warnings,
    "",
  ].join("\n");
}

function formatTracks(result: { timeline: string; revision: number; tracks: TrackSummary[]; problems: TimelineProblem[] }): string {
  if (result.tracks.length === 0) {
    return `Timeline ${result.timeline} (revision ${result.revision}) has no tracks. Add one: \`frameshell track add video\`.\n`;
  }
  const lines = [`Timeline ${result.timeline} · revision ${result.revision} · bottom to top:`];
  for (const track of result.tracks) {
    const name = track.name ? ` "${track.name}"` : "";
    const ends = track.end === null ? "end unknown" : `ends ${track.end} s`;
    const detail = track.kind === "subtitles" ? `follows ${track.follows}, ${styleText(track.style)}` : `${track.clips} clip(s), ${ends}`;
    lines.push(`  ${track.id}  ${track.kind}${name}  ${detail}`);
  }
  return `${[...lines, ...formatProblems(result.problems)].join("\n")}\n`;
}

/** A subtitle track's look as rendered, e.g. `big-keyword at the bottom`; an unknown preset is named. */
function styleText(stored: TrackSummary["style"]): string {
  const { style, unknownPreset } = resolveSubtitleStyle(stored ?? undefined);
  const preset = unknownPreset ? `${style.preset} (unknown preset "${unknownPreset}")` : style.preset;
  return `${preset} ${style.position === "center" ? "in the center" : `at the ${style.position}`}`;
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
