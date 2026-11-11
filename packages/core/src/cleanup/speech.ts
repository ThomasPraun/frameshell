import { type MediaClip, type Timeline, wordSpeaker } from "@frameshell/schema";
import { type EnergyProfile, profileLevel } from "../media/energy.js";
import { type SourceTranscript, type Visible, visibleClips } from "../transcripts/verify.js";
import { FrameGrid } from "../timeline/grid.js";
import type { SpeechAudio, SpeechWord } from "./plan.js";

/** A word belongs to a clip when at least this much of it, or half of it when shorter, plays there (#455, ticket comment on word clocks). */
const MIN_OVERLAP_S = 0.15;

/** What {@link gatherSpeech} reads from the project. */
export interface SpeechSources {
  /** Transcript of every asset the timeline's clips play. */
  transcripts: ReadonlyMap<string, SourceTranscript>;
  /** Energy profile of a project-relative asset; throws when it cannot be read. */
  profile(asset: string): Promise<EnergyProfile>;
  /** Whether a project-relative asset has an audio stream. */
  hasAudio(asset: string): Promise<boolean>;
}

/** The speech a timeline plays: its kept words and its sound. */
export interface GatheredSpeech {
  words: SpeechWord[];
  audio: SpeechAudio;
  /** Clips whose asset has no current transcript or no readable audio, and so are not speech. */
  unchecked: { clip: string; asset: string; reason: string }[];
  /** Media clips that count as speech. */
  clips: number;
}

interface SpeechClip {
  placed: Visible;
  profile: EnergyProfile;
}

/**
 * Kept words of `timeline` (program tracks already folded into media clips, see `withProgramSound`) placed on the
 * timeline clock, and the sound under them. A word counts for the clip that plays most of it, however many tracks
 * place the same words. Clips of assets without a current transcript or without audio are not speech.
 */
export async function gatherSpeech(timeline: Timeline, fps: number, sources: SpeechSources): Promise<GatheredSpeech> {
  const grid = new FrameGrid(fps);
  const clips: SpeechClip[] = [];
  const unchecked: GatheredSpeech["unchecked"] = [];
  const words = new Map<string, SpeechWord>();
  const skip = (clip: MediaClip, reason: string) => unchecked.push({ clip: clip.id, asset: clip.asset, reason });

  for (const track of timeline.tracks) {
    if (track.kind === "subtitles") continue;
    const media = track.clips.filter((clip): clip is MediaClip => clip.type === "media" && clip.audio?.muted !== true);
    const visible = visibleClips(media);
    const here: { placed: Visible; source: Extract<SourceTranscript, { transcript: unknown }> }[] = [];
    for (const placed of visible) {
      const clip = placed.clip;
      const source = sources.transcripts.get(clip.asset);
      if (!source) continue;
      if ("unchecked" in source) {
        skip(clip, source.unchecked === "stale-transcript" ? "its transcript is older than the file" : "it has no transcript");
        continue;
      }
      if (!(await sources.hasAudio(clip.asset))) {
        skip(clip, "it has no audio");
        continue;
      }
      let profile: EnergyProfile;
      try {
        profile = await sources.profile(clip.asset);
      } catch (error) {
        skip(clip, `its audio could not be read: ${(error as Error).message}`);
        continue;
      }
      clips.push({ placed, profile });
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
          speaker: wordSpeaker(transcript, word) ?? null,
          at,
          end: toTimeline(Math.min(word.end, placed.out)),
          speechInside: word.speechInside === true,
        });
      }
    }
  }
  return { words: [...words.values()].sort((a, b) => a.at - b.at || a.end - b.end), audio: speechAudio(clips, fps), unchecked, clips: clips.length };
}

function overlapOf(word: { start: number; end: number }, placed: Visible): number {
  return Math.min(word.end, placed.out) - Math.max(word.start, placed.clip.in);
}

/** {@link SpeechAudio} of the clips that play speech. */
function speechAudio(clips: readonly SpeechClip[], fps: number): SpeechAudio {
  const slack = 0.5 / fps;
  const spans: { start: number; end: number }[] = [];
  for (const { placed } of [...clips].sort((a, b) => a.placed.clip.start - b.placed.clip.start)) {
    const last = spans.at(-1);
    if (last && placed.clip.start <= last.end + slack) last.end = Math.max(last.end, placed.end);
    else spans.push({ start: placed.clip.start, end: placed.end });
  }
  return {
    level(t) {
      let loudest = Number.POSITIVE_INFINITY;
      for (const { placed, profile } of clips) {
        if (t < placed.clip.start || t >= placed.end) continue;
        const level = profileLevel(profile, placed.clip.in + (t - placed.clip.start) * placed.speed);
        loudest = loudest === Number.POSITIVE_INFINITY ? level : Math.max(loudest, level);
      }
      return loudest;
    },
    covers(from, to) {
      return spans.some((span) => span.start <= from + slack && span.end >= to - slack);
    },
  };
}
