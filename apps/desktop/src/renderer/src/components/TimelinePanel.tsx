import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ClipBox,
  RULER_HEIGHT,
  type TimelineLayout,
  type TrackRow,
  clampScroll,
  clipAt,
  contentWidth,
  fitZoom,
  formatDuration,
  formatTimecode,
  layoutTimeline,
  zoomAround,
  zoomLimits,
} from "../timeline/layout.js";
import { MediaCache } from "../timeline/media.js";
import { DEFAULT_THEME, type TimelineTheme, paintTimeline } from "../timeline/paint.js";
import { transport } from "../preview/transport.js";
import { SELECTION_TIMELINE, selection, useSelection } from "../selection.js";
import { useTimelineView } from "../timeline/useTimelineView.js";
import { PanelHeader } from "./PanelHeader.js";

/** Timeline the panel follows: the one selections name, the project's `main` until timelines can be switched. */
const TIMELINE = SELECTION_TIMELINE;
/** Zoom step of the buttons and `+`/`-` keys. */
const ZOOM_STEP = 1.5;
/** Poll `asset.list` this often while an asset on the timeline is still ingesting. */
const INGEST_POLL_MS = 2_000;
/** User Timing entry of one paint; read by the performance e2e test and DevTools. */
const PAINT_MEASURE = "timeline-paint";

/** Scroll and zoom, kept outside React state: they change every frame while scrolling. */
interface ViewState {
  pxPerSecond: number;
  /** True until the user zooms: the timeline keeps fitting the panel. */
  fit: boolean;
  scrollLeft: number;
  scrollTop: number;
  width: number;
  height: number;
}

/**
 * Canvas timeline of the project's main timeline (SPEC §10): tracks and clips
 * from the daemon, redrawn live as the agent edits from the terminal. Zoom
 * with Ctrl/Cmd + wheel, pinch or `+`/`-`/`0`; scroll natively. Click a clip
 * to select it (Shift/Cmd/Ctrl-click toggles, Esc or a click on empty lane
 * clears) in the shared selection store, which the script editor also
 * reads and sets (scene links, SPEC §5.5). The playhead is the shared
 * transport's: it moves while the preview plays (the lanes follow it), and
 * clicking or dragging on the ruler moves it (scrubbing).
 */
export function TimelinePanel({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { view, error, rejection, dismissRejection } = useTimelineView(TIMELINE);
  const layout = useMemo(() => (view ? layoutTimeline(view) : null), [view]);
  const empty = layout !== null && layout.clipCount === 0;

  return (
    <>
      <PanelHeader
        onCollapse={onToggle}
        collapseLabel={collapsed ? "Show timeline" : "Hide timeline"}
        collapseSide={collapsed ? "up" : "down"}
      >
        <span className="panel-title">Timeline</span>
        <span className="panel-meta">{TIMELINE}</span>
        {view && layout && (
          <span className="panel-meta timeline-summary">
            {`${layout.clipCount} ${layout.clipCount === 1 ? "clip" : "clips"}, ${formatTimecode(layout.duration, view.fps)}`}
          </span>
        )}
      </PanelHeader>
      {!collapsed && rejection && (
        <div className="editor-notice is-error timeline-rejection" role="alert">
          <span>
            {`Edit of timelines/${rejection.timeline}.json rejected (${rejection.reason}); the timeline was restored. ` +
              `Your version is kept at ${rejection.preserved}.\n${rejection.message}`}
          </span>
          <button className="link" onClick={dismissRejection}>
            Dismiss
          </button>
        </div>
      )}
      {!collapsed && (
        <TimelineCanvas
          layout={layout}
          fps={view?.fps ?? 30}
          revision={view?.revision ?? null}
          overlay={
            error && !view ? (
              <p className="timeline-error">{error}</p>
            ) : empty || (layout && layout.rows.length === 0) ? (
              <p>
                Ask the agent in the terminal to cut your footage, or drop media into <code>assets/</code>.
              </p>
            ) : null
          }
        />
      )}
    </>
  );
}

function TimelineCanvas({
  layout,
  fps,
  revision,
  overlay,
}: {
  layout: TimelineLayout | null;
  fps: number;
  revision: number | null;
  overlay: ReactNode;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const sizer = useRef<HTMLDivElement>(null);
  const heads = useRef<HTMLDivElement>(null);
  const state = useRef<ViewState>({ pxPerSecond: 10, fit: true, scrollLeft: 0, scrollTop: 0, width: 0, height: 0 });
  const frame = useRef(0);
  const paints = useRef(0);
  const theme = useRef<TimelineTheme>(DEFAULT_THEME);
  const { clips: selectedClips, origin } = useSelection();
  const selected = useMemo(() => new Set(selectedClips), [selectedClips]);
  /** Clip to bring into view: only for selections made elsewhere (a script heading), never under the user's click. */
  const revealClip = origin === "script" ? selectedClips[0] : undefined;
  const latest = useRef({ layout, fps, selected });
  latest.current = { layout, fps, selected };
  /** Pointer id while scrubbing on the ruler. */
  const scrubbing = useRef<number | null>(null);
  const [hover, setHover] = useState<{ row: TrackRow; clip: ClipBox; x: number; y: number } | null>(null);

  const draw = useCallback(() => {
    frame.current = 0;
    const element = canvas.current;
    const context = element?.getContext("2d");
    const { layout: current, fps: rate, selected: chosen } = latest.current;
    const at = transport.get().time;
    const view = state.current;
    if (!element || !context || view.width === 0) return;
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(view.width * ratio);
    const pixelHeight = Math.round(view.height * ratio);
    if (element.width !== pixelWidth || element.height !== pixelHeight) {
      element.width = pixelWidth;
      element.height = pixelHeight;
      element.style.width = `${view.width}px`;
      element.style.height = `${view.height}px`;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const started = performance.now();
    paintTimeline(context, {
      layout: current ?? { rows: [], duration: 0, height: RULER_HEIGHT, clipCount: 0 },
      viewport: view,
      fps: rate,
      playhead: at,
      theme: theme.current,
      media: mediaRef.current!,
      selected: chosen,
    });
    performance.measure(PAINT_MEASURE, { start: started });
    // User Timing buffers are unbounded: keep only recent paints.
    if (++paints.current % 500 === 0) performance.clearMeasures(PAINT_MEASURE);
    if (heads.current) heads.current.style.transform = `translateY(${-view.scrollTop}px)`;
  }, []);

  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  }, [draw]);

  const mediaRef = useRef<MediaCache | null>(null);
  mediaRef.current ??= new MediaCache(window.frameshell.media, schedule);
  useEffect(() => () => mediaRef.current?.dispose(), []);

  /** Apply zoom/scroll limits for the current layout and size, then sync the native scroller. */
  const settle = useCallback(() => {
    const view = state.current;
    const duration = latest.current.layout?.duration ?? 0;
    const limits = zoomLimits(duration, view.width, latest.current.fps);
    view.pxPerSecond = view.fit ? fitZoom(duration, view.width) : Math.min(limits.max, Math.max(limits.min, view.pxPerSecond));
    const width = contentWidth(duration, view.pxPerSecond, view.width);
    const height = Math.max(latest.current.layout?.height ?? RULER_HEIGHT, view.height);
    if (sizer.current) {
      sizer.current.style.width = `${width}px`;
      sizer.current.style.height = `${height}px`;
    }
    view.scrollLeft = clampScroll(view.scrollLeft, duration, view.pxPerSecond, view.width);
    view.scrollTop = Math.min(view.scrollTop, Math.max(0, height - view.height));
    const box = scroller.current;
    if (box && (box.scrollLeft !== view.scrollLeft || box.scrollTop !== view.scrollTop)) {
      box.scrollLeft = view.scrollLeft;
      box.scrollTop = view.scrollTop;
    }
    schedule();
  }, [schedule]);

  const zoom = useCallback(
    (factor: number, anchorX = state.current.width / 2) => {
      const view = state.current;
      const duration = latest.current.layout?.duration ?? 0;
      const next = zoomAround(view, factor, anchorX, zoomLimits(duration, view.width, latest.current.fps));
      Object.assign(view, next, { fit: false });
      settle();
    },
    [settle],
  );

  const fit = useCallback(() => {
    Object.assign(state.current, { fit: true, scrollLeft: 0 });
    settle();
  }, [settle]);

  // Redraw synchronously on a new timeline: the change shows in the same frame as the DOM update.
  useLayoutEffect(() => {
    settle();
    if (frame.current) cancelAnimationFrame(frame.current);
    draw();
  }, [layout, selected, settle, draw]);

  // The playhead moves every frame while playing: repaint outside React, and page the lanes to keep it in view.
  useEffect(
    () =>
      transport.subscribe(() => {
        const { time, playing } = transport.get();
        const view = state.current;
        const x = time * view.pxPerSecond - view.scrollLeft;
        if (playing && scrubbing.current === null && view.width > 0 && (x < 0 || x > view.width - 16)) {
          view.scrollLeft = Math.max(0, time * view.pxPerSecond - view.width * 0.1);
          settle();
        }
        schedule();
      }),
    [schedule, settle],
  );

  // Keyed on the clip, not the selection: pruning other clips must not move the view.
  useEffect(() => {
    const first = revealClip;
    const box = scroller.current;
    const current = latest.current.layout;
    if (!first || !box || !current) return;
    const row = current.rows.find((candidate) => candidate.clips.some((clip) => clip.id === first));
    const clip = row?.clips.find((candidate) => candidate.id === first);
    if (!row || !clip) return;
    // The player follows selections made elsewhere: the playhead jumps to the clip (not while playing).
    if (!transport.get().playing) transport.seek(clip.start);
    const view = state.current;
    const x0 = clip.start * view.pxPerSecond;
    const x1 = clip.end * view.pxPerSecond;
    if (x0 < view.scrollLeft || x1 > view.scrollLeft + view.width) view.scrollLeft = Math.max(0, x0 - view.width / 4);
    const lanes = view.height - RULER_HEIGHT;
    const top = row.top - RULER_HEIGHT;
    if (top < view.scrollTop || top + row.height > view.scrollTop + lanes) view.scrollTop = Math.max(0, top);
    settle();
  }, [revealClip, settle]);

  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    theme.current = {
      ...DEFAULT_THEME,
      ruler: read("--bg-panel", DEFAULT_THEME.ruler),
      line: read("--line", DEFAULT_THEME.line),
      lineSoft: read("--line-soft", DEFAULT_THEME.lineSoft),
      text: read("--text", DEFAULT_THEME.text),
      textMuted: read("--text-muted", DEFAULT_THEME.textMuted),
      textFaint: read("--text-faint", DEFAULT_THEME.textFaint),
      accent: read("--accent", DEFAULT_THEME.accent),
      danger: read("--danger", DEFAULT_THEME.danger),
      video: read("--track-video", DEFAULT_THEME.video),
      audio: read("--track-audio", DEFAULT_THEME.audio),
      subtitles: read("--track-sub", DEFAULT_THEME.subtitles),
      fontUi: read("--font-ui", DEFAULT_THEME.fontUi),
      fontMono: read("--font-mono", DEFAULT_THEME.fontMono),
    };
    schedule();
  }, [schedule]);

  // The scroller's client box is the visible lane area: its scrollbars take space from the canvas.
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const measure = () => {
      if (state.current.width === box.clientWidth && state.current.height === box.clientHeight) return;
      state.current.width = box.clientWidth;
      state.current.height = box.clientHeight;
      settle();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    // Scrollbars appearing or going change the client box without resizing the element.
    observer.observe(sizer.current!);
    return () => observer.disconnect();
  }, [settle]);

  // Ctrl/Cmd + wheel and trackpad pinch (Chromium reports it as ctrl + wheel) zoom at the pointer.
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      zoom(Math.exp(-event.deltaY * scale * 0.0025), event.clientX - box.getBoundingClientRect().left);
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, [zoom]);

  // Media derived by ingest (waveforms, thumbnails) appears as jobs finish.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const poll = async () => {
      const ingesting = await mediaRef.current!.refresh();
      if (ingesting && !disposed) timer = setTimeout(() => void poll(), INGEST_POLL_MS);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [revision]);

  const onScroll = () => {
    const box = scroller.current!;
    state.current.scrollLeft = box.scrollLeft;
    state.current.scrollTop = box.scrollTop;
    schedule();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "=" || event.key === "+") zoom(ZOOM_STEP);
    else if (event.key === "-") zoom(1 / ZOOM_STEP);
    else if (event.key === "0") fit();
    else if (event.key === "Escape") selection.clear();
    else return;
    event.preventDefault();
  };

  /** Playhead to the time under the pointer. */
  const scrubTo = (clientX: number) => {
    const box = scroller.current!;
    const x = Math.min(box.clientWidth, Math.max(0, clientX - box.getBoundingClientRect().left));
    transport.seek((x + state.current.scrollLeft) / state.current.pxPerSecond);
  };

  /**
   * On the ruler: move the playhead there and scrub while dragging (playback
   * pauses). On a lane: select the clip under the pointer. Scrollbars are left alone.
   */
  const onPointerDown = (event: PointerEvent) => {
    const box = scroller.current!;
    const rect = box.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (event.button !== 0 || x >= box.clientWidth || y >= box.clientHeight) return;
    if (y < RULER_HEIGHT) {
      transport.pause();
      scrubbing.current = event.pointerId;
      box.setPointerCapture(event.pointerId);
      scrubTo(event.clientX);
      return;
    }
    if (!layout) return;
    const hit = clipAt(layout, state.current, x, y);
    if (!hit) selection.clear();
    else if (event.shiftKey || event.metaKey || event.ctrlKey) selection.toggleClip(hit.clip.id, "timeline");
    else selection.selectClips([hit.clip.id], "timeline");
  };

  const onPointerMove = (event: PointerEvent) => {
    if (scrubbing.current === event.pointerId) {
      scrubTo(event.clientX);
      return;
    }
    if (!layout) return;
    const rect = scroller.current!.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const hit = clipAt(layout, state.current, x, y);
    setHover((current) => (hit ? { ...hit, x, y } : current ? null : current));
  };

  return (
    <div className="timeline-body">
      <div className="timeline-heads">
        <div className="ruler-spacer">
          <div className="timeline-zoom" role="group" aria-label="Timeline zoom">
            <button className="icon-button" aria-label="Zoom out" title="Zoom out (-)" onClick={() => zoom(1 / ZOOM_STEP)}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 8h8" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
            <button className="icon-button" aria-label="Zoom to fit" title="Zoom to fit (0)" onClick={fit}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
            <button className="icon-button" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoom(ZOOM_STEP)}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 8h8M8 4v8" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
          </div>
        </div>
        <div className="timeline-heads-rows">
          <div ref={heads}>
            {layout?.rows.map((row) => (
              <div key={row.id} className={`track-head track-${row.kind}`} style={{ height: row.height }} title={row.id}>
                <span className="track-id">{row.label}</span>
                <span className="track-label">{row.name ?? (row.followsLabel ? `Words of ${row.followsLabel}` : "")}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div
        className="timeline-lanes"
        data-testid="timeline-lanes"
        data-revision={revision ?? undefined}
        data-clips={layout?.clipCount ?? 0}
        data-selected={selectedClips.join(" ")}
      >
        <canvas ref={canvas} className="timeline-canvas" aria-hidden="true" />
        <div
          ref={scroller}
          className="timeline-scroller"
          tabIndex={0}
          role="region"
          aria-label="Timeline lanes. Click the ruler to move the playhead, drag it to scrub. Click selects a clip, Escape clears. Plus and minus zoom, 0 fits the timeline."
          onScroll={onScroll}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => {
            if (scrubbing.current === event.pointerId) scrubbing.current = null;
          }}
          onPointerCancel={() => (scrubbing.current = null)}
          onPointerLeave={() => setHover(null)}
        >
          <div ref={sizer} className="timeline-sizer" />
        </div>
        {overlay && <div className="timeline-empty">{overlay}</div>}
        {hover && <ClipTooltip hover={hover} fps={fps} />}
        <ClipList layout={layout} fps={fps} selected={selected} />
      </div>
    </div>
  );
}

function ClipTooltip({ hover, fps }: { hover: { row: TrackRow; clip: ClipBox; x: number; y: number }; fps: number }) {
  const { row, clip } = hover;
  return (
    <div className="clip-tooltip" style={{ left: hover.x + 12, top: hover.y + 14 }} role="tooltip">
      <strong>{clip.name}</strong>
      <span>
        {formatTimecode(clip.start, fps)} to {formatTimecode(clip.end, fps)}
      </span>
      <span className="clip-tooltip-faint">
        {clip.problem ? clip.problem : `${formatDuration(clip.end - clip.start)} on ${row.label}, ${clip.type}`}
      </span>
      <span className="clip-tooltip-faint">{clip.id}</span>
    </div>
  );
}

/** The canvas is opaque to assistive tech: the same clips as a list, selection included, for screen readers and tests. */
function ClipList({ layout, fps, selected }: { layout: TimelineLayout | null; fps: number; selected: ReadonlySet<string> }) {
  if (!layout) return null;
  return (
    <ul className="sr-only" aria-label="Timeline clips">
      {layout.rows.flatMap((row) =>
        row.clips.map((clip) => (
          <li key={clip.id} data-clip={clip.id} data-selected={selected.has(clip.id) || undefined}>
            {`${row.label}: ${clip.name}, ${formatTimecode(clip.start, fps)} to ${formatTimecode(clip.end, fps)}`}
            {clip.problem ? `, ${clip.problem}` : ""}
            {selected.has(clip.id) ? ", selected" : ""}
          </li>
        )),
      )}
    </ul>
  );
}
