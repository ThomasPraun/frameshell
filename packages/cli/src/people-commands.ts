import { resolve } from "node:path";
import type { DaemonConnection, MethodParams, MethodResult, PersonInfo, Progress, TuneDistribution, TuneSweepRow } from "@frameshell/protocol";
import { UsageError } from "./timeline-commands.js";

/** Help text of the `people` commands (ADR 0020), in `frameshell --help`. */
export const PEOPLE_USAGE = `  people list                  The project's people: ids, names, linked speakers, angles and faces; links whose
                               target is gone are marked missing (kept, never removed)
  people add <name>            Add a person (id p_… is generated; names are unique ignoring case)
  people rename <person> <name>
                               Rename; the new name is written into the transcript of each linked speaker
  people remove <person>       Remove a person and their links
  people link <person> --speaker <transcript>[:<speaker>]
  people link <person> --angle [<timeline>:]<group>:<angle>
  people link <person> --face <asset>@<seconds>[:x,y]
                               Link a transcript speaker (no :speaker = the whole transcript), a multicam angle
                               or a face (a point of it, fractions of the picture, default 0.5,0.5) to a person.
                               Linking a speaker writes the person's name into that transcript
  people unlink <person> (--speaker … | --angle … | --face …)
                               Remove one link, spelled as when linked
  people scan [<asset>…]       Find the faces in videos (default: every video in assets/), locally: 2 frames a second,
                               each face followed and given a face print. Cached in .frameshell/people/ per file
                               content, so a video already scanned is skipped. First run downloads about 39 MB
  people ranges <person> [--on-screen] [--timeline id]
                               Timeline spans where the person speaks (default) or is on screen, pauses under
                               0.5 s bridged. Cut several from the last span to the first
  people suggest               Links Frameshell suggests (a speaker that sounds like a person's linked voices,
                               the face on screen while a speaker talks, a face nobody has,
                               a multicam angle's person), each with an id
                               sg_…, a score and why; hints say what kept voices or faces apart
  people confirm <suggestion>… [--reject] [--person <person>]
                               Apply suggested links (yes), or with --reject dismiss them for good. A suggestion
                               naming nobody (a new face) needs --person: an existing person or a new name
  people tune                  Read-only report on the voice and face thresholds, replayed on what you confirmed:
                               linked speakers (cached voice prints) and face anchors are the truth. Score spreads
                               and, per threshold, correct and wrong suggestions. Changes, scans and downloads nothing
                               (run people suggest and people scan first); --json has every score and the timings
`;

/** Flags each `people` command takes besides the global ones. */
export const PEOPLE_FLAGS: Record<string, readonly string[]> = {
  "people list": [],
  "people add": [],
  "people rename": [],
  "people remove": [],
  "people link": ["speaker", "angle", "face"],
  "people unlink": ["speaker", "angle", "face"],
  "people scan": [],
  "people ranges": ["on-screen", "onscreen", "timeline"],
  "people suggest": [],
  "people confirm": ["reject", "person"],
  "people tune": [],
};

/** A parsed `people` command; paths are as typed, resolved against the working directory when run. */
export type PeopleInvocation =
  | { kind: "people.list" }
  | { kind: "people.add"; name: string }
  | { kind: "people.rename"; person: string; name: string }
  | { kind: "people.remove"; person: string }
  | { kind: "people.scan"; assets: string[] }
  | { kind: "people.link" | "people.unlink"; person: string; target: PeopleTargetInput }
  | { kind: "people.ranges"; person: string; onScreen: boolean; timeline?: string }
  | { kind: "people.suggest" }
  | { kind: "people.tune" }
  | { kind: "people.confirm"; suggestions: string[]; reject: boolean; person?: string };

/** One target of `people link`, as typed. */
export type PeopleTargetInput =
  | { speaker: { transcript: string; speaker?: string } }
  | { angle: { timeline: string; group: string; angle: string } }
  | { face: { asset: string; at: number; x?: number; y?: number } };

/** Parse `people <sub> …`; null when the shape is wrong. Throws `UsageError` for a bad flag value. */
export function parsePeople(
  rest: string[],
  options: {
    speaker?: string | undefined;
    angle?: string | undefined;
    face?: string | undefined;
    "on-screen"?: boolean | undefined;
    onscreen?: boolean | undefined;
    timeline?: string | undefined;
    reject?: boolean | undefined;
    person?: string | undefined;
  },
): PeopleInvocation | null {
  const [sub, ...args] = rest;
  if (sub === "list") return args.length === 0 ? { kind: "people.list" } : null;
  if (sub === "suggest") return args.length === 0 ? { kind: "people.suggest" } : null;
  if (sub === "tune") return args.length === 0 ? { kind: "people.tune" } : null;
  if (sub === "confirm") {
    if (args.length === 0) return null;
    const bad = args.find((id) => !/^sg_[0-9a-f]{8}$/.test(id));
    if (bad) throw new UsageError(`\`frameshell people confirm\` takes suggestion ids like sg_9c04e1d2 (from \`people suggest\`), got "${bad}".`);
    return { kind: "people.confirm", suggestions: args, reject: options.reject === true, ...(options.person !== undefined ? { person: options.person } : {}) };
  }
  if (sub === "add") return args.length > 0 ? { kind: "people.add", name: args.join(" ") } : null;
  if (sub === "rename") return args.length >= 2 ? { kind: "people.rename", person: args[0]!, name: args.slice(1).join(" ") } : null;
  if (sub === "remove") return args.length === 1 ? { kind: "people.remove", person: args[0]! } : null;
  if (sub === "scan") return { kind: "people.scan", assets: args };
  if (sub === "ranges") {
    return args.length === 1 ? { kind: "people.ranges", person: args[0]!, onScreen: options["on-screen"] === true || options.onscreen === true, ...(options.timeline ? { timeline: options.timeline } : {}) } : null;
  }
  if (sub !== "link" && sub !== "unlink") return null;
  if (args.length !== 1) return null;
  const given = [options.speaker, options.angle, options.face].filter((value) => value !== undefined).length;
  if (given !== 1) throw new UsageError(`\`frameshell people ${sub}\` needs exactly one of --speaker, --angle or --face.`);
  const target = parseTarget(options);
  return { kind: sub === "link" ? "people.link" : "people.unlink", person: args[0]!, target };
}

function parseTarget(options: { speaker?: string | undefined; angle?: string | undefined; face?: string | undefined }): PeopleTargetInput {
  if (options.speaker !== undefined) {
    // The last `:` splits off a speaker id; earlier ones belong to the path (a Windows drive).
    const match = /^(.+):(s\d+)$/.exec(options.speaker);
    const transcript = match ? match[1]! : options.speaker;
    if (transcript === "") throw new UsageError("--speaker takes <transcript>[:<speaker>], e.g. transcripts/ep1.words.json:s1.");
    return { speaker: { transcript, ...(match ? { speaker: match[2]! } : {}) } };
  }
  if (options.angle !== undefined) {
    const parts = options.angle.split(":");
    if ((parts.length !== 2 && parts.length !== 3) || parts.some((part) => part === "")) {
      throw new UsageError("--angle takes [<timeline>:]<group>:<angle>, e.g. main:g_talk:juan (timeline defaults to main).");
    }
    const [timeline, group, angle] = parts.length === 3 ? parts : ["main", parts[0]!, parts[1]!];
    return { angle: { timeline: timeline!, group: group!, angle: angle! } };
  }
  const spelled = options.face!;
  const at = spelled.lastIndexOf("@");
  const bad = () => new UsageError("--face takes <asset>@<seconds>[:x,y], e.g. assets/ep1.mp4@12.5:0.41,0.33 (x,y: fractions of the picture, default 0.5,0.5).");
  if (at <= 0) throw bad();
  const [seconds, point, ...extra] = spelled.slice(at + 1).split(":");
  if (extra.length > 0 || seconds === undefined || seconds.trim() === "") throw bad();
  const time = Number(seconds);
  if (!Number.isFinite(time) || time < 0) throw bad();
  if (point === undefined) return { face: { asset: spelled.slice(0, at), at: time } };
  const xy = point.split(",").map((part) => (part.trim() === "" ? Number.NaN : Number(part)));
  if (xy.length !== 2 || xy.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) throw bad();
  return { face: { asset: spelled.slice(0, at), at: time, x: xy[0]!, y: xy[1]! } };
}

/** Run a parsed `people` command; returns stdout text. `onProgress` follows `scan`, `suggest` and `confirm` (model downloads, scan and voice-print progress). */
export async function executePeople(conn: DaemonConnection, inv: PeopleInvocation, cwd: string, json: boolean, onProgress?: (progress: Progress) => void): Promise<string> {
  const print = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  switch (inv.kind) {
    case "people.list": {
      const result = await conn.request("people.list", { cwd });
      return json ? print(result) : formatPeople(result);
    }
    case "people.add": {
      const result = await conn.request("people.add", { cwd, name: inv.name });
      return json ? print(result) : `Added ${result.person.name} (${result.person.id})\n`;
    }
    case "people.rename": {
      const result = await conn.request("people.rename", { cwd, person: inv.person, name: inv.name });
      if (json) return print(result);
      return (
        `Renamed ${result.previous} to ${result.person.name} (${result.person.id})\n` +
        result.transcripts.map((file) => `  speaker name written in ${file}\n`).join("") +
        result.skipped.map((entry) => `  warning: ${entry.transcript}: ${entry.reason}\n`).join("")
      );
    }
    case "people.remove": {
      const result = await conn.request("people.remove", { cwd, person: inv.person });
      return json ? print(result) : `Removed ${result.removed.name} (${result.removed.id}) and ${linkCount(result.removed)}\n`;
    }
    case "people.scan": {
      const params = inv.assets.length > 0 ? { assets: inv.assets.map((asset) => resolve(cwd, asset)) } : {};
      const result = await conn.request("people.scan", { cwd, ...params }, onProgress ? { onProgress } : {});
      return json ? print(result) : formatScan(result);
    }
    case "people.link": {
      const result = await conn.request("people.link", { cwd, person: inv.person, ...targetParams(inv.target, cwd) });
      if (json) return print(result);
      return (
        `${result.linked ? "Linked" : "Already linked:"} ${describeTarget(inv.target)} to ${result.person.name} (${result.person.id})\n` +
        result.transcripts.map((file) => `  speaker name written in ${file}\n`).join("")
      );
    }
    case "people.unlink": {
      const result = await conn.request("people.unlink", { cwd, person: inv.person, ...targetParams(inv.target, cwd) });
      return json ? print(result) : `Unlinked ${describeTarget(inv.target)} from ${result.person.name} (${result.person.id})\n`;
    }
    case "people.ranges": {
      const result = await conn.request("people.ranges", { cwd, person: inv.person, kind: inv.onScreen ? "onscreen" : "speaks", ...(inv.timeline ? { timeline: inv.timeline } : {}) });
      if (json) return print(result);
      const verb = result.kind === "speaks" ? "speaks" : "is on screen";
      const lines = result.spans.map((span) => `  ${span.start.toFixed(2)} - ${span.end.toFixed(2)} s`);
      return (
        `${result.person.name} ${verb} in ${result.timeline}: ${result.spans.length} span${result.spans.length === 1 ? "" : "s"}, ${result.total.toFixed(2)} s\n` +
        lines.map((line) => `${line}\n`).join("") +
        result.warnings.map((warning) => `  warning: ${warning}\n`).join("") +
        (result.spans.length > 1 ? "Times are timeline seconds now: ripple-cut from the last span to the first.\n" : "")
      );
    }
    case "people.suggest": {
      const result = await conn.request("people.suggest", { cwd }, onProgress ? { onProgress } : {});
      return json ? print(result) : formatSuggestions(result);
    }
    case "people.tune": {
      const result = await conn.request("people.tune", { cwd });
      return json ? print(result) : formatTune(result);
    }
    case "people.confirm": {
      const result = await conn.request(
        "people.confirm",
        { cwd, suggestions: inv.suggestions, reject: inv.reject, ...(inv.person !== undefined ? { person: inv.person } : {}) },
        onProgress ? { onProgress } : {},
      );
      if (json) return print(result);
      if (inv.reject) return `Dismissed ${result.dismissed.length} suggestion${result.dismissed.length === 1 ? "" : "s"}${result.dismissed.length < inv.suggestions.length ? " (the others were already dismissed)" : ""}\n`;
      return result.confirmed
        .map((entry) => {
          const what = [
            ...(entry.speaker ? [`speaker ${entry.speaker.speaker} of ${entry.speaker.transcript}`] : []),
            ...(entry.face ? [`the face at ${entry.face.asset} ${entry.face.at} s`] : []),
          ].join(" and ");
          return (
            (entry.added ? `Added ${entry.person.name} (${entry.person.id})\n` : "") +
            `${entry.linked ? "Linked" : "Already linked:"} ${what} to ${entry.person.name} (${entry.person.id})\n` +
            entry.transcripts.map((file) => `  speaker name written in ${file}\n`).join("")
          );
        })
        .join("");
    }
  }
}

/** `people scan`: one line per video, then warnings. */
function formatScan(result: MethodResult<"people.scan">): string {
  if (result.assets.length === 0 && result.warnings.length === 0) return "No videos to scan. Import some: frameshell import <file>\n";
  const lines = result.assets.map((entry) => `${entry.asset}  ${entry.cached ? "cached" : "scanned"} · ${entry.samples} frames · ${entry.tracks} face track${entry.tracks === 1 ? "" : "s"} · ${entry.embeddings} face print${entry.embeddings === 1 ? "" : "s"}`);
  return `${[...lines, ...result.warnings.map((warning) => `warning: ${warning}`)].join("\n")}\n`;
}

function targetParams(target: PeopleTargetInput, cwd: string): Pick<MethodParams<"people.link">, "speaker" | "angle" | "face"> {
  if ("speaker" in target) return { speaker: { ...target.speaker, transcript: resolve(cwd, target.speaker.transcript) } };
  if ("face" in target) return { face: { ...target.face, asset: resolve(cwd, target.face.asset) } };
  return target;
}

function describeTarget(target: PeopleTargetInput): string {
  if ("speaker" in target) return target.speaker.speaker ? `speaker ${target.speaker.speaker} of ${target.speaker.transcript}` : `all of ${target.speaker.transcript}`;
  if ("angle" in target) return `angle ${target.angle.angle} of group ${target.angle.group} (${target.angle.timeline})`;
  return `the face at ${target.face.asset} ${target.face.at} s`;
}

function linkCount(person: PersonInfo): string {
  const count = person.speakers.length + person.angles.length + person.faces.length;
  return `${count} link${count === 1 ? "" : "s"}`;
}

/** `people tune` for people: score spreads, then each sweep as a table; `*` marks the constants now. */
export function formatTune(result: MethodResult<"people.tune">): string {
  const lines: string[] = [];
  const spread = (label: string, d: TuneDistribution | null) =>
    lines.push(d ? `  ${label.padEnd(10)} n=${d.count}  min ${d.min.toFixed(2)}  p10 ${d.p10.toFixed(2)}  median ${d.median.toFixed(2)}  p90 ${d.p90.toFixed(2)}  max ${d.max.toFixed(2)}` : `  ${label.padEnd(10)} none`);
  const gap = (value: number | null) => lines.push(`  gap        ${value === null ? "n/a" : value.toFixed(2)} (lowest same-person minus highest different-person score; above 0 one line separates them)`);
  if (result.voice) {
    const v = result.voice;
    lines.push(`Voices: ${v.speakers} linked speakers of ${v.people} people (${v.usable} with another print of their person to match)`);
    spread("same", v.same);
    spread("different", v.different);
    gap(v.gap);
    spread("margin", v.margin);
    lines.push(`  now: SPEAKER_MATCH ${v.current.match}, SPEAKER_MARGIN ${v.current.margin}; ${v.wrong.length} wrong suggestion${v.wrong.length === 1 ? "" : "s"}`);
    for (const wrong of v.wrong) lines.push(`    ${wrong.subject} is ${wrong.expected}, suggested ${wrong.suggested} (${wrong.score.toFixed(2)})`);
    lines.push("", ...sweepTable("match", v.rows, v.current), "");
  }
  if (result.faces) {
    const f = result.faces;
    lines.push(`Faces: ${f.tracks} anchored face tracks of ${f.people} people`);
    spread("same", f.same);
    spread("different", f.different);
    gap(f.gap);
    lines.push("", `  cluster cut (FACE_CLUSTER_MATCH, now ${f.clusterCurrent}): purity 1 = no cluster mixes people`);
    lines.push("    match  clusters  purity  mixed  splits");
    for (const row of f.clusterRows) {
      const mark = row.match === f.clusterCurrent ? "*" : " ";
      lines.push(`  ${mark} ${row.match.toFixed(2)}  ${String(row.clusters).padStart(8)}  ${row.purity === null ? "   n/a" : row.purity.toFixed(3).padStart(6)}  ${String(row.mixed).padStart(5)}  ${String(row.splits).padStart(6)}`);
    }
    const p = f.person;
    lines.push("", `  face to person: ${p.clusters} clusters with one anchored person, ${p.usable} with that person elsewhere to match`);
    spread("margin", p.margin);
    lines.push(`  now: FACE_PERSON_MATCH ${p.current.match}, FACE_PERSON_MARGIN ${p.current.margin}; ${p.wrong.length} wrong suggestion${p.wrong.length === 1 ? "" : "s"}`);
    for (const wrong of p.wrong) lines.push(`    ${wrong.subject} is ${wrong.expected}, suggested ${wrong.suggested} (${wrong.score.toFixed(2)})`);
    lines.push("", ...sweepTable("match", p.rows, p.current));
  }
  if (!result.voice && !result.faces) lines.push("Nothing to tune yet.");
  if (result.hints.length > 0) lines.push("", ...result.hints.map((hint) => `hint: ${hint}`));
  lines.push("", `Read in ${result.timings.voicesMs} ms (voices), ${result.timings.facesMs} ms (faces); sweeps ${result.timings.sweepMs} ms. Nothing was changed. --json has every score.`);
  return `${lines.join("\n")}\n`;
}

/** A sweep as a grid, one line per match and one column per margin: `correct/wrong` suggestions; `*` marks the current line. */
function sweepTable(title: string, rows: readonly TuneSweepRow[], current: { match: number; margin: number }): string[] {
  const margins = [...new Set(rows.map((row) => row.margin))];
  const matches = [...new Set(rows.map((row) => row.match))];
  const star = (match: number, margin = current.margin) => (match === current.match && margin === current.margin ? "*" : " ");
  const cell = (match: number, margin: number) => {
    const row = rows.find((candidate) => candidate.match === match && candidate.margin === margin)!;
    return `${row.correct}/${row.wrong}${star(match, margin)}`.padStart(9);
  };
  const out = [`  correct/wrong suggestions; ${title} down, margin across`, `  ${title.padEnd(6)}${margins.map((margin) => margin.toFixed(2).padStart(9)).join("")}`];
  for (const match of matches) out.push(`  ${match.toFixed(2).padEnd(6)}${margins.map((margin) => cell(match, margin)).join("")}`);
  const percent = (value: number | null) => (value === null ? "n/a" : `${Math.round(value * 100)}%`).padStart(9);
  out.push("", `  at margin ${current.margin}:`, "    match  suggested  correct  wrong  precision   recall");
  for (const row of rows.filter((candidate) => candidate.margin === current.margin)) {
    out.push(`  ${star(row.match)} ${row.match.toFixed(2)}  ${String(row.suggested).padStart(9)}  ${String(row.correct).padStart(7)}  ${String(row.wrong).padStart(5)}  ${percent(row.precision)}  ${percent(row.recall)}`);
  }
  return out;
}

/** `people suggest` for people: one line per suggestion with its id, then the hints. */
function formatSuggestions(result: MethodResult<"people.suggest">): string {
  const lines = result.suggestions.length === 0 ? ["No suggestions."] : result.suggestions.map((suggestion) => `${suggestion.id}  ${suggestion.reason}`);
  if (result.suggestions.length > 0) lines.push("", "Yes: frameshell people confirm <id>…   No: frameshell people confirm <id>… --reject");
  if (result.suggestions.some((suggestion) => !suggestion.person && suggestion.kind !== "angle")) lines.push("Naming nobody: frameshell people confirm <id> --person <name>");
  if (result.hints.length > 0) lines.push("", ...result.hints.map((hint) => `hint: ${hint}`));
  return `${lines.join("\n")}\n`;
}

/** `people list` for people: each person with their links, missing ones marked with why. */
function formatPeople(result: MethodResult<"people.list">): string {
  if (result.people.length === 0) return "No people yet. Add one: frameshell people add <name>\n";
  const tail = (link: { by?: string | undefined; missing: boolean; reason?: string | undefined }) =>
    `${link.by ? `  (by ${link.by})` : ""}${link.missing ? `  MISSING: ${link.reason ?? "gone"}` : ""}`;
  const lines: string[] = [];
  for (const person of result.people) {
    lines.push(`${person.name} (${person.id})`);
    if (linkCount(person) === "0 links") lines.push("  no links");
    for (const link of person.speakers) lines.push(`  speaker  ${link.transcript}${link.speaker ? `:${link.speaker}` : " (all)"}${tail(link)}`);
    for (const link of person.angles) lines.push(`  angle    ${link.timeline}:${link.group}:${link.angle}${tail(link)}`);
    for (const link of person.faces) lines.push(`  face     ${link.asset}@${link.at}:${link.x},${link.y}${tail(link)}`);
  }
  const missing = result.people.reduce((sum, person) => sum + [...person.speakers, ...person.angles, ...person.faces].filter((link) => link.missing).length, 0);
  if (missing > 0) lines.push("", `${missing} link${missing === 1 ? "" : "s"} missing: ignored, kept in people.json (a later run may bring them back).`);
  return `${lines.join("\n")}\n`;
}
