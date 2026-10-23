import type { PersonInfo, TimelineView } from "@frameshell/protocol";
import { parseTranscript } from "@frameshell/schema";
import { type SelectionOrigin, selection } from "../selection.js";
import { type TranscriptSource, buildTranscriptModel } from "../transcript/model.js";
import { personWords, toRanges } from "./model.js";

/** Which of a person's time a pick selects. */
export type PersonTime = "speaks" | "onscreen";

/** Latest pick, so a slow answer never replaces a newer pick. */
let latest = 0;

/**
 * Select `person` in the shared store (ADR 0020): at once, so "Ask agent" and `ui_state` know the pick, then with
 * their spans from `people.ranges` of the main timeline and, for `speaks`, the words of their linked
 * voices the timeline plays. `reveal` moves the timeline and the playhead to the first span (a click does; a
 * refresh after an edit does not). `origin` defaults to the People panel. Resolves with the daemon's message when
 * the spans could not be read, else null.
 */
export async function pickPerson(
  person: Pick<PersonInfo, "id" | "name">,
  what: PersonTime,
  context: { view: TimelineView | null; sources: readonly TranscriptSource[]; info: PersonInfo },
  options: { reveal: boolean; origin?: SelectionOrigin },
): Promise<string | null> {
  const ticket = ++latest;
  const origin = options.origin ?? "people";
  const picked = { id: person.id, name: person.name, what };
  const current = selection.get();
  if (current.person?.id !== person.id || current.person.what !== what || current.person.name !== person.name) {
    selection.selectPerson(picked, [], [], origin);
  }
  try {
    const { spans } = await window.frameshell.people.ranges(person.id, what);
    if (ticket !== latest) return null;
    const words = what === "speaks" && context.view ? personWords(context.info, buildTranscriptModel(context.view, context.sources)) : [];
    selection.selectPerson(picked, toRanges(spans), words, origin, { reveal: options.reveal });
    return null;
  } catch (error) {
    return ticket === latest ? (error as Error).message : null;
  }
}

/**
 * Pick person `id` for the agent (`ui.select`), with no People panel needed: their links from `people.list` and
 * the transcripts those name, read through `readFile`, then {@link pickPerson}. Resolves with their name; rejects
 * with why they cannot be picked.
 */
export async function pickPersonById(
  ref: { id: string; what: PersonTime },
  view: TimelineView | null,
  readFile: (path: string) => Promise<string>,
  options: { reveal: boolean },
): Promise<string> {
  const { people } = await window.frameshell.people.list();
  const info = people.find((candidate) => candidate.id === ref.id);
  if (!info) throw new Error(`No person ${ref.id} in people.json any more.`);
  const sources: TranscriptSource[] = [];
  for (const path of new Set(info.speakers.filter((link) => !link.missing).map((link) => link.transcript))) {
    try {
      const parsed = parseTranscript(JSON.parse(await readFile(path)));
      if (parsed.ok) sources.push({ path, transcript: parsed.value });
    } catch {
      // A transcript that cannot be read leaves its words out; the spans still come from the daemon.
    }
  }
  const error = await pickPerson(info, ref.what, { view, sources, info }, { reveal: options.reveal, origin: "agent" });
  if (error) throw new Error(`Cannot place ${info.name} on the timeline: ${error}`);
  return info.name;
}
