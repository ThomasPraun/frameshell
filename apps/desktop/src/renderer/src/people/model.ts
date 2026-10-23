// The People panel's model (ADR 0020): what a person's links say, how a change is undone, and what picking a person selects.
import type { PersonInfo, TimelineView } from "@frameshell/protocol";
import { angleLinkKey, faceAnchorKey, speakerLinkKey } from "@frameshell/schema";
import type { PersonTarget } from "../../../shared/api.js";
import type { SelectedWord, TimeRange } from "../selection.js";
import type { TranscriptModel, TranscriptSource } from "../transcript/model.js";

/** The project's people as `people.list` reports them. */
export interface PeopleSnapshot {
  people: readonly PersonInfo[];
  dismissed: readonly string[];
}

/** One call that puts a people change back. A person is named by id, or by name when it is added again. */
export type UndoStep =
  | { kind: "add"; name: string }
  | { kind: "remove"; person: string }
  | { kind: "rename"; person: string; name: string }
  | { kind: "link"; person: string; target: PersonTarget }
  | { kind: "unlink"; person: string; target: PersonTarget };

/** What Cmd/Ctrl+Z does: the calls in order, and what they take back (for the status line). */
export interface UndoEntry {
  steps: UndoStep[];
  change: { kind: "add" | "rename" | "remove" | "link" | "unlink"; name: string; from?: string };
}

type Target = PersonTarget;

/** Every link of a person as the target `people.link` takes, keyed like the file keys it. */
function targets(person: PersonInfo): Map<string, Target> {
  const found = new Map<string, Target>();
  for (const { transcript, speaker } of person.speakers) {
    found.set(`s${speakerLinkKey({ transcript, speaker })}`, { speaker: { transcript, ...(speaker !== undefined ? { speaker } : {}) } });
  }
  for (const { timeline, group, angle } of person.angles) found.set(`a${angleLinkKey({ timeline, group, angle })}`, { angle: { timeline, group, angle } });
  for (const { asset, at, x, y } of person.faces) found.set(`f${faceAnchorKey({ asset, at, x, y })}`, { face: { asset, at, x, y } });
  return found;
}

/**
 * The inverse of whatever turned `before` into `after`, applied through the same methods: links added are
 * unlinked, people added are removed, renames are renamed back, people removed are added again (a new id; the
 * links follow by name) and links removed are linked again. `entry` is null when nothing changed that a call can
 * put back; `changed` tells apart "nothing changed" from "only a dismissed suggestion", which has no inverse.
 */
export function inverseOf(before: PeopleSnapshot, after: PeopleSnapshot): { entry: UndoEntry | null; changed: boolean } {
  const was = new Map(before.people.map((person) => [person.id, person]));
  const now = new Map(after.people.map((person) => [person.id, person]));
  const unlink: UndoStep[] = [];
  const removed: UndoStep[] = [];
  const renamed: UndoStep[] = [];
  const added: UndoStep[] = [];
  const link: UndoStep[] = [];
  const notes: UndoEntry["change"][] = [];
  const note = (next: UndoEntry["change"]) => notes.push(next);

  for (const person of after.people) {
    const old = was.get(person.id);
    if (!old) {
      removed.push({ kind: "remove", person: person.id });
      note({ kind: "add", name: person.name });
      continue;
    }
    if (old.name !== person.name) {
      renamed.push({ kind: "rename", person: person.id, name: old.name });
      note({ kind: "rename", name: person.name, from: old.name });
    }
    const had = targets(old);
    const has = targets(person);
    for (const [key, target] of has) {
      if (had.has(key)) continue;
      unlink.push({ kind: "unlink", person: person.id, target });
      note({ kind: "link", name: person.name });
    }
    for (const [key, target] of had) {
      if (has.has(key)) continue;
      link.push({ kind: "link", person: person.id, target });
      note({ kind: "unlink", name: person.name });
    }
  }
  for (const old of before.people) {
    if (now.has(old.id)) continue;
    added.push({ kind: "add", name: old.name });
    for (const target of targets(old).values()) link.push({ kind: "link", person: old.name, target });
    note({ kind: "remove", name: old.name });
  }

  const steps = [...unlink, ...removed, ...renamed, ...added, ...link];
  const dismissedChanged = before.dismissed.length !== after.dismissed.length || before.dismissed.some((id) => !after.dismissed.includes(id));
  if (steps.length === 0 || notes.length === 0) return { entry: null, changed: dismissedChanged };
  return { entry: { steps, change: notes[0]! }, changed: true };
}

/** Number of colour slots a person's swatch cycles through (`--angle-1`…`--angle-6`). */
const COLOURS = 6;

/** Colour slot of a person, 0-based: from the id, so it stays when others come and go. */
export function personColour(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % COLOURS;
}

/** Whether a link was confirmed by an agent (`agent:<label>:<session>`), and which. */
export function agentOf(by: string | undefined): string | null {
  return by?.startsWith("agent:") ? by.split(":")[1] || "agent" : null;
}

/** The agent that confirmed any link of the person, as its label; null when a person made them all. */
export function confirmedBy(person: PersonInfo): string | null {
  for (const link of [...person.speakers, ...person.angles, ...person.faces]) {
    const agent = agentOf(link.by);
    if (agent) return agent;
  }
  return null;
}

/** A voice or angle that can still be linked to someone. */
export interface LinkChoice {
  /** `<kind>:<…>`: unique among the choices. */
  key: string;
  kind: "voice" | "angle";
  /** Text as the picker shows it. */
  label: string;
  /** Group heading, e.g. the transcript file. */
  group: string;
  target: Target;
}

/**
 * Voices and angles nobody has: every speaker of every transcript, or the whole transcript when it names none,
 * and every angle of every multicam group of `view`; minus what a person already holds or what a whole-transcript link covers.
 */
export function linkChoices(sources: readonly TranscriptSource[], view: TimelineView | null, people: readonly PersonInfo[]): LinkChoice[] {
  const taken = new Set<string>();
  const whole = new Set<string>();
  for (const person of people) {
    for (const link of person.speakers) {
      taken.add(speakerLinkKey(link));
      if (link.speaker === undefined) whole.add(link.transcript);
    }
    for (const link of person.angles) taken.add(angleLinkKey(link));
  }
  const choices: LinkChoice[] = [];
  for (const { path, transcript } of sources) {
    if (whole.has(path)) continue;
    const speakers = transcript.speakers ?? [];
    if (speakers.length === 0) {
      if (!taken.has(speakerLinkKey({ transcript: path }))) {
        choices.push({ key: `voice:${path}`, kind: "voice", label: path.replace(/^transcripts\//, ""), group: path, target: { speaker: { transcript: path } } });
      }
      continue;
    }
    for (const speaker of speakers) {
      if (taken.has(speakerLinkKey({ transcript: path, speaker: speaker.id }))) continue;
      choices.push({ key: `voice:${path}:${speaker.id}`, kind: "voice", label: speaker.name, group: path, target: { speaker: { transcript: path, speaker: speaker.id } } });
    }
  }
  for (const group of view?.groups ?? []) {
    for (const angle of group.angles) {
      const target = { timeline: view!.timeline, group: group.id, angle: angle.id };
      if (taken.has(angleLinkKey(target))) continue;
      choices.push({ key: `angle:${group.id}:${angle.id}`, kind: "angle", label: angle.name, group: group.id, target: { angle: target } });
    }
  }
  return choices;
}

/** Name of speaker `id` in the transcript at `path`, else the id itself. */
export function speakerName(sources: readonly TranscriptSource[], path: string, id: string): string {
  return sources.find((source) => source.path === path)?.transcript.speakers?.find((speaker) => speaker.id === id)?.name ?? id;
}

/** Name of angle `angle` in group `group` of `view`, else the id itself. */
export function angleName(view: TimelineView | null, group: string, angle: string): string {
  return view?.groups?.find((candidate) => candidate.id === group)?.angles.find((candidate) => candidate.id === angle)?.name ?? angle;
}

/** `people.ranges` spans as selection ranges. */
export function toRanges(spans: readonly { start: number; end: number }[]): TimeRange[] {
  return spans.filter((span) => span.end > span.start).map(({ start, end }) => ({ from: start, to: end }));
}

/**
 * The words picking `person` selects in the transcript view: those of their linked speakers (or of a whole
 * linked transcript) that the timeline plays, in transcript order within each file.
 */
export function personWords(person: PersonInfo, model: TranscriptModel): SelectedWord[] {
  const words: SelectedWord[] = [];
  for (const transcript of model.assets) {
    const links = person.speakers.filter((link) => link.transcript === transcript.path && !link.missing);
    if (links.length === 0) continue;
    const all = links.some((link) => link.speaker === undefined);
    const ids = new Set(links.flatMap((link) => (link.speaker === undefined ? [] : [link.speaker])));
    for (const word of transcript.words) {
      if (word.placements.length === 0) continue;
      if (!all && (word.speaker === null || !ids.has(word.speaker))) continue;
      words.push({ transcript: transcript.path, asset: transcript.asset, word: word.id, text: word.text, start: word.start, end: word.end });
    }
  }
  return words;
}

/** Share of the picture's width a face thumbnail shows around the anchor. */
const CROP_WIDTH = 0.3;

/**
 * CSS `object-view-box` showing the face around a face anchor's point: a square (in pixels) of {@link CROP_WIDTH}
 * of the picture's width, kept inside the picture. `aspect` is the picture's width over its height.
 */
export function faceViewBox(point: { x: number; y: number }, aspect: number): string {
  const width = Math.min(1, CROP_WIDTH);
  const height = Math.min(1, (CROP_WIDTH * aspect) || 1);
  const left = Math.min(Math.max(point.x - width / 2, 0), 1 - width);
  const top = Math.min(Math.max(point.y - height / 2, 0), 1 - height);
  const pct = (fraction: number) => `${Math.round(fraction * 1000) / 10}%`;
  return `inset(${pct(top)} ${pct(1 - left - width)} ${pct(1 - top - height)} ${pct(left)})`;
}

/** Seconds as `M:SS` for a face sample's time or a total. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
