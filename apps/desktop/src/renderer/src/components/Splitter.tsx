import { type PointerEvent as ReactPointerEvent, useRef } from "react";

/**
 * Drag handle between two panels. Reports the pointer offset from where the
 * drag started; the owner maps it onto the panel it resizes (sign depends on side).
 */
export function Splitter({
  orientation,
  label,
  onDragStart,
  onDrag,
  onDragEnd,
}: {
  /** `vertical` = a vertical bar dragged sideways. */
  orientation: "vertical" | "horizontal";
  label: string;
  onDragStart: () => void;
  onDrag: (offsetPx: number) => void;
  onDragEnd: () => void;
}) {
  const start = useRef<number | null>(null);
  const axis = (event: ReactPointerEvent) => (orientation === "vertical" ? event.clientX : event.clientY);

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      className={`splitter splitter-${orientation}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = axis(event);
        document.body.classList.add(`dragging-${orientation}`);
        onDragStart();
      }}
      onPointerMove={(event) => {
        if (start.current !== null) onDrag(axis(event) - start.current);
      }}
      onPointerUp={(event) => {
        if (start.current === null) return;
        start.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        document.body.classList.remove(`dragging-${orientation}`);
        onDragEnd();
      }}
    />
  );
}
