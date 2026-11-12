import { ErrorCode, type OperationName, RpcError, SECONDS_TEXT, TIME_REF_FIELDS } from "@frameshell/protocol";
import { type Timeline, describeMarkers, findMarker } from "@frameshell/schema";
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
 * 4. a scheme prefix: `beat:N` and `bar:N` (ADR 0029 slice 4) read the timeline's beat grid, counting from 1
 *    (`beat:1` is the first beat of the grid, `bar:8` the start of the eighth bar), with the same optional `+s`/`-s`
 *    offset as a marker (`bar:8-0.2`); `N` may be fractional (`beat:2.5`, halfway between beats 2 and 3). `word:…` is
 *    reserved for its slice and refused with a pointer until then. New schemes join {@link SCHEMES}; nothing else
 *    changes.
 */

/** What a resolver may read: the timeline the operation applies to. */
export interface TimeRefScope {
  /** Timeline being edited, in the state the operation sees (the open transaction's earlier changes included). */
  timeline: Pick<Timeline, "id" | "markers" | "tempo">;
  /** The timeline's beat grid (`tempoGrid`), for `beat:` and `bar:`; absent until {@link GridNeeded} asked for it. */
  grid?: TempoResult;
}

/** Loads the beat grid of the timeline being edited; a nominal grid on the timeline clock runs at least to timeline second `horizon`. */
export type GridLoader = (horizon: number) => Promise<TempoResult>;

/** Turns what follows `scheme:` into timeline seconds, or throws {@link TimeRefError}. */
export type SchemeResolver = (rest: string, scope: TimeRefScope) => number;

/**
 * Schemes that are reserved but not built yet, with what they wait for. A resolver registered in
 * {@link SCHEMES} replaces the entry.
 */
const PLANNED_SCHEMES: Readonly<Record<string, string>> = {
  word: "word references (ADR 0029, after the beat grid)",
};

/** Built schemes by name; `word:` joins when word references exist. */
const SCHEMES: Readonly<Record<string, SchemeResolver>> = {
  beat: (rest, scope) => gridPoint("beat", rest, scope),
  bar: (rest, scope) => gridPoint("bar", rest, scope),
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

/** Seconds resolved to microseconds, so `4.1 + 0.5` is `4.6` and not `4.6000000000000005`. */
const tidy = (seconds: number) => Math.round(seconds * 1e6) / 1e6;

/**
 * Seconds `ref` names on `scope`'s timeline. A number passes through; a string is read as described at the top of
 * this file. Throws {@link TimeRefError} for an unknown name, a reserved scheme, or a result before 0, and
 * {@link GridNeeded} for `beat:`/`bar:` while `scope.grid` is absent (use {@link resolveTimeRefAsync}).
 */
export function resolveTimeRef(ref: number | string, scope: TimeRefScope): number {
  if (typeof ref === "number") return checked(ref, String(ref));
  const text = ref.trim();
  if (text === "") throw new TimeRefError("A time reference is empty.", "Give seconds, or a marker id or label.");
  if (SECONDS_TEXT.test(text)) return checked(Number(text), text);

  const marker = findMarker(scope.timeline.markers, text);
  if (marker) return marker.at;

  const offset = /^(.+?)\s*([+-])\s*(\d+(?:\.\d*)?|\.\d+)$/.exec(text);
  if (offset) {
    const base = findMarker(scope.timeline.markers, offset[1]!);
    if (base) return checked(base.at + (offset[2] === "-" ? -1 : 1) * Number(offset[3]), text);
  }

  const scheme = /^([a-z]+):(.*)$/i.exec(text);
  if (scheme) {
    const [, given, rest] = scheme as unknown as [string, string, string];
    const name = given.toLowerCase();
    const built = SCHEMES[name];
    if (built) return checked(built(rest, scope), text);
    const waiting = PLANNED_SCHEMES[name];
    if (waiting) throw new TimeRefError(`"${text}" needs ${waiting}, which does not exist yet.`, "Use seconds, a marker id or label, or `beat:N` / `bar:N` for now.");
  }
  throw unknownName(text, scope);
}

/**
 * {@link resolveTimeRef} that can read the beat grid: `loadGrid` is called only when `ref` is a `beat:` or `bar:`
 * reference. With no loader, such a reference fails as a {@link TimeRefError}.
 */
export async function resolveTimeRefAsync(ref: number | string, timeline: TimeRefScope["timeline"], loadGrid?: GridLoader): Promise<number> {
  try {
    return resolveTimeRef(ref, { timeline });
  } catch (error) {
    if (!(error instanceof GridNeeded) || !loadGrid) throw error;
    return resolveTimeRef(ref, { timeline, grid: await loadGrid(error.horizon) });
  }
}

/**
 * `request` with every time reference of its operation (the {@link TIME_REF_FIELDS} table) turned into seconds
 * against `timeline`; the same object when there is none to turn. `loadGrid` reads the timeline's beat grid for
 * `beat:` and `bar:` references. The journal records the result, so a replay or a revert never depends on a marker
 * staying where it was or on the grid staying as it was. Throws `RpcError` InvalidOperation naming the operation and
 * the argument.
 */
export async function resolveTimeRefs(request: WireRequestLike, timeline: TimeRefScope["timeline"], loadGrid?: GridLoader): Promise<OperationRequest> {
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
  for (const field of fields) {
    const value = args[field];
    if (typeof value !== "string") continue;
    try {
      (resolved ??= { ...args })[field] = await resolveTimeRefAsync(value, timeline, shared);
    } catch (error) {
      throw asInvalidOperation(request.op, field, value, error);
    }
  }
  return resolved ? ({ op: request.op, args: resolved } as OperationRequest) : (request as OperationRequest);
}

/**
 * {@link resolveTimeRef} for argument `field` of method or operation `op`: a failure is an `RpcError` InvalidOperation that
 * names both, with the reason `time reference`. For methods that take a time of their own (`music.fit` `end`).
 */
export function resolveTimeRefArg(op: string, field: string, value: number | string, timeline: Pick<Timeline, "id" | "markers">): number {
  try {
    return resolveTimeRef(value, { timeline });
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
 * tempo, or its beats are missing) or it is LOW confidence. Null when `found` holds a usable grid.
 */
export function unusableGrid(found: TempoResult): { message: string; hint?: string } | null {
  const { grid, problem } = found;
  if (!grid) {
    return problem
      ? { message: problem }
      : { message: "the timeline has no tempo.", hint: "Set one with `tempo.set` { clip } (a measured music clip) or { bpm } (a nominal grid)." };
  }
  if (grid.low) {
    return {
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

/** Time of `beat:N` / `bar:N`: entry N (from 1) of the grid's beats or bar starts, a fraction interpolated, plus the offset. */
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
  const whole = Math.floor(position);
  const fraction = position - whole;
  const first = times[whole - 1];
  const next = times[whole];
  if (first === undefined || (fraction > 0 && next === undefined)) {
    const what = scheme === "bar" ? "bar starts" : "beats";
    throw new TimeRefError(
      `"${shown}" is past the end of the grid, which has ${times.length} ${what}${times.length ? ` (the last at ${times[times.length - 1]} s)` : ""}.`,
      grid.source === "beats" ? "A measured grid covers its music clip only: use a smaller number, or make the clip longer." : "Use a smaller number.",
    );
  }
  const offset = parsed[2] === undefined ? 0 : (parsed[2] === "-" ? -1 : 1) * Number(parsed[3]);
  return first + (fraction > 0 ? fraction * (next! - first) : 0) + offset;
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
    known ? `Markers: ${known}.` : "It has no markers: use seconds, or add one with `marker.add`.",
  );
}
