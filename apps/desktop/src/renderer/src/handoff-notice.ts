// File > Export OpenTimelineIO / Export Premiere XML (ADR 0045, 0047): the notice shown once the daemon has written the file.
import type { HandoffKind, MenuCommand } from "../../shared/api.js";

/** The wording {@link handoffNotice} picks from (`t.workspace`). */
export interface HandoffNoticeText {
  handoffExported(name: string): string;
  handoffExportedWith(name: string, count: number, kind: HandoffKind): string;
}

/** The hand-off file a menu command writes; undefined for any other command. */
export function handoffKindOf(command: MenuCommand): HandoffKind | undefined {
  if (command === "exportOtio") return "otio";
  if (command === "exportPremiere") return "premiere";
  return undefined;
}

/** What the notice says of an export: the file's name, and how many things the file leaves out when there are any. */
export function handoffNotice(result: { path: string; warnings: readonly string[] }, kind: HandoffKind, said: HandoffNoticeText): string {
  const name = result.path.split(/[\\/]/).pop() ?? result.path;
  return result.warnings.length === 0 ? said.handoffExported(name) : said.handoffExportedWith(name, result.warnings.length, kind);
}
