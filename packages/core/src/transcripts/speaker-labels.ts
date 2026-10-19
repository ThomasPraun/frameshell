import { type Transcript, type TranscriptFileWord, type TranscriptSpeaker, wordIdNumber } from "@frameshell/schema";

/**
 * Speakers on transcript words (ADR 0016 decision 3). Pure: diarization gives
 * anonymous voice clusters over time; these functions put them on words and
 * give them ids that stay put across runs, so names a person typed and
 * corrections in `edits` keep meaning the same person.
 */

/** A stretch of the asset during which one voice cluster speaks. Source-asset seconds. */
export interface SpeakerSegment {
  start: number;
  end: number;
  /** Cluster label of the run that produced it, e.g. `speaker_00`; meaningless across runs. */
  label: string;
}

/** A word with no segment over it takes the nearest one this close (seconds): onsets and segment edges blur. */
const NEAREST_S = 0.5;

/**
 * The segment label of each word: the one overlapping the word's span most
 * (a word with `start == end` counts as a point), else the nearest segment
 * within {@link NEAREST_S}, else undefined. `segments` in any order.
 */
export function wordLabels(words: readonly Pick<TranscriptFileWord, "start" | "end">[], segments: readonly SpeakerSegment[]): (string | undefined)[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  return words.map((word) => {
    let best: string | undefined;
    let bestScore = 0;
    let nearest: string | undefined;
    let nearestGap = NEAREST_S;
    for (const segment of sorted) {
      if (segment.start > word.end + NEAREST_S) break;
      const overlap = Math.min(word.end, segment.end) - Math.max(word.start, segment.start);
      // A point word inside a segment scores above nothing but below any real overlap.
      const score = overlap > 0 ? overlap : word.start >= segment.start && word.start < segment.end ? Number.MIN_VALUE : 0;
      if (score > bestScore) {
        best = segment.label;
        bestScore = score;
      }
      const gap = Math.max(segment.start - word.end, word.start - segment.end, 0);
      if (gap < nearestGap) {
        nearest = segment.label;
        nearestGap = gap;
      }
    }
    return best ?? nearest;
  });
}

/** Default name of speaker `id` (`s2` → `Speaker 2`); a person renames it in the transcript's `speakers`. */
export function defaultSpeakerName(id: string): string {
  return `Speaker ${id.slice(1)}`;
}

/** Outcome of {@link labelSpeakers}. */
export interface LabelledSpeakers {
  /** The words, each with the speaker id diarization found (no `speaker` where none was found). */
  words: TranscriptFileWord[];
  /** Speakers of the words in order of first appearance, then earlier ones that only edits still name. */
  speakers: TranscriptSpeaker[];
}

/**
 * Turn per-word cluster `labels` into transcript speakers. A cluster takes
 * the id of the earlier speaker it shares the most words with (by word id,
 * one cluster per speaker, largest overlaps first), keeping its name; other
 * clusters get new ids above every id used before. Speakers named only by
 * kept `edits` stay listed so the edits stay valid.
 */
export function labelSpeakers(
  words: readonly TranscriptFileWord[],
  labels: readonly (string | undefined)[],
  previous: Pick<Transcript, "words" | "edits" | "speakers"> | null,
): LabelledSpeakers {
  const before = new Map((previous?.words ?? []).map((word) => [word.id, word.speaker]));
  const shared = new Map<string, Map<string, number>>();
  words.forEach((word, i) => {
    const label = labels[i];
    const old = before.get(word.id);
    if (label === undefined || old === undefined) return;
    const counts = shared.get(label) ?? new Map<string, number>();
    counts.set(old, (counts.get(old) ?? 0) + 1);
    shared.set(label, counts);
  });
  const pairs = [...shared].flatMap(([label, counts]) => [...counts].map(([id, count]) => ({ label, id, count })));
  // Deterministic: largest overlap first, then by id and label.
  pairs.sort((a, b) => b.count - a.count || compare(a.id, b.id) || compare(a.label, b.label));
  const idOf = new Map<string, string>();
  const taken = new Set<string>();
  for (const { label, id } of pairs) {
    if (idOf.has(label) || taken.has(id)) continue;
    idOf.set(label, id);
    taken.add(id);
  }
  const oldSpeakers = previous?.speakers ?? [];
  let next = [...oldSpeakers.map((speaker) => speaker.id), ...Object.values(previous?.edits ?? {}).flatMap((edit) => (edit.speaker ? [edit.speaker] : []))].reduce(
    (max, id) => Math.max(max, Number(id.slice(1)) + 1),
    1,
  );
  const labelled = words.map((word, i): TranscriptFileWord => {
    const { speaker: _old, ...rest } = word;
    const label = labels[i];
    if (label === undefined) return rest;
    let id = idOf.get(label);
    if (id === undefined) {
      id = `s${next++}`;
      idOf.set(label, id);
    }
    return { ...rest, speaker: id };
  });
  return { words: labelled, speakers: speakerList(labelled, previous?.edits ?? {}, oldSpeakers) };
}

/**
 * After re-transcription: the speaker of each new word from the old words
 * it overlaps (the old words act as diarization segments), so speakers
 * survive without diarizing again. Sets `speaker` on `words` in place and
 * returns the speakers to keep, or undefined when `previous` had none.
 */
export function carrySpeakers(
  words: TranscriptFileWord[],
  edits: Transcript["edits"],
  previous: Pick<Transcript, "words" | "speakers"> | null,
): Transcript["speakers"] {
  if (!previous?.speakers) return undefined;
  const segments = previous.words.flatMap((word) => (word.speaker ? [{ start: word.start, end: Math.max(word.end, word.start), label: word.speaker }] : []));
  const labels = wordLabels(words, segments);
  words.forEach((word, i) => {
    const label = labels[i];
    if (label === undefined) delete word.speaker;
    else word.speaker = label;
  });
  return speakerList(words, edits, previous.speakers);
}

/** Speakers `words` or `edits` name, in order of first appearance in `words`; names from `known`. */
function speakerList(words: readonly TranscriptFileWord[], edits: Transcript["edits"], known: readonly TranscriptSpeaker[]): TranscriptSpeaker[] {
  const names = new Map(known.map((speaker) => [speaker.id, speaker.name]));
  const ids: string[] = [];
  const add = (id: string | undefined) => {
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  };
  for (const word of words) add(edits[word.id]?.speaker ?? word.speaker);
  for (const word of words) add(word.speaker);
  const edited = Object.entries(edits)
    .flatMap(([id, edit]) => (edit.speaker ? [{ id, speaker: edit.speaker }] : []))
    .sort((a, b) => wordIdNumber(a.id) - wordIdNumber(b.id));
  for (const { speaker } of edited) add(speaker);
  return ids.map((id) => ({ id, name: names.get(id) ?? defaultSpeakerName(id) }));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
