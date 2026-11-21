import type { VoiceoverGenerateResult } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { checkNote, differenceText, lineCounts, lineRows, progressText, refusalText } from "../src/renderer/src/voiceover/model.js";
import { strings } from "../src/shared/i18n/index.js";

const said = strings("en").voiceover;

const verification = (extra: Record<string, unknown>) => ({ status: "skipped", provider: null, model: null, reason: "Verification was not asked for.", misread: 0, doubtful: 0, ...extra });
const line = (id: string, state: "generated" | "cached" | "copied", check: unknown = null) => ({ id, display: `Line ${id}`, file: `assets/voiceover/vo/${id}.wav`, state, check });
const resultOf = (lines: unknown[], checks: Record<string, unknown> = {}) => ({ lines, verification: verification(checks), warnings: [] }) as unknown as VoiceoverGenerateResult;

describe("lineRows", () => {
  it("reads each line's check, or `none` when the check did not run", () => {
    const result = resultOf([
      line("hook-1", "generated", { status: "clean", heard: "Line hook-1", misreads: [] }),
      line("fix-1", "cached", {
        status: "misread",
        heard: "Close them",
        misreads: [{ kind: "missing", expected: "all", heard: "", at: null, maybeTranscription: false }],
      }),
      line("end-1", "copied"),
    ]);
    expect(lineRows(result)).toEqual([
      { id: "hook-1", number: 1, file: "assets/voiceover/vo/hook-1.wav", display: "Line hook-1", state: "generated", status: "clean", misreads: [] },
      { id: "fix-1", number: 2, file: "assets/voiceover/vo/fix-1.wav", display: "Line fix-1", state: "cached", status: "misread", misreads: [{ kind: "missing", expected: "all", heard: "", maybeTranscription: false }] },
      { id: "end-1", number: 3, file: "assets/voiceover/vo/end-1.wav", display: "Line end-1", state: "copied", status: "none", misreads: [] },
    ]);
  });
});

describe("lineCounts", () => {
  it("counts generated and copied lines as said now, cached ones as already there", () => {
    expect(lineCounts(resultOf([line("a", "generated"), line("b", "copied"), line("c", "cached")]))).toEqual({ generated: 2, reused: 1 });
  });
});

describe("checkNote", () => {
  it("counts the lines of a check that ran", () => {
    expect(checkNote(resultOf([], { status: "checked", provider: "whisper-cpp", misread: 1, doubtful: 2, reason: null }), "yes")).toEqual({ kind: "checked", misread: 1, doubtful: 2 });
  });

  it("says why it did not run: the app could not offer it, the person skipped the download, or the daemon skipped it", () => {
    expect(checkNote(resultOf([]), "unavailable")).toEqual({ kind: "unavailable" });
    expect(checkNote(resultOf([]), "declined")).toEqual({ kind: "declined" });
    expect(checkNote(resultOf([], { reason: "Verification skipped: the project is not trusted." }), "yes")).toEqual({ kind: "why", reason: "Verification skipped: the project is not trusted." });
  });
});

describe("progressText", () => {
  it("names what is going on, a line by its number and never its id", () => {
    expect(progressText(null, said)).toBe(said.working);
    expect(progressText({ stage: "speak", line: "hook-1", fraction: 0, place: { index: 1, total: 3 } }, said)).toBe("Saying line 1 of 3…");
    expect(progressText({ stage: "speak", line: "hook-1", fraction: 0, place: null }, said)).toBe(said.working);
    expect(progressText({ stage: "verify", line: "fix-1", fraction: 0.5, place: { index: 2, total: 2 } }, said)).toBe("Checking line 2 of 2 against the script…");
    expect(progressText({ stage: "verify", line: "fix-1", fraction: null, place: null }, said)).toBe(said.checkingAll);
    expect(progressText({ stage: "download", line: null, fraction: 0.1, place: null }, said)).toBe(said.downloading);
    expect(progressText({ stage: "confirm", line: null, fraction: null, place: null }, said)).toBe(said.confirmWait);
  });
});

describe("refusalText", () => {
  it("words each refusal of Place, and keeps any other message", () => {
    expect(refusalText({ kind: "replace" }, said)).toContain("Replace clips already placed");
    expect(refusalText({ kind: "before-zero" }, said)).toBe("Start at 0 seconds or later.");
    expect(refusalText({ kind: "no-tempo" }, said)).toContain("no tempo");
    expect(refusalText({ kind: "unknown-time", value: "intro" }, said)).toContain("“intro”");
    expect(refusalText({ kind: "other", message: "disk full" }, said)).toBe("disk full");
  });
});

describe("differenceText", () => {
  it("puts the script against what was heard, and flags what the transcription may have done", () => {
    expect(differenceText({ kind: "changed", expected: "tabs", heard: "taps", maybeTranscription: true }, said)).toBe("Said as other words: Script: tabs · Heard: taps (maybe the transcription)");
    expect(differenceText({ kind: "missing", expected: "all", heard: "", maybeTranscription: false }, said)).toBe("Not said: Script: all");
  });

  it("speaks Spanish when asked to", () => {
    expect(differenceText({ kind: "added", expected: "", heard: "uh", maybeTranscription: false }, strings("es").voiceover)).toContain("Palabras de más");
  });
});
