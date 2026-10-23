import { randomBytes } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ErrorCode, type PEOPLE_CHANGES, type PersonInfo, RpcError } from "@frameshell/protocol";
import {
  PEOPLE_FILE,
  type PeopleFile,
  type Person,
  type PersonAngleLink,
  type PersonFaceAnchor,
  type PersonSpeakerLink,
  type Timeline,
  type Transcript,
  angleLinkKey,
  createPeopleFile,
  faceAnchorKey,
  findPerson,
  parsePeopleFile,
  parseTimeline,
  personNameKey,
  speakerLinkKey,
} from "@frameshell/schema";
import { canonicalPath, exists, readJsonIfExists, writeJsonAtomic } from "../fs-util.js";
import { readPrevious } from "../transcripts/transcriber.js";

/** What happened, as `people.changed` names it. */
export type PeopleChange = (typeof PEOPLE_CHANGES)[number];

/** Options of {@link PeopleService}. */
export interface PeopleServiceOptions {
  /** Called after `people.json` is written, with the project root as the caller spelled it and the person's id. */
  onChanged?: (root: string, change: PeopleChange, person: string) => void;
}

/** What a link or unlink names: exactly one field is set. */
export interface PeopleTarget {
  speaker?: { transcript: string; speaker?: string | undefined } | undefined;
  angle?: { timeline: string; group: string; angle: string } | undefined;
  face?: { asset: string; at: number; x: number; y: number } | undefined;
}

/** What `rename` and `link` report about the transcripts they wrote a speaker name into. */
export interface NameWrites {
  /** Transcript files whose speaker name changed. */
  transcripts: string[];
  /** Transcripts a name could not be written to, with why. */
  skipped: { transcript: string; reason: string }[];
}

/** Why a link's target is gone, or null when it exists. */
type Gone = string | null;

/** Targets read once per call. */
interface Lookups {
  transcripts: Map<string, Transcript | string>;
  timelines: Map<string, Timeline | string>;
}

/**
 * `people.json` (ADR 0020, SPEC §5.7): the only writer, one change at a time
 * per project, each written atomically. Linking a transcript speaker and
 * renaming its person write the person's name into that transcript's
 * `speakers` entry. Links to things that are gone are reported `missing` and
 * kept.
 */
export class PeopleService {
  readonly #onChanged: (root: string, change: PeopleChange, person: string) => void;
  /** Last change of each project in flight, by canonical root: the next one waits for it. */
  readonly #tails = new Map<string, Promise<unknown>>();

  constructor(options: PeopleServiceOptions = {}) {
    this.#onChanged = options.onChanged ?? (() => {});
  }

  /** Everyone in the project, each link marked `missing` with the reason when its target is gone. */
  async list(root: string): Promise<{ people: PersonInfo[]; dismissed: string[] }> {
    const file = await readPeople(root);
    const lookups = newLookups();
    const people = [];
    for (const person of file.people) people.push(await describe(root, person, lookups));
    return { people, dismissed: file.dismissed };
  }

  /** Add a person with no links. Throws `InvalidOperation` (`name taken`) or `InvalidProjectFile`. */
  add(root: string, name: string): Promise<PersonInfo> {
    return this.#change(root, async () => {
      const file = await readPeople(root);
      const taken = nameOwner(file, name);
      if (taken) throw nameTaken("people.add", name, taken);
      const person: Person = { id: newId(file), name: name.trim(), speakers: [], angles: [], faces: [] };
      await this.#save(root, { ...file, people: [...file.people, person] }, "add", person.id);
      return describe(root, person, newLookups());
    });
  }

  /** Rename a person (id or exact name) and their transcript speakers. Throws `InvalidOperation` (`unknown person`, `name taken`). */
  rename(root: string, ref: string, name: string): Promise<{ person: PersonInfo; previous: string } & NameWrites> {
    return this.#change(root, async () => {
      const file = await readPeople(root);
      const current = requirePerson("people.rename", file, ref);
      const taken = nameOwner(file, name);
      if (taken && taken.id !== current.id) throw nameTaken("people.rename", name, taken);
      const person: Person = { ...current, name: name.trim() };
      await this.#save(root, { ...file, people: file.people.map((candidate) => (candidate === current ? person : candidate)) }, "rename", person.id);
      const writes = await writeSpeakerNames(root, person, person.speakers);
      return { person: await describe(root, person, newLookups()), previous: current.name, ...writes };
    });
  }

  /** Remove a person (id or exact name) and their links; the person as they were is returned. */
  remove(root: string, ref: string): Promise<PersonInfo> {
    return this.#change(root, async () => {
      const file = await readPeople(root);
      const person = requirePerson("people.remove", file, ref);
      const removed = await describe(root, person, newLookups());
      await this.#save(root, { ...file, people: file.people.filter((candidate) => candidate !== person) }, "remove", person.id);
      return removed;
    });
  }

  /**
   * Link one target to a person. `by` is recorded on the link. The target must
   * exist now. Throws `InvalidOperation`: `unknown person`, `bad target`,
   * `target missing`, `already linked` (to someone else).
   */
  link(root: string, ref: string, target: PeopleTarget, by?: string): Promise<{ person: PersonInfo; linked: boolean; transcripts: string[] }> {
    return this.#change(root, async () => {
      const file = await readPeople(root);
      const current = requirePerson("people.link", file, ref);
      const lookups = newLookups();
      const normalized = await normalizeTarget(root, "people.link", target);
      const next = await withLink(root, current, normalized, by, lookups);
      if (next === current) return { person: await describe(root, current, lookups), linked: false, transcripts: [] };
      const updated = { ...file, people: file.people.map((candidate) => (candidate === current ? next : candidate)) };
      const checked = parsePeopleFile(updated);
      if (!checked.ok) throw refused("people.link", checked.error.split("\n").map((line) => line.replace(/^[\w.]+: /, "")).join("; "), "already linked");
      await this.#save(root, checked.value, "link", next.id);
      const added = normalized.speaker?.speaker === undefined ? [] : next.speakers.filter((link) => speakerLinkKey(link) === speakerLinkKey(normalized.speaker!));
      const { transcripts } = await writeSpeakerNames(root, next, added);
      return { person: await describe(root, next, lookups), linked: true, transcripts };
    });
  }

  /** Remove one link from a person; works when the target is gone. Throws `InvalidOperation`: `unknown person`, `bad target`, `not linked`. */
  unlink(root: string, ref: string, target: PeopleTarget): Promise<PersonInfo> {
    return this.#change(root, async () => {
      const file = await readPeople(root);
      const current = requirePerson("people.unlink", file, ref);
      const normalized = await normalizeTarget(root, "people.unlink", target);
      const next = withoutLink(current, normalized);
      if (!next) throw notLinked(current, normalized);
      await this.#save(root, { ...file, people: file.people.map((candidate) => (candidate === current ? next : candidate)) }, "unlink", next.id);
      return describe(root, next, newLookups());
    });
  }

  async #save(root: string, file: PeopleFile, change: PeopleChange, person: string): Promise<void> {
    await writeJsonAtomic(join(root, PEOPLE_FILE), file);
    this.#onChanged(root, change, person);
  }

  /** Run `work` after the project's earlier changes, so two requests never read the same file and overwrite each other. */
  async #change<T>(root: string, work: () => Promise<T>): Promise<T> {
    const key = await canonicalPath(root);
    const run = (this.#tails.get(key) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => {});
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return run;
  }
}

/** `people.json` of the project, or an empty file when there is none. Throws `InvalidProjectFile`. */
async function readPeople(root: string): Promise<PeopleFile> {
  const path = join(root, PEOPLE_FILE);
  const invalid = (details: string) => new RpcError(ErrorCode.InvalidProjectFile, `Invalid ${path}:\n${details}`, { path, details });
  let raw: unknown;
  try {
    raw = await readJsonIfExists(path);
  } catch (error) {
    throw invalid((error as Error).message);
  }
  if (raw === undefined) return createPeopleFile();
  const parsed = parsePeopleFile(raw);
  if (!parsed.ok) throw invalid(parsed.error);
  return parsed.value;
}

function newId(file: PeopleFile): string {
  for (;;) {
    const id = `p_${randomBytes(3).toString("hex")}`;
    if (!file.people.some((person) => person.id === id)) return id;
  }
}

function nameOwner(file: PeopleFile, name: string): Person | undefined {
  return file.people.find((person) => personNameKey(person.name) === personNameKey(name));
}

function refused(op: string, message: string, reason: string, hint?: string): RpcError {
  return new RpcError(ErrorCode.InvalidOperation, `${op}: ${message}`, { op, reason, ...(hint ? { hint } : {}) });
}

function nameTaken(op: string, name: string, owner: Person): RpcError {
  return refused(op, `the name "${name.trim()}" is already taken by ${owner.id} (names are unique ignoring case).`, "name taken", "Pick another name, or use the existing person.");
}

function requirePerson(op: string, file: PeopleFile, ref: string): Person {
  const person = findPerson(file, ref);
  if (person) return person;
  const known = file.people.map((candidate) => `${candidate.name} (${candidate.id})`).join(", ");
  throw refused(op, `no person "${ref}"${known ? ` (people: ${known})` : ", the project has no people yet"}.`, "unknown person", "frameshell people list");
}

function newLookups(): Lookups {
  return { transcripts: new Map(), timelines: new Map() };
}

/** Project-relative `/`-separated path of `input` (absolute, or relative to the project root). Null when it leaves the project or is daemon-owned. */
export async function projectPath(root: string, input: string): Promise<string | null> {
  const absolute = isAbsolute(input) ? resolve(input) : resolve(root, input);
  let rel = relative(root, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) rel = relative(await canonicalPath(root), await canonicalPath(absolute));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  const path = rel.split(sep).join("/");
  return path.split("/")[0]!.toLowerCase() === ".frameshell" ? null : path;
}

/** `target` with its paths made project-relative. Throws `InvalidOperation` `bad target` when a path is outside the project, or no kind or several are given. */
async function normalizeTarget(root: string, op: string, target: PeopleTarget): Promise<PeopleTarget> {
  const kinds = [target.speaker, target.angle, target.face].filter((part) => part !== undefined).length;
  if (kinds !== 1) throw refused(op, "pass exactly one of speaker, angle or face.", "bad target");
  const outside = (path: string) => refused(op, `${path} is not inside the project.`, "bad target");
  if (target.speaker) {
    const transcript = await projectPath(root, target.speaker.transcript);
    if (transcript === null) throw outside(target.speaker.transcript);
    return { speaker: { transcript, ...(target.speaker.speaker !== undefined ? { speaker: target.speaker.speaker } : {}) } };
  }
  if (target.face) {
    const asset = await projectPath(root, target.face.asset);
    if (asset === null) throw outside(target.face.asset);
    return { face: { ...target.face, asset } };
  }
  return { angle: target.angle };
}

/** `person` with `normalized` (see `normalizeTarget`) added, or `person` itself when already linked. Throws `InvalidOperation` for a missing target. */
async function withLink(root: string, person: Person, normalized: PeopleTarget, by: string | undefined, lookups: Lookups): Promise<Person> {
  const mark = by ? { by } : {};
  const missing = (gone: Gone) => {
    if (gone) throw refused("people.link", `${gone}.`, "target missing", "Check the path or ids: frameshell people list shows what exists in links; timeline show lists angles.");
  };
  if (normalized.speaker) {
    const link: PersonSpeakerLink = { ...normalized.speaker, ...mark };
    if (person.speakers.some((held) => speakerLinkKey(held) === speakerLinkKey(link))) return person;
    missing(await speakerGone(root, link, lookups));
    return { ...person, speakers: [...person.speakers, link] };
  }
  if (normalized.angle) {
    const link: PersonAngleLink = { ...normalized.angle, ...mark };
    if (person.angles.some((held) => angleLinkKey(held) === angleLinkKey(link))) return person;
    missing(await angleGone(root, link, lookups));
    return { ...person, angles: [...person.angles, link] };
  }
  const anchor: PersonFaceAnchor = { ...normalized.face!, ...mark };
  if (person.faces.some((held) => faceAnchorKey(held) === faceAnchorKey(anchor))) return person;
  missing(await assetGone(root, anchor.asset));
  return { ...person, faces: [...person.faces, anchor] };
}

/** `person` without the link `target` names; null when they have none such. */
function withoutLink(person: Person, target: PeopleTarget): Person | null {
  if (target.speaker) {
    const key = speakerLinkKey(target.speaker);
    return person.speakers.some((held) => speakerLinkKey(held) === key) ? { ...person, speakers: person.speakers.filter((held) => speakerLinkKey(held) !== key) } : null;
  }
  if (target.angle) {
    const key = angleLinkKey(target.angle);
    return person.angles.some((held) => angleLinkKey(held) === key) ? { ...person, angles: person.angles.filter((held) => angleLinkKey(held) !== key) } : null;
  }
  const key = faceAnchorKey(target.face!);
  return person.faces.some((held) => faceAnchorKey(held) === key) ? { ...person, faces: person.faces.filter((held) => faceAnchorKey(held) !== key) } : null;
}

function notLinked(person: Person, target: PeopleTarget): RpcError {
  const held = [
    ...person.speakers.map((link) => `speaker ${link.transcript}${link.speaker ? `:${link.speaker}` : ""}`),
    ...person.angles.map((link) => `angle ${link.timeline}:${link.group}:${link.angle}`),
    ...person.faces.map((anchor) => `face ${anchor.asset}@${anchor.at}:${anchor.x},${anchor.y}`),
  ];
  const what = target.speaker ? "that speaker" : target.angle ? "that angle" : "that face anchor";
  return refused("people.unlink", `${person.name} is not linked to ${what}${held.length > 0 ? ` (links: ${held.join(", ")})` : " (no links)"}.`, "not linked");
}

async function readTranscript(root: string, rel: string, lookups: Lookups): Promise<Transcript | string> {
  const known = lookups.transcripts.get(rel);
  if (known !== undefined) return known;
  let result: Transcript | string;
  const path = join(root, ...rel.split("/"));
  try {
    result = (await readPrevious(path)) ?? `${rel} does not exist`;
  } catch (error) {
    result = error instanceof RpcError && error.code === ErrorCode.InvalidProjectFile ? `${rel} is not a valid transcript` : `${rel} cannot be read`;
  }
  lookups.transcripts.set(rel, result);
  return result;
}

async function speakerGone(root: string, link: PersonSpeakerLink, lookups: Lookups): Promise<Gone> {
  const transcript = await readTranscript(root, link.transcript, lookups);
  if (typeof transcript === "string") return transcript;
  if (link.speaker === undefined || transcript.speakers?.some((speaker) => speaker.id === link.speaker)) return null;
  const known = transcript.speakers?.map((speaker) => speaker.id).join(", ");
  return `${link.transcript} has no speaker ${link.speaker}${known ? ` (speakers: ${known})` : "; run `transcribe --speakers` first"}`;
}

async function angleGone(root: string, link: PersonAngleLink, lookups: Lookups): Promise<Gone> {
  let timeline = lookups.timelines.get(link.timeline);
  if (timeline === undefined) {
    const path = join(root, "timelines", `${link.timeline}.json`);
    try {
      const raw = /[\\/]/.test(link.timeline) ? undefined : await readJsonIfExists(path);
      const parsed = raw === undefined ? null : parseTimeline(raw);
      timeline = parsed === null ? `timeline ${link.timeline} does not exist` : parsed.ok ? parsed.value : `timeline ${link.timeline} is not valid`;
    } catch {
      timeline = `timeline ${link.timeline} is not valid`;
    }
    lookups.timelines.set(link.timeline, timeline);
  }
  if (typeof timeline === "string") return timeline;
  const group = timeline.groups?.find((candidate) => candidate.id === link.group);
  if (!group) return `timeline ${link.timeline} has no group ${link.group}`;
  if (group.angles.some((angle) => angle.id === link.angle)) return null;
  return `group ${link.group} has no angle ${link.angle} (angles: ${group.angles.map((angle) => angle.id).join(", ")})`;
}

async function assetGone(root: string, asset: string): Promise<Gone> {
  return (await exists(join(root, ...asset.split("/")))) ? null : `${asset} does not exist`;
}

/** `person` with each link marked `missing` and why. */
async function describe(root: string, person: Person, lookups: Lookups): Promise<PersonInfo> {
  const mark = (gone: Gone) => (gone === null ? { missing: false } : { missing: true, reason: gone });
  const speakers = [];
  for (const link of person.speakers) speakers.push({ ...link, ...mark(await speakerGone(root, link, lookups)) });
  const angles = [];
  for (const link of person.angles) angles.push({ ...link, ...mark(await angleGone(root, link, lookups)) });
  const faces = [];
  for (const anchor of person.faces) faces.push({ ...anchor, ...mark(await assetGone(root, anchor.asset)) });
  return { ...person, speakers, angles, faces };
}

/**
 * Set `person.name` as the name of each given linked speaker in its
 * transcript (SPEC §5.7). A link to a whole transcript names no speaker, so
 * it writes nothing. Missing or invalid transcripts are skipped, never an error.
 */
async function writeSpeakerNames(root: string, person: Person, links: readonly PersonSpeakerLink[]): Promise<NameWrites> {
  const writes: NameWrites = { transcripts: [], skipped: [] };
  for (const link of links) {
    if (link.speaker === undefined) continue;
    const path = join(root, ...link.transcript.split("/"));
    let transcript: Transcript | null;
    try {
      transcript = await readPrevious(path);
    } catch {
      writes.skipped.push({ transcript: link.transcript, reason: "the transcript file is invalid" });
      continue;
    }
    const entry = transcript?.speakers?.find((speaker) => speaker.id === link.speaker);
    if (!transcript || !entry) {
      writes.skipped.push({ transcript: link.transcript, reason: transcript ? `it has no speaker ${link.speaker}` : "the transcript file is missing" });
      continue;
    }
    if (entry.name === person.name) continue;
    await writeJsonAtomic(path, { ...transcript, speakers: transcript.speakers!.map((speaker) => (speaker === entry ? { ...speaker, name: person.name } : speaker)) });
    writes.transcripts.push(link.transcript);
  }
  return writes;
}
