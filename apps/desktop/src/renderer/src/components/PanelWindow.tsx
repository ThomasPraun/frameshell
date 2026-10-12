import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import type { DetachablePanel } from "../../../shared/layout.js";
import { usePanelWindow } from "../panel-window.js";

/**
 * `children` drawn in `panel`'s own window (ADR 0012) while mounted: the
 * window opens on mount and closes on unmount. `onClosed` runs when the user
 * closes the window, to dock the panel back.
 */
export function PanelWindow({
  panel,
  title,
  onClosed,
  children,
}: {
  panel: DetachablePanel;
  title: string;
  onClosed: () => void;
  children: ReactNode;
}) {
  const host = usePanelWindow(panel, title, onClosed);
  return host ? createPortal(children, host) : null;
}
