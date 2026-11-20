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

/** What the last Open of a desktop app came to, kept until the panel closes or checks again. */
export type LaunchNote =
  /** The app was asked to open; `copied`: the starter phrase is on the clipboard. */
  | { kind: "opened"; copied: boolean }
  | { kind: "not-found" }
  | { kind: "failed"; message: string };

/** What a card shows. */
export interface CardView {
  /** `no-settings`: Open found and started the app, but its settings folder is still missing (#735). */
  kind: "loading" | "working" | "unavailable" | "not-installed" | "no-settings" | "ready" | "different" | "connected";
  /**
   * The Open button (desktop cards only). Shown once connected; and when the app looks not installed, because the
   * settings folder it is judged by only exists after the app ran once, so Open can still work.
   */
  open: boolean;
  /** The Download button, the official page: the app looks not installed, or Open did not find it. */
  download: boolean;
  /** What the last Open came to. */
  launch: LaunchNote | null;
  /** The Connect button: "again" when Frameshell's entry runs another command; null when none shows. */
  connect: "connect" | "again" | null;
  disconnect: boolean;
  /** The last change worked: the app must be restarted to see it. */
  restart: "connected" | "disconnected" | null;
  /** Copies of the files as they were before the last change. */
  backups: readonly string[];
  problem: AiAppProblem | null;
}

/**
 * The card for an app's `status` (undefined while reading), while `working` on a change, after `last` and after the
 * `launch` of its Open.
 */
export function cardView(status: AiAppStatus | undefined, working: boolean, last?: LastChange, launch?: LaunchNote): CardView {
  const none = { open: false, download: false, launch: null, connect: null, disconnect: false, restart: null, backups: [], problem: null } as const;
  if (!status) return { kind: "loading", ...none };
  if (working) return { kind: "working", ...none };
  if (!status.available) return { kind: "unavailable", ...none };
  const problem = last?.change.problem ?? status.problem;
  const after = {
    launch: launch ?? null,
    restart: last && !last.change.problem ? (last.connect ? "connected" : "disconnected") : null,
    backups: last?.change.backups ?? [],
    problem,
  } as const;
  const missing = launch?.kind === "not-found";
  if (status.connected) return { kind: "connected", open: true, download: missing, connect: null, disconnect: true, ...after };
  if (status.different) return { kind: "different", open: false, download: false, connect: "again", disconnect: true, ...after };
  // Open found the app, so the card never says it is not installed (#735); Check again reads the settings once it has started.
  if (!status.installed && launch?.kind === "opened") return { kind: "no-settings", open: true, download: false, connect: null, disconnect: false, ...after };
  if (!status.installed) return { kind: "not-installed", open: true, download: true, connect: null, disconnect: false, ...after };
  return { kind: "ready", open: false, download: false, connect: "connect", disconnect: false, ...after };
}

/** The text to paste into the AI app after Open: it names the open project, with none it asks in general. */
export function starterPhrase(project: string | null, said: { project(name: string): string; general: string }): string {
  return project ? said.project(project) : said.general;
}
