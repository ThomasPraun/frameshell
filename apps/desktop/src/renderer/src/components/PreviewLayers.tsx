import { type CSSProperties, useEffect, useRef } from "react";
import { type Program, type VideoSpan, programAt } from "../preview/program.js";
import { frameBox } from "../preview/transform-edit.js";

/** Drift, in frames, a playing layer may have from the playhead before it is re-seeked. */
const MAX_DRIFT_FRAMES = 2;

type GeneratedSpan = Extract<VideoSpan, { kind: "generated" }>;

interface LayersProps {
  program: Program;
  /** Program frame the monitor shows (the last one at the very end). */
  frame: number;
  /** Program seconds: the shared playhead (`preview/transport.ts`). */
  time: number;
  playing: boolean;
  /** Base URL serving the project's cached renders (`frameshell-media://…/`). */
  mediaUrl: string;
}

/**
 * Generated clips (SPEC §3.4) over the program picture, bottom layer first:
 * each plays its cached render in a `<video>` placed like export places it
 * (`layerRect`) and slaved to the shared playhead; one still rendering shows
 * a slate with its progress instead. The engine's canvas holds every other
 * layer, so a generated clip always shows above media clips of higher tracks.
 */
export function PreviewLayers({ program, frame, time, playing, mediaUrl }: LayersProps) {
  const active = program.layers.flatMap((_, layer) => {
    const span = programAt(program, frame, layer);
    return span?.kind === "generated" ? [span] : [];
  });
  if (active.length === 0) return null;
  return (
    <div className="preview-layers">
      {active.map((span) =>
        span.render?.state === "ready" && span.size ? (
          <RenderedLayer key={`${span.clip}:${span.render.file}`} span={span} file={span.render.file} {...{ program, frame, time, playing, mediaUrl }} />
        ) : (
          <PendingLayer key={span.clip} span={span} />
        ),
      )}
    </div>
  );
}

function RenderedLayer({ span, file, program, frame, time, playing, mediaUrl }: LayersProps & { span: GeneratedSpan; file: string }) {
  const video = useRef<HTMLVideoElement>(null);
  // Paused: the middle of the shown frame, so decoder rounding never lands on its neighbour.
  const shown = playing ? time : (frame + 0.5) / program.fps;
  // Render seconds the playhead shows: the render's clock is the composition's, from the clip's `in`.
  const at = span.in + shown - span.start / program.fps;

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const drift = Math.abs(element.currentTime - at);
    if (!playing) {
      if (!element.paused) element.pause();
      if (drift > 0.5 / program.fps) element.currentTime = at;
      return;
    }
    if (element.paused || drift > MAX_DRIFT_FRAMES / program.fps) element.currentTime = at;
    if (element.paused) void element.play().catch(() => {});
  }, [at, playing, program.fps]);

  const box = frameBox(program.resolution, span.size!, span.placement);
  const style: CSSProperties = {
    left: `${box.left * 100}%`,
    top: `${box.top * 100}%`,
    width: `${box.width * 100}%`,
    height: `${box.height * 100}%`,
    opacity: span.placement.opacity,
  };
  return (
    <video
      ref={video}
      className="preview-layer"
      style={style}
      src={`${mediaUrl}${file}`}
      crossOrigin="anonymous"
      muted
      playsInline
      preload="auto"
      data-testid="preview-layer"
      data-clip={span.clip}
      data-state="ready"
    />
  );
}

function PendingLayer({ span }: { span: GeneratedSpan }) {
  const render = span.render && span.render.state !== "ready" ? span.render : null;
  const state = render?.state ?? "queued";
  const progress = render?.progress ?? 0;
  const title =
    state === "failed" ? "Render failed" : state === "unavailable" ? "Cannot render this clip" : state === "rendering" ? "Rendering" : "Waiting to render";
  return (
    <div className="preview-layer-pending" data-testid="preview-layer-pending" data-clip={span.clip} data-state={state} role="status">
      <p className="preview-layer-title">
        {title} <code>{span.type}</code> clip <code>{span.clip}</code>
      </p>
      {(state === "rendering" || state === "queued") && (
        <div className="preview-layer-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {render?.error && (
        <p className="preview-layer-error" title={render.error}>
          {render.error}
        </p>
      )}
    </div>
  );
}
