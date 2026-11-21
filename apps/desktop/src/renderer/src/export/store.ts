// Export video (#738): the window's one export, outside the view, so the File menu and the preview's button share it.
import { useSyncExternalStore } from "react";
import { SELECTION_TIMELINE } from "../selection.js";
import { shortcutLabel } from "../shortcuts.js";
import { type ExportView, type VideoExport, exportView, heardJob } from "./model.js";

/** File > Export video…'s key, as the tooltip shows it. */
export const EXPORT_VIDEO_SHORTCUT = shortcutLabel("Mod+E");

let current: VideoExport | null = null;
let starting = false;
let error: string | null = null;
let view: ExportView = { kind: "idle" };
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;

function publish(): void {
  view = exportView(current, starting, error);
  for (const listener of listeners) listener();
}

/** Follow the daemon's export jobs once someone looks. */
function follow(): void {
  unsubscribe ??= window.frameshell.timeline.onExportJob((job) => {
    const next = heardJob(current, job);
    if (next === current) return;
    current = next;
    publish();
  });
}

/** The window's video export. */
export const videoExport = {
  /** Ask where, then export the main timeline; does nothing while an export is starting or running. */
  async start(): Promise<void> {
    if (starting || view.kind === "running") return;
    follow();
    starting = true;
    error = null;
    publish();
    try {
      const started = await window.frameshell.timeline.exportVideo(SELECTION_TIMELINE);
      if (started) current = started;
    } catch (failure) {
      error = (failure as Error).message ?? String(failure);
    }
    starting = false;
    publish();
  },
  /** Show the exported file in the file manager. */
  reveal(path: string): void {
    void window.frameshell.timeline.revealExport(path);
  },
  get(): ExportView {
    return view;
  },
  subscribe(listener: () => void): () => void {
    follow();
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** The window's export, followed live. */
export function useVideoExport(): ExportView {
  return useSyncExternalStore(videoExport.subscribe, videoExport.get);
}
