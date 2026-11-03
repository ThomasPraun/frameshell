// "Chat about this" (SPEC decision 21, ADR 0025): one command, run from Cmd/Ctrl+L or any panel's context menu, with "Copy reference".
import type { ClipRenderInfo } from "@frameshell/protocol";
import type { MouseEvent } from "react";
import { type MenuItem, contextMenu } from "../components/ContextMenu.js";
import { SELECTION_TIMELINE, type Selection, selection } from "../selection.js";
import { timelineSnapshot } from "../timeline/useTimelineView.js";
import { t } from "../i18n.js";
import { windowOf } from "../windows.js";
import { referenceLines } from "./reference.js";

const isMac = navigator.userAgent.includes("Mac");

/** Shortcut as menus show it. */
export const ASK_SHORTCUT = isMac ? "⌘L" : "Ctrl+L";

/** What the workspace does for the command: send the reference to the agent target, or put it on the clipboard. */
export interface AskHandlers {
  run(extra: readonly string[]): void;
  copy(): void;
}

let handlers: AskHandlers | null = null;

/**
 * The command. The workspace installs what it does (it owns the terminal
 * panel and its collapsed state); panels only call {@link askAgent.run}.
 */
export const askAgent = {
  /** Chat about the current selection, with `extra` lines (a request) after its reference; no-op before the workspace is up. */
  run(extra: readonly string[] = []): void {
    handlers?.run(extra);
  },
  /** Put the current selection's reference on the clipboard (the same lines {@link askAgent.run} types); no-op before the workspace is up. */
  copy(): void {
    handlers?.copy();
  },
  /** Make `next` the command; returns an uninstall function. */
  install(next: AskHandlers): () => void {
    handlers = next;
    return () => {
      if (handlers === next) handlers = null;
    };
  },
};

/** True when `current` holds anything a reference can name. */
export function hasSelection(current: Selection): boolean {
  return (
    current.clips.length > 0 ||
    current.words.length > 0 ||
    current.range !== null ||
    current.history !== null ||
    current.files.length > 0 ||
    current.scene !== null ||
    current.region !== null ||
    current.points.length > 0 ||
    current.person !== null ||
    current.track !== null
  );
}

/**
 * Reference lines of the current selection, on the shared timeline feed's
 * latest revision. A preview region, and every point picked with the Pick
 * tool, first gets its frame captured by the daemon; when that fails the line
 * goes without it and `warning` says why. The capture waits for every
 * generated clip's render, so while one is queued, rendering or failed the
 * line says `frame pending` instead and is typed at once (ADR 0011): the
 * agent captures the frame later. Points, and a region with elements, get a
 * details file under `.frameshell/context/` with everything the line shortens.
 */
export async function composeReference(): Promise<{ lines: string[]; warning: string | null }> {
  const current = selection.get();
  const view = timelineSnapshot(SELECTION_TIMELINE);
  const warnings: string[] = [];
  const times = current.points.length > 0 ? [...new Set(current.points.map((point) => point.at))] : current.region ? [current.region.at] : [];
  if (times.length === 0) return { lines: referenceLines(current, view), warning: null };

  const renders = await clipRenders();
  const framePending = renders.some((clip) => clip.state === "queued" || clip.state === "rendering" || clip.state === "failed");
  const sources = new Map(renders.filter((clip) => clip.source).map((clip) => [clip.clip, clip.source!]));
  const frames = new Map<number, string>();
  if (!framePending) {
    for (const at of times) {
      try {
        frames.set(at, await window.frameshell.context.captureFrame(at));
      } catch (error) {
        warnings.push(t.workspace.frameNotCaptured((error as Error).message));
        break;
      }
    }
  }

  const fps = view?.fps ?? 30;
  const name = (at: number, n: number) => `e_${String(Math.max(0, Math.floor(at * fps + 1e-6))).padStart(4, "0")}_${n}.json`;
  const write = async (file: string, content: object): Promise<string | null> => {
    try {
      return await window.frameshell.context.writeDetails(file, `${JSON.stringify(content, null, 2)}\n`);
    } catch (error) {
      warnings.push(t.workspace.detailsNotSaved((error as Error).message));
      return null;
    }
  };
  const details: (string | null)[] = [];
  if (current.points.length > 0) {
    for (const [index, point] of current.points.entries()) {
      details.push(await write(name(point.at, index + 1), { kind: "point", timeline: SELECTION_TIMELINE, ...point }));
    }
  } else if (current.region && current.region.elements.length > 0) {
    details.push(await write(name(current.region.at, 1), { kind: "region", timeline: SELECTION_TIMELINE, ...current.region }));
  }

  const frame = current.region ? (frames.get(current.region.at) ?? null) : null;
  const lines = referenceLines(current, view, { frame, frames, framePending, details, sources });
  return { lines, warning: warnings.length > 0 ? [...new Set(warnings)].join(" ") : null };
}

/** `clip.renders` of the selection's timeline; empty when the daemon cannot say (the capture then says what is wrong). */
async function clipRenders(): Promise<ClipRenderInfo[]> {
  try {
    return (await window.frameshell.clips.renders(SELECTION_TIMELINE)).clips;
  } catch {
    return [];
  }
}

/**
 * "Chat about this" and "Copy reference" for the current selection, both
 * disabled with nothing selected. Menus that open through `contextMenu`
 * directly put these first, after selecting what was right-clicked.
 */
export function askItems(): MenuItem[] {
  const disabled = !hasSelection(selection.get());
  return [
    { label: t.workspace.chatAboutThis, shortcut: ASK_SHORTCUT, disabled, run: () => askAgent.run() },
    { label: t.workspace.copyReference, disabled, run: () => askAgent.copy() },
  ];
}

/**
 * Open the context menu with {@link askItems} at the pointer. Call after the
 * panel has selected what was right-clicked. `extra` entries (the panel's own
 * commands) follow it.
 */
export function openAskMenu(event: MouseEvent, extra: readonly MenuItem[] = []): void {
  event.preventDefault();
  contextMenu.open(event.clientX, event.clientY, [...askItems(), ...extra], windowOf(event.target));
}
