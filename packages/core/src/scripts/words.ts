import { readFile, readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import { type MediaClip, type ScriptWordRange, type Timeline, type Transcript, parseTimeline, parseTranscript } from "@frameshell/schema";
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
 * runs from its first to its last word id in transcript order; it resolves
 * in each transcript that holds both ids. A word is placed by a media clip
 * of its asset whose visible `[in, out)` holds the word's midpoint (overlaps
 * trimmed as in the export), so a clip cut in the middle of a range
 * shortens its span, and words cut out are not counted. Unknown ids, ids in
 * different transcripts and reversed ranges become warnings, never errors;
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
    const holders = transcripts.map((transcript) => locate(transcript, range));
    const matched = holders.filter((holder) => holder.from !== -1 && holder.to !== -1);
    if (matched.length === 0) {
      warnings.push(unresolvable(scene.slug, range, transcripts, holders));
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

function unresolvable(
  slug: string,
  range: ScriptWordRange,
  transcripts: readonly ReadTranscript[],
  holders: readonly { transcript: ReadTranscript; from: number; to: number }[],
): string {
  const label = `Scene "${slug}": words ${range.from}..${range.to}`;
  if (transcripts.length === 0) return `${label} cannot be placed: the project has no transcripts (transcribe an asset first).`;
  const partial = holders.filter((holder) => holder.from !== -1 || holder.to !== -1);
  if (partial.length > 0) {
    const where = partial.map(({ transcript, from }) => `${from !== -1 ? range.from : range.to} in ${transcript.rel}`).join(", ");
    return `${label}: the ids are not in one transcript (${where}); a range must stay inside one transcript.`;
  }
  return `${label}: unknown word ids; no transcript has ${range.from} or ${range.to}.`;
}

/** Span of the `wanted` words of `transcript` that `timeline` places, or null when it places none. */
function spanOn(id: string, timeline: Timeline, transcript: Transcript, wanted: ReadonlySet<string>): SceneSpan | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const track of timeline.tracks) {
    if (track.kind === "subtitles") continue;
    const clips = track.clips.filter((clip): clip is MediaClip => clip.type === "media").filter((clip) => clip.asset === transcript.asset);
    for (const placed of visibleClips(clips)) {
      const { clip, speed } = placed;
      const toTimeline = (source: number) => clip.start + (source - clip.in) / speed;
      for (const word of transcript.words) {
        if (!wanted.has(word.id)) continue;
        const mid = (word.start + word.end) / 2;
        if (mid < clip.in || mid >= placed.out) continue;
        start = Math.min(start, toTimeline(Math.max(word.start, clip.in)));
        end = Math.max(end, toTimeline(Math.min(word.end, placed.out)));
        count++;
      }
    }
  }
  return count === 0 ? null : { timeline: id, start: round(start), end: round(end), words: count };
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
