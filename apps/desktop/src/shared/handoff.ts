// The editor hand-off files the File menu writes (ADR 0045, 0047): the one table the menu, save dialog, IPC and notice read.
import type { MenuCommand } from "./api.js";

/** The editor hand-off kinds: `otio` (OpenTimelineIO, ADR 0045) and `premiere` (Premiere Pro XML, ADR 0047). */
export const HANDOFF_KINDS = ["otio", "premiere"] as const;

/** An editor hand-off file the File menu writes. */
export type HandoffKind = (typeof HANDOFF_KINDS)[number];

/** What the app needs to know of one hand-off kind. */
export interface HandoffInfo {
  /** The menu command that asks for the file. */
  command: MenuCommand;
  /** Id of the File menu item; image projects disable it. */
  menuId: string;
  /** File extension without the dot: the save dialog offers it and the daemon refuses any other. */
  extension: string;
  /** The daemon method that writes the file. */
  method: "export.otio" | "export.premiereXml";
  /** The `frameshell export <cli>` subcommand that writes the same file and lists what it leaves out. */
  cli: string;
  /** What the file is, as the notice names it (a product name: the same in every language). */
  app: string;
}

/** The hand-off kinds, one entry each. */
export const HANDOFFS: Record<HandoffKind, HandoffInfo> = {
  otio: { command: "exportOtio", menuId: "export-otio", extension: "otio", method: "export.otio", cli: "otio", app: "OpenTimelineIO" },
  premiere: { command: "exportPremiere", menuId: "export-premiere", extension: "xml", method: "export.premiereXml", cli: "premiere", app: "Premiere" },
};

/** True when `value` names a hand-off kind (an IPC argument is untyped at runtime). */
export function isHandoffKind(value: unknown): value is HandoffKind {
  return typeof value === "string" && (HANDOFF_KINDS as readonly string[]).includes(value);
}
