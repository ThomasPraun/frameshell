// What the voiceover dialog shows (ADR 0034 decision 22), from the daemon's results; pure, so it is tested without the app.
import type { VoiceoverGenerateResult } from "@frameshell/protocol";
import type { Dict } from "../../../shared/i18n/index.js";
import type { VoiceoverProgress } from "../../../shared/api.js";

/** The dialog's strings. */
export type VoiceoverStrings = Dict["voiceover"];

/** Whether the person's generation asked for the misread check: yes, it could not be offered (no usable transcription), or they skipped its download. */
export type CheckAsked = "yes" | "unavailable" | "declined";

type Line = VoiceoverGenerateResult["lines"][number];

/** One line of the report. */
export interface LineRow {
  id: string;
  display: string;
  state: Line["state"];
  /** The misread check of the line; `none` when it did not run. */
  status: "clean" | "doubtful" | "misread" | "none";
  misreads: { kind: string; expected: string; heard: string; maybeTranscription: boolean }[];
}

/** The lines of a result as report rows, in script order. */
export function lineRows(result: VoiceoverGenerateResult): LineRow[] {
  return result.lines.map((line) => ({
    id: line.id,
    display: line.display,
    state: line.state,
    status: line.check?.status ?? "none",
    misreads: (line.check?.misreads ?? []).map(({ kind, expected, heard, maybeTranscription }) => ({ kind, expected, heard, maybeTranscription })),
  }));
}

/** How many lines the call said now (`generated`, `copied`) and how many it found already there. */
export function lineCounts(result: VoiceoverGenerateResult): { generated: number; reused: number } {
  const generated = result.lines.filter((line) => line.state !== "cached").length;
  return { generated, reused: result.lines.length - generated };
}

/** What the report says about the misread check. */
export type CheckNote =
  | { kind: "checked"; misread: number; doubtful: number }
  | { kind: "unavailable" }
  | { kind: "declined" }
  | { kind: "why"; reason: string };

/** The check's outcome in words the report can show: it ran, or why it did not (never a failure of the generation). */
export function checkNote(result: VoiceoverGenerateResult, asked: CheckAsked): CheckNote {
  const { verification } = result;
  if (verification.status === "checked") return { kind: "checked", misread: verification.misread, doubtful: verification.doubtful };
  if (asked === "unavailable") return { kind: "unavailable" };
  if (asked === "declined") return { kind: "declined" };
  return { kind: "why", reason: verification.reason ?? "" };
}

/** The sentence under a running generation's progress bar. */
export function progressText(progress: VoiceoverProgress | null, said: VoiceoverStrings): string {
  if (!progress) return said.working;
  switch (progress.stage) {
    case "confirm":
      return said.confirmWait;
    case "download":
      return said.downloading;
    case "speak":
      return progress.line ? said.saying(progress.line) : said.working;
    case "verify":
      return progress.line ? said.checking(progress.line) : said.checkingAll;
  }
}

/** The part of a line's heard-versus-script difference the report prints, one `Script: … · Heard: …` per difference. */
export function differenceText(misread: LineRow["misreads"][number], said: VoiceoverStrings): string {
  const kind = said.misreadKind[misread.kind as keyof VoiceoverStrings["misreadKind"]] ?? misread.kind;
  const heard = misread.heard === "" ? "" : ` · ${said.heard}: ${misread.heard}`;
  return `${kind}: ${said.expected}: ${misread.expected}${heard}${misread.maybeTranscription ? ` (${said.maybeTranscription})` : ""}`;
}
