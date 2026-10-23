// "Ask agent" reference text (SPEC decision 21, §10): what the user selected, as plain lines any agent CLI reads.
import type { TimelineView } from "@frameshell/protocol";
import type { SelectedPoint, SelectedWord, Selection } from "../selection.js";
import { wordPlacement } from "../transcript/model.js";

/** Every reference line starts with this tag, so agents (and the bundled skill) recognize it. */
const TAG = "[frameshell]";
/** Longest quoted text (subtitle words) before it is shortened; ids carry the rest. */
const MAX_QUOTE = 48;

/** Timeline seconds as `HH:MM:SS.hh` (hundredths), e.g. `00:03:12.40`. */
export function referenceTime(seconds: number): string {
  const centis = Math.round(Math.max(0, seconds) * 100);
  const two = (n: number) => String(n).padStart(2, "0");
  const whole = Math.floor(centis / 100);
  return `${two(Math.floor(whole / 3600))}:${two(Math.floor(whole / 60) % 60)}:${two(whole % 60)}.${two(centis % 100)}`;
}

const span = (from: number, to: number) => `${referenceTime(from)}–${referenceTime(to)}`;

/** Seconds as `MM:SS`, or `H:MM:SS` from an hour on. */
function clock(seconds: number): string {
  const whole = Math.round(Math.max(0, seconds));
  const two = (n: number) => String(n).padStart(2, "0");
  const hours = Math.floor(whole / 3600);
  return `${hours > 0 ? `${hours}:` : ""}${two(Math.floor(whole / 60) % 60)}:${two(whole % 60)}`;
}

/** Quoted, escaped and shortened text. */
function quote(text: string): string {
  const short = text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE - 1).trimEnd()}…` : text;
  return `"${short.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Selected words grouped by the clip that plays them, timeline order; unplaced words go to a clipless group. */
function wordGroups(selection: Selection, view: TimelineView | null): { clip: string | null; from: number; to: number; words: SelectedWord[] }[] {
  if (!view) {
    const range = selection.range ?? { from: 0, to: 0 };
    return [{ clip: null, from: range.from, to: range.to, words: [...selection.words] }];
  }
  const groups: { clip: string | null; from: number; to: number; words: SelectedWord[] }[] = [];
  for (const word of selection.words) {
    const placed = wordPlacement(view, word);
    const clip = placed?.clip ?? null;
    const last = groups[groups.length - 1];
    if (last && last.clip === clip) {
      last.words.push(word);
      if (placed) {
        last.from = Math.min(last.from, placed.from);
        last.to = Math.max(last.to, placed.to);
      }
      continue;
    }
    groups.push({ clip, from: placed?.from ?? selection.range?.from ?? 0, to: placed?.to ?? selection.range?.to ?? 0, words: [word] });
  }
  return groups;
}

function wordLines(selection: Selection, view: TimelineView | null): string[] {
  return wordGroups(selection, view).map(({ clip, from, to, words }) => {
    const first = words[0]!.word;
    const last = words[words.length - 1]!.word;
    const ids = first === last ? `word ${first}` : `words ${first}–${last}`;
    const text = quote(words.map((word) => word.text).join(" "));
    return [`${TAG} subtitle ${text}`, span(from, to), ...(clip ? [`clip ${clip}`] : []), ids].join(" · ");
  });
}

function clipLine(id: string, view: TimelineView | null): string {
  for (const track of view?.tracks ?? []) {
    const clip = track.clips.find((candidate) => candidate.id === id);
    if (!clip) continue;
    const fields = clip as Record<string, unknown>;
    const what = typeof fields["asset"] === "string" ? fields["asset"] : typeof fields["source"] === "string" ? fields["source"] : null;
    const when = clip.end === null ? `@ ${referenceTime(clip.start)}` : span(clip.start, clip.end);
    return [`${TAG} clip ${id}`, what ? `${clip.type} ${what}` : clip.type, when, `track ${track.id}`].join(" · ");
  }
  return `${TAG} clip ${id}`;
}

/** What the reference cites besides the selection itself: captures, details files, clip sources. */
export interface ReferenceExtras {
  /** Frame capture of the region, or of every point, by its time `at`. */
  frame?: string | null;
  /** Frame captures of points by their time `at` (seconds), when they differ from {@link frame}. */
  frames?: ReadonlyMap<number, string>;
  /** No capture: a render it needs is not ready (ADR 0011). */
  framePending?: boolean;
  /** Details file of the region (one entry) or of each point, in order; null where none was written. */
  details?: readonly (string | null)[];
  /** Composition source or asset by clip id (also nested `<nested clip>/<clip>` ids), for clips the view does not hold. */
  sources?: ReadonlyMap<string, string>;
}

/** Last segments of a probe selector: enough to recognize the element in a line; the details file has it whole. */
const SHORT_SELECTOR_SEGMENTS = 3;

function shortSelector(selector: string): string {
  const parts = selector.split(" > ");
  return parts.length > SHORT_SELECTOR_SEGMENTS ? `… > ${parts.slice(-SHORT_SELECTOR_SEGMENTS).join(" > ")}` : selector;
}

/** Asset or composition source of clip `id`: the view's own clips, else `sources`. */
function sourceOf(id: string, view: TimelineView | null, sources: ReadonlyMap<string, string> | undefined): string | null {
  const known = sources?.get(id);
  if (known) return known;
  for (const track of view?.tracks ?? []) {
    const fields = track.clips.find((candidate) => candidate.id === id) as Record<string, unknown> | undefined;
    if (!fields) continue;
    return typeof fields["asset"] === "string" ? fields["asset"] : typeof fields["source"] === "string" ? fields["source"] : null;
  }
  return null;
}

/** One `point` line (ADR 0011): where, the clip seen there, the element in its composition, what lies under it. */
function pointLine(point: SelectedPoint, view: TimelineView | null, extras: ReferenceExtras, index: number): string {
  const parts = [`${TAG} point (${point.x.toFixed(2)},${point.y.toFixed(2)}) @ ${referenceTime(point.at)}`];
  const targetAt = point.layers.findIndex((layer) => layer.clip === point.target);
  const target = point.layers[targetAt];
  if (!target) parts.push("black");
  else {
    const source = sourceOf(target.clip, view, extras.sources);
    parts.push([`clip ${target.clip} ${target.type}`, source].filter(Boolean).join(" "));
    const [element] = point.elements;
    if (element) {
      // A sub-composition's element lives in another file than the clip's source.
      const file = element.adapter?.["source"];
      parts.push(
        [
          `element ${shortSelector(element.selector)}`,
          element.text ? quote(element.text) : null,
          typeof file === "string" && file !== source ? `in ${file}` : null,
          element.generated ? "(created by a script)" : null,
        ]
          .filter(Boolean)
          .join(" "),
      );
      const components = element.adapter?.["components"];
      if (Array.isArray(components) && components.length > 0) parts.push(`react ${components.join(" > ")}`);
    } else if (point.unavailable) {
      parts.push(`elements unavailable: ${point.unavailable}`);
    }
  }
  const under = point.layers.slice(targetAt + 1);
  if (target && under.length > 0) parts.push(`under ${under.map((layer) => `${layer.clip} ${layer.type}`).join(", ")}`);
  const details = extras.details?.[index];
  if (details) parts.push(`details ${details}`);
  const frame = extras.frames?.get(point.at) ?? extras.frame;
  if (frame) parts.push(`frame ${frame}`);
  else if (extras.framePending) parts.push("frame pending");
  return parts.join(" · ");
}

/**
 * The reference of `selection`, one line per selected item (SPEC §10):
 * words become subtitle lines (one per clip playing them), clips one line
 * each, a History pick its transaction or operation first, a script scene
 * one line naming its time span (when picked on the timeline's scene band) and its clips, a bare timeline range, explorer files (`asset`
 * under `assets/`, else `file`), a preview region naming the clips under it
 * (topmost first) and its saved `frame` capture when there is one, or
 * `frame pending` while a render it needs is not ready (ADR 0011), and
 * points picked with the Pick tool, one line each, and a person picked in the People panel (one line: id, name, speaks or on
 * screen, span count and total; the spans themselves are `people ranges`). Times are timeline times
 * of `view`; ids are the project files'. Empty for an empty selection.
 */
export function referenceLines(selection: Selection, view: TimelineView | null, options: ReferenceExtras = {}): string[] {
  if (selection.person) {
    const { id, name, what } = selection.person;
    const total = selection.spans.reduce((sum, { from, to }) => sum + (to - from), 0);
    const spans = `${selection.spans.length} span${selection.spans.length === 1 ? "" : "s"}, ${clock(total)} total`;
    return [`${TAG} person ${id} ${quote(name)} · ${what === "speaks" ? "speaks" : "on screen"} · ${spans}`];
  }
  if (selection.points.length > 0) return selection.points.map((point, index) => pointLine(point, view, options, index));
  if (selection.region) {
    const { x0, y0, x1, y1, at, clips } = selection.region;
    const point = (x: number, y: number) => `(${x.toFixed(2)},${y.toFixed(2)})`;
    const under = clips.length > 0 ? [`clips ${clips.map((c) => c.clip).join(", ")}`] : [];
    const details = options.details?.[0] ? [`details ${options.details[0]}`] : [];
    const frame = options.frame ? [`frame ${options.frame}`] : options.framePending ? ["frame pending"] : [];
    return [[`${TAG} region ${point(x0, y0)}–${point(x1, y1)} @ ${referenceTime(at)}`, ...under, ...details, ...frame].join(" · ")];
  }
  if (selection.words.length > 0) return wordLines(selection, view);
  if (selection.scene) {
    const { script, slug, title } = selection.scene;
    const clips = selection.clips.length > 0 ? [`clips ${selection.clips.join(", ")}`] : [];
    const when = selection.range ? [span(selection.range.from, selection.range.to)] : [];
    return [[`${TAG} scene ${script}#${slug} ${quote(title)}`, ...when, ...clips].join(" · ")];
  }
  if (selection.files.length > 0) {
    return selection.files.map((path) => `${TAG} ${path.startsWith("assets/") ? "asset" : "file"} ${path}`);
  }
  const lines: string[] = [];
  if (selection.history) lines.push(`${TAG} ${selection.history.startsWith("op_") ? "operation" : "transaction"} ${selection.history}`);
  lines.push(...selection.clips.map((id) => clipLine(id, view)));
  if (lines.length === 0 && selection.range) lines.push(`${TAG} range ${span(selection.range.from, selection.range.to)}`);
  return lines;
}

/**
 * Keystrokes that type `lines` into a terminal prompt without submitting
 * it. Rows are separated by newlines only when the program reading the
 * terminal enabled bracketed paste (it then takes them as text, not Enter);
 * otherwise the lines share one row. Control characters are replaced by
 * spaces: a file name or transcript word must never press Enter or smuggle
 * an escape sequence (a fake paste end) into the agent's input.
 */
export function agentInput(lines: readonly string[], bracketedPaste: boolean): string {
  // eslint-disable-next-line no-control-regex -- stripping them is the point.
  const clean = lines.map((line) => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, " "));
  if (bracketedPaste && clean.length > 1) return `${clean.join("\n")}\n`;
  return `${clean.join(" ")} `;
}
