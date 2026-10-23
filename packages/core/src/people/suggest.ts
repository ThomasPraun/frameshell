import { createHash } from "node:crypto";
import type { PeopleSuggestion } from "@frameshell/protocol";
import { cosine } from "./voices.js";

/**
 * Lowest voice similarity (cosine of CAM++ prints) suggested as the same
 * person. Measured on synthetic voices (macOS TTS, ~8 s each): one voice in
 * two passages scored 0.93 to 0.95, two different voices 0.26 on average and
 * up to 0.62 (two similar female voices). Placeholder until tuned on real
 * recordings, where room and microphone lower same-voice scores.
 */
export const SPEAKER_MATCH = 0.7;
/** The best person must beat the second best by this much, or the voice is too ambiguous to suggest. */
export const SPEAKER_MARGIN = 0.1;

/** Stable id of a suggestion: `sg_` + 8 hex of its kind and targets, so a "no" is remembered across runs. */
export function suggestionId(kind: string, targets: readonly string[]): string {
  return `sg_${createHash("sha256").update([kind, ...targets].join("\0")).digest("hex").slice(0, 8)}`;
}

/** A person's voice: the mean of their linked speakers' prints. */
export interface PersonVoice {
  id: string;
  name: string;
  print: readonly number[];
}

/** A transcript speaker no one is linked to, with its voice print. */
export interface SpeakerVoice {
  transcript: string;
  speaker: string;
  /** Its name in the transcript. */
  name: string;
  print: readonly number[];
}

/**
 * `speaker` suggestions (ADR 0020 decision 5): each unlinked speaker whose
 * voice is closest to one person's, at least {@link SPEAKER_MATCH} and
 * {@link SPEAKER_MARGIN} ahead of the next person. At most one per speaker;
 * best score first.
 */
export function speakerSuggestions(people: readonly PersonVoice[], speakers: readonly SpeakerVoice[]): PeopleSuggestion[] {
  const suggestions: PeopleSuggestion[] = [];
  for (const speaker of speakers) {
    const ranked = people.map((person) => ({ person, score: cosine(person.print, speaker.print) })).sort((a, b) => b.score - a.score);
    const [best, second] = ranked;
    if (!best || best.score < SPEAKER_MATCH || (second && best.score - second.score < SPEAKER_MARGIN)) continue;
    const score = Math.round(best.score * 100) / 100;
    suggestions.push({
      id: suggestionId("speaker", [best.person.id, speaker.transcript, speaker.speaker]),
      kind: "speaker",
      person: { id: best.person.id, name: best.person.name },
      speaker: { transcript: speaker.transcript, speaker: speaker.speaker, name: speaker.name },
      score,
      reason: `${speaker.speaker} (${speaker.name}) in ${speaker.transcript} sounds like ${best.person.name} (${score.toFixed(2)}).`,
    });
  }
  return suggestions.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
