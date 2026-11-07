import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DaemonConnection, connectToDaemon } from "@frameshell/protocol";
import { parseShootScript } from "@frameshell/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/index.js";
import { type HeardWord, compareTake } from "../src/shoot/compare.js";
import { scriptSuggestions } from "../src/people/script-suggest.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// Calls in a shoot (ADR 0024 decision 8): the voices of a take's transcripts are tied to the shoot script's
// `**Name:**` people through `people.json` suggestions, and `speaker` deviations then name those people.

const SCRIPT = ["---", "shoot: true", "---", "## Talk", "**Ana:** Cuántas pestañas tenés abiertas ahora", "**Juan:** Ninguna la vas a leer nunca"].join("\n");
const ANA = "cuántas pestañas tenés abiertas ahora";
const JUAN = "ninguna la vas a leer nunca";

describe("compareTake voices", () => {
  it("counts each voice's words in the lines of each script person", () => {
    const word = (text: string, i: number, speaker?: string): HeardWord => ({
      text,
      start: i * 0.4,
      end: i * 0.4 + 0.35,
      speaker: null,
      voice: { transcript: "transcripts/system.words.json", ...(speaker ? { speaker } : {}) },
    });
    const heard = [...ANA.split(" ").map((text, i) => word(text, i, "s1")), ...JUAN.split(" ").map((text, i) => word(text, i + 5, i === 0 ? undefined : "s2"))];
    const { voices } = compareTake(parseShootScript(SCRIPT), heard, "es");
    expect(voices).toEqual([
      { transcript: "transcripts/system.words.json", name: "Juan", words: 1 },
      { transcript: "transcripts/system.words.json", speaker: "s1", name: "Ana", words: 5 },
      { transcript: "transcripts/system.words.json", speaker: "s2", name: "Juan", words: 5 },
    ]);
    expect(compareTake(parseShootScript(SCRIPT.replace("shoot: true", "shoot: true\nfollow: topics")), heard, "es").voices).toEqual([]);
  });
});

describe("scriptSuggestions", () => {
  const transcript = (speakers: boolean) => ({ asset: "assets/x.m4a", speakers: speakers ? [{ id: "s1", name: "Speaker 1" }] : [] }) as never;
  const people = [{ id: "p_ana000", name: "ana", speakers: [], angles: [], faces: [] }];

  it("suggests a voice holding most words of one person's lines, and hints at speakers for a mixed whole transcript", () => {
    const transcripts = new Map([
      ["transcripts/a.words.json", transcript(true)],
      ["transcripts/b.words.json", transcript(false)],
      ["transcripts/c.words.json", transcript(false)],
    ]);
    const { suggestions, hints } = scriptSuggestions({
      people,
      transcripts,
      voices: [
        { script: "scripts/s.md", transcript: "transcripts/a.words.json", speaker: "s1", name: "Ana", words: 9 },
        { script: "scripts/s.md", transcript: "transcripts/a.words.json", speaker: "s1", name: "Juan", words: 1 },
        { script: "scripts/s.md", transcript: "transcripts/a.words.json", name: "Juan", words: 3 },
        { script: "scripts/s.md", transcript: "transcripts/b.words.json", name: "Juan", words: 6 },
        { script: "scripts/s.md", transcript: "transcripts/c.words.json", name: "Ana", words: 4 },
        { script: "scripts/s.md", transcript: "transcripts/c.words.json", name: "Juan", words: 4 },
      ],
    });
    expect(suggestions).toMatchObject([
      { kind: "script", person: { id: "p_ana000", name: "ana" }, speaker: { transcript: "transcripts/a.words.json", speaker: "s1", name: "Speaker 1" }, score: 0.9, links: ["speaker"] },
      { kind: "script", speaker: { transcript: "transcripts/b.words.json" }, script: { script: "scripts/s.md", name: "Juan", words: 6 }, score: 1 },
    ]);
    expect(suggestions[1]!.person).toBeUndefined();
    expect(hints).toEqual(["assets/x.m4a says the lines of Ana, Juan in scripts/s.md, with no speakers to tell them apart: frameshell transcribe --speakers assets/x.m4a"]);
  });

  it("leaves out linked voices and voices with too few words", () => {
    const transcripts = new Map([["transcripts/a.words.json", transcript(true)]]);
    const linked = [{ ...people[0]!, speakers: [{ transcript: "transcripts/a.words.json", speaker: "s1" }] }];
    const voices = [{ script: "scripts/s.md", transcript: "transcripts/a.words.json", speaker: "s1", name: "Juan", words: 9 }];
    expect(scriptSuggestions({ people: linked, transcripts, voices }).suggestions).toEqual([]);
    expect(scriptSuggestions({ people, transcripts, voices: [{ ...voices[0]!, words: 4 }] }).suggestions).toEqual([]);
  });
});

describe("people.suggest kind script", () => {
  let daemon: Daemon;
  let conn: DaemonConnection;
  let root: string;

  beforeEach(async () => {
    daemon = await startDaemon({ socketPath: uniqueSocketPath(), idleTimeoutMs: Number.POSITIVE_INFINITY });
    conn = await connectToDaemon(daemon.socketPath, { client: "test" });
    root = join(tempDir(), "call");
    await conn.request("project.init", { dir: root });
    for (const dir of ["scripts", "transcripts"]) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, "scripts", "talk.md"), SCRIPT);
  });

  afterEach(async () => {
    conn.close();
    await daemon.close();
  });

  /** A call recording whose diarized transcript has `s1` say Ana's line and `s2` Juan's. */
  function call(): string {
    const bytes = "fake call audio";
    writeFileSync(join(root, "assets", "system.m4a"), bytes);
    const said = [...ANA.split(" ").map((text) => ({ text, speaker: "s1" })), ...JUAN.split(" ").map((text) => ({ text, speaker: "s2" }))];
    const words = said.map((word, i) => ({ id: `w_${String(i + 1).padStart(6, "0")}`, text: word.text, start: i * 0.4, end: i * 0.4 + 0.35, speaker: word.speaker }));
    const transcript = {
      schemaVersion: 1,
      asset: "assets/system.m4a",
      assetHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      provider: "test",
      model: "test",
      language: "es",
      speakers: [
        { id: "s1", name: "Speaker 1" },
        { id: "s2", name: "Speaker 2" },
      ],
      words,
    };
    writeFileSync(join(root, "transcripts", "system.words.json"), JSON.stringify(transcript));
    return "assets/system.m4a";
  }

  it("links each call voice to the script person whose lines it says, and the speaker deviations follow the links", async () => {
    const added = await conn.request("shoot.add", { cwd: root, script: "scripts/talk.md", asset: call() });
    expect(added.take.deviations.filter((d) => d.kind === "speaker").map((d) => [d.expected, d.heard])).toEqual([
      ["Ana", "Speaker 1"],
      ["Juan", "Speaker 2"],
    ]);

    const suggested = await conn.request("people.suggest", { cwd: root, download: false });
    const scripts = suggested.suggestions.filter((suggestion) => suggestion.kind === "script");
    expect(scripts.map((suggestion) => [suggestion.speaker?.speaker, suggestion.script?.name, suggestion.person])).toEqual([
      ["s1", "Ana", undefined],
      ["s2", "Juan", undefined],
    ]);

    const confirmed = await conn.request("people.confirm", { cwd: root, suggestions: scripts.map((suggestion) => suggestion.id) });
    expect(confirmed.confirmed.map((entry) => [entry.person.name, entry.added, entry.speaker])).toEqual([
      ["Ana", true, { transcript: "transcripts/system.words.json", speaker: "s1" }],
      ["Juan", true, { transcript: "transcripts/system.words.json", speaker: "s2" }],
    ]);
    const status = await conn.request("shoot.status", { cwd: root, script: "scripts/talk.md" });
    expect(status.takes[0]!.deviations.filter((d) => d.kind === "speaker")).toEqual([]);
    expect((await conn.request("people.suggest", { cwd: root, download: false })).suggestions.filter((suggestion) => suggestion.kind === "script")).toEqual([]);
  });

  it("names the person linked to a speaker even when the transcript's own name says otherwise", async () => {
    await conn.request("shoot.add", { cwd: root, script: "scripts/talk.md", asset: call() });
    await conn.request("people.add", { cwd: root, name: "Juan" });
    await conn.request("people.link", { cwd: root, person: "Juan", speaker: { transcript: "transcripts/system.words.json", speaker: "s1" } });
    // A hand edit puts the old name back into the transcript; the link still says who it is.
    call();
    const status = await conn.request("shoot.status", { cwd: root, script: "scripts/talk.md" });
    expect(status.takes[0]!.deviations.filter((d) => d.kind === "speaker").map((d) => [d.expected, d.heard])).toEqual([
      ["Ana", "Juan"],
      ["Juan", "Speaker 2"],
    ]);
  });
});
