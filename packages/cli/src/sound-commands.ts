import { type DaemonConnection, SECONDS_TEXT, type SoundMusicResult, type SoundPlaceResult, type SoundSfxResult } from "@frameshell/protocol";
import {
  MUSIC_BPM_RANGE,
  MUSIC_CHORD_PATTERN,
  MUSIC_MAX_BARS,
  MUSIC_MAX_SECONDS,
  MUSIC_METER_RANGE,
  MUSIC_PRESETS,
  MUSIC_PRESET_DEFAULTS,
  MUSIC_SECTIONS,
  SFX_JITTER,
  SFX_KINDS,
  SFX_PITCH_RANGE,
  SFX_SEED_MAX,
  SFX_VARIANTS,
  SOUND_ROLES,
  SOUND_TIERS,
  SOUND_TYPING_RATE,
  type SfxKind,
} from "@frameshell/schema";
import { UsageError } from "./timeline-commands.js";

/** Help text of the `sound` commands (ADR 0038), in `frameshell --help`. */
export const SOUND_USAGE = `  sound sfx <kind> [--variant n] [--seed n] [--pitch x] [--length s]
                               Synthesize a sound effect offline into assets/sound/<kind>-<key>.wav and import it.
                               Kinds: ${SFX_KINDS.join(", ")}. The same arguments always give the same file; vary
                               --variant (1 to ${SFX_VARIANTS}) and --seed between uses. --pitch scales every frequency
                               (default: seeded ${SFX_JITTER.pitch.min} to ${SFX_JITTER.pitch.max}); --length is for whoosh and riser.
                               Prints peakAt: the second of the take that must land on the cue
  sound place <kind> (--at <t>[,<t>…] | --cuts <track> [--which 1,3] | --typing --from <t> --to <t> [--rate n])
               [--role r] [--tier t] [--offset ms] [--gain dB] [--variant n] [--seed n] [--pitch x] [--length s]
               [--track id] [--timeline id]
                               Make the sound effect (like sound sfx) and place it on the audio track SFX in one
                               transaction. Each <t> is seconds or a marker (hook, hook+0.5; commas separate the times, so a
                               label with a comma needs its marker id); --cuts puts one on every
                               edit point of a track (or the numbered ones); --typing a run of keys (tick or click, up
                               to ${SOUND_TYPING_RATE.max} a second). The take's peak lands on the time plus the offset of its role
                               (${SOUND_ROLES.join(", ")}; a riser ends before it); the gain comes from the style by
                               --tier (${SOUND_TIERS.join(", ")}). Warns about crowded frames, short gaps and repeated takes
  sound music <preset> [--bpm n] [--meter n] [--bars n | --length s] [--sections <parts>] [--chords Am,F,C,G]
               [--accents <t>,<t>] [--seed n] [--at <t>] [--track id] [--gain dB] [--timeline id] [--no-place]
                               Synthesize a music bed offline into assets/sound/music-<preset>-<key>.wav (-14 LUFS)
                               with its exact beat grid in beats/, and place it on the audio track Music at --at
                               (default 0) in one transaction; the timeline's tempo follows it when it has none.
                               Presets: ${MUSIC_PRESETS.map((preset) => `${preset} (${MUSIC_PRESET_DEFAULTS[preset].bpm} BPM)`).join(", ")}.
                               Length: --bars, or --length seconds, else to the end of the timeline. --sections
                               lists parts as kind[:bars][@time] (${MUSIC_SECTIONS.join(", ")}), e.g.
                               intro:2,full:6,build:2,drop@reveal,outro; the track ends on a final hit that rings.
                               --accents adds a crash and a big kick on the nearest beat. --no-place only writes it
`;

/** Flags each `sound` command takes besides the global ones. */
export const SOUND_FLAGS: Record<string, readonly string[]> = {
  "sound sfx": ["variant", "seed", "pitch", "length"],
  "sound place": ["timeline", "at", "from", "to", "track", "offset", "gain", "variant", "seed", "pitch", "length", "role", "tier", "cuts", "which", "typing", "rate"],
  "sound music": ["timeline", "bpm", "meter", "bars", "length", "sections", "chords", "accents", "seed", "at", "track", "gain", "no-place"],
};

/** A parsed `sound` command. */
export type SoundInvocation =
  | { kind: "sound.sfx"; sfx: SfxKind; variant?: number; seed?: number; pitch?: number; length?: number }
  | { kind: "sound.place"; params: Record<string, unknown> }
  | { kind: "sound.music"; params: Record<string, unknown> };

/** The options the `sound` commands read. */
export interface SoundOptions {
  variant?: string | undefined;
  seed?: string | undefined;
  pitch?: string | undefined;
  length?: string | undefined;
  timeline?: string | undefined;
  at?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  track?: string | string[] | undefined;
  offset?: string | undefined;
  gain?: string | undefined;
  role?: string | undefined;
  tier?: string | undefined;
  cuts?: string | undefined;
  which?: string | undefined;
  typing?: boolean | undefined;
  rate?: string | undefined;
  bpm?: string | undefined;
  meter?: string | undefined;
  bars?: string | undefined;
  sections?: string | undefined;
  chords?: string | undefined;
  accents?: string | undefined;
  "no-place"?: boolean | undefined;
}

/** Parse `sound sfx <kind> …`, `sound place <kind> …` or `sound music <preset> …`; null when the shape is wrong. Throws `UsageError` for a bad flag value. */
export function parseSound(rest: string[], options: SoundOptions): SoundInvocation | null {
  const [sub, ...args] = rest;
  if (sub === "music") return args.length === 1 ? parseMusic(args[0]!, options) : null;
  if ((sub !== "sfx" && sub !== "place") || args.length !== 1) return null;
  const sfx = args[0]!;
  if (!(SFX_KINDS as readonly string[]).includes(sfx)) throw new UsageError(`Unknown sound effect "${sfx}": expected ${SFX_KINDS.join(", ")}.`);
  if (sub === "place") return parsePlace(sfx as SfxKind, options);
  const variant = number(options.variant, "variant", `a whole number from 1 to ${SFX_VARIANTS}`, (n) => Number.isInteger(n) && n >= 1 && n <= SFX_VARIANTS);
  const seed = number(options.seed, "seed", `a whole number from 0 to ${SFX_SEED_MAX}`, (n) => Number.isInteger(n) && n >= 0 && n <= SFX_SEED_MAX);
  const pitch = number(options.pitch, "pitch", `a multiplier from ${SFX_PITCH_RANGE.min} to ${SFX_PITCH_RANGE.max}`, (n) => n >= SFX_PITCH_RANGE.min && n <= SFX_PITCH_RANGE.max);
  const length = number(options.length, "length", "a number of seconds above 0", (n) => n > 0);
  return {
    kind: "sound.sfx",
    sfx: sfx as SfxKind,
    ...(variant !== undefined ? { variant } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(pitch !== undefined ? { pitch } : {}),
    ...(length !== undefined ? { length } : {}),
  };
}

function parsePlace(kind: SfxKind, options: SoundOptions): SoundInvocation {
  const modes = [options.at !== undefined, options.cuts !== undefined, options.typing === true].filter(Boolean).length;
  if (modes !== 1) throw new UsageError("`sound place` needs one of --at <times>, --cuts <track> or --typing --from <t> --to <t>.");
  const variant = number(options.variant, "variant", `a whole number from 1 to ${SFX_VARIANTS}`, (n) => Number.isInteger(n) && n >= 1 && n <= SFX_VARIANTS);
  const seed = number(options.seed, "seed", `a whole number from 0 to ${SFX_SEED_MAX}`, (n) => Number.isInteger(n) && n >= 0 && n <= SFX_SEED_MAX);
  const pitch = number(options.pitch, "pitch", `a multiplier from ${SFX_PITCH_RANGE.min} to ${SFX_PITCH_RANGE.max}`, (n) => n >= SFX_PITCH_RANGE.min && n <= SFX_PITCH_RANGE.max);
  const length = number(options.length, "length", "a number of seconds above 0", (n) => n > 0);
  const offset = number(options.offset, "offset", "milliseconds from -1000 to 1000", (n) => n >= -1000 && n <= 1000);
  const gain = number(options.gain, "gain", "dB from -60 to 12", (n) => n >= -60 && n <= 12);
  if (options.role !== undefined && !(SOUND_ROLES as readonly string[]).includes(options.role)) throw new UsageError(`--role: expected ${SOUND_ROLES.join(", ")}, got "${options.role}".`);
  if (options.tier !== undefined && !(SOUND_TIERS as readonly string[]).includes(options.tier)) throw new UsageError(`--tier: expected ${SOUND_TIERS.join(", ")}, got "${options.tier}".`);
  const tracks = options.track === undefined ? [] : ([] as string[]).concat(options.track);
  if (tracks.length > 1) throw new UsageError("--track was given several times; `sound place` puts the sounds on one audio track.");
  if (options.typing !== true && (options.rate !== undefined || options.from !== undefined || options.to !== undefined)) throw new UsageError("--from, --to and --rate are for --typing.");
  if (options.cuts === undefined && options.which !== undefined) throw new UsageError("--which is for --cuts.");

  const common = {
    ...(options.role !== undefined ? { role: options.role } : {}),
    ...(options.tier !== undefined ? { tier: options.tier } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...(gain !== undefined ? { gain } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(pitch !== undefined ? { pitch } : {}),
  };
  const sound = { kind, ...(variant !== undefined ? { variant } : {}), ...(length !== undefined ? { length } : {}), ...common };
  let where: Record<string, unknown>;
  if (options.at !== undefined) {
    where = { cues: options.at.split(",").map((ref) => ({ at: when(ref, "at"), ...sound })) };
  } else if (options.cuts !== undefined) {
    where = { cuts: { track: options.cuts, ...(options.which !== undefined ? { which: wholeList(options.which, "which") } : {}), ...sound } };
  } else {
    if (options.from === undefined || options.to === undefined) throw new UsageError("--typing needs --from <t> and --to <t>.");
    if (kind !== "tick" && kind !== "click") throw new UsageError(`--typing makes keys: use the kind tick or click, not ${kind}.`);
    if (variant !== undefined || length !== undefined) throw new UsageError("--typing rotates the takes itself: leave out --variant and --length.");
    const rate = number(options.rate, "rate", `keys per second above 0 and up to ${SOUND_TYPING_RATE.max}`, (n) => n > 0 && n <= SOUND_TYPING_RATE.max);
    where = { typing: { from: when(options.from, "from"), to: when(options.to, "to"), kind, ...(rate !== undefined ? { rate } : {}), ...common } };
  }
  return {
    kind: "sound.place",
    params: { ...(options.timeline !== undefined ? { timeline: options.timeline } : {}), ...(tracks[0] !== undefined ? { track: tracks[0] } : {}), ...where },
  };
}

function parseMusic(preset: string, options: SoundOptions): SoundInvocation {
  if (!(MUSIC_PRESETS as readonly string[]).includes(preset)) throw new UsageError(`Unknown music preset "${preset}": expected ${MUSIC_PRESETS.join(", ")}.`);
  const bpm = number(options.bpm, "bpm", `a tempo from ${MUSIC_BPM_RANGE.min} to ${MUSIC_BPM_RANGE.max}`, (n) => n >= MUSIC_BPM_RANGE.min && n <= MUSIC_BPM_RANGE.max);
  const meter = number(options.meter, "meter", `beats per bar from ${MUSIC_METER_RANGE.min} to ${MUSIC_METER_RANGE.max}`, (n) => Number.isInteger(n) && n >= MUSIC_METER_RANGE.min && n <= MUSIC_METER_RANGE.max);
  const bars = number(options.bars, "bars", `a whole number from 1 to ${MUSIC_MAX_BARS}`, (n) => Number.isInteger(n) && n >= 1 && n <= MUSIC_MAX_BARS);
  const length = number(options.length, "length", `seconds above 0 and up to ${MUSIC_MAX_SECONDS}`, (n) => n > 0 && n <= MUSIC_MAX_SECONDS);
  if (bars !== undefined && length !== undefined) throw new UsageError("Give --bars or --length, not both.");
  const seed = number(options.seed, "seed", `a whole number from 0 to ${SFX_SEED_MAX}`, (n) => Number.isInteger(n) && n >= 0 && n <= SFX_SEED_MAX);
  const gain = number(options.gain, "gain", "dB from -60 to 12", (n) => n >= -60 && n <= 12);
  const tracks = options.track === undefined ? [] : ([] as string[]).concat(options.track);
  if (tracks.length > 1) throw new UsageError("--track was given several times; `sound music` puts its clip on one audio track.");
  const place = options["no-place"] !== true;
  if (!place && (tracks.length > 0 || gain !== undefined)) throw new UsageError("--track and --gain place the clip: leave them out with --no-place.");
  let chords: string[] | undefined;
  if (options.chords !== undefined) {
    chords = options.chords.split(",").map((chord) => chord.trim());
    const wrong = chords.find((chord) => !MUSIC_CHORD_PATTERN.test(chord));
    if (wrong !== undefined) throw new UsageError(`--chords: "${wrong}" is not a chord the sequencer plays; use a root and a quality like Am, F, Cmaj7, G7, Dm9, Bb, F#m7.`);
  }
  return {
    kind: "sound.music",
    params: {
      preset,
      ...(options.timeline !== undefined ? { timeline: options.timeline } : {}),
      ...(bpm !== undefined ? { bpm } : {}),
      ...(meter !== undefined ? { meter } : {}),
      ...(bars !== undefined ? { bars } : {}),
      ...(length !== undefined ? { length } : {}),
      ...(options.sections !== undefined ? { sections: parseSections(options.sections) } : {}),
      ...(chords !== undefined ? { chords } : {}),
      ...(options.accents !== undefined ? { accents: options.accents.split(",").map((ref) => when(ref, "accents")) } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(options.at !== undefined ? { at: when(options.at, "at") } : {}),
      ...(tracks[0] !== undefined ? { track: tracks[0] } : {}),
      ...(gain !== undefined ? { gain } : {}),
      ...(place ? {} : { place: false }),
    },
  };
}

/** `--sections`: parts separated by commas, each `kind`, `kind:bars`, `kind@time` or `kind:bars@time`. */
function parseSections(raw: string): { kind: string; bars?: number; at?: number | string }[] {
  return raw.split(",").map((part) => {
    const text = part.trim();
    const split = text.indexOf("@");
    const head = split < 0 ? text : text.slice(0, split);
    const [kind, count, extra] = head.split(":");
    if (extra !== undefined || !(MUSIC_SECTIONS as readonly string[]).includes(kind ?? "")) {
      throw new UsageError(`--sections: "${text}" is not a part; write kind[:bars][@time] with a kind of ${MUSIC_SECTIONS.join(", ")}, e.g. intro:2,full:6,drop@reveal,outro.`);
    }
    const bars = count === undefined ? undefined : Number(count);
    if (bars !== undefined && (count!.trim() === "" || !Number.isInteger(bars) || bars < 1)) throw new UsageError(`--sections: "${text}": bars must be a whole number from 1.`);
    return { kind: kind!, ...(bars !== undefined ? { bars } : {}), ...(split >= 0 ? { at: when(text.slice(split + 1), "sections") } : {}) };
  });
}

/** Whole numbers from 1 in a comma list (`1,3`). */
function wholeList(raw: string, flag: string): number[] {
  return raw.split(",").map((part) => {
    const value = Number(part.trim());
    if (part.trim() === "" || !Number.isInteger(value) || value < 1) throw new UsageError(`--${flag}: expected whole numbers from 1 like 1,3, got "${raw}".`);
    return value;
  });
}

/** A time flag: seconds as a number, else the text (a marker id or label, optionally `+s` or `-s`) for the daemon to resolve. */
function when(raw: string, flag: string): number | string {
  const text = raw.trim();
  if (text === "") throw new UsageError(`--${flag}: expected seconds or a marker id or label, got "${raw}".`);
  return SECONDS_TEXT.test(text) ? Number(text) : text;
}

function number(raw: string | undefined, flag: string, expected: string, valid: (n: number) => boolean): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value) || !valid(value)) throw new UsageError(`--${flag}: expected ${expected}, got "${raw}".`);
  return value;
}

/** Run a parsed `sound` command; human output unless `json`. */
export async function executeSound(conn: DaemonConnection, inv: SoundInvocation, cwd: string, json: boolean): Promise<string> {
  if (inv.kind === "sound.music") {
    const result = await conn.request("sound.music", { cwd, ...inv.params } as Parameters<typeof conn.request<"sound.music">>[1]);
    return json ? `${JSON.stringify(result, null, 2)}\n` : formatMusic(result);
  }
  if (inv.kind === "sound.place") {
    const result = await conn.request("sound.place", { cwd, ...inv.params } as Parameters<typeof conn.request<"sound.place">>[1]);
    return json ? `${JSON.stringify(result, null, 2)}\n` : formatPlace(result);
  }
  const { kind: _kind, sfx, ...params } = inv;
  const result = await conn.request("sound.sfx", { cwd, kind: sfx, ...params });
  return json ? `${JSON.stringify(result, null, 2)}\n` : formatSfx(result);
}

function formatSfx(result: SoundSfxResult): string {
  const lines = [
    `${result.file}  ${result.state}  ${result.kind} ${result.variant}, seed ${result.seed}, pitch ${result.pitch.toFixed(2)}`,
    `  ${result.duration.toFixed(2)} s, ${result.channels === 2 ? "stereo" : "mono"}, peak ${result.peakDb} dBFS, rms ${result.rmsDb} dBFS`,
    `  peakAt ${result.peakAt.toFixed(3)} s: put this instant of the take on the cue`,
  ];
  if (result.credited) lines.push("  recorded in credits.json (own work)");
  return `${lines.join("\n")}\n`;
}

function formatMusic(result: SoundMusicResult): string {
  const lines = [
    `${result.file}  ${result.state}  ${result.preset} ${result.bpm} BPM, ${result.meter} beats a bar, ${result.bars} bars, seed ${result.seed}`,
    `  ${result.duration.toFixed(2)} s, final hit at ${result.hitAt.toFixed(3)} s, ${result.lufs} LUFS, peak ${result.peakDb} dBFS`,
    `  parts: ${result.sections.map((section) => `${section.kind} ${section.bars} (${section.start.toFixed(2)} s)`).join(", ")}; chords ${result.chords.join(" ")}`,
    `  ${result.beats.file} ${result.beats.state}: exact grid, ${result.beats.count} beats`,
  ];
  if (result.credited) lines.push("  recorded in credits.json (own work)");
  if (result.clip !== null && result.track !== null) {
    lines.push(`${result.clip}  ${result.track.id}${result.track.created ? ` (new audio track ${result.track.name})` : ""}  start ${result.start!.toFixed(3)} s, gain ${result.gain} dB`);
    if (result.tempo === "set") lines.push("  the timeline's tempo now follows this clip (beat: and bar: times, --snap-to beat)");
  }
  for (const warning of result.warnings) lines.push(`  warning: ${warning}`);
  if (result.tx) lines.push(`  transaction ${result.tx}`);
  return `${lines.join("\n")}\n`;
}

function formatPlace(result: SoundPlaceResult): string {
  const lines = result.placed.map((sound) => {
    const how = sound.offset === 0 ? "on" : `${sound.offset > 0 ? "+" : ""}${sound.offset} ms from`;
    return `${sound.clip}  ${sound.track}  ${sound.kind}  start ${sound.start.toFixed(3)} s, peak ${how} ${sound.cue.toFixed(3)} s (at ${sound.anchorAt.toFixed(3)} s), gain ${sound.gain} dB  ${sound.file}`;
  });
  if (lines.length === 0) lines.push("Nothing placed.");
  for (const track of result.tracks.filter((entry) => entry.created)) lines.push(`  new audio track ${track.id} (${track.name})`);
  if (result.generated > 0) lines.push(`  ${result.generated} take${result.generated === 1 ? "" : "s"} written to assets/sound/`);
  for (const skip of result.skipped) lines.push(`  skipped ${skip.kind} at ${skip.cue.toFixed(3)} s: ${skip.reason}`);
  for (const warning of result.warnings) lines.push(`  warning: ${warning}`);
  if (result.tx) lines.push(`  transaction ${result.tx}`);
  return `${lines.join("\n")}\n`;
}
