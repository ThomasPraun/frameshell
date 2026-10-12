import { PROBE_MAX_ELEMENTS, type ProbedElement, markGenerated } from "@frameshell/protocol/probe";
import { type PointerEvent, useEffect, useRef, useState } from "react";
import { type PickResult, elementBox, pagePoint, pickTarget, resolvePick } from "../preview/pick.js";
import { PickPages } from "../preview/pick-pages.js";
import type { Program } from "../preview/program.js";
import { type FrameBox, layerBox, layersIn } from "../preview/transform-edit.js";
import { transport } from "../preview/transport.js";
import { type SelectedPoint, type SelectedRegion, selection, useSelection } from "../selection.js";
import { formatTimecode } from "../timeline/layout.js";

/** Smaller drags than this (fraction of the frame, both ways) are a click: a pick, not a region. */
const MIN_REGION = 0.01;

/** Alpha of the canvas's pictures at a point, from the engine (see `PreviewPlayer.alphaAt`). */
export type AlphaAt = (point: { x: number; y: number }) => Promise<{ frame: number; layers: Map<number, number> }>;

/** What the cursor points at while the tool hovers: the pick, and how far up its element chain ↑ went. */
interface Hover {
  point: { x: number; y: number };
  frame: number;
  result: PickResult;
  depth: number;
}

/**
 * The Pick tool's surface over the preview frame (ADR 0011). While `active`:
 * hovering outlines what the pointer is on (the composition element of a
 * generated clip, else the clip's picture), ↑/↓ move the outline to the
 * element's parent or back, a click picks that point, Shift+click adds
 * points (each keeps its time), and a drag selects a region naming the clips
 * and elements in it. Picked points and the selected region stay drawn
 * whether or not the tool is on; with it off, presses fall through.
 */
export function PickLayer({
  active,
  fps,
  frame,
  program,
  timeline,
  alphaAt,
}: {
  active: boolean;
  fps: number;
  frame: number;
  program: Program | null;
  timeline: string | null;
  alphaAt: AlphaAt;
}) {
  const { region, points } = useSelection();
  const layer = useRef<HTMLDivElement>(null);
  const pages = useRef<PickPages | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [draft, setDraft] = useState<{ pointer: number; x: number; y: number; rect: SelectedRegion | null } | null>(null);
  const asked = useRef(0);
  /** One hover probe at a time; the latest pointer position waits for it. */
  const hovering = useRef<{ busy: boolean; next: { x: number; y: number } | null }>({ busy: false, next: null });
  const resolution = program?.resolution ?? null;

  // Pages live while the tool is on, for one program format and timeline.
  useEffect(() => {
    const host = layer.current?.parentElement;
    if (!active || !host || !timeline || !resolution) return;
    const opened = new PickPages(host, timeline, resolution);
    pages.current = opened;
    return () => {
      opened.dispose();
      if (pages.current === opened) pages.current = null;
      setHover(null);
    };
  }, [active, timeline, resolution]);

  // A hover belongs to one frame.
  useEffect(() => setHover((current) => (current && current.frame !== frame ? null : current)), [frame]);

  /** Pointer position as fractions of the frame, clamped to it. */
  const point = (event: PointerEvent) => {
    const box = layer.current!.getBoundingClientRect();
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    return { x: clamp((event.clientX - box.left) / box.width), y: clamp((event.clientY - box.top) / box.height) };
  };

  const resolve = async (at: { x: number; y: number }): Promise<PickResult | null> => {
    const opened = pages.current;
    if (!program || !opened) return null;
    const shown = await alphaAt(at);
    // Alpha of another frame (still decoding) says nothing about this one: boxes alone decide.
    const alpha = shown.frame === frame ? (index: number) => shown.layers.get(index) : () => undefined;
    return resolvePick(program, frame, at, alpha, (target, x, y, depth) => opened.probeAt(target, x, y, depth));
  };

  const hoverAt = (at: { x: number; y: number }) => {
    const state = hovering.current;
    if (state.busy) {
      state.next = at;
      return;
    }
    state.busy = true;
    const ticket = ++asked.current;
    void resolve(at)
      .then((result) => {
        if (ticket === asked.current) setHover(result ? { point: at, frame, result, depth: 0 } : null);
      })
      .finally(() => {
        state.busy = false;
        const next = state.next;
        state.next = null;
        if (next) hoverAt(next);
      });
  };

  /** Pick at `at`: the hover's result when it is that point (keeping ↑/↓), else a fresh one. */
  const pickAt = async (at: { x: number; y: number }, add: boolean) => {
    const known = hover && hover.frame === frame && hover.point.x === at.x && hover.point.y === at.y ? hover : null;
    const result = known?.result ?? (await resolve(at));
    if (!result) return;
    const depth = known?.depth ?? 0;
    const picked: SelectedPoint = {
      x: at.x,
      y: at.y,
      at: frame / fps,
      layers: result.layers,
      target: result.target,
      elements: await markGenerated(result.elements.slice(depth), readSource),
      unavailable: result.unavailable,
    };
    if (add) selection.addPoint(picked, "preview");
    else selection.selectPoints([picked], "preview");
  };

  /** Elements of the generated clips in a region, topmost clip first, up to the probe's limit in all. */
  const regionElements = async (rect: SelectedRegion): Promise<SelectedRegion["elements"]> => {
    const opened = pages.current;
    if (!program || !opened) return [];
    const found: { clip: string; element: ProbedElement }[] = [];
    for (const hit of layersIn(program, frame, rect)) {
      if (hit.kind !== "generated" || found.length >= PROBE_MAX_ELEMENTS) continue;
      const target = pickTarget(program, frame, hit.layer);
      if (!target) continue;
      const a = pagePoint(target.box, program.resolution, { x: rect.x0, y: rect.y0 });
      const b = pagePoint(target.box, program.resolution, { x: rect.x1, y: rect.y1 });
      try {
        const elements = await opened.probeRect(target, { x0: a.x, y0: a.y, x1: b.x, y1: b.y }, PROBE_MAX_ELEMENTS - found.length);
        found.push(...(await markGenerated(elements, readSource)).map((element) => ({ clip: hit.clip, element })));
      } catch {
        // No live page: the region still names the clip.
      }
    }
    return found;
  };

  const spanning = (a: { x: number; y: number }, b: { x: number; y: number }): SelectedRegion => {
    const rect = { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
    const clips = program ? layersIn(program, frame, rect).map(({ clip, type }) => ({ clip, type })) : [];
    return { ...rect, at: transport.get().time, clips, elements: [] };
  };

  // ↑ / ↓ walk the hovered element's ancestors.
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      setHover((current) => {
        if (!current || current.result.elements.length === 0) return current;
        const depth = Math.max(0, Math.min(current.result.elements.length - 1, current.depth + (event.key === "ArrowUp" ? 1 : -1)));
        return { ...current, depth };
      });
      event.preventDefault();
    };
    const view = layer.current?.ownerDocument.defaultView ?? window;
    view.addEventListener("keydown", onKey);
    return () => view.removeEventListener("keydown", onKey);
  }, [active]);

  const outline = hover && active && !draft && program ? outlineOf(hover, program) : null;
  const shownRegion = draft?.rect ?? region;
  const percent = (value: number) => `${value * 100}%`;
  const here = points.filter((picked) => Math.abs(picked.at * fps - frame) < 0.5);
  return (
    <div
      ref={layer}
      className={`preview-region-layer preview-pick-layer${active ? " is-active" : ""}`}
      data-testid="preview-pick-layer"
      onPointerDown={(event) => {
        if (!active || event.button !== 0) return;
        event.preventDefault();
        transport.pause();
        layer.current!.setPointerCapture(event.pointerId);
        setDraft({ pointer: event.pointerId, ...point(event), rect: null });
      }}
      onPointerMove={(event) => {
        if (!active) return;
        if (draft && draft.pointer === event.pointerId) {
          const at = point(event);
          if (Math.abs(at.x - draft.x) >= MIN_REGION || Math.abs(at.y - draft.y) >= MIN_REGION || draft.rect) setDraft({ ...draft, rect: spanning(draft, at) });
          return;
        }
        if (!draft) hoverAt(point(event));
      }}
      onPointerUp={(event) => {
        if (!draft || draft.pointer !== event.pointerId) return;
        const at = point(event);
        const rect = spanning(draft, at);
        setDraft(null);
        if (rect.x1 - rect.x0 >= MIN_REGION && rect.y1 - rect.y0 >= MIN_REGION) {
          selection.selectRegion(rect, "preview");
          void regionElements(rect).then((elements) => {
            // Only if the user did not select something else meanwhile.
            if (elements.length > 0 && selection.get().region?.at === rect.at && selection.get().region?.x0 === rect.x0) {
              selection.selectRegion({ ...rect, elements }, "preview");
            }
          });
        } else {
          void pickAt({ x: draft.x, y: draft.y }, event.shiftKey);
        }
      }}
      onPointerLeave={() => {
        asked.current++;
        hovering.current.next = null;
        if (!draft) setHover(null);
      }}
      onPointerCancel={() => setDraft(null)}
    >
      {outline && (
        <div
          className="preview-pick-outline"
          data-testid="preview-pick-outline"
          data-clip={outline.clip}
          data-selector={outline.element?.selector ?? undefined}
          style={{ left: percent(outline.box.left), top: percent(outline.box.top), width: percent(outline.box.width), height: percent(outline.box.height) }}
        >
          <span className="preview-pick-label">{outline.label}</span>
        </div>
      )}
      {here.map((picked, index) => (
        <span
          key={index}
          className="preview-pick-point"
          data-testid="preview-pick-point"
          data-target={picked.target ?? ""}
          data-selector={picked.elements[0]?.selector ?? ""}
          style={{ left: percent(picked.x), top: percent(picked.y) }}
        />
      ))}
      {shownRegion && (
        <div
          className={`preview-region${draft ? " is-drawing" : ""}`}
          data-testid="preview-region"
          data-region={`${shownRegion.x0.toFixed(3)},${shownRegion.y0.toFixed(3)},${shownRegion.x1.toFixed(3)},${shownRegion.y1.toFixed(3)}`}
          data-elements={shownRegion.elements.length}
          style={{
            left: percent(shownRegion.x0),
            top: percent(shownRegion.y0),
            width: percent(shownRegion.x1 - shownRegion.x0),
            height: percent(shownRegion.y1 - shownRegion.y0),
          }}
        >
          {!draft && <span className="preview-region-time">{formatTimecode(shownRegion.at, fps)}</span>}
        </div>
      )}
    </div>
  );
}

/** A project file's text, for {@link markGenerated}. */
const readSource = (path: string) => window.frameshell.files.read(path);

/** Where to outline a hover, and its label: the element at the chosen depth, else the target clip's picture. */
function outlineOf(hover: Hover, program: Program): { box: FrameBox; label: string; clip: string; element: ProbedElement | null } | null {
  const { result, depth } = hover;
  if (!result.target) return null;
  const element = result.elements[depth] ?? null;
  if (element && result.page) {
    return { box: elementBox(result.page, program.resolution, element), label: `${elementLabel(element)} · ${result.target}`, clip: result.target, element };
  }
  const picture = layerBox(program, hover.frame, result.target);
  if (!picture) return null;
  const note = result.unavailable ? " · no live page" : "";
  return { box: picture.box, label: `${result.target}${note}`, clip: result.target, element: null };
}

/** `tag#id.class` of an element, as browser inspectors label it. */
function elementLabel(element: ProbedElement): string {
  return `${element.tag}${element.id ? `#${element.id}` : ""}${element.classes.slice(0, 2).map((name) => `.${name}`).join("")}`;
}
