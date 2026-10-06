// The transcript view's model (SPEC §10): which words the timeline plays, where, and how to bring a cut one back.
import type { TimelineView } from "@frameshell/protocol";
import type { Transcript } from "@frameshell/schema";
import type { TimelineEdit } from "../../../shared/api.js";
import type { SelectedWord, TimeRange } from "../selection.js";

/** A transcript file (SPEC §5.4) as read from the project. */
export interface TranscriptSource {
  /** Project-relative file, e.g. `transcripts/take.words.json`. */
  path: string;
  transcript: Transcript;
}

/** One place a word plays on the timeline. Timeline seconds, clipped to the clip's `[in, out)`. */
export interface Placement {
  clip: string;
  track: string;
  from: number;
  to: number;
}

/** A transcript word with where the timeline plays it. */
export interface TranscriptWord {
  /** `<transcript path>#<word id>`: unique across transcripts. */
  key: string;
  id: string;
  /** Text as shown: the human edit when there is one. */
  text: string;
  /** Source-asset seconds. */
  start: number;
  end: number;
  /** Earliest first; empty when every clip cut it (struck). */
  placements: Placement[];
}

/** The words of one asset on the timeline, in source order. */
export interface AssetTranscript {
  asset: string;
  path: string;
  words: TranscriptWord[];
}

/** Everything the transcript view shows for one timeline revision. */
export interface TranscriptModel {
  /** Assets with media clips on the timeline and a transcript, by first appearance. */
  assets: AssetTranscript[];
  /** Assets with media clips on the timeline but no transcript yet. */
  missing: string[];
  /** Every placement with its word key, sorted by `from`: the playhead lookup. */
  timeline: { from: number; to: number; key: string }[];
}

/** A media clip as the model reads it from `timeline.show`. */
interface MediaSpan {
  id: string;
  track: string;
  asset: string;
  start: number;
  end: number;
  in: number;
  out: number;
  speed: number;
  gain: number | undefined;
  muted: boolean | undefined;
}

const round = (seconds: number) => Math.round(seconds * 1000) / 1000;
const mid = (word: { start: number; end: number }) => (word.start + word.end) / 2;

/** Media clips of every video and audio track, earliest first. */
function mediaSpans(view: TimelineView): MediaSpan[] {
  const spans: MediaSpan[] = [];
  for (const track of view.tracks) {
    if (track.kind === "subtitles") continue;
    for (const clip of track.clips) {
      const { asset, in: inS, out, speed, audio } = clip as Record<string, unknown>;
      if (clip.type !== "media" || typeof asset !== "string" || typeof inS !== "number" || typeof out !== "number") continue;
      const rate = typeof speed === "number" ? speed : 1;
      const sound = (audio ?? {}) as { gain?: number; muted?: boolean };
      spans.push({
        id: clip.id,
        track: track.id,
        asset,
        start: clip.start,
        end: clip.end ?? clip.start + (out - inS) / rate,
        in: inS,
        out,
        speed: rate,
        gain: sound.gain,
        muted: sound.muted,
      });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * Where `clips` play the source span `[start, end)`: a clip keeps a word
 * when the word's midpoint lies in its `[in, out)`, as `transcribe --verify`
 * and subtitle tracks count it (SPEC §5.3).
 */
function place(clips: readonly MediaSpan[], start: number, end: number): Placement[] {
  const center = mid({ start, end });
  return clips
    .filter((clip) => center >= clip.in && center < clip.out)
    .map((clip) => ({
      clip: clip.id,
      track: clip.track,
      from: round(clip.start + (Math.max(start, clip.in) - clip.in) / clip.speed),
      to: round(clip.start + (Math.min(end, clip.out) - clip.in) / clip.speed),
    }));
}

/**
 * Model of the timeline's transcripts: every word of each asset its media
 * clips use, struck when no clip keeps it, else placed on the timeline
 * clock. `sources` may hold transcripts of other assets; they are ignored.
 */
export function buildTranscriptModel(view: TimelineView, sources: readonly TranscriptSource[]): TranscriptModel {
  const spans = mediaSpans(view);
  const assets: AssetTranscript[] = [];
  const missing: string[] = [];
  const timeline: TranscriptModel["timeline"] = [];
  for (const asset of new Set(spans.map((span) => span.asset))) {
    const source = sources.find((candidate) => candidate.transcript.asset === asset);
    if (!source) {
      missing.push(asset);
      continue;
    }
    const clips = spans.filter((span) => span.asset === asset);
    const { transcript, path } = source;
    const words = [...transcript.words]
      .sort((a, b) => a.start - b.start)
      .map((word) => {
        const key = `${path}#${word.id}`;
        const placements = place(clips, word.start, word.end);
        for (const { from, to } of placements) timeline.push({ from, to, key });
        return { key, id: word.id, text: transcript.edits[word.id]?.text ?? word.text, start: word.start, end: word.end, placements };
      });
    assets.push({ asset, path, words });
  }
  timeline.sort((a, b) => a.from - b.from);
  return { assets, missing, timeline };
}

/** Key of the word playing at timeline second `time`; null between words and outside the program. */
export function wordAt(model: TranscriptModel, time: number): string | null {
  const entries = model.timeline;
  // Last entry starting at or before `time`; a few before it may still cover it (stacked tracks).
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (entries[middle]!.from <= time) low = middle + 1;
    else high = middle;
  }
  for (let i = low - 1; i >= 0 && i >= low - 4; i--) {
    const entry = entries[i]!;
    if (time >= entry.from && time < entry.to) return entry.key;
  }
  return null;
}

/** Earliest place a selected word plays on this revision, with its clip; null when cut. */
export function wordPlacement(view: TimelineView, word: SelectedWord): Placement | null {
  const clips = mediaSpans(view).filter((span) => span.asset === word.asset);
  return place(clips, word.start, word.end)[0] ?? null;
}

/** Timeline range of a selected word on this revision (its earliest placement); null when cut. */
export function placeWord(view: TimelineView, word: SelectedWord): TimeRange | null {
  const first = wordPlacement(view, word);
  return first ? { from: first.from, to: first.to } : null;
}

/** How cut words come back: which clip grows or is inserted after, and the `ui` operation that does it. */
export interface Restore {
  /** `extend`: an adjacent clip grows over the words; `insert`: a new clip plays just the words. */
  how: "extend" | "insert";
  /** Clip extended, or the clip the new one is placed after (before, when the words precede every clip). */
  clip: string;
  edit: TimelineEdit;
}

/** One restore step with what the plan needs to order and report it. */
interface RunRestore {
  restore: Restore;
  /** Keys of the words it brings back. */
  keys: string[];
  /** Timeline second where it opens room: clips starting there or later move. */
  at: number;
  /** Source second of its first word: orders steps that open room at the same point. */
  source: number;
  /** Clip tracks left in place, see {@link rippleScope}. */
  held: string[];
}

/**
 * Tracks a restore opening room at timeline second `at` on track `own`
 * moves. The own track always moves. Another video or audio track moves
 * only when that opens no gap: the first of its clips starting at or after
 * `at` must not touch a clip that stays (one ending where it starts).
 * Moving such a track would leave black or silence there, e.g. footage or
 * music laid under a voice line restored on its own track. `held` lists the
 * tracks that stay; those keep their timing, so they shift against the
 * restored track after `at`.
 */
export function rippleScope(view: TimelineView, own: string, at: number): { tracks: string[]; held: string[] } {
  const frame = (seconds: number) => Math.round(seconds * view.fps);
  const from = frame(at);
  const tracks: string[] = [];
  const held: string[] = [];
  for (const track of view.tracks) {
    if (track.kind === "subtitles") continue;
    const moving = track.clips.filter((clip) => frame(clip.start) >= from);
    const first = moving.reduce<(typeof moving)[number] | undefined>((min, clip) => (!min || clip.start < min.start ? clip : min), undefined);
    // A clip of unknown length (broken nested timeline) may touch: treat it as touching.
    const opensGap =
      track.id !== own &&
      first !== undefined &&
      track.clips.some((clip) => frame(clip.start) < from && (clip.end === null || frame(clip.end) === frame(first.start)));
    (opensGap ? held : tracks).push(track.id);
  }
  return { tracks, held };
}

/**
 * Restore of the struck words `first..last` (indices into `entry.words`, all
 * struck) as one edit, the inverse of the cut that removed them:
 *
 * - When nothing else was cut between the words and the clip that ends
 *   before them in the source, that clip's tail grows over them (`clip.trim`
 *   `out`); else, when nothing was cut between them and the clip that starts
 *   after them, that clip's head grows back over them (`clip.trim` `in`).
 * - Otherwise only their range is inserted as a new clip right after the
 *   clip before them (`clip.add`), so other cut words stay cut.
 *
 * Every variant ripples (later clips move right instead of being
 * overlapped), on the tracks {@link rippleScope} allows, and snaps its edges
 * into audio pauses (ADR 0003). Edges are requested mid-gap between the
 * words and their neighbours; `snapBounds` keeps the snapped edge in that
 * gap: a new `in` between the previous word's end (or the source the clip
 * before plays) and the first word's start, a new `out` between the last
 * word's end and the next word's start (or the source the clip after plays).
 * Inter-word gaps are often shorter than a pause, so an unfenced snap could
 * land across a restored word (leaving it cut) or across a neighbour
 * (bringing it back). Null when no clip of the asset is left to anchor on.
 */
function restoreRun(view: TimelineView, entry: AssetTranscript, first: number, last: number): RunRestore | null {
  const run = entry.words.slice(first, last + 1);
  const head0 = run[0]!;
  const tail0 = run.at(-1)!;
  const clips = mediaSpans(view).filter((span) => span.asset === entry.asset);
  const low = mid(head0);
  const high = mid(tail0);
  const before = clips.filter((clip) => clip.out <= low).sort((a, b) => b.out - a.out || b.start - a.start)[0];
  const after = clips.filter((clip) => clip.in > high).sort((a, b) => a.in - b.in || a.start - b.start)[0];
  const cutBetween = (from: number, to: number) => entry.words.some((other) => !run.includes(other) && mid(other) >= from && mid(other) < to);

  const previous = entry.words[first - 1];
  const next = entry.words[last + 1];
  // Fences: source an edge may take without cutting into the run, a neighbour word or another clip's source.
  const inMin = round(Math.max(previous?.end ?? 0, before?.out ?? 0));
  const inMax = round(Math.max(inMin, head0.start));
  const outMax = round(Math.min(next?.start ?? Infinity, after?.in ?? Infinity));
  const outMin = round(Math.min(outMax, tail0.end));
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
  const head = clamp(round(previous ? (previous.end + head0.start) / 2 : head0.start), inMin, inMax);
  const tail = clamp(round(next ? (tail0.end + next.start) / 2 : tail0.end), outMin, outMax);
  const inBounds = { min: inMin, max: inMax };
  const outBounds = Number.isFinite(outMax) ? { min: outMin, max: outMax } : { min: outMin };
  const keys = run.map((word) => word.key);
  const step = (restore: Restore, at: number, scope: { tracks: string[]; held: string[] }): RunRestore => {
    // Every track may move: leave `rippleTracks` out, as a plain ripple.
    if (scope.held.length > 0) Object.assign(restore.edit.args, { rippleTracks: scope.tracks });
    return { restore, keys, at, source: head0.start, held: scope.held };
  };

  if (before && !cutBetween(before.out, low)) {
    const at = round(before.end);
    return step(
      { how: "extend", clip: before.id, edit: { op: "clip.trim", args: { clip: before.id, out: tail, snapBounds: { out: outBounds }, ripple: true } } },
      at,
      rippleScope(view, before.track, at),
    );
  }
  if (after && !cutBetween(high, after.in)) {
    return step(
      { how: "extend", clip: after.id, edit: { op: "clip.trim", args: { clip: after.id, in: head, snapBounds: { in: inBounds }, ripple: true } } },
      after.start,
      rippleScope(view, after.track, after.start),
    );
  }
  const anchor = before ?? after;
  if (!anchor) return null;
  const start = before ? round(before.end) : anchor.start;
  return step(
    {
      how: "insert",
      clip: anchor.id,
      edit: {
        op: "clip.add",
        args: {
          track: anchor.track,
          asset: entry.asset,
          start,
          in: head,
          out: tail,
          ...(anchor.speed !== 1 ? { speed: anchor.speed } : {}),
          ...(anchor.gain !== undefined ? { gain: anchor.gain } : {}),
          ...(anchor.muted ? { muted: true } : {}),
          ripple: true,
          snap: true,
          snapBounds: { in: inBounds, out: outBounds },
        },
      },
    },
    start,
    rippleScope(view, anchor.track, start),
  );
}

/**
 * The operation that restores cut word `key` (SPEC §10); see
 * {@link restorePlan} for several words. Null for a kept word or unknown key.
 */
export function restoreEdit(view: TimelineView, model: TranscriptModel, key: string): Restore | null {
  return restorePlan(view, model, [key])?.steps[0] ?? null;
}

/** Edits that bring back several cut words at once: one `ui` transaction, so one undo step. */
export interface RestorePlan {
  /** In apply order: latest on the timeline first, so no step moves where a later one opens room. */
  edits: TimelineEdit[];
  /** One per edit, same order. */
  steps: Restore[];
  /** Keys of the struck words the edits bring back. */
  keys: string[];
  /** Video and audio tracks some step leaves in place, so they do not get a gap; see {@link rippleScope}. */
  held: string[];
}

/**
 * Restore every struck word among `keys` (a struck sentence, a drag
 * selection; kept and unknown keys are skipped). Struck words next to each
 * other in their transcript come back as one run, by one edit (see
 * {@link restoreRun}): the clip before grows over the whole run instead of
 * word by word. Null when no key names a struck word that can come back.
 */
export function restorePlan(view: TimelineView, model: TranscriptModel, keys: readonly string[]): RestorePlan | null {
  const wanted = new Set(keys);
  const runs: RunRestore[] = [];
  for (const entry of model.assets) {
    let first = -1;
    entry.words.forEach((word, index) => {
      const take = wanted.has(word.key) && word.placements.length === 0;
      if (take && first === -1) first = index;
      const next = entry.words[index + 1];
      const continues = next !== undefined && wanted.has(next.key) && next.placements.length === 0;
      if (take && !continues) {
        const run = restoreRun(view, entry, first, index);
        if (run) runs.push(run);
        first = -1;
      }
    });
  }
  if (runs.length === 0) return null;
  // Each step is computed on the current timeline: apply the latest first so earlier ones still hold.
  runs.sort((a, b) => b.at - a.at || b.source - a.source);
  return {
    edits: runs.map((run) => run.restore.edit),
    steps: runs.map((run) => run.restore),
    keys: runs.flatMap((run) => run.keys),
    held: [...new Set(runs.flatMap((run) => run.held))],
  };
}

/** Whether timeline `view` keeps word `key` (some clip plays its midpoint); false for an unknown key. */
export function isKept(view: TimelineView, sources: readonly TranscriptSource[], key: string): boolean {
  const model = buildTranscriptModel(view, sources);
  return model.assets.some((asset) => asset.words.some((word) => word.key === key && word.placements.length > 0));
}

/**
 * Keys of the struck words around `words[index]` with no kept word between
 * them, in source order: the cut passage it belongs to. Empty for a kept word.
 */
export function struckRun(words: readonly TranscriptWord[], index: number): string[] {
  const struck = (i: number) => words[i] !== undefined && words[i]!.placements.length === 0;
  if (!struck(index)) return [];
  let first = index;
  let last = index;
  while (struck(first - 1)) first--;
  while (struck(last + 1)) last++;
  return words.slice(first, last + 1).map((word) => word.key);
}

/**
 * Transcript file `content` with word `id` corrected to `text`, as a human
 * edit (SPEC §5.4 `edits`; subtitles and `transcribe --verify` read it).
 * Every other field and edit stays as it is. `text` is trimmed; empty, or
 * equal to what was transcribed, drops the edit so the word reads as
 * transcribed again. Throws when `content` is no transcript object or has no
 * word `id`.
 */
export function withWordText(content: string, id: string, text: string): string {
  const data = JSON.parse(content) as { words?: unknown; edits?: unknown };
  const words = Array.isArray(data.words) ? (data.words as { id?: unknown; text?: unknown }[]) : null;
  const word = words?.find((candidate) => candidate.id === id);
  if (!word) throw new Error(`no word ${id} in this transcript`);
  const edits = { ...(typeof data.edits === "object" && data.edits !== null ? (data.edits as Record<string, unknown>) : {}) };
  const corrected = text.trim();
  if (corrected === "" || corrected === word.text) delete edits[id];
  else edits[id] = { ...(edits[id] as object | undefined), text: corrected };
  return `${JSON.stringify({ ...data, edits }, null, 2)}\n`;
}

/** Source silence that starts a new paragraph, seconds. */
const PARAGRAPH_GAP_S = 1.2;
/** Shorter silence that starts one after a sentence end. */
const SENTENCE_GAP_S = 0.6;

/**
 * Split words (source order) into paragraphs at long source pauses, or at
 * a shorter pause after a sentence end: reading aid only, never saved.
 */
export function paragraphs<W extends { text: string; start: number; end: number }>(words: readonly W[]): W[][] {
  const result: W[][] = [];
  let current: W[] = [];
  for (const word of words) {
    const last = current.at(-1);
    if (last) {
      const gap = word.start - last.end;
      if (gap >= PARAGRAPH_GAP_S || (gap >= SENTENCE_GAP_S && /[.!?…]["»”']?$/.test(last.text))) {
        result.push(current);
        current = [];
      }
    }
    current.push(word);
  }
  if (current.length > 0) result.push(current);
  return result;
}
