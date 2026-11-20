// "Connect your AI": the rows the panel lists, in which group, and what each card offers for an app's status and the
// last change made from the panel. Pure; the panel is `components/ConnectAi.tsx`, its state `connect/store.ts`.
import type { AiAppChange, AiAppId, AiAppProblem, AiAppStatus } from "../../../shared/api.js";

/** A row of the panel. ChatGPT's desktop app and Codex CLI are two rows of one app: they share one settings file. */
export type RowId = "claude-desktop" | "chatgpt" | "claude-code" | "codex-cli" | "gemini";

/** The big cards, first: apps people who are not developers use. */
export const DESKTOP_ROWS: readonly RowId[] = ["claude-desktop", "chatgpt"];

/** The smaller "For developers" group, after the desktop apps. */
export const DEVELOPER_ROWS: readonly RowId[] = ["claude-code", "codex-cli", "gemini"];

/** The app whose settings a row connects. */
export const ROW_APP: Readonly<Record<RowId, AiAppId>> = {
  "claude-desktop": "claude-desktop",
  chatgpt: "codex",
  "claude-code": "claude-code",
  "codex-cli": "codex",
  gemini: "gemini",
};

/** Connect or Disconnect made from the panel, kept until the panel closes or checks again. */
export interface LastChange {
  connect: boolean;
  change: AiAppChange;
}

/** What a card shows. */
export interface CardView {
  kind: "loading" | "working" | "unavailable" | "not-installed" | "ready" | "different" | "connected";
  /** The Connect button: "again" when Frameshell's entry runs another command; null when none shows. */
  connect: "connect" | "again" | null;
  disconnect: boolean;
  /** The last change worked: the app must be restarted to see it. */
  restart: "connected" | "disconnected" | null;
  /** Copies of the files as they were before the last change. */
  backups: readonly string[];
  problem: AiAppProblem | null;
}

/** The card for an app's `status` (undefined while reading), while `working` on a change, after `last`. */
export function cardView(status: AiAppStatus | undefined, working: boolean, last?: LastChange): CardView {
  const none = { connect: null, disconnect: false, restart: null, backups: [], problem: null } as const;
  if (!status) return { kind: "loading", ...none };
  if (working) return { kind: "working", ...none };
  if (!status.available) return { kind: "unavailable", ...none };
  const problem = last?.change.problem ?? status.problem;
  const after = {
    restart: last && !last.change.problem ? (last.connect ? "connected" : "disconnected") : null,
    backups: last?.change.backups ?? [],
    problem,
  } as const;
  if (status.connected) return { kind: "connected", connect: null, disconnect: true, ...after };
  if (status.different) return { kind: "different", connect: "again", disconnect: true, ...after };
  if (!status.installed) return { kind: "not-installed", connect: null, disconnect: false, ...after };
  return { kind: "ready", connect: "connect", disconnect: false, ...after };
}
