import type { Placement } from "@frameshell/schema/composite";
import { type CSSProperties, type PointerEvent, type RefObject, useEffect, useRef, useState } from "react";
import type { ProjectView } from "../../../shared/api.js";
import { PreviewPlayer } from "../preview/player.js";
import { type PlaceholderReason, type Program, programAt } from "../preview/program.js";
import { dragPlacement, frameBox as placedBox, layerAt, layerBox, placementEdit } from "../preview/transform-edit.js";
import { transport, useTransport } from "../preview/transport.js";
import { useProgram, useResolution } from "../preview/useProgram.js";
import { selection, useSelection } from "../selection.js";
import { formatTimecode } from "../timeline/layout.js";
import { ClipInspector } from "./ClipInspector.js";
import { PanelHeader } from "./PanelHeader.js";
import { sendClipEdit } from "./clip-edits.js";

/** Canvas short side, px: the proxies' size (SPEC §6.3), so frames draw 1:1. */
const CANVAS_SHORT_SIDE = 540;
/** `FRAMESHELL_PREVIEW_PROBE=1` (main adds `?probe=1`): expose measurement hooks (ADR 0001 harness). */
const PROBE = new URLSearchParams(location.search).get("probe") === "1";

const PLACEHOLDER_TEXT: Record<PlaceholderReason, string> = {
  generated: "Rendered clips are not previewed yet",
  timeline: "Nested timeline cannot be read",
  ingest: "Building the preview proxy",
  unavailable: "No preview for this clip",
};

/**
 * Program monitor (SPEC §3.4, ADR 0001): plays the main timeline's media
 * clips from their proxies at the playhead the timeline panel shares, every
 * video track composited as a layer. Space plays and pauses, arrows step a
 * frame (Shift: a second), Home/End jump to the ends. Clips it cannot play
 * yet show a placeholder. A click on a layer selects its clip; the selected
 * clip gets handles to move and scale it, and the inspector below sets its
 * placement and sound.
 */
export function PreviewPanel({ project }: { project: ProjectView }) {
  const program = useProgram();
  const resolution = useResolution();
  const { time, playing, frames, fps } = useTransport();
  const frameBox = useRef<HTMLDivElement>(null);
  const player = useRef<PreviewPlayer | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const box = frameBox.current!;
    const instance = new PreviewPlayer(
      box,
      project.mediaUrl,
      {
        onTime: (at) => transport.report(at),
        onShown: (frame) => box.setAttribute("data-shown", String(frame)),
        onError: (message) => setNotice(message),
        onSilent: () => setNotice("No audio output: playing without sound"),
      },
      { probe: PROBE },
    );
    player.current = instance;
    const detach = transport.attach(instance);
    instance.seek(transport.get().time);
    return () => {
      detach();
      instance.dispose();
      player.current = null;
    };
  }, [project.mediaUrl]);

  useEffect(() => {
    if (!program) return;
    player.current?.setProgram(program);
    transport.setProgram(program.frames, program.fps);
  }, [program]);

  const aspect = resolution.width / resolution.height;
  useEffect(() => {
    const scale = CANVAS_SHORT_SIDE / Math.min(resolution.width, resolution.height);
    const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
    player.current?.setSize(even(resolution.width), even(resolution.height));
  }, [resolution.width, resolution.height]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || editable(event.target)) return;
      const second = transport.get().fps;
      if (event.key === " " && !(event.target instanceof HTMLButtonElement)) transport.toggle();
      else if (event.key === "ArrowLeft") transport.step(event.shiftKey ? -second : -1);
      else if (event.key === "ArrowRight") transport.step(event.shiftKey ? second : 1);
      else if (event.key === "Home") transport.seek(0);
      else if (event.key === "End") transport.seek(Infinity);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const frame = Math.min(Math.floor(time * fps + 1e-6), Math.max(0, frames - 1));
  const empty = program !== null && program.frames === 0;
  return (
    <>
      <PanelHeader>
        <span className="panel-title">Preview</span>
        <span className="timecode" aria-label="Playhead" data-testid="playhead">
          {formatTimecode(time, fps)}
        </span>
        <span className="panel-meta preview-duration" aria-label="Duration">
          {formatTimecode(frames / fps, fps)}
        </span>
      </PanelHeader>
      <div className="preview-stage">
        <div
          ref={frameBox}
          className="preview-frame"
          style={{ "--frame-aspect": aspect } as CSSProperties}
          data-testid="preview-frame"
          data-playing={playing || undefined}
          role="img"
          aria-label={empty ? "Empty program monitor" : `Program monitor at ${formatTimecode(time, fps)}`}
        >
          <div className="safe-area action" />
          <div className="safe-area title" />
          {empty && <p className="preview-caption">Nothing on the timeline yet</p>}
          {program && <Placeholder program={program} frame={frame} />}
          {program && !playing && <Handles program={program} frame={frame} frameRef={frameBox} />}
        </div>
      </div>
      <ClipInspector />
      <TransportBar playing={playing} disabled={frames === 0} notice={notice} />
    </>
  );
}

/** The base layer's placeholder fills the frame; upper layers' are listed small, over the picture. */
function Placeholder({ program, frame }: { program: Program; frame: number }) {
  const base = programAt(program, frame);
  const upper = program.layers.flatMap((_, layer) => {
    const span = layer > 0 ? programAt(program, frame, layer) : null;
    return span?.kind === "placeholder" ? [{ span, layer }] : [];
  });
  return (
    <>
      {base?.kind === "placeholder" && (
        <div className="preview-placeholder" data-testid="preview-placeholder" data-reason={base.reason}>
          <p>{PLACEHOLDER_TEXT[base.reason]}</p>
          <p className="preview-placeholder-detail">
            <code>{base.type}</code> clip <code>{base.clip}</code>
          </p>
        </div>
      )}
      {upper.length > 0 && (
        <ul className="preview-layer-notes" aria-label="Layers not shown">
          {upper.map(({ span, layer }) => (
            <li key={span.clip} data-testid="preview-layer-placeholder" data-reason={span.reason}>
              {`V${layer + 1}: ${PLACEHOLDER_TEXT[span.reason]} (${span.type} clip ${span.clip})`}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Clip id the timeline holds for a picture: a nested timeline's clips (`n1/c2`) belong to their nested clip. */
const timelineClip = (id: string) => id.split("/")[0]!;

/**
 * Click-to-select over the frame, and move/scale handles on the one selected
 * clip while it shows. A drag moves a ghost of its box; release saves the
 * placement as one `clip.set` (the picture follows once the daemon has it).
 * Clips of nested timelines select their nested clip and get no handles:
 * their placement is composed, not stored.
 */
function Handles({ program, frame, frameRef }: { program: Program; frame: number; frameRef: RefObject<HTMLDivElement | null> }) {
  const { clips } = useSelection();
  const selected = clips.length === 1 ? clips[0]! : null;
  const target = selected ? layerBox(program, frame, selected) : null;
  const drag = useRef<{ pointer: number; kind: "move" | "scale"; from: { x: number; y: number }; start: Placement } | null>(null);
  const [ghost, setGhost] = useState<{ clip: string; placement: Placement } | null>(null);

  // The saved placement arrived (or the selection moved on): the ghost has done its job.
  useEffect(() => {
    if (ghost && (!target || ghost.clip !== selected || samePlacement(ghost.placement, target.placement))) setGhost(null);
  }, [ghost, selected, target]);

  const local = (event: PointerEvent) => {
    const rect = frameRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top, width: rect.width, height: rect.height };
  };

  const onSelect = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const at = local(event);
    const hit = layerAt(program, frame, { x: at.x / at.width, y: at.y / at.height });
    if (hit) selection.selectClips([timelineClip(hit)], "preview");
    else selection.clear();
  };

  const onHandleDown = (kind: "move" | "scale") => (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !target) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = local(event);
    drag.current = { pointer: event.pointerId, kind, from: { x: at.x, y: at.y }, start: target.placement };
  };
  const dragged = (event: PointerEvent) => {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return null;
    const at = local(event);
    return dragPlacement({ kind: active.kind, start: active.start, from: active.from, to: { x: at.x, y: at.y }, frame: at, project: program.resolution });
  };
  const onHandleMove = (event: PointerEvent) => {
    const placement = dragged(event);
    if (placement && selected) setGhost({ clip: selected, placement });
  };
  const onHandleUp = (event: PointerEvent) => {
    const placement = dragged(event);
    const start = drag.current?.start;
    drag.current = null;
    if (!placement || !start || !selected) return;
    const edit = placementEdit(selected, start, placement);
    if (!edit) {
      setGhost(null);
      return;
    }
    setGhost({ clip: selected, placement });
    sendClipEdit(edit).catch(() => setGhost(null));
  };

  const editable = target !== null && selected !== null && !selected.includes("/");
  const shown = editable ? (ghost?.clip === selected ? placedBox(program.resolution, target.size, ghost.placement) : target.box) : null;
  const percent = (value: number) => `${value * 100}%`;
  return (
    <div className="preview-hit" onPointerDown={onSelect} data-testid="preview-hit">
      {shown && (
        <div
          className="layer-handles"
          data-testid="layer-handles"
          data-clip={selected}
          style={{ left: percent(shown.left), top: percent(shown.top), width: percent(shown.width), height: percent(shown.height) }}
          onPointerDown={onHandleDown("move")}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onLostPointerCapture={() => (drag.current = null)}
          title="Drag to move; drag a corner to scale"
        >
          {(["nw", "ne", "sw", "se"] as const).map((corner) => (
            <span
              key={corner}
              className={`layer-handle ${corner}`}
              data-testid={`layer-handle-${corner}`}
              onPointerDown={onHandleDown("scale")}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function samePlacement(a: Placement, b: Placement): boolean {
  return a.x === b.x && a.y === b.y && a.scale === b.scale && a.opacity === b.opacity;
}

function TransportBar({ playing, disabled, notice }: { playing: boolean; disabled: boolean; notice: string | null }) {
  return (
    <div className="preview-transport" role="toolbar" aria-label="Transport">
      <div className="preview-transport-buttons">
        <button className="icon-button" aria-label="Go to start" title="Go to start (Home)" disabled={disabled} onClick={() => transport.seek(0)}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 3v10M12 3.5L6 8l6 4.5z" fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
        </button>
        <button className="icon-button" aria-label="Previous frame" title="Previous frame (Left)" disabled={disabled} onClick={() => transport.step(-1)}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M10 3.5L4.5 8l5.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          className={`icon-button preview-play${playing ? " playing" : ""}`}
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause (Space)" : "Play (Space)"}
          disabled={disabled}
          onClick={() => transport.toggle()}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            {playing ? <path d="M4.5 3h2.5v10H4.5zM9 3h2.5v10H9z" fill="currentColor" /> : <path d="M4.5 2.5v11L13 8z" fill="currentColor" />}
          </svg>
        </button>
        <button className="icon-button" aria-label="Next frame" title="Next frame (Right)" disabled={disabled} onClick={() => transport.step(1)}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6 3.5L11.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
        </button>
        <button className="icon-button" aria-label="Go to end" title="Go to end (End)" disabled={disabled} onClick={() => transport.seek(Infinity)}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M12 3v10M4 3.5L10 8l-6 4.5z" fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {notice && (
        <span className="preview-notice" role="status" title={notice}>
          {notice}
        </span>
      )}
    </div>
  );
}

/** Typing targets keep their keys. Monaco may type through an EditContext on a plain div, so its whole subtree counts. */
function editable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.closest(".monaco-editor, .xterm") !== null ||
    ("editContext" in target && (target as { editContext?: unknown }).editContext != null)
  );
}
