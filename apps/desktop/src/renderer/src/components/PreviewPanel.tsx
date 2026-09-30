import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { ProjectView } from "../../../shared/api.js";
import { PreviewPlayer } from "../preview/player.js";
import { type PlaceholderReason, type Program, programAt } from "../preview/program.js";
import { transport, useTransport } from "../preview/transport.js";
import { useProgram, useResolution } from "../preview/useProgram.js";
import { formatTimecode } from "../timeline/layout.js";
import { PanelHeader } from "./PanelHeader.js";

/** Canvas short side, px: the proxies' size (SPEC §6.3), so frames draw 1:1. */
const CANVAS_SHORT_SIDE = 540;
/** `FRAMESHELL_PREVIEW_PROBE=1` (main adds `?probe=1`): expose measurement hooks (ADR 0001 harness). */
const PROBE = new URLSearchParams(location.search).get("probe") === "1";

const PLACEHOLDER_TEXT: Record<PlaceholderReason, string> = {
  generated: "Rendered clips are not previewed yet",
  timeline: "Nested timelines are not previewed yet",
  still: "Still images are not previewed yet",
  ingest: "Building the preview proxy",
  unavailable: "No preview for this clip",
};

/**
 * Program monitor (SPEC §3.4, ADR 0001): plays the main timeline's media
 * clips from their proxies at the playhead the timeline panel shares. Space
 * plays and pauses, arrows step a frame (Shift: a second), Home/End jump to
 * the ends. Clips it cannot play yet show a placeholder.
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
      if (event.metaKey || event.ctrlKey || event.altKey || editable(event.target)) return;
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
        </div>
      </div>
      <TransportBar playing={playing} disabled={frames === 0} notice={notice} />
    </>
  );
}

function Placeholder({ program, frame }: { program: Program; frame: number }) {
  const span = programAt(program, frame);
  if (!span || span.kind !== "placeholder") return null;
  return (
    <div className="preview-placeholder" data-testid="preview-placeholder" data-reason={span.reason}>
      <p>{PLACEHOLDER_TEXT[span.reason]}</p>
      <p className="preview-placeholder-detail">
        <code>{span.type}</code> clip <code>{span.clip}</code>
      </p>
    </div>
  );
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
