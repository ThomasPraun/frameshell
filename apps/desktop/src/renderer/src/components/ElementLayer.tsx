import type { MovableElement } from "@frameshell/protocol";
import { type ElementAdjust, elementStyles } from "@frameshell/schema";
import { type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { type Adjust, adjustedBox, dragAdjust, elementEdit, filled, fragileSelector, topmostAt, withAdjust } from "../preview/element-edit.js";
import { elementMode, useElementMode } from "../preview/element-mode.js";
import { elementBox, pagePoint, pickTarget } from "../preview/pick.js";
import { PickPages, type PickTarget } from "../preview/pick-pages.js";
import { type Program, programAt, spanPlacement } from "../preview/program.js";
import type { FrameBox } from "../preview/transform-edit.js";
import { t } from "../i18n.js";
import { sendClipEdit } from "./clip-edits.js";

/** An element found on the clip's page: what moves, where it shows (fractions of the frame), and how it was reached. */
interface Found {
  selector: string;
  /** Page px per composition CSS px of a move. */
  unit: number;
  box: FrameBox;
  /** Frame point (fractions) it was found at, and ancestors walked up from there with ↑. */
  point: { x: number; y: number } | null;
  depth: number;
}

/** One drag of the selected element, pointer positions in screen px relative to the frame. */
interface Drag {
  pointer: number;
  kind: "move" | "scale";
  from: { x: number; y: number };
  start: Adjust;
  found: Found;
  page: FrameBox;
  /** The clip's live page shows the drag (topmost picture); otherwise only the outline moves. */
  live: boolean;
  next: Adjust;
}

/**
 * Element mode over the preview frame (ADR 0021): the elements of generated
 * clip `clip` (a top-level clip) at the paused frame. Hovering outlines the
 * element under the pointer, a press selects it, its body drags it and its
 * corners scale it about its centre; ↑/↓ select the parent or back. A drop
 * saves one `clip.set` of `elements` by `ui`. When the clip is the topmost
 * picture, its live page shows the drag with the new sheet, in place of the
 * render (the engine leaves the clip out while {@link ElementMode.held}); a
 * covered clip moves only the outline. A page that cannot load (untrusted
 * project, no live preview) leaves the mode with `onNotice` saying why.
 */
export function ElementLayer({
  program,
  frame,
  timeline,
  clip,
  elements,
  onNotice,
}: {
  program: Program;
  frame: number;
  timeline: string;
  clip: string;
  /** The clip's stored adjustments. */
  elements: Readonly<Record<string, ElementAdjust>>;
  onNotice: (notice: string | null) => void;
}) {
  const { held } = useElementMode();
  const layer = useRef<HTMLDivElement>(null);
  const pages = useRef<PickPages | null>(null);
  const [hover, setHover] = useState<Found | null>(null);
  const [picked, setPicked] = useState<Found | null>(null);
  const [ghost, setGhost] = useState<{ selector: string; box: FrameBox } | null>(null);
  const drag = useRef<Drag | null>(null);
  const hovering = useRef<{ busy: boolean; next: { x: number; y: number } | null; ticket: number }>({ busy: false, next: null, ticket: 0 });
  const { resolution } = program;

  const span = useMemo(() => {
    for (let layer = program.layers.length - 1; layer >= 0; layer--) {
      const found = programAt(program, frame, layer);
      if (found?.clip === clip && found.kind === "generated") return { layer, span: found };
    }
    return null;
  }, [program, frame, clip]);
  const current = span ? pickTarget(program, frame, span.layer) : null;
  // While a drag's page shows, it stays the page of the render the drag began on (a new key would reload it).
  const target: PickTarget | null = current && held?.clip === clip ? { ...current, identity: held.identity ?? current.identity } : current;
  const targetRef = useRef(target);
  targetRef.current = target;
  const elementsRef = useRef(elements);
  elementsRef.current = elements;
  const opacity = span ? spanPlacement(span.span, frame, program.fps).opacity : 1;
  const topmost = topmostAt(program, frame, clip);

  // The clip left the frame: back to whole clips.
  useEffect(() => {
    if (!span) elementMode.leave();
  }, [span]);

  useEffect(() => {
    const host = layer.current?.parentElement;
    if (!host) return;
    const opened = new PickPages(host, timeline, resolution);
    pages.current = opened;
    return () => {
      opened.dispose();
      if (pages.current === opened) pages.current = null;
    };
  }, [timeline, resolution]);

  const measured = (found: MovableElement, at: PickTarget) => ({ selector: found.element.selector, unit: found.unit, box: elementBox(at.box, resolution, found.element) });

  const failed = (error: unknown) => {
    onNotice(t.preview.elementsUnavailable((error as Error)?.message ?? String(error)));
    elementMode.leave();
  };

  // The page follows the stored adjustments (undo, an agent's edit) and the frame; its counts say what matches.
  const sheet = useMemo(() => {
    try {
      return elementStyles(elements);
    } catch {
      return "";
    }
  }, [elements]);
  const identity = target?.identity ?? null;
  const seconds = target?.seconds ?? null;
  const pickedSelector = picked?.selector ?? null;
  useEffect(() => {
    const opened = pages.current;
    const at = targetRef.current;
    if (!opened || !at || drag.current) return;
    if (!at.identity) return failed(new Error(t.preview.noRenderState));
    let stale = false;
    void opened
      .restyle(at, sheet, Object.keys(elementsRef.current))
      .then(async (counts) => {
        if (stale) return;
        elementMode.setCounts(clip, counts);
        if (!pickedSelector) return;
        const found = await opened.elementOf(at, pickedSelector);
        if (stale) return;
        setPicked((was) => (was && was.selector === pickedSelector ? (found ? { ...was, ...measured(found, at) } : null) : was));
        setGhost(null);
      })
      .catch((error: unknown) => !stale && failed(error));
    return () => {
      stale = true;
    };
    // `failed` and the refs are stable in effect; the page answers for the target's page, time and sheet.
  }, [sheet, identity, seconds, clip, pickedSelector]);

  // The drag page shows while held, at the opacity the render would have.
  const shownHeld = held?.clip === clip;
  useEffect(() => {
    pages.current?.show(clip, shownHeld ? opacity : null);
  }, [shownHeld, clip, opacity]);
  useEffect(() => () => elementMode.release(), []);

  /** Pointer position on the frame: screen px from its top left corner, and fractions of it. */
  const local = (event: PointerEvent) => {
    const rect = (layer.current!.parentElement ?? layer.current!).getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    return { x, y, width: rect.width, height: rect.height, point: { x: x / rect.width, y: y / rect.height } };
  };

  const find = async (point: { x: number; y: number }, depth: number): Promise<Found | null> => {
    const opened = pages.current;
    const at = targetRef.current;
    if (!opened || !at) return null;
    const page = pagePoint(at.box, resolution, point);
    const found = await opened.movableAt(at, page.x, page.y, depth);
    return found ? { ...measured(found, at), point, depth } : null;
  };

  /** One hover probe at a time; the latest pointer position waits for it. */
  const hoverAt = (point: { x: number; y: number }) => {
    const state = hovering.current;
    if (state.busy) {
      state.next = point;
      return;
    }
    state.busy = true;
    const ticket = ++state.ticket;
    void find(point, 0)
      .then((found) => ticket === state.ticket && setHover(found), () => ticket === state.ticket && setHover(null))
      .finally(() => {
        state.busy = false;
        const next = state.next;
        state.next = null;
        if (next) hoverAt(next);
      });
  };

  const inside = (box: FrameBox, point: { x: number; y: number }) =>
    point.x >= box.left && point.x <= box.left + box.width && point.y >= box.top && point.y <= box.top + box.height;

  const startDrag = (event: PointerEvent<HTMLElement>, kind: "move" | "scale", found: Found) => {
    const at = targetRef.current;
    if (!at) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const where = local(event);
    const start = filled(elementsRef.current[found.selector]);
    const live = topmost;
    drag.current = { pointer: event.pointerId, kind, from: { x: where.x, y: where.y }, start, found, page: at.box, live, next: start };
    setHover(null);
    if (live) elementMode.hold(clip, at.identity);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const { point } = local(event);
    if (picked && inside(picked.box, point)) return startDrag(event, "move", picked);
    if (hover && inside(hover.box, point)) {
      setPicked(hover);
      return startDrag(event, "move", hover);
    }
    void find(point, 0).then(setPicked, () => setPicked(null));
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const active = drag.current;
    const where = local(event);
    if (!active) return hoverAt(where.point);
    if (active.pointer !== event.pointerId) return;
    const geometry = { page: active.page, resolution, unit: active.found.unit };
    active.next = dragAdjust({ kind: active.kind, start: active.start, from: active.from, to: { x: where.x, y: where.y }, frame: where, box: active.found.box, ...geometry });
    setGhost({ selector: active.found.selector, box: adjustedBox(active.found.box, active.start, active.next, geometry) });
    if (active.live) pages.current?.sheet(clip, safeStyles(withAdjust(elementsRef.current, active.found.selector, active.next)));
  };

  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return;
    drag.current = null;
    const edit = elementEdit(clip, active.found.selector, elementsRef.current[active.found.selector], active.next);
    if (!edit) return restore(active);
    onNotice(null);
    sendClipEdit(edit, { label: active.kind === "move" ? "Move element" : "Scale element" }).catch((error: Error) => {
      restore(active);
      onNotice(error.message);
    });
  };

  /** Back to the stored adjustments: a drag that changed nothing, failed to save, or lost its pointer. */
  const restore = (active: Drag) => {
    setGhost(null);
    if (active.live) pages.current?.sheet(clip, sheet);
    elementMode.release();
  };
  const cancel = () => {
    const active = drag.current;
    drag.current = null;
    if (active) restore(active);
  };

  // ↑ / ↓ select the picked element's parent, or back down to where it was picked.
  useEffect(() => {
    const view = layer.current?.ownerDocument.defaultView ?? window;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      if (!picked?.point || drag.current) return;
      event.preventDefault();
      const depth = Math.max(0, picked.depth + (event.key === "ArrowUp" ? 1 : -1));
      if (depth === picked.depth) return;
      void find(picked.point, depth).then((found) => found && setPicked(found));
    };
    view.addEventListener("keydown", onKey);
    return () => view.removeEventListener("keydown", onKey);
  });

  const percent = (value: number) => `${value * 100}%`;
  const place = (box: FrameBox) => ({ left: percent(box.left), top: percent(box.top), width: percent(box.width), height: percent(box.height) });
  const selectedBox = picked ? (ghost?.selector === picked.selector ? ghost.box : picked.box) : null;
  const showHover = hover && !drag.current && hover.selector !== picked?.selector;
  return (
    <div
      ref={layer}
      className="preview-element-layer"
      data-testid="preview-element-layer"
      data-clip={clip}
      data-live={topmost || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        hovering.current.ticket++;
        hovering.current.next = null;
        setHover(null);
      }}
      onLostPointerCapture={(event) => drag.current?.pointer === event.pointerId && cancel()}
    >
      <p className="preview-element-label" data-testid="preview-element-label" title={topmost ? t.preview.elementModeHint : t.preview.elementModeCoveredHint}>
        {topmost ? t.preview.elementMode(clip) : t.preview.elementModeCovered(clip)}
      </p>
      {showHover && (
        <div className="preview-element-hover" data-testid="preview-element-hover" data-selector={hover.selector} style={place(hover.box)}>
          <span className="preview-element-name">{hover.selector}</span>
        </div>
      )}
      {picked && selectedBox && (
        <div
          className="layer-handles element-handles"
          data-testid="element-handles"
          data-selector={picked.selector}
          data-fragile={fragileSelector(picked.selector) || undefined}
          style={place(selectedBox)}
          title={t.preview.dragHandle}
        >
          <span className="preview-element-name">{picked.selector}</span>
          {(["nw", "ne", "sw", "se"] as const).map((corner) => (
            <span
              key={corner}
              className={`layer-handle ${corner}`}
              data-testid={`element-handle-${corner}`}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.stopPropagation();
                startDrag(event, "scale", picked);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** The sheet of `elements`; empty when a selector cannot go in one (the daemon refuses those anyway). */
function safeStyles(elements: Readonly<Record<string, ElementAdjust>>): string {
  try {
    return elementStyles(elements);
  } catch {
    return "";
  }
}
