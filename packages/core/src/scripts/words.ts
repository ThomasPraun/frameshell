import { readFile, readdir } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import {
  type MediaClip,
  type ScriptWordRange,
  type Timeline,
  type Transcript,
  parseTimeline,
  parseTranscript,
  withProgramSound,
} from "@frameshell/schema";
import { visibleClips } from "../transcripts/verify.js";

/** A scene's words placed on one timeline: first to last placed word, in timeline seconds. */
export interface SceneSpan {
  timeline: string;
  start: number;
  end: number;
  words: number;
}

/** Result of {@link resolveWordRanges}: one entry per input range, plus problems to show the agent. */
export interface ResolvedWordRanges {
  spans: SceneSpan[][];
  warnings: string[];
}

/** Input of {@link resolveWordRanges}: the scene slug names it in diagnostics. */
export interface SceneWords {
  slug: string;
  range: ScriptWordRange | null;
}

/**
 * Timeline time spans of script scenes' word ranges (ADR 0015). A range
 * runs from its first to its last word id in transcript order. Word ids are
 * per transcript, so a range names its transcript file; a bare range works
 * only when exactly one transcript holds both ids (several: a warning, no
 * span). A word is placed by a media clip
 * of its asset whose visible `[in, out)` holds the word's midpoint (overlaps
 * trimmed as in the export), so a clip cut in the middle of a range
 * shortens its span, and words cut out or muted are not counted; each word
 * counts once however many tracks place it. Unknown ids or transcripts, ids in
 * different transcripts, ambiguous bare ranges and reversed ranges become
 * warnings, never errors;
 * unreadable files are skipped with a warning.
 */
export async function resolveWordRanges(root: string, scenes: readonly SceneWords[]): Promise<ResolvedWordRanges> {
  const spans: SceneSpan[][] = scenes.map(() => []);
  const warnings: string[] = [];
  if (!scenes.some((scene) => scene.range)) return { spans, warnings };

  const transcripts = await readTranscripts(root, warnings);
  const timelines = await readTimelines(root);
  scenes.forEach((scene, index) => {
    const range = scene.range;
    if (!range) return;
    const named = range.transcript === null ? transcripts : transcripts.filter((transcript) => transcriptMatches(transcript, range.transcript!));
    if (range.transcript !== null && named.length === 0) {
      warnings.push(`Scene "${scene.slug}": words ${range.from}..${range.to} name transcript "${range.transcript}", which does not exist (see transcripts/).`);
      return;
    }
    const holders = named.map((transcript) => locate(transcript, range));
    const matched = holders.filter((holder) => holder.from !== -1 && holder.to !== -1);
    if (matched.length === 0) {
      warnings.push(unresolvable(scene.slug, range, transcripts, holders));
      return;
    }
    if (matched.length > 1) {
      const where = matched.map((holder) => holder.transcript.rel).join(", ");
      warnings.push(
        `Scene "${scene.slug}": words ${range.from}..${range.to} are in several transcripts (${where}); ` +
          `name one: \`<!-- words: ${basename(matched[0]!.transcript.rel)} ${range.from}..${range.to} -->\`. Not placed.`,
      );
      return;
    }
    for (const { transcript, from, to } of matched) {
      if (from > to) {
        warnings.push(`Scene "${scene.slug}": words ${range.from}..${range.to} are reversed in ${transcript.rel}; write the earlier word first.`);
        continue;
      }
      const wanted = new Set(transcript.value.words.slice(from, to + 1).map((word) => word.id));
      for (const { id, timeline } of timelines) {
        const span = spanOn(id, timeline, transcript.value, wanted);
        if (span) spans[index]!.push(span);
      }
    }
  });
  return { spans, warnings };
}

interface ReadTranscript {
  rel: string;
  value: Transcript;
}

/** Positions of the range ends in a transcript's words; -1 when absent. */
function locate(transcript: ReadTranscript, range: ScriptWordRange): { transcript: ReadTranscript; from: number; to: number } {
  const ids = transcript.value.words.map((word) => word.id);
  return { transcript, from: ids.indexOf(range.from), to: ids.indexOf(range.to) };
}

/** Whether a range's transcript reference (`talk.words.json` or `transcripts/talk.words.json`) names this transcript. */
function transcriptMatches(transcript: ReadTranscript, name: string): boolean {
  const wanted = name.replace(/^\.?\//, "");
  return transcript.rel === wanted || transcript.rel === `transcripts/${wanted}`;
}

function unresolvable(
  slug: string,
  range: ScriptWordRange,
  transcripts: readonly ReadTranscript[],
  holders: readonly { transcript: ReadTranscript; from: number; to: number }[],
): string {
  const label = `Scene "${slug}": words ${range.from}..${range.to}`;
  if (transcripts.length === 0) return `${label} cannot be placed: the project has no transcripts (transcribe an asset first).`;
  const fromAt = holders.filter((holder) => holder.from !== -1).map((holder) => holder.transcript.rel);
  const toAt = holders.filter((holder) => holder.to !== -1).map((holder) => holder.transcript.rel);
  if (fromAt.length > 0 && toAt.length > 0) {
    return `${label}: the ids are not in one transcript (${range.from} in ${fromAt.join(", ")}; ${range.to} in ${toAt.join(", ")}); a range must stay inside one transcript.`;
  }
  if (fromAt.length > 0) return `${label}: unknown word id ${range.to} (${range.from} is in ${fromAt.join(", ")}).`;
  if (toAt.length > 0) return `${label}: unknown word id ${range.from} (${range.to} is in ${toAt.join(", ")}).`;
  return `${label}: unknown word ids; no transcript has ${range.from} or ${range.to}.`;
}

/** Span of the `wanted` words of `transcript` that `timeline` places, or null when it places none. */
function spanOn(id: string, timeline: Timeline, transcript: Transcript, wanted: ReadonlySet<string>): SceneSpan | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  const placedIds = new Set<string>();
  // A program track places the words its angles' sound plays.
  for (const track of withProgramSound(timeline).tracks) {
    if (track.kind === "subtitles") continue;
    // Overlaps trim against every media clip of the track, as in the export and `keptWords`.
    const visible = visibleClips(track.clips.filter((clip): clip is MediaClip => clip.type === "media"));
    for (const placed of visible) {
      const { clip, speed } = placed;
      if (clip.asset !== transcript.asset || clip.audio?.muted === true) continue;
      const toTimeline = (source: number) => clip.start + (source - clip.in) / speed;
      for (const word of transcript.words) {
        if (!wanted.has(word.id)) continue;
        const mid = (word.start + word.end) / 2;
        if (mid < clip.in || mid >= placed.out) continue;
        start = Math.min(start, toTimeline(Math.max(word.start, clip.in)));
        end = Math.max(end, toTimeline(Math.min(word.end, placed.out)));
        placedIds.add(word.id);
      }
    }
  }
  return placedIds.size === 0 ? null : { timeline: id, start: round(start), end: round(end), words: placedIds.size };
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

async function readTranscripts(root: string, warnings: string[]): Promise<ReadTranscript[]> {
  const entries = await readdir(join(root, "transcripts"), { recursive: true }).catch(() => []);
  const found: ReadTranscript[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".words.json")).sort()) {
    const rel = `transcripts/${entry.split(sep).join("/")}`;
    try {
      const parsed = parseTranscript(JSON.parse(await readFile(join(root, rel), "utf8")));
      if (parsed.ok) found.push({ rel, value: parsed.value });
      else warnings.push(`${rel} is not a valid transcript, skipped when placing script words: ${parsed.error.split("\n")[0]}`);
    } catch (error) {
      warnings.push(`${rel} could not be read, skipped when placing script words: ${(error as Error).message.split("\n")[0]}`);
    }
  }
  return found;
}

async function readTimelines(root: string): Promise<{ id: string; timeline: Timeline }[]> {
  const names = (await readdir(join(root, "timelines")).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
  const found: { id: string; timeline: Timeline }[] = [];
  for (const name of names) {
    try {
      const parsed = parseTimeline(JSON.parse(await readFile(join(root, "timelines", name), "utf8")));
      if (parsed.ok) found.push({ id: name.slice(0, -".json".length), timeline: parsed.value });
      // An invalid timeline is already reported once by the clip-link pass.
    } catch {
      // Same: unreadable timelines are reported by the clip-link pass.
    }
  }
  return found;
}
