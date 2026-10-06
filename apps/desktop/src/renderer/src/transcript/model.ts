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
  /** The span hides speech the transcript lacks (transcript `speechInside`): never cut inside it. */
  speechInside: boolean;
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
        const text = transcript.edits[word.id]?.text ?? word.text;
        return { key, id: word.id, text, start: word.start, end: word.end, placements, speechInside: word.speechInside === true };
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

/** How a cut word comes back: which clip grows or is inserted after, and the `ui` operation that does it. */
export interface Restore {
  /** `extend`: an adjacent clip grows over the word; `insert`: a new clip plays just the word. */
  how: "extend" | "insert";
  /** Clip extended, or the clip the new one is placed after (before, when the word precedes every clip). */
  clip: string;
  edit: TimelineEdit;
}

/**
 * The operation that restores cut word `key` (SPEC §10), as the inverse of
 * the cut that removed it:
 *
 * - When nothing else was cut between the word and the clip that ends before
 *   it in the source, that clip's tail grows over it (`clip.trim` `out`);
 *   else, when nothing was cut between the word and the clip that starts
 *   after it, that clip's head grows back over it (`clip.trim` `in`).
 * - Otherwise only the word's range is inserted as a new clip right after
 *   the clip before it (`clip.add`), so other cut words stay cut.
 *
 * Every variant ripples (later clips on every track move right instead of
 * being overlapped) and snaps its edges into audio pauses (ADR 0003). Edges
 * are requested mid-gap between the word and its neighbours; `snapBounds`
 * keeps the snapped edge in that gap: a new `in` between the previous word's
 * end (or the source the clip before plays) and the word's start, a new `out`
 * between the word's end and the next word's start (or the source the clip
 * after plays). Inter-word gaps are often shorter than a pause, so an
 * unfenced snap could land across the word (leaving it cut) or across a
 * neighbour (bringing it back). Null for a kept word or unknown key.
 */
export function restoreEdit(view: TimelineView, model: TranscriptModel, key: string): Restore | null {
  const entry = model.assets.find((asset) => asset.words.some((word) => word.key === key));
  if (!entry) return null;
  const index = entry.words.findIndex((word) => word.key === key);
  const word = entry.words[index]!;
  if (word.placements.length > 0) return null;
  const clips = mediaSpans(view).filter((span) => span.asset === entry.asset);
  const center = mid(word);
  const before = clips.filter((clip) => clip.out <= center).sort((a, b) => b.out - a.out || b.start - a.start)[0];
  const after = clips.filter((clip) => clip.in > center).sort((a, b) => a.in - b.in || a.start - b.start)[0];
  const cutBetween = (from: number, to: number) => entry.words.some((other) => other !== word && mid(other) >= from && mid(other) < to);

  const previous = entry.words[index - 1];
  const next = entry.words[index + 1];
  // Fences: source an edge may take without cutting into the word, a neighbour word or another clip's source.
  const inMin = round(Math.max(previous?.end ?? 0, before?.out ?? 0));
  const inMax = round(Math.max(inMin, word.start));
  const outMax = round(Math.min(next?.start ?? Infinity, after?.in ?? Infinity));
  const outMin = round(Math.min(outMax, word.end));
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
  const head = clamp(round(previous ? (previous.end + word.start) / 2 : word.start), inMin, inMax);
  const tail = clamp(round(next ? (word.end + next.start) / 2 : word.end), outMin, outMax);
  const inBounds = { min: inMin, max: inMax };
  const outBounds = Number.isFinite(outMax) ? { min: outMin, max: outMax } : { min: outMin };

  if (before && !cutBetween(before.out, center)) {
    return {
      how: "extend",
      clip: before.id,
      edit: { op: "clip.trim", args: { clip: before.id, out: tail, snapBounds: { out: outBounds }, ripple: true } },
    };
  }
  if (after && !cutBetween(center, after.in)) {
    return {
      how: "extend",
      clip: after.id,
      edit: { op: "clip.trim", args: { clip: after.id, in: head, snapBounds: { in: inBounds }, ripple: true } },
    };
  }
  const anchor = before ?? after;
  if (!anchor) return null;
  return {
    how: "insert",
    clip: anchor.id,
    edit: {
      op: "clip.add",
      args: {
        track: anchor.track,
        asset: entry.asset,
        start: before ? round(before.end) : anchor.start,
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
  };
}

/** Whether timeline `view` keeps word `key` (some clip plays its midpoint); false for an unknown key. */
export function isKept(view: TimelineView, sources: readonly TranscriptSource[], key: string): boolean {
  const model = buildTranscriptModel(view, sources);
  return model.assets.some((asset) => asset.words.some((word) => word.key === key && word.placements.length > 0));
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
