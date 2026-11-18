import { type MediaClip, type Timeline, withProgramSound, wordSpeaker } from "@frameshell/schema";
import { FrameGrid } from "../timeline/grid.js";
import type { TimelineWords } from "../timeline/time-ref.js";
import { type SourceTranscript, type Visible, sourceTranscripts, visibleClips } from "./verify.js";

/** A word belongs to a clip when at least this much of it, or half of it when shorter, plays there (#455, ticket comment on word clocks). */
const MIN_OVERLAP_S = 0.15;

/** A transcript word as it plays on the timeline clock. */
export interface PlacedWord {
  id: string;
  /** As the person corrected it, else as transcribed. */
  text: string;
  /** Project-relative transcript file. */
  transcript: string;
  /** Project-relative asset of the clip that plays it. */
  asset: string;
  /** Id of the clip that plays it. */
  clip: string;
  /** Id of the track the clip is on. */
  track: string;
  speaker: string | null;
  /** The transcript's language code, null when it has none. */
  language: string | null;
  /** Timeline seconds the word starts and ends, clamped to the clip that plays it. */
  at: number;
  end: number;
  /** The word hides speech the transcript lacks: never cut around it. */
  speechInside: boolean;
}

/** A media clip {@link placeWords} left out, and why. */
export interface LeftOutClip {
  clip: string;
  asset: string;
  /** Why, as a clause (`it has no transcript`). */
  reason: string;
  /** Set when the reason is the transcript: none, or one of other content. */
  transcript?: "no-transcript" | "stale-transcript";
}

/**
 * Asks whether a placed clip with a current transcript counts; returns the reason to leave it out, or null. Called
 * once per visible clip, in track order (cleanup checks the clip's audio here).
 */
export type AdmitClip = (placed: Visible) => Promise<string | null>;

/** `timeline` as it is heard (program tracks folded into their angles' sound) and the transcript of every asset it plays. */
export async function heardTranscripts(
  projectDir: string,
  timeline: Timeline,
  assetHash: ((rel: string) => Promise<string | null>) | undefined,
): Promise<{ heard: Timeline; transcripts: Map<string, SourceTranscript> }> {
  // Words are heard, not seen: a program track counts as its angles' sound.
  const heard = withProgramSound(timeline);
  return { heard, transcripts: await sourceTranscripts(projectDir, heard, assetHash) };
}

/**
 * Kept words of `timeline` (program tracks already folded in, see {@link heardTranscripts}) on the timeline clock, by
 * start. Only unmuted media clips count, as each plays after overlaps are trimmed; a word counts for the clip that plays
 * most of it, however many tracks place the same words, so a word a cut removed is not here. Clips of assets without a
 * current transcript, or that `admit` refuses, are left out. Words of nested timeline clips are not placed.
 */
export async function placeWords(
  timeline: Timeline,
  fps: number,
  transcripts: ReadonlyMap<string, SourceTranscript>,
  admit?: AdmitClip,
): Promise<{ words: PlacedWord[]; left: LeftOutClip[]; admitted: Visible[] }> {
  const grid = new FrameGrid(fps);
  const left: LeftOutClip[] = [];
  const admitted: Visible[] = [];
  const words = new Map<string, PlacedWord>();
  const skip = (clip: MediaClip, reason: string, transcript?: LeftOutClip["transcript"]) =>
    left.push({ clip: clip.id, asset: clip.asset, reason, ...(transcript ? { transcript } : {}) });

  for (const track of timeline.tracks) {
    if (track.kind === "subtitles") continue;
    const media = track.clips.filter((clip): clip is MediaClip => clip.type === "media" && clip.audio?.muted !== true);
    const here: { placed: Visible; source: Extract<SourceTranscript, { transcript: unknown }> }[] = [];
    for (const placed of visibleClips(media)) {
      const clip = placed.clip;
      const source = transcripts.get(clip.asset);
      if (!source) continue;
      if ("unchecked" in source) {
        skip(clip, source.unchecked === "stale-transcript" ? "its transcript is older than the file" : "it has no transcript", source.unchecked);
        continue;
      }
      const refused = admit ? await admit(placed) : null;
      if (refused !== null) {
        skip(clip, refused);
        continue;
      }
      admitted.push(placed);
      here.push({ placed, source });
    }
    for (const { placed, source } of here) {
      const { clip, speed } = placed;
      const { transcript, rel } = source;
      const toTimeline = (sourceSeconds: number) => clip.start + (sourceSeconds - clip.in) / speed;
      for (const word of transcript.words) {
        const overlap = Math.min(word.end, placed.out) - Math.max(word.start, clip.in);
        if (overlap < Math.min(MIN_OVERLAP_S, (word.end - word.start) / 2) - 1e-9 || overlap <= 0) continue;
        // The clip that plays most of the word keeps it.
        const rival = here.find((other) => other.placed !== placed && other.source.rel === rel && overlapOf(word, other.placed) > overlap + 1e-9);
        if (rival) continue;
        const at = toTimeline(Math.max(word.start, clip.in));
        const key = `${rel}#${word.id}@${grid.frame(at)}`;
        if (words.has(key)) continue;
        words.set(key, {
          id: word.id,
          text: transcript.edits[word.id]?.text ?? word.text,
          transcript: rel,
          asset: clip.asset,
          clip: clip.id,
          track: track.id,
          speaker: wordSpeaker(transcript, word) ?? null,
          language: transcript.language ?? null,
          at,
          end: toTimeline(Math.min(word.end, placed.out)),
          speechInside: word.speechInside === true,
        });
      }
    }
  }
  return { words: [...words.values()].sort((a, b) => a.at - b.at || a.end - b.end), left, admitted };
}

function overlapOf(word: { start: number; end: number }, placed: Visible): number {
  return Math.min(word.end, placed.out) - Math.max(word.start, placed.clip.in);
}

/**
 * The words `word:` time references read (ADR 0029 slice 4): the kept words `timeline` plays, as {@link placeWords}
 * finds them for `cleanup`, and the heard clips whose asset has no current transcript.
 */
export async function readTimelineWords(
  projectDir: string,
  timeline: Timeline,
  fps: number,
  assetHash: ((rel: string) => Promise<string | null>) | undefined,
): Promise<TimelineWords> {
  const { heard, transcripts } = await heardTranscripts(projectDir, timeline, assetHash);
  const { words, left } = await placeWords(heard, fps, transcripts);
  return {
    words: words.map(({ id, text, asset, clip, track, language, at, end }) => ({ id, text, asset, clip, track, language, at, end })),
    unchecked: left.flatMap((entry) => (entry.transcript ? [{ clip: entry.clip, asset: entry.asset, reason: entry.transcript }] : [])),
  };
}
