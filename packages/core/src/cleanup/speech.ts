import type { Timeline } from "@frameshell/schema";
import { type EnergyProfile, profileLevel } from "../media/energy.js";
import { placeWords } from "../transcripts/timeline-words.js";
import type { SourceTranscript, Visible } from "../transcripts/verify.js";
import type { SpeechAudio, SpeechWord } from "./plan.js";

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
 * timeline clock by {@link placeWords} (shared with `word:` time references), and the sound under them. Clips of assets
 * without a current transcript or without audio are not speech.
 */
export async function gatherSpeech(timeline: Timeline, fps: number, sources: SpeechSources): Promise<GatheredSpeech> {
  const clips: SpeechClip[] = [];
  const { words, left } = await placeWords(timeline, fps, sources.transcripts, async (placed) => {
    const asset = placed.clip.asset;
    if (!(await sources.hasAudio(asset))) return "it has no audio";
    try {
      clips.push({ placed, profile: await sources.profile(asset) });
    } catch (error) {
      return `its audio could not be read: ${(error as Error).message}`;
    }
    return null;
  });
  return {
    words: words.map(({ id, text, transcript, speaker, at, end, speechInside }) => ({ id, text, transcript, speaker, at, end, speechInside })),
    audio: speechAudio(clips, fps),
    unchecked: left.map(({ clip, asset, reason }) => ({ clip, asset, reason })),
    clips: clips.length,
  };
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
