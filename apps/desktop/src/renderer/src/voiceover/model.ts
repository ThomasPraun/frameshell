// What the voiceover dialog shows (ADR 0034 decision 22), from the daemon's results; pure, so it is tested without the app.
import type { VoiceoverGenerateResult } from "@frameshell/protocol";
import type { Dict } from "../../../shared/i18n/index.js";
import type { VoiceoverPlaceRun, VoiceoverProgress } from "../../../shared/api.js";

/** The dialog's strings. */
export type VoiceoverStrings = Dict["voiceover"];

/** Whether the person's generation asked for the misread check: yes, it could not be offered (no usable transcription), or they skipped its download. */
export type CheckAsked = "yes" | "unavailable" | "declined";

type Line = VoiceoverGenerateResult["lines"][number];

/** One line of the report. */
export interface LineRow {
  id: string;
  /** Place in the script, 1-based: how the dialog names the line. */
  number: number;
  /** The take, project-relative. */
  file: string;
  display: string;
  state: Line["state"];
  /** The misread check of the line; `none` when it did not run. */
  status: "clean" | "doubtful" | "misread" | "none";
  misreads: { kind: string; expected: string; heard: string; maybeTranscription: boolean }[];
}

/** The lines of a result as report rows, in script order. */
export function lineRows(result: VoiceoverGenerateResult): LineRow[] {
  return result.lines.map((line, index) => ({
    id: line.id,
    number: index + 1,
    file: line.file,
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

/** The sentence under a running generation's progress bar: lines by number, never by id (#756). */
export function progressText(progress: VoiceoverProgress | null, said: VoiceoverStrings): string {
  if (!progress) return said.working;
  switch (progress.stage) {
    case "confirm":
      return said.confirmWait;
    case "download":
      return said.downloading;
    case "speak":
      return progress.place ? said.saying(progress.place.index, progress.place.total) : said.working;
    case "verify":
      return progress.place ? said.checking(progress.place.index, progress.place.total) : said.checkingAll;
  }
}

/** The part of a line's heard-versus-script difference the report prints, one `Script: … · Heard: …` per difference. */
export function differenceText(misread: LineRow["misreads"][number], said: VoiceoverStrings): string {
  const kind = said.misreadKind[misread.kind as keyof VoiceoverStrings["misreadKind"]] ?? misread.kind;
  const heard = misread.heard === "" ? "" : ` · ${said.heard}: ${misread.heard}`;
  return `${kind}: ${said.expected}: ${misread.expected}${heard}${misread.maybeTranscription ? ` (${said.maybeTranscription})` : ""}`;
}

/** Why placing was refused, as the dialog says it. */
export function refusalText(reason: Extract<VoiceoverPlaceRun, { status: "refused" }>["reason"], said: VoiceoverStrings): string {
  switch (reason.kind) {
    case "replace":
      return said.refused.replace;
    case "before-zero":
      return said.refused.beforeZero;
    case "no-tempo":
      return said.refused.noTempo;
    case "unknown-time":
      return said.refused.unknownTime(reason.value);
    case "other":
      return reason.message;
  }
}
