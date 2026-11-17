import type { RenderBeatsProblem } from "@frameshell/plugin-api";
import { ErrorCode, type OperationName, RpcError, SECONDS_TEXT, TIME_REF_FIELDS } from "@frameshell/protocol";
import { type Timeline, describeMarkers, editDistance, findMarker, isSchemeRefLabel, numberLanguage, spokenTokens } from "@frameshell/schema";
import type { OperationRequest } from "./engine.js";
import type { TempoResult, TimelineGrid } from "./tempo.js";

/**
 * TimeRef (ADR 0029 decision 7, ADR 0037): a time on a timeline's clock written as seconds or as a name,
 * resolved by the daemon to seconds before an operation runs. One resolver for every time argument; no verb
 * parses names itself.
 *
 * Forms, tried in this order on a string:
 * 1. a number (`"12.5"`): seconds;
 * 2. the id or label (ignoring case) of a marker of the timeline: its time;
 * 3. such a name with an offset in seconds (`hook+0.5`, `outro-1`): the marker's time plus the offset. The whole
 *    string is tried as a name first, so a label like `end-card` is never read as `end` minus `card`;
 * 4. a scheme prefix: `beat:N` and `bar:N` (ADR 0029 slice 4) read the timeline's beat grid, counting from 1 in the
 *    music FILE (`beat:1` is its first measured beat, `bar:1` its first downbeat, whatever the clip trims; a pickup
 *    makes `bar:N` differ from `beat:(meter*(N-1)+1)`), carried on at the grid's period past the measured part, with the
 *    same optional `+s`/`-s` offset as a marker (`bar:8-0.2`); `N` may be fractional (`beat:2.5`, halfway between beats
 *    2 and 3). `word:<text>[#n][+s|-s]` (ADR 0029 slice 4 part 3) is the start of the nth time the timeline plays a
 *    spoken word (`word:this#2`, `word:over+0.2`), or a transcript word id (`word:w_000012`). New schemes join
 *    {@link SCHEMES}; nothing else changes.
 */

/** What a resolver may read: the timeline the operation applies to. */
export interface TimeRefScope {
  /** Timeline being edited, in the state the operation sees (the open transaction's earlier changes included). */
  timeline: Pick<Timeline, "id" | "markers" | "tempo">;
  /** The timeline's beat grid (`tempoGrid`), for `beat:` and `bar:`; absent until {@link GridNeeded} asked for it. */
  grid?: TempoResult;
  /** The words the timeline plays, for `word:`; absent until {@link WordsNeeded} asked for them. */
  words?: TimelineWords;
}

/** Loads the beat grid of the timeline being edited; a nominal grid on the timeline clock runs at least to timeline second `horizon`. */
export type GridLoader = (horizon: number) => Promise<TempoResult>;

/** A transcript word as the timeline plays it (cut words are not played), what `word:` reads. */
export interface TimelineWord {
  /** Transcript word id (`w_000012`), unique within its asset's transcript. */
  id: string;
  /** As the person corrected it, else as transcribed. */
  text: string;
  /** Project-relative asset of the clip that plays it. */
  asset: string;
  clip: string;
  /** Language code of its transcript; spells digits for matching (`20` meets `twenty`). Null when unknown. */
  language: string | null;
  /** Timeline seconds the word starts and ends. */
  at: number;
  end: number;
}

/** The words a timeline plays and the heard clips whose words cannot be read. */
export interface TimelineWords {
  /** By start on the timeline clock. */
  words: readonly TimelineWord[];
  /** Heard media clips whose asset has no transcript, or one of other content (stale). */
  unchecked: readonly { clip: string; asset: string; reason: "no-transcript" | "stale-transcript" }[];
}

/** Loads the words the timeline being edited plays, in the state the operation sees. */
export type WordLoader = () => Promise<TimelineWords>;

/** Turns what follows `scheme:` into timeline seconds, or throws {@link TimeRefError}. */
export type SchemeResolver = (rest: string, scope: TimeRefScope) => number;

/** Built schemes by name. */
const SCHEMES: Readonly<Record<string, SchemeResolver>> = {
  beat: (rest, scope) => gridPoint("beat", rest, scope),
  bar: (rest, scope) => gridPoint("bar", rest, scope),
  word: (rest, scope) => wordPoint(rest, scope),
};

/** Failure to turn a reference into seconds; the message names the reference and says what to use instead. */
export class TimeRefError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(hint ? `${message} ${hint}` : message);
    this.name = "TimeRefError";
  }
}

/**
 * Thrown by a scheme that reads the beat grid when {@link TimeRefScope.grid} is not loaded yet. {@link resolveTimeRefAsync}
 * loads the grid and tries again; a caller with no grid source sees it as the plain {@link TimeRefError} it is.
 */
export class GridNeeded extends TimeRefError {
  constructor(
    /** Timeline second the grid must reach (nominal grid on the timeline clock only; 0 otherwise). */
    readonly horizon: number,
  ) {
    super("This reference needs the timeline's beat grid, which this caller cannot read.");
    this.name = "GridNeeded";
  }
}

/**
 * Thrown by `word:` when {@link TimeRefScope.words} is not loaded yet. {@link resolveTimeRefAsync} loads the words and
 * tries again; a caller with no word source sees it as the plain {@link TimeRefError} it is.
 */
export class WordsNeeded extends TimeRefError {
  constructor() {
    super("This reference needs the words the timeline plays, which this caller cannot read.");
    this.name = "WordsNeeded";
  }
}

/** Seconds resolved to microseconds, so `4.1 + 0.5` is `4.6` and not `4.6000000000000005`. */
const tidy = (seconds: number) => Math.round(seconds * 1e6) / 1e6;

/**
 * Seconds `ref` names on `scope`'s timeline. A number passes through; a string is read as described at the top of
 * this file. Throws {@link TimeRefError} for an unknown name or a result before 0, {@link GridNeeded} for
 * `beat:`/`bar:` while `scope.grid` is absent and {@link WordsNeeded} for `word:` while `scope.words` is absent (use
 * {@link resolveTimeRefAsync}).
 */
export function resolveTimeRef(ref: number | string, scope: TimeRefScope): number {
  if (typeof ref === "number") return checked(ref, String(ref));
  const text = ref.trim();
  if (text === "") throw new TimeRefError("A time reference is empty.", "Give seconds, or a marker id or label.");
  if (SECONDS_TEXT.test(text)) return checked(Number(text), text);

  // A scheme wins over a marker an older project stored under such a label (new ones are refused on write).
  const schemed = isSchemeRefLabel(text);
  const marker = schemed ? undefined : findMarker(scope.timeline.markers, text);
  if (marker) return marker.at;

  const offset = schemed ? null : /^(.+?)\s*([+-])\s*(\d+(?:\.\d*)?|\.\d+)$/.exec(text);
  if (offset) {
    const base = findMarker(scope.timeline.markers, offset[1]!);
    if (base) return checked(base.at + (offset[2] === "-" ? -1 : 1) * Number(offset[3]), text);
  }

  const scheme = /^([a-z]+):(.*)$/i.exec(text);
  if (scheme) {
    const [, given, rest] = scheme as unknown as [string, string, string];
    const built = SCHEMES[given.toLowerCase()];
    if (built) return checked(built(rest, scope), text);
  }
  throw unknownName(text, scope);
}

/**
 * {@link resolveTimeRef} that can read the beat grid and the words the timeline plays: `loadGrid` is called only when
 * `ref` is a `beat:` or `bar:` reference, `loadWords` only for a `word:` one. With no loader, such a reference fails as
 * a {@link TimeRefError}.
 */
export async function resolveTimeRefAsync(ref: number | string, timeline: TimeRefScope["timeline"], loadGrid?: GridLoader, loadWords?: WordLoader): Promise<number> {
  const scope: TimeRefScope = { timeline };
  for (;;) {
    try {
      return resolveTimeRef(ref, scope);
    } catch (error) {
      if (error instanceof GridNeeded && loadGrid && !scope.grid) scope.grid = await loadGrid(error.horizon);
      else if (error instanceof WordsNeeded && loadWords && !scope.words) scope.words = await loadWords();
      else throw error;
    }
  }
}

/**
 * `request` with every time reference of its operation (the {@link TIME_REF_FIELDS} table) turned into seconds
 * against `timeline`; the same object when there is none to turn. `loadGrid` reads the timeline's beat grid for
 * `beat:` and `bar:` references, `loadWords` the words it plays for `word:`. The journal records the result, so a
 * replay or a revert never depends on a marker, the grid or a cut staying as it was. Throws `RpcError`
 * InvalidOperation naming the operation and the argument.
 */
export async function resolveTimeRefs(
  request: WireRequestLike,
  timeline: TimeRefScope["timeline"],
  loadGrid?: GridLoader,
  loadWords?: WordLoader,
): Promise<OperationRequest> {
  const fields: readonly string[] | undefined = (TIME_REF_FIELDS as Partial<Record<string, readonly string[]>>)[request.op];
  if (!fields) return request as OperationRequest;
  const args = request.args as Record<string, unknown>;
  let resolved: Record<string, unknown> | undefined;
  // One grid load serves every field of the request (`cut --from bar:2 --to bar:6`); a later field that reaches further loads again.
  let loaded: { horizon: number; result: TempoResult } | undefined;
  const shared: GridLoader | undefined = loadGrid
    ? async (horizon) => {
        if (!loaded || loaded.horizon < horizon) loaded = { horizon, result: await loadGrid(horizon) };
        return loaded.result;
      }
    : undefined;
  const sharedWords = onceWords(loadWords);
  for (const field of fields) {
    const value = args[field];
    if (typeof value !== "string") continue;
    try {
      (resolved ??= { ...args })[field] = await resolveTimeRefAsync(value, timeline, shared, sharedWords);
    } catch (error) {
      throw asInvalidOperation(request.op, field, value, error);
    }
  }
  return resolved ? ({ op: request.op, args: resolved } as OperationRequest) : (request as OperationRequest);
}

/** `load` called at most once, its result shared by every later call: one word read serves every field of a request or method. */
export function onceWords(load: WordLoader): WordLoader;
export function onceWords(load: WordLoader | undefined): WordLoader | undefined;
export function onceWords(load: WordLoader | undefined): WordLoader | undefined {
  if (!load) return undefined;
  let words: Promise<TimelineWords> | undefined;
  return () => (words ??= load());
}

/**
 * {@link resolveTimeRefAsync} for argument `field` of method or operation `op`: a failure is an `RpcError` InvalidOperation that
 * names both, with the reason `time reference`. For methods that take a time of their own (`music.fit` `end`).
 */
export async function resolveTimeRefArg(
  op: string,
  field: string,
  value: number | string,
  timeline: TimeRefScope["timeline"],
  loadGrid?: GridLoader,
  loadWords?: WordLoader,
): Promise<number> {
  try {
    return await resolveTimeRefAsync(value, timeline, loadGrid, loadWords);
  } catch (error) {
    throw asInvalidOperation(op, field, value, error);
  }
}

/** A {@link TimeRefError} as the `RpcError` InvalidOperation that names the operation and argument; anything else unchanged. */
function asInvalidOperation(op: string, field: string, value: number | string, error: unknown): unknown {
  if (!(error instanceof TimeRefError)) return error;
  return new RpcError(ErrorCode.InvalidOperation, `${op}: ${field}: ${error.message}`, {
    op,
    field,
    reason: "time reference",
    value,
    ...(error.hint ? { hint: error.hint } : {}),
  });
}

/** An operation request whose time arguments may still be names: what a caller sends before {@link resolveTimeRefs}. */
export type WireRequestLike = { op: OperationName | "timeline.patch"; args: unknown };

/** `N` or `N+s` / `N-s` after `beat:` or `bar:`. */
const GRID_REF = /^\s*(\d+(?:\.\d*)?|\.\d+)\s*(?:([+-])\s*(\d+(?:\.\d*)?|\.\d+))?\s*$/;

/**
 * Why a beat grid cannot be used, in the words `--snap-to` and `beat:`/`bar:` both refuse with: there is none (no
 * tempo, or its beats are missing) or it is LOW confidence. `code` is the stable reason a generated clip's render key
 * counts (ADR 0029 decision 8). Null when `found` holds a usable grid.
 */
export function unusableGrid(found: TempoResult): { code: RenderBeatsProblem; message: string; hint?: string } | null {
  if (!found.grid) {
    return found.problem !== null
      ? { code: found.reason, message: found.problem }
      : { code: "no-tempo", message: "the timeline has no tempo.", hint: "Set one with `tempo.set` { clip } (a measured music clip) or { bpm } (a nominal grid)." };
  }
  const { grid } = found;
  if (grid.low) {
    return {
      code: "low-confidence",
      message: `the grid of ${grid.asset} is LOW confidence (${grid.confidence}): it may be double time or a bar off.`,
      hint: "Check it with `beats.show`, then correct it with `edits.tempo` or `edits.downbeat` in its beats file, or measure again with a `bpm` hint.",
    };
  }
  return null;
}

/** Timeline second a nominal grid on the timeline clock must reach to hold beat or bar `position`; 0 for any other grid. */
function horizonFor(tempo: NonNullable<Timeline["tempo"]>, scheme: "beat" | "bar", position: number): number {
  if (tempo.bpm === undefined || tempo.clip !== undefined) return 0;
  const beats = Math.ceil(position) * (scheme === "bar" ? (tempo.meter ?? 4) : 1);
  return (tempo.offset ?? 0) + ((beats + 1) * 60) / tempo.bpm;
}

/** Time of `beat:N` / `bar:N`: entry N (from 1, counted in the song) of the grid's beats or bar starts, a fraction interpolated, plus the offset. */
function gridPoint(scheme: "beat" | "bar", rest: string, scope: TimeRefScope): number {
  const shown = `${scheme}:${rest}`;
  const parsed = GRID_REF.exec(rest);
  if (!parsed) {
    throw new TimeRefError(`"${shown}" is not a ${scheme} number.`, `Write ${scheme}:N counting from 1, optionally followed by +s or -s seconds (\`${scheme}:8\`, \`${scheme}:8.5\`, \`${scheme}:8-0.2\`).`);
  }
  const position = Number(parsed[1]);
  if (position < 1) throw new TimeRefError(`"${shown}" is before the first ${scheme}.`, `${scheme === "bar" ? "Bars" : "Beats"} count from 1: \`${scheme}:1\` is the first.`);
  const tempo = scope.timeline.tempo;
  if (!tempo) {
    const none = unusableGrid({ grid: null, problem: null })!;
    throw new TimeRefError(`"${shown}": ${none.message}`, none.hint);
  }
  if (!scope.grid) throw new GridNeeded(horizonFor(tempo, scheme, position));
  const refusal = unusableGrid(scope.grid);
  if (refusal) throw new TimeRefError(`"${shown}": ${refusal.message}`, refusal.hint);
  const grid = scope.grid.grid as TimelineGrid;
  const times = scheme === "bar" ? grid.bars : grid.beats;
  const base = scheme === "bar" ? grid.barBase : grid.beatBase;
  if (times.length === 0) {
    throw new TimeRefError(`"${shown}": the timeline's grid has no ${scheme === "bar" ? "bar starts" : "beats"} inside its music clip.`, "Extend the clip, or set a nominal tempo with `tempo.set` { bpm }.");
  }
  // Seconds between entries: the grid's own average (a measured grid drifts a little from its tempo); one entry falls back to the tempo.
  const period = times.length > 1 ? (times[times.length - 1]! - times[0]!) / (times.length - 1) : (60 / grid.bpm) * (scheme === "bar" ? grid.meter : 1);
  // Entry `index` (0-based, counted in the song): listed where the clip shows it, else carried on at the period before and past the listed part.
  const timeAt = (index: number) => {
    const slot = index - base;
    return slot < 0 ? times[0]! + slot * period : slot < times.length ? times[slot]! : times[times.length - 1]! + (slot - times.length + 1) * period;
  };
  const whole = Math.floor(position);
  const fraction = position - whole;
  const first = timeAt(whole - 1);
  const offset = parsed[2] === undefined ? 0 : (parsed[2] === "-" ? -1 : 1) * Number(parsed[3]);
  return first + (fraction > 0 ? fraction * (timeAt(whole) - first) : 0) + offset;
}

/** A trailing `+s` / `-s` offset in seconds after a word. */
const WORD_OFFSET = /^(.*?)\s*([+-])\s*(\d+(?:\.\d*)?|\.\d+)$/;
/** A trailing `#n` occurrence number after a word. */
const WORD_ORDINAL = /^(.*?)\s*#\s*(\d+)$/;
/** A transcript word id (`WordIdSchema`). */
const WORD_ID = /^w_\d{6,}$/i;
/** How to write a word reference, for refusals. */
const WORD_FORMS = "Write `word:<text>`, `#n` for the nth time it is said (from 1) and `+s`/`-s` seconds (`word:over`, `word:this#2`, `word:over+0.2`), or a transcript word id (`word:w_000012`).";

/** One time a word (or a run of words) is said on the timeline clock. */
interface Said {
  at: number;
  end: number;
}

/** Comparable form of spoken text: {@link spokenTokens} joined, so `twenty-three`, `twenty three` and `23` meet. */
function spokenKey(text: string, language: string | null): string {
  return spokenTokens(text, numberLanguage(language)).join("");
}

/** Spoken keys of `words`, computed once per loaded word list. */
const KEYS = new WeakMap<TimelineWords, string[]>();
function keysOf(words: TimelineWords): string[] {
  let keys = KEYS.get(words);
  if (!keys) KEYS.set(words, (keys = words.words.map((word) => spokenKey(word.text, word.language))));
  return keys;
}

/**
 * Time of `word:<text>[#n][+s|-s]`: the start of the nth time (from 1, on the timeline clock) the timeline plays the
 * word, plus the offset. Text matches when its spoken tokens equal a word's (case, accents and punctuation ignored,
 * digits spelled in the transcript's language), or a run of consecutive words' (`word:thank you`); the same words
 * heard at once on two tracks are said once. A transcript word id names that word, refused when two assets have it.
 */
function wordPoint(rest: string, scope: TimeRefScope): number {
  const shown = `word:${rest.trim()}`;
  if (rest.trim() === "") throw new TimeRefError(`"${shown}" names no word.`, WORD_FORMS);
  if (!scope.words) throw new WordsNeeded();
  const loaded = scope.words;
  const stale = loaded.unchecked.filter((clip) => clip.reason === "stale-transcript");
  if (stale.length > 0) {
    throw new TimeRefError(
      `"${shown}": the transcript of ${stale.map((clip) => `clip ${clip.clip} (${clip.asset})`).join(", ")} is older than its file, so its words and times may be wrong.`,
      `Transcribe it again: ${[...new Set(stale.map((clip) => `\`frameshell transcribe ${clip.asset}\``))].join(", ")}.`,
    );
  }
  if (loaded.words.length === 0) {
    throw new TimeRefError(`"${shown}": timeline ${scope.timeline.id} plays no transcribed words.`, untranscribedHint(loaded) ?? "Transcribe its clips' assets first: `frameshell transcribe <asset>`.");
  }
  // The whole text is tried first, so a word like `covid-19` is never read as `covid` minus 19 s.
  const readings: { text: string; offset: number }[] = [{ text: rest.trim(), offset: 0 }];
  const split = WORD_OFFSET.exec(rest.trim());
  if (split && split[1]!.trim() !== "") readings.push({ text: split[1]!.trim(), offset: (split[2] === "-" ? -1 : 1) * Number(split[3]) });
  for (const reading of readings) {
    const ordinal = WORD_ORDINAL.exec(reading.text);
    const text = (ordinal ? ordinal[1]! : reading.text).trim();
    if (text === "") continue;
    const said = WORD_ID.test(text) ? saidById(text.toLowerCase(), loaded, shown) : saidText(text, loaded);
    if (said.length === 0) continue;
    const nth = ordinal ? Number(ordinal[2]) : 1;
    if (nth < 1) throw new TimeRefError(`"${shown}": occurrences count from 1.`, `\`#1\` is the first time "${text}" is said.`);
    if (nth > said.length) {
      const times = said.slice(0, 8).map((one) => `${tidy(one.at)} s`);
      throw new TimeRefError(
        `"${shown}": "${text}" is said ${said.length} time${said.length === 1 ? "" : "s"} on timeline ${scope.timeline.id} (at ${times.join(", ")}${said.length > times.length ? ", …" : ""}).`,
        `Use #1 to #${said.length}.`,
      );
    }
    return said[nth - 1]!.at + reading.offset;
  }
  throw notSaid(shown, readings.at(-1)!.text.replace(WORD_ORDINAL, "$1").trim(), scope.timeline.id, loaded);
}

/** Times the words with transcript id `id` play; refused when two assets on the timeline have a word with that id. */
function saidById(id: string, loaded: TimelineWords, shown: string): Said[] {
  const words = loaded.words.filter((word) => word.id === id);
  const assets = [...new Set(words.map((word) => word.asset))];
  if (assets.length > 1) {
    throw new TimeRefError(`"${shown}": ${id} is a word id in the transcripts of ${assets.join(" and ")}.`, "Name the word by its text instead (`word:<text>#n`).");
  }
  return words.map(({ at, end }) => ({ at, end }));
}

/** Times `text` is said: runs of consecutive words whose spoken keys join to its key, overlapping repeats folded. */
function saidText(text: string, loaded: TimelineWords): Said[] {
  const keys = keysOf(loaded);
  const wanted = new Map<string | null, { key: string; reach: number }>();
  const want = (language: string | null) => {
    let found = wanted.get(language);
    if (!found) {
      const tokens = spokenTokens(text, numberLanguage(language));
      wanted.set(language, (found = { key: tokens.join(""), reach: tokens.length + 1 }));
    }
    return found;
  };
  const { words } = loaded;
  const found: Said[] = [];
  for (let i = 0; i < words.length; i++) {
    const { key, reach } = want(words[i]!.language);
    if (key === "" || keys[i] === "" || !key.startsWith(keys[i]!)) continue;
    let joined = "";
    for (let j = i; j < words.length && j < i + reach; j++) {
      joined += keys[j]!;
      if (joined === key) {
        found.push({ at: words[i]!.at, end: words[j]!.end });
        break;
      }
      if (!key.startsWith(joined)) break;
    }
  }
  // The same speech on two tracks (two mics, or a clip's sound twice) is said once: the earlier copy counts.
  const said: Said[] = [];
  for (const one of found.sort((a, b) => a.at - b.at)) {
    const last = said.at(-1);
    if (last && one.at < last.end - 1e-6) continue;
    said.push(one);
  }
  return said;
}

/** Refusal for a word the timeline does not play: the closest words it does, and the clips it could not read. */
function notSaid(shown: string, text: string, timeline: string, loaded: TimelineWords): TimeRefError {
  const keys = keysOf(loaded);
  const key = spokenKey(text, loaded.words[0]?.language ?? null);
  const seen = new Map<string, { text: string; count: number; distance: number }>();
  loaded.words.forEach((word, index) => {
    const own = keys[index]!;
    if (own === "") return;
    const entry = seen.get(own);
    if (entry) entry.count++;
    else seen.set(own, { text: word.text.trim(), count: 1, distance: editDistance(key, own) });
  });
  const reach = Math.max(2, Math.ceil(key.length / 3));
  const nearest = [...seen.values()]
    .filter((entry) => entry.distance <= reach)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 5)
    .map((entry) => `"${entry.text}"${entry.count > 1 ? ` (${entry.count}×)` : ""}`);
  const hints = [
    nearest.length > 0 ? `Closest words it plays: ${nearest.join(", ")}.` : null,
    untranscribedHint(loaded),
    WORD_ID.test(text) ? null : "Words removed by a cut are not played.",
  ].filter((hint) => hint !== null);
  return new TimeRefError(`"${shown}": "${text}" is not said on timeline ${timeline}.`, hints.join(" "));
}

/** Hint naming the heard clips with no transcript, whose words no `word:` reference can reach; null when there are none. */
function untranscribedHint(loaded: TimelineWords): string | null {
  const missing = loaded.unchecked.filter((clip) => clip.reason === "no-transcript");
  if (missing.length === 0) return null;
  const assets = [...new Set(missing.map((clip) => clip.asset))];
  return `Clips without a transcript are not searched: ${missing.map((clip) => `${clip.clip} (${clip.asset})`).join(", ")}; transcribe ${assets.length === 1 ? "it" : "them"} with ${assets.map((asset) => `\`frameshell transcribe ${asset}\``).join(", ")}.`;
}

function checked(seconds: number, shown: string): number {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new TimeRefError(`"${shown}" is ${seconds < 0 ? "before the start of the timeline" : "not a time"}.`, "Times are 0 or more seconds.");
  }
  return tidy(seconds);
}

function unknownName(text: string, scope: TimeRefScope): TimeRefError {
  const known = describeMarkers(scope.timeline.markers);
  return new TimeRefError(
    `"${text}" is neither seconds nor a marker of timeline ${scope.timeline.id}.`,
    `${known ? `Markers: ${known}.` : "It has no markers: use seconds, or add one with `marker.add`."} A spoken word is \`word:<text>\`.`,
  );
}
