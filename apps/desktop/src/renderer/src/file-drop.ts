import { useEffect, useState } from "react";
import { listenEverywhere } from "./windows.js";
import { t } from "./i18n.js";

/**
 * Accept files dragged in from the OS on every project window (ADR 0012),
 * and call `onDrop` with their absolute paths. Drags from inside the app
 * (text, tabs) carry no files and pass through. Drops inside an element
 * matching `ignore` are left alone, e.g. the terminal. Returns true while
 * files are dragged over a window, outside ignored elements.
 */
export function useFileDrop(onDrop: (paths: string[]) => void, { ignore }: { ignore?: string } = {}): boolean {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    // dragenter and dragleave fire for every child crossed: count them so leaving a child is not leaving the window.
    let depth = 0;
    const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") === true;
    const ignored = (event: DragEvent) => {
      const target = event.target as { closest?: (selector: string) => unknown } | null;
      return ignore !== undefined && typeof target?.closest === "function" && target.closest(ignore) !== null;
    };
    const offs = [
      listenEverywhere("dragenter", (event) => {
        if (!carriesFiles(event)) return;
        depth++;
        setDragging(true);
      }),
      listenEverywhere("dragleave", (event) => {
        if (!carriesFiles(event)) return;
        depth = Math.max(0, depth - 1);
        if (depth === 0) setDragging(false);
      }),
      listenEverywhere("dragover", (event) => {
        if (!carriesFiles(event)) return;
        // Over an ignored element the window shows no drop target.
        setDragging(!ignored(event));
        if (ignored(event)) return;
        // Without this the drop is refused; main blocks the navigation to the file anyway.
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      }),
      listenEverywhere("drop", (event) => {
        if (!carriesFiles(event)) return;
        depth = 0;
        setDragging(false);
        if (ignored(event)) return;
        event.preventDefault();
        const paths = [...(event.dataTransfer?.files ?? [])].map((file) => window.frameshell.files.pathOf(file)).filter(Boolean);
        if (paths.length > 0) onDrop(paths);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [onDrop, ignore]);

  return dragging;
}

/** Status bar line after a drop: what was imported, and what was not media. */
export function importNotice(imported: string[], refused: string[]): string {
  const name = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const parts: string[] = [];
  if (imported.length > 0) parts.push(t.workspace.imported(imported.map(name).join(", ")));
  if (refused.length > 0) parts.push(t.workspace.notMedia(refused.map(name).join(", ")));
  return parts.join(" ");
}
