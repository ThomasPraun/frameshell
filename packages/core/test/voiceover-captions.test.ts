import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DaemonConnection, ErrorCode, RpcError, connectToDaemon } from "@frameshell/protocol";
import { type Timeline, type Transcript, subtitleTracks } from "@frameshell/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Daemon, captionLine, chunkSizes, displayWords, standInSpeechProvider, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { testBinaryManager } from "./media-tools.js";
import { installLocalPlugin } from "./plugin-fixture.js";

// Seams under test: the pure planner of `voiceover.captions` (ADR 0034 decision 23) on synthetic heard words, and the
// method through a real in-process daemon with the stand-in voice (each word a 0.3 s tone, 0.1 s apart: one phrase
// per word) and a transcription plugin that hears what a test lists.

const word = (text: string, start: number, length = 0.3) => ({ text, start, end: start + length });
const BIG = { maxWords: 3, maxChars: 18 };

describe("displayWords", () => {
  it("splits at spaces and joins a token of punctuation only to the word before it", () => {
    expect(displayWords("¿Cuántas — tenés?  Son 23.")).toEqual(["¿Cuántas —", "tenés?", "Son", "23."]);
    expect(displayWords("— Hola")).toEqual(["— Hola"]);
  });
});

describe("chunkSizes", () => {
  it("takes the fewest even cues within the word and character limits, larger first", () => {
    expect(chunkSizes(["a", "b", "c"], BIG)).toEqual([3]);
    expect(chunkSizes(["a", "b", "c", "d"], BIG)).toEqual([2, 2]);
    expect(chunkSizes(["a", "b", "c", "d", "e", "f", "g"], BIG)).toEqual([3, 2, 2]);
    // Two words of 10 characters exceed 18 characters together: one word each.
    expect(chunkSizes(["abcdefghij", "klmnopqrst", "uvwxyzabcd"], BIG)).toEqual([1, 1, 1]);
    expect(chunkSizes(["abcdefg", "hijklmn", "opqrstu"], BIG)).toEqual([2, 1]);
    // A single word longer than the limit is still a cue.
    expect(chunkSizes(["internationalization"], BIG)).toEqual([1]);
  });
});

describe("captionLine", () => {
  const whole = [{ from: 0, to: 1.6 }];

  it("covers every heard word a spelled number was said as with its one display word", () => {
    const line = captionLine(
      { display: "It costs 1,500 dollars.", phrases: [{ from: 0, to: 2.4 }], heard: [word("It", 0.02, 0.15), word("costs", 0.2), word("one", 0.55, 0.2), word("thousand", 0.8), word("five", 1.15, 0.2), word("hundred", 1.4), word("dollars.", 1.8, 0.5)] },
      "en",
      { maxWords: 7, maxChars: 42 },
    );
    expect(line.timing).toBe("heard");
    expect(line.words.map((w) => w.text)).toEqual(["It", "costs", "1,500", "dollars."]);
    expect(line.words[2]).toEqual({ text: "1,500", start: 0.55, end: 1.7 });
    expect(line.missing).toEqual([]);
  });

  it("matches digits the transcription wrote as the number said, and the spelled words the voice read", () => {
    const spelled = captionLine({ display: "Son 23 pestañas.", phrases: whole, heard: [word("Son", 0.02), word("veintitrés", 0.42), word("pestañas.", 0.82)] }, "es", BIG);
    expect(spelled.words.map((w) => [w.text, w.start])).toEqual([["Son", 0.02], ["23", 0.42], ["pestañas.", 0.82]]);
    const digits = captionLine({ display: "Son 23 pestañas.", phrases: whole, heard: [word("Son", 0.02), word("23", 0.42), word("pestañas.", 0.82)] }, "es", BIG);
    expect(digits.words.map((w) => w.start)).toEqual([0.02, 0.42, 0.82]);
    expect(digits.timing).toBe("heard");
  });

  it("finds digits the transcription wrote far from where the spread puts the number", () => {
    // The spread puts "23" at about 0.43 to 1.86 s; it was said at 2.2 s, after a long "Son": out of its slot.
    const line = captionLine(
      { display: "Son 23 pestañas.", phrases: [{ from: 0, to: 3 }], heard: [word("Son", 0.02, 0.98), word("23", 2.2), word("pestañas.", 2.55, 0.4)] },
      "es",
      BIG,
    );
    expect(line.timing).toBe("heard");
    expect(line.missing).toEqual([]);
    expect(line.words[1]).toEqual({ text: "23", start: 2.2, end: 2.5 });
  });

  it("splits one heard word shared by two display words between them", () => {
    const line = captionLine({ display: "We can not stop.", phrases: [{ from: 0, to: 2 }], heard: [word("We", 0.02, 0.2), word("cannot", 0.4, 0.5), word("stop.", 1.1, 0.4)] }, "en", BIG);
    expect(line.timing).toBe("heard");
    const [, can, not] = line.words;
    expect(can).toEqual({ text: "can", start: 0.4, end: 0.65 });
    expect(not).toEqual({ text: "not", start: 0.65, end: 0.9 });
  });

  it("puts a respelled name over the words it was said as", () => {
    const line = captionLine(
      { display: "Frameshell las cierra.", phrases: whole, heard: [word("freim", 0.02, 0.2), word("shel", 0.25, 0.2), word("las", 0.6, 0.2), word("cierra.", 0.9, 0.4)] },
      "es",
      BIG,
    );
    expect(line.words).toEqual([
      { text: "Frameshell", start: 0.02, end: 0.45 },
      { text: "las", start: 0.6, end: 0.8 },
      { text: "cierra.", start: 0.9, end: 1.3 },
    ]);
  });

  it("times a word the voice dropped between its neighbours and lists it", () => {
    const line = captionLine({ display: "One two three four.", phrases: whole, heard: [word("One", 0.02, 0.2), word("two", 0.3, 0.2), word("four.", 0.9, 0.3)] }, "en", BIG);
    expect(line.missing).toEqual(["three"]);
    expect(line.timing).toBe("heard");
    const three = line.words[2]!;
    expect(three.start).toBe(0.5);
    expect(three.end).toBe(0.9);
    expect(line.words.map((w) => w.text)).toEqual(["One", "two", "three", "four."]);
  });

  it("keeps each word in the phrase it starts in and chunks every phrase on its own", () => {
    const phrases = [
      { from: 0, to: 1.1 },
      { from: 1.4, to: 3.1 },
    ];
    const heard = ["We", "build", "it.", "Then", "we", "ship", "it", "every", "week."].map((text, i) => word(text, i < 3 ? 0.02 + i * 0.35 : 1.42 + (i - 3) * 0.28, 0.25));
    const line = captionLine({ display: "We build it. Then we ship it every week.", phrases, heard }, "en", BIG);
    expect(line.phrases).toEqual([
      { phrase: 1, first: 0, chunks: [3] },
      { phrase: 2, first: 3, chunks: [3, 3] },
    ]);
    for (const w of line.words.slice(0, 3)) expect(w.end).toBeLessThanOrEqual(1.1);
    for (const w of line.words.slice(3)) expect(w.start).toBeGreaterThanOrEqual(1.4);
  });

  it("spreads the words over the phrases by the length of what is said when nothing was heard", () => {
    const phrases = [
      { from: 0, to: 1 },
      { from: 1.5, to: 2.5 },
    ];
    const line = captionLine({ display: "Son 23 pestañas.", phrases, heard: null }, "es", BIG);
    expect(line.timing).toBe("proportional");
    expect(line.missing).toEqual([]);
    // "23" is said as "veintitrés": longer than "Son", so it takes more of the time.
    const [son, number, tabs] = line.words;
    expect(son!.start).toBe(0);
    expect(number!.end - number!.start).toBeGreaterThan(son!.end - son!.start);
    expect(tabs!.start).toBeGreaterThanOrEqual(1.5);
    expect(tabs!.end).toBeLessThanOrEqual(2.5);
    expect(line.phrases.map((p) => p.phrase)).toEqual([1, 2]);
  });

  it("spreads a line whose take was heard as other words, and says it was not aligned", () => {
    const line = captionLine({ display: "Son 23 pestañas.", phrases: whole, heard: [word("Hello", 0.02), word("there", 0.5)] }, "es", BIG);
    expect(line.timing).toBe("unaligned");
    expect(line.missing).toEqual([]);
    expect(line.words.map((w) => w.text)).toEqual(["Son", "23", "pestañas."]);
  });
});

const TRANSCRIBE_PLUGIN = fileURLToPath(new URL("./fixtures/transcribe-plugin/", import.meta.url));
const script = (lines: string[]) => ["---", "title: Launch", "voiceover: true", "language: es", "provider: stand-in", "---", ...lines].join("\n");
const LINES = ["## Hook", "Son 23 pestañas.", "## Fix", "{Frameshell|freim shel} las cierra."];
// Where the stand-in says each word of a take: 0.3 s tones 0.1 s apart, 20 ms in.
const at = (index: number) => 0.02 + 0.4 * index;

let daemon: Daemon;
let conn: DaemonConnection;
let root: string;

beforeEach(async () => {
  daemon = await startDaemon({
    socketPath: uniqueSocketPath(),
    idleTimeoutMs: Number.POSITIVE_INFINITY,
    speechProviders: [standInSpeechProvider()],
    dirs: { dataDir: tempDir(), configDir: tempDir() },
    binaries: testBinaryManager(),
  });
  conn = await connectToDaemon(daemon.socketPath, { client: "cli/test", session: "term-1" });
  root = join(tempDir(), "launch");
  await conn.request("project.init", { dir: root });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "launch-vo.md"), script(LINES));
}, 60_000);

afterEach(async () => {
  conn.close();
  await daemon.close();
});

const pluginDir = () => join(root, ".frameshell", "plugins", "node_modules", "transcribe-plugin");
const heard = (...lists: unknown[]) => writeFileSync(join(pluginDir(), "words.json"), JSON.stringify(lists));
const withTranscriber = async () => {
  installLocalPlugin(root, TRANSCRIBE_PLUGIN, "transcribe-plugin");
  const configPath = join(root, "frameshell.json");
  writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, "utf8")), transcription: { provider: "fake-heard" } }));
  await conn.request("project.trust", { cwd: root, decision: "trust" });
};
const generateAndPlace = async () => {
  await conn.request("voiceover.generate", { cwd: root, script: "scripts/launch-vo.md", verify: false });
  await conn.request("voiceover.place", { cwd: root, timeline: "main", script: "scripts/launch-vo.md" });
};
const captions = (params: Record<string, unknown> = {}) => conn.request("voiceover.captions", { cwd: root, timeline: "main", script: "scripts/launch-vo.md", ...params } as never);
const timeline = (): Timeline => JSON.parse(readFileSync(join(root, "timelines", "main.json"), "utf8")) as Timeline;
const transcript = (line: string): Transcript => JSON.parse(readFileSync(join(root, "transcripts", "voiceover", "launch-vo", `${line}.words.json`), "utf8")) as Transcript;
const rejection = async (promise: Promise<unknown>): Promise<RpcError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
};

describe("voiceover.captions", () => {
  it("captions the placed takes in the display form, timed by what was heard, in one transaction", async () => {
    await withTranscriber();
    await generateAndPlace();
    heard([word("Son", at(0)), word("veintitrés", at(1)), word("pestañas.", at(2))], [word("freim", at(0)), word("shel", at(1)), word("las", at(2)), word("cierra.", at(3))]);
    const result = await captions();

    expect(result.timing).toEqual({ status: "heard", provider: "fake-heard", model: "fake-model", reason: null });
    expect(result.track).toMatchObject({ name: "Voiceover captions", created: true });
    expect(result.lines).toEqual([
      { id: "hook-1", timing: "heard", words: 3, chunks: ["Son", "23", "pestañas."], missing: [], placed: true },
      { id: "fix-1", timing: "heard", words: 3, chunks: ["Frameshell", "las", "cierra."], missing: [], placed: true },
    ]);
    expect(result.transcripts).toEqual(["transcripts/voiceover/launch-vo/hook-1.words.json", "transcripts/voiceover/launch-vo/fix-1.words.json"]);

    // The take's transcript holds the display words, the provider that timed them, and nothing the voice read instead.
    const hook = transcript("hook-1");
    expect(hook).toMatchObject({ asset: "assets/voiceover/launch-vo/hook-1.wav", provider: "fake-heard", model: "fake-model", language: "es" });
    expect(hook.words.map((w) => [w.text, w.start])).toEqual([["Son", 0.02], ["23", 0.42], ["pestañas.", 0.82]]);
    expect(transcript("fix-1").words[0]).toMatchObject({ text: "Frameshell", start: 0.02 });

    // The subtitle track follows the voice track and shows the display words, one cue per phrase of the take.
    const written = timeline();
    const voice = written.tracks.find((track) => track.name === "Voiceover")!;
    const subtitles = written.tracks.find((track) => track.id === result.track.id)!;
    expect(subtitles).toMatchObject({ kind: "subtitles", follows: voice.id });
    if (subtitles.kind !== "subtitles") throw new Error("not a subtitle track");
    expect(subtitles.phrases?.map((phrase) => phrase.chunks)).toEqual([[1], [1], [1], [1], [1], [1]]);
    const shown = subtitleTracks(written, (asset) => (asset.endsWith("hook-1.wav") ? hook : asset.endsWith("fix-1.wav") ? transcript("fix-1") : null), 30).find((track) => track.track === subtitles.id)!;
    // The default preset shows them in capitals.
    expect(shown.cues.map((cue) => cue.words.map((w) => w.text).join(" "))).toEqual(["SON", "23", "PESTAÑAS.", "FRAMESHELL", "LAS", "CIERRA."]);

    // One transaction: reverting it takes the track away.
    const { transactions } = await conn.request("history", { cwd: root, timeline: "main" });
    const last = transactions.at(-1)!;
    expect(last).toMatchObject({ tx: result.tx, label: "Voiceover captions: launch-vo (2 lines)" });
    expect(last.operations.map((operation) => operation.op)).toEqual(["track.add", "captions.set"]);

    // Again: the same track, the word ids kept, the phrases replaced rather than added.
    const again = await captions();
    expect(again.track).toMatchObject({ id: result.track.id, created: false });
    expect(transcript("hook-1").words.map((w) => w.id)).toEqual(hook.words.map((w) => w.id));
    const track = timeline().tracks.find((candidate) => candidate.id === result.track.id)!;
    expect(track.kind === "subtitles" && track.phrases?.length).toBe(6);
  }, 60_000);

  it("spreads the words over the phrases and says why when the project cannot transcribe", async () => {
    await generateAndPlace();
    const result = await captions({ lines: ["hook-1"] });
    expect(result.timing.status).toBe("proportional");
    expect(result.timing.reason).toMatch(/^Not transcribed: /);
    expect(result.warnings.some((warning) => warning.includes("spread over each take's phrases"))).toBe(true);
    expect(result.lines).toEqual([{ id: "hook-1", timing: "proportional", words: 3, chunks: ["Son", "23", "pestañas."], missing: [], placed: true }]);
    expect(transcript("hook-1")).toMatchObject({ provider: "voiceover-script", model: "proportional" });
  }, 60_000);

  it("times a take by the heard words its transcript already holds when the project can no longer transcribe", async () => {
    await withTranscriber();
    await generateAndPlace();
    heard([word("Son", at(0)), word("veintitrés", at(1)), word("pestañas.", at(2))]);
    await captions({ lines: ["hook-1"] });
    const timed = transcript("hook-1");
    await conn.request("project.trust", { cwd: root, decision: "deny" });

    const result = await captions({ lines: ["hook-1"] });
    expect(result.timing.status).toBe("proportional");
    expect(result.lines).toEqual([{ id: "hook-1", timing: "heard", words: 3, chunks: ["Son", "23", "pestañas."], missing: [], placed: true }]);
    expect(result.warnings.some((warning) => warning.includes("timed by the words its current transcript holds (fake-heard)"))).toBe(true);
    const kept = transcript("hook-1");
    expect(kept).toMatchObject({ provider: "fake-heard", model: "fake-model" });
    expect(kept.words.map((w) => [w.id, w.start, w.end])).toEqual(timed.words.map((w) => [w.id, w.start, w.end]));
  }, 60_000);

  it("plans without writing on a dry run", async () => {
    await generateAndPlace();
    const before = timeline().revision;
    const result = await captions({ dryRun: true });
    expect(result).toMatchObject({ dryRun: true, tx: null, track: { id: null, created: true } });
    expect(result.lines.map((line) => line.chunks)).toEqual([["Son", "23", "pestañas."], ["Frameshell", "las", "cierra."]]);
    expect(timeline().revision).toBe(before);
    expect(existsSync(join(root, "transcripts", "voiceover", "launch-vo", "hook-1.words.json"))).toBe(false);
  }, 60_000);

  it("refuses takes no clip plays, and a track that is not a subtitle track of the voice", async () => {
    await conn.request("voiceover.generate", { cwd: root, script: "scripts/launch-vo.md", verify: false });
    const unplaced = await rejection(captions());
    expect(unplaced.code).toBe(ErrorCode.InvalidOperation);
    expect(unplaced.message).toContain("run `voiceover.place` first");

    await conn.request("voiceover.place", { cwd: root, timeline: "main", script: "scripts/launch-vo.md" });
    const voice = timeline().tracks.find((track) => track.name === "Voiceover")!;
    const wrong = await rejection(captions({ track: voice.id }));
    expect(wrong.code).toBe(ErrorCode.InvalidOperation);
    expect(wrong.message).toContain("captions go on a subtitle track");
  }, 60_000);

  it("names lines that have no take", async () => {
    const none = await rejection(captions());
    expect(none.code).toBe(ErrorCode.InvalidOperation);
    expect(none.message).toContain("no take for hook-1, fix-1");
  }, 60_000);
});
