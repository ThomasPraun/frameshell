import { ErrorCode, type OperationName, RpcError, TIME_REF_FIELDS } from "@frameshell/protocol";
import { type Timeline, markerLabelKey } from "@frameshell/schema";
import type { OperationRequest } from "./engine.js";

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
 * 4. a scheme prefix (`beat:32`, `bar:8`, `word:…`): reserved for the slices that build them, refused with a pointer
 *    until then. New schemes join {@link SCHEMES}; nothing else changes.
 */

/** What a resolver may read: the timeline the operation applies to. */
export interface TimeRefScope {
  /** Timeline being edited, in the state the operation sees (the open transaction's earlier changes included). */
  timeline: Pick<Timeline, "id" | "markers">;
}

/** Turns what follows `scheme:` into timeline seconds, or throws {@link TimeRefError}. */
export type SchemeResolver = (rest: string, scope: TimeRefScope) => number;

/**
 * Schemes that are reserved but not built yet, with what they wait for. A resolver registered in
 * {@link SCHEMES} replaces the entry.
 */
const PLANNED_SCHEMES: Readonly<Record<string, string>> = {
  beat: "the beat grid (ADR 0029 slices 2 and 3)",
  bar: "the beat grid (ADR 0029 slices 2 and 3)",
  word: "word references (ADR 0029 slice 4, after markers)",
};

/** Built schemes by name. Empty until the beat grid and word references exist. */
const SCHEMES: Readonly<Record<string, SchemeResolver>> = {};

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

/** Seconds resolved to microseconds, so `4.1 + 0.5` is `4.6` and not `4.6000000000000005`. */
const tidy = (seconds: number) => Math.round(seconds * 1e6) / 1e6;

/**
 * Seconds `ref` names on `scope`'s timeline. A number passes through; a string is read as described at the top of
 * this file. Throws {@link TimeRefError} for an unknown name, a reserved scheme, or a result before 0.
 */
export function resolveTimeRef(ref: number | string, scope: TimeRefScope): number {
  if (typeof ref === "number") return checked(ref, String(ref));
  const text = ref.trim();
  if (text === "") throw new TimeRefError("A time reference is empty.", "Give seconds, or a marker id or label.");
  const seconds = Number(text);
  if (Number.isFinite(seconds)) return checked(seconds, text);

  const marker = markerNamed(text, scope);
  if (marker) return marker.at;

  const offset = /^(.+?)\s*([+-])\s*(\d+(?:\.\d+)?)$/.exec(text);
  if (offset) {
    const base = markerNamed(offset[1]!, scope);
    if (base) return checked(base.at + (offset[2] === "-" ? -1 : 1) * Number(offset[3]), text);
  }

  const scheme = /^([a-z]+):(.*)$/.exec(text);
  if (scheme) {
    const [, name, rest] = scheme as unknown as [string, string, string];
    const built = SCHEMES[name];
    if (built) return checked(built(rest, scope), text);
    const waiting = PLANNED_SCHEMES[name];
    if (waiting) throw new TimeRefError(`"${text}" needs ${waiting}, which does not exist yet.`, "Use seconds, or a marker id or label for now.");
  }
  throw unknownName(text, scope);
}

/**
 * `request` with every time reference of its operation (the {@link TIME_REF_FIELDS} table) turned into seconds
 * against `timeline`; the same object when there is none to turn. The journal records the result, so a replay or
 * a revert never depends on a marker staying where it was. Throws `RpcError` InvalidOperation naming the
 * operation and the argument.
 */
export function resolveTimeRefs(request: WireRequestLike, timeline: Pick<Timeline, "id" | "markers">): OperationRequest {
  const fields: readonly string[] | undefined = (TIME_REF_FIELDS as Partial<Record<string, readonly string[]>>)[request.op];
  if (!fields) return request as OperationRequest;
  const args = request.args as Record<string, unknown>;
  let resolved: Record<string, unknown> | undefined;
  for (const field of fields) {
    const value = args[field];
    if (typeof value !== "string") continue;
    try {
      (resolved ??= { ...args })[field] = resolveTimeRef(value, { timeline });
    } catch (error) {
      if (!(error instanceof TimeRefError)) throw error;
      throw new RpcError(ErrorCode.InvalidOperation, `${request.op}: ${field}: ${error.message}`, {
        op: request.op,
        field,
        reason: "time reference",
        value,
        ...(error.hint ? { hint: error.hint } : {}),
      });
    }
  }
  return resolved ? ({ op: request.op, args: resolved } as OperationRequest) : (request as OperationRequest);
}

/** An operation request whose time arguments may still be names: what a caller sends before {@link resolveTimeRefs}. */
export type WireRequestLike = { op: OperationName | "timeline.patch"; args: unknown };

function markerNamed(name: string, scope: TimeRefScope) {
  const markers = scope.timeline.markers ?? [];
  return markers.find((marker) => marker.id === name) ?? markers.find((marker) => markerLabelKey(marker.label) === markerLabelKey(name));
}

function checked(seconds: number, shown: string): number {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new TimeRefError(`"${shown}" is ${seconds < 0 ? "before the start of the timeline" : "not a time"}.`, "Times are 0 or more seconds.");
  }
  return tidy(seconds);
}

function unknownName(text: string, scope: TimeRefScope): TimeRefError {
  const markers = scope.timeline.markers ?? [];
  const known = markers.map((marker) => `${marker.id} "${marker.label}" at ${marker.at} s`).join(", ");
  return new TimeRefError(
    `"${text}" is neither seconds nor a marker of timeline ${scope.timeline.id}.`,
    known ? `Markers: ${known}.` : "It has no markers: use seconds, or add one with `marker.add`.",
  );
}
