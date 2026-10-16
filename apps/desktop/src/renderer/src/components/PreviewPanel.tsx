import type { Placement, Size } from "@frameshell/schema/composite";
import { type CSSProperties, type PointerEvent, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ProjectView } from "../../../shared/api.js";
import { openAskMenu } from "../ask/ask-agent.js";
import { liveTarget } from "../preview/live.js";
import { PreviewPlayer } from "../preview/player.js";
import { type PlaceholderReason, type Program, programAt } from "../preview/program.js";
import { dragPlacement, frameBox as placedBox, layerAt, layerBox, placementEdit } from "../preview/transform-edit.js";
import { transport, useTransport } from "../preview/transport.js";
import { useProgram, useResolution } from "../preview/useProgram.js";
import { SELECTION_TIMELINE, selection, useSelection } from "../selection.js";
import { drawSubtitleLines, subtitleLines } from "../subtitles/model.js";
import { useSubtitleFont, useSubtitles } from "../subtitles/useSubtitles.js";
import { formatTimecode } from "../timeline/layout.js";
import { useTimelineView } from "../timeline/useTimelineView.js";
import { PickLayer } from "./PickLayer.js";
import { forgetLivePages } from "../preview/live-pages.js";
import { ClipInspector } from "./ClipInspector.js";
import { DetachButton } from "./DetachControls.js";
import { LivePreview } from "./LivePreview.js";
import { PanelHeader } from "./PanelHeader.js";
import { RenderSlates } from "./RenderSlates.js";
import { SubtitleInspector } from "./SubtitleInspector.js";
import { sendClipEdit } from "./clip-edits.js";
import { elementOf, isTag, listenEverywhere, windowOf } from "../windows.js";
import { rich, t } from "../i18n.js";

/** Canvas short side, px: the proxies' size (SPEC §6.3), so frames draw 1:1. */
const CANVAS_SHORT_SIDE = 540;
/** `FRAMESHELL_PREVIEW_PROBE=1` (main adds `?probe=1`): expose measurement hooks (ADR 0001 harness). */
const PROBE = new URLSearchParams(location.search).get("probe") === "1";

const PLACEHOLDER_TEXT: Record<PlaceholderReason, string> = {
  timeline: t.preview.nestedTimeline,
  ingest: t.preview.ingest,
  unavailable: t.preview.noPreview,
};

/**
 * Program monitor (SPEC §3.4, ADR 0001): plays the main timeline's media
 * clips from their proxies at the playhead the timeline panel shares, every
 * video track composited as a layer. Space plays and pauses, arrows step a
 * frame (Shift: a second), Home/End jump to the ends. Clips it cannot play
 * yet show a placeholder. A click on a layer selects its clip; the selected
 * clip gets handles to move and scale it, and the inspector below sets its
 * placement and sound (a selected subtitle track's style is set there too;
 * subtitle tracks draw over the picture as export burns them). The region tool draws a rectangle on the frame for
 * "Ask agent" (SPEC §10): it becomes the shared selection, with the
 * playhead's time; Escape clears it. Right-click opens "Ask agent".
 * A generated clip whose render is not ready plays its composition live
 * when it is the topmost picture and its adapter supports it (ADR 0010).
 * The header's button moves the panel to its own window and back
 * (ADR 0012); F, pressed in the window it shows in, toggles full screen.
 * The playback keys work from every window of the project.
 */
export function PreviewPanel({
  project,
  detached,
  onDetach,
}: {
  project: ProjectView;
  /** Shown in its own window. */
  detached: boolean;
  /** Move the panel to its own window, or back when `detached`. */
  onDetach: () => void;
}) {
  const program = useProgram();
  const resolution = useResolution();
  const { time, playing, frames, fps } = useTransport();
  const frameBox = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const player = useRef<PreviewPlayer | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pickTool, setPickTool] = useState(false);
  const pickToolOn = useRef(false);
  pickToolOn.current = pickTool;
  /** Pick tool on or off; turning it on pauses, since it points at one frame. */
  const togglePick = useCallback(() => {
    if (!pickToolOn.current) transport.pause();
    setPickTool((on) => !on);
  }, []);
  const { view } = useTimelineView(SELECTION_TIMELINE);
  const [liveClip, setLiveClip] = useState<string | null>(null);

  useEffect(() => {
    const box = frameBox.current!;
    const instance = new PreviewPlayer(
      box,
      project.mediaUrl,
      {
        onTime: (at) => transport.report(at),
        onShown: (frame) => box.setAttribute("data-shown", String(frame)),
        onError: (message) => setNotice(message),
        onSilent: () => setNotice(t.preview.noAudio),
      },
      { probe: PROBE },
    );
    player.current = instance;
    // Live pages belong to one project: another one asks again.
    forgetLivePages();
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

  /** Alpha of the pictures on the canvas at a point; empty (all opaque) without a player. */
  const alphaAt = useCallback(
    (point: { x: number; y: number }) => player.current?.alphaAt(point) ?? Promise.resolve({ frame: -1, layers: new Map<number, number>() }),
    [],
  );

  const aspect = resolution.width / resolution.height;
  const canvasSize = useMemo(() => {
    const scale = CANVAS_SHORT_SIDE / Math.min(resolution.width, resolution.height);
    const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
    return { width: even(resolution.width), height: even(resolution.height) };
  }, [resolution.width, resolution.height]);
  useEffect(() => {
    player.current?.setSize(canvasSize.width, canvasSize.height);
  }, [canvasSize]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || editable(event.target)) return;
      const second = transport.get().fps;
      const panel = body.current;
      const doc = panel?.ownerDocument;
      // Full screen needs a key press in the window the preview is in: a browser grants it to that window alone.
      const here = panel !== null && windowOf(event.target) === windowOf(panel);
      if (event.key === "Escape" && here && doc?.fullscreenElement) leaveFullScreen(doc);
      else if ((event.key === "f" || event.key === "F") && !event.shiftKey && here) toggleFullScreen(panel);
      else if (event.key === " " && !isTag(event.target, "BUTTON")) transport.toggle();
      else if (event.key === "ArrowLeft") transport.step(event.shiftKey ? -second : -1);
      else if (event.key === "ArrowRight") transport.step(event.shiftKey ? second : 1);
      else if (event.key === "Home") transport.seek(0);
      else if (event.key === "End") transport.seek(Infinity);
      else if (event.key === "Escape" && (selection.get().region || selection.get().points.length > 0)) selection.clear();
      else if (event.key === "Escape" && pickToolOn.current) setPickTool(false);
      else if ((event.key === "i" || event.key === "I") && !event.shiftKey) togglePick();
      else return;
      event.preventDefault();
    };
    return listenEverywhere("keydown", onKey);
  }, [togglePick]);

  const frame = Math.min(Math.floor(time * fps + 1e-6), Math.max(0, frames - 1));
  const empty = program !== null && program.frames === 0;
  const live = useMemo(() => (program ? liveTarget(program, frame) : null), [program, frame]);
  return (
    <div className="preview-body" ref={body} data-testid="preview-body">
      <PanelHeader actions={<DetachButton name={t.workspace.preview.toLowerCase()} detached={detached} onClick={onDetach} testId="preview-detach" />}>
        <span className="panel-title">{t.workspace.preview}</span>
        <span className="timecode" aria-label={t.preview.playhead} data-testid="playhead">
          {formatTimecode(time, fps)}
        </span>
        <span className="panel-meta preview-duration" aria-label={t.preview.duration}>
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
          aria-label={empty ? t.preview.emptyMonitor : t.preview.monitorAt(formatTimecode(time, fps))}
          onContextMenu={openAskMenu}
        >
          <div className="safe-area action" />
          <div className="safe-area title" />
          {empty && <p className="preview-caption">{t.preview.emptyCaption}</p>}
          {program && <Placeholder program={program} frame={frame} />}
          {/* A generated clip still rendering plays its composition live, above the canvas (ADR 0010). */}
          <LivePreview target={live} timeline={view?.timeline ?? null} time={time} fps={fps} resolution={resolution} onLive={setLiveClip} />
          {program && <RenderSlates program={program} frame={frame} live={liveClip} />}
          {/* Subtitles read over every picture and the render slates. Neither takes a click. */}
          <SubtitleOverlay size={canvasSize} frame={frame} />
          {program && !playing && <Handles program={program} frame={frame} frameRef={frameBox} alphaAt={alphaAt} />}
          <PickLayer active={pickTool && !empty} fps={fps} frame={frame} program={program} timeline={view?.timeline ?? null} alphaAt={alphaAt} />
        </div>
      </div>
      <Inspector />
      <TransportBar
        playing={playing}
        disabled={frames === 0}
        notice={notice}
        pickTool={pickTool}
        onPickTool={togglePick}
      />
    </div>
  );
}

/**
 * How long a window takes to settle into full screen. macOS animates into
 * it, and a request to leave during the animation is never answered, which
 * would block every later one.
 */
const FULL_SCREEN_SETTLE_MS = 1500;
/** When each document's preview last entered full screen, `performance.now()` of the project window. */
const enteredFullScreen = new WeakMap<Document, number>();
/** Documents with a request to leave full screen already on its way. */
const leaving = new WeakSet<Document>();

/** Enter full screen with the preview alone, or leave it. */
function toggleFullScreen(panel: HTMLElement): void {
  const doc = panel.ownerDocument;
  if (doc.fullscreenElement) return leaveFullScreen(doc);
  enteredFullScreen.set(doc, performance.now());
  // Refused (no key press in this window): nothing changes.
  void panel.requestFullscreen().catch(() => enteredFullScreen.delete(doc));
}

/** Leave full screen in `doc`, once the window has settled into it. */
function leaveFullScreen(doc: Document): void {
  if (leaving.has(doc)) return;
  leaving.add(doc);
  const wait = Math.max(0, (enteredFullScreen.get(doc) ?? 0) + FULL_SCREEN_SETTLE_MS - performance.now());
  setTimeout(() => {
    leaving.delete(doc);
    if (doc.fullscreenElement) void doc.exitFullscreen().catch(() => undefined);
  }, wait);
}

/** Settings of the selection: a subtitle track's style, else the selected clip's placement and sound. */
function Inspector() {
  const { track } = useSelection();
  const { view } = useTimelineView(SELECTION_TIMELINE);
  const subtitles = track !== null && view?.tracks.some((candidate) => candidate.id === track && candidate.kind === "subtitles");
  return subtitles ? <SubtitleInspector track={track} /> : <ClipInspector />;
}

/**
 * Subtitle lines at program frame `frame`, drawn over the picture on a
 * canvas the size of the player's, with the bundled face export burns with.
 * `data-frame` names the frame drawn once the face is loaded (tests wait on it).
 */
function SubtitleOverlay({ size, frame }: { size: Size; frame: number }) {
  const { tracks } = useSubtitles();
  const canvas = useRef<HTMLCanvasElement>(null);
  const ready = useSubtitleFont(canvas);
  useLayoutEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    if (element.width !== size.width || element.height !== size.height) {
      element.width = size.width;
      element.height = size.height;
    }
    context.clearRect(0, 0, size.width, size.height);
    if (!ready) return;
    const lines = subtitleLines(tracks, frame, size, (text, font) => {
      context.font = font;
      return context.measureText(text).width;
    });
    drawSubtitleLines(context, lines);
    element.dataset["frame"] = String(frame);
    element.dataset["text"] = lines.map((line) => line.text).join("\n");
    element.dataset["active"] = lines.map((line) => line.active ?? "").join("\n");
  }, [tracks, frame, size, ready]);
  return <canvas ref={canvas} className="preview-subtitles" aria-hidden="true" data-testid="preview-subtitles" />;
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
            {rich(t.preview.clipOf, { type: <code>{base.type}</code>, clip: <code>{base.clip}</code> })}
          </p>
        </div>
      )}
      {upper.length > 0 && (
        <ul className="preview-layer-notes" aria-label={t.preview.hiddenLayers}>
          {upper.map(({ span, layer }) => (
            <li key={span.clip} data-testid="preview-layer-placeholder" data-reason={span.reason}>
              {t.preview.layerNote(layer + 1, PLACEHOLDER_TEXT[span.reason], span.type, span.clip)}
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
function Handles({
  program,
  frame,
  frameRef,
  alphaAt,
}: {
  program: Program;
  frame: number;
  frameRef: RefObject<HTMLDivElement | null>;
  alphaAt: (point: { x: number; y: number }) => Promise<{ frame: number; layers: Map<number, number> }>;
}) {
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

  // The clip the user sees at that pixel (ADR 0011): transparent parts of an overlay let the click through.
  const onSelect = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button === 0) selectAt(event);
  };
  const selectAt = (event: PointerEvent) => {
    const at = local(event);
    const point = { x: at.x / at.width, y: at.y / at.height };
    void alphaAt(point).then((shown) => {
      // Alpha of another frame (still decoding) says nothing about this one: boxes alone decide.
      const alpha = shown.frame === frame ? (layer: number) => shown.layers.get(layer) : undefined;
      const hit = layerAt(program, frame, point, alpha);
      if (hit) selection.selectClips([timelineClip(hit)], "preview");
      else selection.clear();
    });
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
      // A click, not a drag: the handles cover the whole box, so pick what shows at that pixel (maybe a layer above).
      setGhost(null);
      selectAt(event);
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
          title={t.preview.dragHandle}
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

function TransportBar({
  playing,
  disabled,
  notice,
  pickTool,
  onPickTool,
}: {
  playing: boolean;
  disabled: boolean;
  notice: string | null;
  pickTool: boolean;
  onPickTool: () => void;
}) {
  return (
    <div className="preview-transport" role="toolbar" aria-label={t.preview.transport}>
      <button
        className={`icon-button region-toggle${pickTool ? " on" : ""}`}
        aria-label={t.preview.pick}
        aria-pressed={pickTool}
        title={t.preview.pickHint}
        disabled={disabled}
        onClick={onPickTool}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 6v4M6 8h4" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
      <div className="preview-transport-buttons">
        <button className="icon-button" aria-label={t.preview.goToStart} title={t.preview.goToStartHint} disabled={disabled} onClick={() => transport.seek(0)}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 3v10M12 3.5L6 8l6 4.5z" fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
        </button>
        <button className="icon-button" aria-label={t.preview.prevFrame} title={t.preview.prevFrameHint} disabled={disabled} onClick={() => transport.step(-1)}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M10 3.5L4.5 8l5.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          className={`icon-button preview-play${playing ? " playing" : ""}`}
          aria-label={playing ? t.preview.pause : t.preview.play}
          title={playing ? t.preview.pauseHint : t.preview.playHint}
          disabled={disabled}
          onClick={() => transport.toggle()}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            {playing ? <path d="M4.5 3h2.5v10H4.5zM9 3h2.5v10H9z" fill="currentColor" /> : <path d="M4.5 2.5v11L13 8z" fill="currentColor" />}
          </svg>
        </button>
        <button className="icon-button" aria-label={t.preview.nextFrame} title={t.preview.nextFrameHint} disabled={disabled} onClick={() => transport.step(1)}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6 3.5L11.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
        </button>
        <button className="icon-button" aria-label={t.preview.goToEnd} title={t.preview.goToEndHint} disabled={disabled} onClick={() => transport.seek(Infinity)}>
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

/**
 * Typing targets keep their keys. Monaco may type through an EditContext on
 * a plain div, so its whole subtree counts. Elements of any project window
 * (a detached panel's come from its own realm).
 */
function editable(target: EventTarget | null): boolean {
  const element = elementOf(target);
  if (!element) return false;
  return (
    element.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) ||
    element.closest(".monaco-editor, .xterm") !== null ||
    ("editContext" in element && (element as { editContext?: unknown }).editContext != null)
  );
}
