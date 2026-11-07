import type { PeopleSuggestion } from "@frameshell/protocol";
import { type Person, type Transcript, personNameKey, speakerLinkKey } from "@frameshell/schema";
import { suggestionId } from "./suggest.js";

/** Share of a voice's words in shoot script lines that one `**Name:**` must hold for the voice to be suggested as that person. */
export const SCRIPT_SPEAKER_SHARE = 0.8;
/** Fewest words of a voice in that person's lines for a suggestion: one short line could be anybody's. */
export const SCRIPT_SPEAKER_MIN_WORDS = 5;

/** Heard words of a transcript speaker (or a whole transcript, `speaker` absent) in lines a shoot script gives to `name`. */
export interface ScriptVoice {
  script: string;
  transcript: string;
  speaker?: string | undefined;
  name: string;
  words: number;
}

/** What {@link scriptSuggestions} reads. */
export interface ScriptSuggestInput {
  voices: readonly ScriptVoice[];
  people: readonly Person[];
  /** Valid transcripts by project-relative path. */
  transcripts: ReadonlyMap<string, Transcript>;
}

/**
 * `script` suggestions (ADR 0024 decision 8, ADR 0020 decision 5), dismissed ones included, by transcript then
 * speaker: each voice linked to nobody whose words in a shoot script's lines are {@link SCRIPT_SPEAKER_SHARE} one
 * person's, at least {@link SCRIPT_SPEAKER_MIN_WORDS} of them, is that person (the one named like them, else a new one).
 * A whole transcript is suggested only while it has no speakers. Hints name transcripts whose words are split across
 * people with no speakers to tell them apart, with the command that finds them.
 */
export function scriptSuggestions(input: ScriptSuggestInput): { suggestions: PeopleSuggestion[]; hints: string[] } {
  const linked = new Set(input.people.flatMap((person) => person.speakers.map(speakerLinkKey)));
  const byName = new Map(input.people.map((person) => [personNameKey(person.name), person]));
  const perVoice = new Map<string, { script: string; transcript: string; speaker: string | undefined; names: Map<string, { name: string; words: number }> }>();
  for (const voice of input.voices) {
    const key = `${voice.script}\0${speakerLinkKey(voice)}`;
    const entry = perVoice.get(key) ?? { script: voice.script, transcript: voice.transcript, speaker: voice.speaker, names: new Map() };
    const name = entry.names.get(personNameKey(voice.name)) ?? { name: voice.name, words: 0 };
    name.words += voice.words;
    entry.names.set(personNameKey(voice.name), name);
    perVoice.set(key, entry);
  }
  const suggestions: PeopleSuggestion[] = [];
  const hints: string[] = [];
  for (const { script, transcript: rel, speaker, names } of perVoice.values()) {
    const transcript = input.transcripts.get(rel);
    if (!transcript || linked.has(speakerLinkKey({ transcript: rel, speaker }))) continue;
    const diarized = (transcript.speakers?.length ?? 0) > 0;
    // Words with no speaker in a diarized transcript are nobody's in particular.
    if (speaker === undefined && diarized) continue;
    const ranked = [...names.values()].sort((a, b) => b.words - a.words || a.name.localeCompare(b.name));
    const total = ranked.reduce((sum, entry) => sum + entry.words, 0);
    const top = ranked[0]!;
    const share = top.words / total;
    if (share < SCRIPT_SPEAKER_SHARE || top.words < SCRIPT_SPEAKER_MIN_WORDS) {
      if (speaker === undefined && ranked.length > 1) {
        hints.push(
          `${transcript.asset} says the lines of ${ranked.map((entry) => entry.name).join(", ")} in ${script}, with no speakers to tell them apart: ` +
            `frameshell transcribe --speakers ${transcript.asset}`,
        );
      }
      continue;
    }
    const person = byName.get(personNameKey(top.name));
    const name = speaker === undefined ? undefined : transcript.speakers?.find((candidate) => candidate.id === speaker)?.name;
    const score = Math.round(share * 100) / 100;
    const voice = speaker === undefined ? `All of ${rel}` : `${speaker}${name ? ` (${name})` : ""} in ${rel}`;
    suggestions.push({
      id: suggestionId("script", [script, rel, speaker ?? "", personNameKey(top.name)]),
      kind: "script",
      ...(person ? { person: { id: person.id, name: person.name } } : {}),
      speaker: { transcript: rel, ...(speaker !== undefined ? { speaker, ...(name !== undefined ? { name } : {}) } : {}) },
      script: { script, name: top.name, words: top.words },
      links: ["speaker"],
      score,
      reason: `${voice} says ${top.name}'s lines in ${script} (${top.words} words, ${Math.round(share * 100)}%)${person ? "" : `; a new person, ${top.name}`}.`,
    });
  }
  return { suggestions: suggestions.sort((a, b) => a.speaker!.transcript.localeCompare(b.speaker!.transcript) || (a.speaker!.speaker ?? "").localeCompare(b.speaker!.speaker ?? "")), hints };
}
