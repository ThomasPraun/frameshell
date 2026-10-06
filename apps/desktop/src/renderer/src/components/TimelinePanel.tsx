import type { ClipDiff, OperationResult } from "@frameshell/protocol";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { TimelineEdit } from "../../../shared/api.js";
import { openAskMenu } from "../ask/ask-agent.js";
import { diffCounts } from "../history/model.js";
import { useHistoryDiff } from "../history/useHistory.js";
import { transport } from "../preview/transport.js";
import { SELECTION_TIMELINE, revealSeek, selection, useSelection } from "../selection.js";
import { type CueBox, cueBoxAt, cueBoxes, cueSelection } from "../subtitles/model.js";
import { type SubtitlesState, useSubtitles } from "../subtitles/useSubtitles.js";
import { type DragPreview, type EditCommand, type Grab, commandEdits, dragEdit, dragPreview, grabAt, snapPoints } from "../timeline/edit.js";
import {
  type ClipBox,
  RULER_HEIGHT,
  type TimelineLayout,
  type TrackRow,
  clampScroll,
  contentWidth,
  fitZoom,
  formatDuration,
  formatTimecode,
  layoutTimeline,
  zoomAround,
  zoomLimits,
} from "../timeline/layout.js";
import { MediaCache } from "../timeline/media.js";
import { DEFAULT_THEME, type DragGhost, type TimelineTheme, clipBadges, paintTimeline } from "../timeline/paint.js";
import { useTimelineView } from "../timeline/useTimelineView.js";
import { uiLink } from "../ui-link.js";
import { PanelHeader } from "./PanelHeader.js";
import { TRANSCRIPT_SHORTCUT } from "./TranscriptView.js";

/** Timeline the panel follows: the one selections name, the project's `main` until timelines can be switched. */
const TIMELINE = SELECTION_TIMELINE;
/** Zoom step of the buttons and `+`/`-` keys. */
const ZOOM_STEP = 1.5;
/** User Timing entry of one paint; read by the performance e2e test and DevTools. */
const PAINT_MEASURE = "timeline-paint";
/** A press becomes a drag past this many px: a click on a clip never nudges it. */
const DRAG_THRESHOLD_PX = 3;
/** Edges snap to targets within this many px. */
const SNAP_PX = 8;
/** Status line messages fade after this long. */
const STATUS_MS = 6_000;
const isMac = navigator.userAgent.includes("Mac");

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

/** Pointer gesture in progress on the lanes. */
type Gesture =
  | { kind: "scrub"; pointer: number }
  /** Drag over empty lane space: selects the time range swept. */
  | { kind: "range"; pointer: number; time: number; clientX: number; moving: boolean }
  | {
      kind: "clip";
      pointer: number;
      grab: Grab;
      /** Timeline time and client px under the press. */
      time: number;
      clientX: number;
      clientY: number;
      /** Past the drag threshold: a ghost is shown and release sends an edit. */
      moving: boolean;
      preview: DragPreview | null;
    };

/** One line of feedback in the header: what an edit did, or why the daemon refused it. */
interface Status {
  text: string;
  tone: "info" | "error";
}

/**
 * Canvas timeline of the project's main timeline (SPEC §10): tracks and clips
 * from the daemon, redrawn live as the agent edits from the terminal, and
 * edited in place. Every edit is one daemon operation by `ui`, saved at once;
 * drags show a ghost and send on release. Clicks select in the shared
 * selection store, which the script editor also reads and sets (scene links,
 * SPEC §5.5); the ruler moves the shared playhead. Keys are listed in
 * {@link KEYS_LABEL}.
 * The playhead is the shared transport's (preview/transport.ts): it moves while the preview
 * plays (the lanes follow it), and the ruler scrubs it.
 */
export function TimelinePanel({
  collapsed,
  onToggle,
  onShowTranscript,
}: {
  collapsed: boolean;
  onToggle: () => void;
  /** Open the transcript view: the header's "Transcript" button. */
  onShowTranscript?: () => void;
}) {
  const { view, error, rejection, dismissRejection } = useTimelineView(TIMELINE);
  const layout = useMemo(() => (view ? layoutTimeline(view) : null), [view]);
  const empty = layout !== null && layout.clipCount === 0;
  const [status, setStatus] = useState<Status | null>(null);
  // The History panel's pick, marked on the lanes: what that transaction or operation did.
  const { history } = useSelection();
  const { diff } = useHistoryDiff(TIMELINE, history, view?.revision ?? null);
  const marks = history !== null && diff?.target === history ? diff.clips : null;

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), STATUS_MS);
    return () => clearTimeout(timer);
  }, [status]);

  return (
    <>
      <PanelHeader
        onCollapse={onToggle}
        collapseLabel={collapsed ? "Show timeline" : "Hide timeline"}
        collapseSide={collapsed ? "up" : "down"}
      >
        <span className="panel-title">Timeline</span>
        <span className="panel-meta">{TIMELINE}</span>
        <span className={`timeline-status${status?.tone === "error" ? " timeline-status-error" : ""}`} role="status" aria-live="polite">
          {status?.text ?? ""}
        </span>
        {history !== null && <DiffLegend target={history} marks={marks} />}
        {onShowTranscript && (
          <button className="link" aria-label="Show transcript" title={`Open the transcript view (${TRANSCRIPT_SHORTCUT})`} onClick={onShowTranscript}>
            Transcript
          </button>
        )}
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
          diff={marks}
          onStatus={setStatus}
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

/** Screen-reader summary of the lanes' mouse and keyboard controls. */
const KEYS_LABEL =
  "Timeline lanes. Click selects a clip, drag moves it, drag an edge to trim; drag over empty space selects a time range; " +
  "the ruler moves the playhead. " +
  "Click a subtitle cue to select its words, or a subtitle lane to set its style. " +
  "S splits at the playhead, [ and ] trim to it, comma and period nudge a frame, Delete removes, Shift+Delete ripple deletes, " +
  "arrows move the playhead, N toggles snapping, Escape clears. Plus and minus zoom, 0 fits the timeline. " +
  `${isMac ? "Command" : "Control"}+Z undoes, ${isMac ? "Command+Shift+Z" : "Control+Y"} redoes.`;

function TimelineCanvas({
  layout,
  fps,
  revision,
  diff,
  overlay,
  onStatus,
}: {
  layout: TimelineLayout | null;
  fps: number;
  revision: number | null;
  /** Marks of the history entry selected in the History panel; null when none. */
  diff: readonly ClipDiff[] | null;
  overlay: ReactNode;
  onStatus: (status: Status | null) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const sizer = useRef<HTMLDivElement>(null);
  const heads = useRef<HTMLDivElement>(null);
  const state = useRef<ViewState>({ pxPerSecond: 10, fit: true, scrollLeft: 0, scrollTop: 0, width: 0, height: 0 });
  const frame = useRef(0);
  const paints = useRef(0);
  const theme = useRef<TimelineTheme>(DEFAULT_THEME);
  const { clips: selectedClips, range, reveal, track: selectedTrack } = useSelection();
  const selected = useMemo(() => new Set(selectedClips), [selectedClips]);
  const subtitles = useSubtitles();
  const cues = useMemo(() => new Map(subtitles.tracks.map((track) => [track.track, cueBoxes(track, subtitles.fps)] as const)), [subtitles]);
  const [snapping, setSnapping] = useState(true);
  const gesture = useRef<Gesture | null>(null);
  /** Ghost drawn from a drag until the daemon's new revision shows the clip there. */
  const ghost = useRef<{ drag: DragGhost; until: number | null } | null>(null);
  /** Edits run one after another, in the order they were made. */
  const queue = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef({ layout, fps, selected, range, revision, snapping, diff, cues, selectedTrack });
  latest.current = { layout, fps, selected, range, revision, snapping, diff, cues, selectedTrack };
  const lanesEl = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ row: TrackRow; clip: ClipBox; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState<{ preview: DragPreview; x: number; y: number } | null>(null);

  const draw = useCallback(() => {
    frame.current = 0;
    const element = canvas.current;
    const context = element?.getContext("2d");
    const { layout: current, fps: rate, selected: chosen, range: words, diff: marks, cues: subtitleCues, selectedTrack: track } = latest.current;
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
    const drag = ghost.current?.drag;
    const { mediaDrawn } = paintTimeline(context, {
      layout: current ?? { rows: [], duration: 0, height: RULER_HEIGHT, clipCount: 0 },
      viewport: view,
      fps: rate,
      playhead: at,
      theme: theme.current,
      media: mediaRef.current!,
      selected: chosen,
      ...(marks ? { diff: marks } : {}),
      range: words,
      subtitles: subtitleCues,
      selectedTrack: track,
      ...(drag ? { drag } : {}),
    });
    performance.measure(PAINT_MEASURE, { start: started });
    // User Timing buffers are unbounded: keep only recent paints.
    if (++paints.current % 500 === 0) performance.clearMeasures(PAINT_MEASURE);
    if (heads.current) heads.current.style.transform = `translateY(${-view.scrollTop}px)`;
    // Written per paint, outside React: tests and DevTools see when waveforms or thumbnails arrive.
    element.parentElement?.setAttribute("data-media-drawn", String(mediaDrawn));
    // Scroll, zoom and resize all repaint: the agent's `ui_state.visible` follows (throttled there).
    uiLink.changed();
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
    // A revision at or past the one a drag produced shows the clip where its ghost was.
    const pending = ghost.current;
    if (pending?.until != null && revision !== null && revision >= pending.until) ghost.current = null;
    settle();
    if (frame.current) cancelAnimationFrame(frame.current);
    draw();
  }, [layout, revision, selected, range, diff, cues, selectedTrack, settle, draw]);

  // `ui_state.visible`: read from the live scroll and zoom when published, null once the lanes unmount.
  useEffect(() => {
    uiLink.setViewport(() => {
      const view = state.current;
      if (view.width === 0 || view.pxPerSecond <= 0) return null;
      return { from: view.scrollLeft / view.pxPerSecond, to: (view.scrollLeft + view.width) / view.pxPerSecond };
    });
    return () => uiLink.setViewport(null);
  }, []);
  // The playhead moves every frame while playing: repaint outside React, and page the lanes to keep it in view.
  useEffect(
    () =>
      transport.subscribe(() => {
        const { time, playing } = transport.get();
        const view = state.current;
        const x = time * view.pxPerSecond - view.scrollLeft;
        // Playing pages ahead; a jump from elsewhere (agent `ui_seek`, preview keys) centers the playhead.
        if (gesture.current?.kind !== "scrub" && view.width > 0 && (x < 0 || x > view.width - 16)) {
          view.scrollLeft = Math.max(0, time * view.pxPerSecond - view.width * (playing ? 0.1 : 0.5));
          settle();
        }
        lanesEl.current?.setAttribute("data-playhead", String(time));
        schedule();
      }),
    [schedule, settle],
  );

  // Keyed on the request, not the selection: the same heading clicked again scrolls again, pruning never scrolls.
  useEffect(() => {
    const box = scroller.current;
    const current = latest.current.layout;
    if (!reveal || !box || !current) return;
    const follow = (clip: { start: number } | null) => {
      const time = revealSeek(reveal, clip, { playing: transport.get().playing, fps: latest.current.fps });
      if (time !== null) transport.seek(time);
    };
    if (reveal.range) {
      // Selected words (transcript): the playhead goes to their start, even while playing; the lanes scroll to them.
      const { from, to } = reveal.range;
      follow(null);
      const view = state.current;
      view.scrollLeft = box.scrollLeft;
      if (from * view.pxPerSecond < view.scrollLeft || to * view.pxPerSecond > view.scrollLeft + view.width) {
        view.scrollLeft = Math.max(0, from * view.pxPerSecond - view.width / 4);
      }
      settle();
      return;
    }
    let row = current.rows.find((candidate) => candidate.clips.some((clip) => clip.id === reveal.clip));
    let clip: { start: number; end: number } | undefined = row?.clips.find((candidate) => candidate.id === reveal.clip);
    // Gone from the timeline (a transaction removed it): look where it was.
    if ((!row || !clip) && reveal.place) {
      const { place } = reveal;
      row = current.rows.find((candidate) => candidate.id === place.track);
      clip = { start: place.start, end: place.end ?? place.start };
    }
    if (!row || !clip) return;
    // The player follows selections made elsewhere: the playhead jumps to the clip (not while playing).
    follow(clip);
    const view = state.current;
    // The DOM is the truth: a scroll made just before (wheel, script) may not have reached `state` (its event is async).
    view.scrollLeft = box.scrollLeft;
    view.scrollTop = box.scrollTop;
    const x0 = clip.start * view.pxPerSecond;
    const x1 = clip.end * view.pxPerSecond;
    if (x0 < view.scrollLeft || x1 > view.scrollLeft + view.width) view.scrollLeft = Math.max(0, x0 - view.width / 4);
    const lanes = view.height - RULER_HEIGHT;
    const top = row.top - RULER_HEIGHT;
    if (top < view.scrollTop || top + row.height > view.scrollTop + lanes) view.scrollTop = Math.max(0, top);
    settle();
  }, [reveal, settle]);

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
      diffAdded: read("--diff-added", DEFAULT_THEME.diffAdded),
      diffMoved: read("--diff-moved", DEFAULT_THEME.diffMoved),
      diffChanged: read("--diff-changed", DEFAULT_THEME.diffChanged),
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

  // Media derived by ingest (waveforms, thumbnails) appears on the daemon's `asset.changed`, never by polling.
  // Listening first: an event during the initial read is replayed over it.
  useEffect(() => {
    const media = mediaRef.current!;
    const off = window.frameshell.media.onChanged((change) => media.apply(change));
    void media.refresh();
    return off;
  }, []);

  /**
   * Queue daemon calls, one at a time; a refusal shows the daemon's message.
   * `clips` is how many clips the call edits, for the status line.
   */
  const run = useCallback(
    (work: () => Promise<OperationResult | null>, done?: (result: OperationResult | null) => void, clips = 1) => {
      queue.current = queue.current.then(async () => {
        try {
          const result = await work();
          onStatus(result ? describe(result, latest.current.fps, clips) : null);
          done?.(result);
        } catch (error) {
          onStatus({ tone: "error", text: (error as Error).message });
          done?.(null);
        }
      });
    },
    [onStatus],
  );

  const send = useCallback(
    (edits: TimelineEdit[], done?: (result: OperationResult | null) => void) => {
      if (edits.length === 0) {
        done?.(null);
        return;
      }
      // One call per command: main applies its edits as one transaction, one undo step.
      run(() => window.frameshell.timeline.edit(TIMELINE, edits), done, edits.length);
    },
    [run],
  );

  const command = (kind: EditCommand) => {
    const current = latest.current;
    if (!current.layout) return;
    const edits = commandEdits(kind, { layout: current.layout, selected: selectedClips, playhead: transport.get().time, fps: current.fps });
    if (edits.length === 0) onStatus({ tone: "info", text: nothingToDo(kind, selectedClips.length > 0) });
    else send(edits);
  };

  const history = (direction: "undo" | "redo") =>
    run(async () => {
      const result = await window.frameshell.timeline[direction](TIMELINE);
      if (!result) onStatus({ tone: "info", text: direction === "undo" ? "Nothing to undo" : "Nothing to redo" });
      return result;
    });

  /** Move the playhead, scrolling it into view when a key took it off screen. */
  const seek = (seconds: number, reveal: boolean) => {
    const rate = latest.current.fps;
    const time = Math.max(0, Math.round(seconds * rate) / rate);
    transport.seek(time);
    const view = state.current;
    const x = time * view.pxPerSecond;
    if (reveal && (x < view.scrollLeft || x > view.scrollLeft + view.width)) {
      view.scrollLeft = Math.max(0, x - view.width / 2);
      settle();
    }
  };

  const onScroll = () => {
    const box = scroller.current!;
    state.current.scrollLeft = box.scrollLeft;
    state.current.scrollTop = box.scrollTop;
    schedule();
  };

  const cancelDrag = (): boolean => {
    const current = gesture.current;
    gesture.current = null;
    setDragging(null);
    if (current?.kind === "clip" && current.moving) {
      ghost.current = null;
      schedule();
      return true;
    }
    return false;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const mod = isMac ? event.metaKey : event.ctrlKey;
    const frames = event.shiftKey ? 10 : 1;
    if (mod && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "z") history(event.shiftKey ? "redo" : "undo");
      else if (key === "y" && !isMac) history("redo");
      else if (key === "k") command({ kind: "split" });
      else return;
    } else if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    } else if (event.key === "=" || event.key === "+") zoom(ZOOM_STEP);
    else if (event.key === "-") zoom(1 / ZOOM_STEP);
    else if (event.key === "0") fit();
    else if (event.key === "Escape") {
      if (!cancelDrag()) selection.clear();
    } else if (event.code === "KeyS" && !event.shiftKey) command({ kind: "split" });
    else if (event.code === "BracketLeft") command({ kind: "trim", side: "head" });
    else if (event.code === "BracketRight") command({ kind: "trim", side: "tail" });
    else if (event.code === "Comma") command({ kind: "nudge", frames: -frames });
    else if (event.code === "Period") command({ kind: "nudge", frames });
    else if (event.key === "Delete" || event.key === "Backspace") command({ kind: "delete", ripple: event.shiftKey });
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const step = event.shiftKey ? 1 : 1 / latest.current.fps;
      seek(transport.get().time + (event.key === "ArrowLeft" ? -step : step), true);
    } else if (event.key === "Home") seek(0, true);
    else if (event.key === "End") seek(latest.current.layout?.duration ?? 0, true);
    else if (event.code === "KeyN") setSnapping((on) => !on);
    else return;
    event.preventDefault();
  };

  /** Pointer position in the scroller's box, or null over its scrollbars. */
  const locate = (event: PointerEvent) => {
    const box = scroller.current!;
    const rect = box.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    return x >= box.clientWidth || y >= box.clientHeight ? null : { x, y };
  };

  const timeAt = (x: number) => (x + state.current.scrollLeft) / state.current.pxPerSecond;

  /**
   * Press on the lanes: the ruler scrubs the playhead; a clip is selected
   * (Shift/Cmd/Ctrl toggles) and may be dragged; empty lane clears, and a
   * drag from there selects the time range it sweeps.
   */
  const onPointerDown = (event: PointerEvent) => {
    const at = locate(event);
    if (event.button !== 0 || !layout || !at) return;
    const box = scroller.current!;
    if (at.y < RULER_HEIGHT) {
      transport.pause();
      gesture.current = { kind: "scrub", pointer: event.pointerId };
      box.setPointerCapture(event.pointerId);
      seek(timeAt(at.x), false);
      return;
    }
    const grab = grabAt(layout, state.current, at.x, at.y);
    if (!grab) {
      const row = layout.rows.find((candidate) => at.y + state.current.scrollTop >= candidate.top && at.y + state.current.scrollTop < candidate.top + candidate.height);
      if (row?.kind === "subtitles") {
        pickSubtitle(row.id, timeAt(at.x));
        return;
      }
      selection.clear();
      gesture.current = { kind: "range", pointer: event.pointerId, time: timeAt(at.x), clientX: event.clientX, moving: false };
      box.setPointerCapture(event.pointerId);
      return;
    }
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      selection.toggleClip(grab.clip.id, "timeline");
      return;
    }
    // Pressing a selected clip keeps the others selected until release: the press may start a drag.
    if (!selected.has(grab.clip.id)) selection.selectClips([grab.clip.id], "timeline");
    gesture.current = {
      kind: "clip",
      pointer: event.pointerId,
      grab,
      time: timeAt(at.x),
      clientX: event.clientX,
      clientY: event.clientY,
      moving: false,
      preview: null,
    };
    box.setPointerCapture(event.pointerId);
    setHover(null);
  };

  /** A subtitle lane pressed at `time`: its cue's words (the playhead goes there), else the track alone. */
  const pickSubtitle = (track: string, time: number) => {
    const box = cueBoxAt(latest.current.cues.get(track) ?? [], time);
    const picked = box ? cueSelection(box.cue, subtitles.fps, subtitles.transcriptOf) : null;
    if (picked && picked.words.length > 0) selection.selectWords(picked.words, picked.range, "timeline", { reveal: true, track });
    else selection.selectTrack(track, "timeline");
  };

  /** Add a subtitle track following the likeliest track, then select it for its style. */
  const addSubtitles = () => {
    const follows = subtitleSource(latest.current.layout, selectedClips, subtitles);
    if (!follows) {
      onStatus({ tone: "info", text: "Add a video or audio track first: subtitles follow one" });
      return;
    }
    send([{ op: "track.add", args: { kind: "subtitles", follows, style: { preset: "big-keyword" } } }], (result) => {
      const added = result?.changes.added[0];
      if (added) selection.selectTrack(added, "timeline");
    });
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!layout) return;
    const rect = scroller.current!.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const current = gesture.current;
    if (current?.kind === "scrub") {
      seek(timeAt(x), false);
      return;
    }
    if (current?.kind === "range") {
      if (!current.moving && Math.abs(event.clientX - current.clientX) < DRAG_THRESHOLD_PX) return;
      current.moving = true;
      // Frame grid, inside the timeline: a range names frames the agent can address.
      const rate = latest.current.fps;
      const onGrid = (time: number) => Math.min(layout.duration, Math.max(0, Math.round(time * rate) / rate));
      const [a, b] = [onGrid(current.time), onGrid(timeAt(x))];
      selection.selectRange({ from: Math.min(a, b), to: Math.max(a, b) }, "timeline");
      return;
    }
    if (current?.kind === "clip") {
      const travel = Math.max(Math.abs(event.clientX - current.clientX), Math.abs(event.clientY - current.clientY));
      if (!current.moving && travel < DRAG_THRESHOLD_PX) return;
      current.moving = true;
      const view = state.current;
      // Alt inverts snapping for this drag position.
      const snap = latest.current.snapping !== event.altKey;
      const preview = dragPreview({
        layout,
        grab: current.grab,
        delta: timeAt(x) - current.time,
        y: y + view.scrollTop,
        fps: latest.current.fps,
        snap: snap
          ? { points: snapPoints(layout, transport.get().time, new Set([current.grab.clip.id])), tolerance: SNAP_PX / view.pxPerSecond }
          : null,
      });
      current.preview = preview;
      ghost.current = { drag: toGhost(preview), until: null };
      setDragging({ preview, x, y });
      schedule();
      return;
    }
    const grab = grabAt(layout, state.current, x, y);
    scroller.current!.style.cursor = grab ? (grab.part === "body" ? "grab" : "ew-resize") : "";
    setHover((was) => (grab ? { row: grab.row, clip: grab.clip, x, y } : was ? null : was));
  };

  const onPointerUp = (event: PointerEvent) => {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    gesture.current = null;
    setDragging(null);
    if (current.kind !== "clip") return;
    if (!current.moving) {
      // A click (no drag) on a clip of a multi-selection selects just it.
      if (!event.shiftKey && !event.metaKey && !event.ctrlKey) selection.selectClips([current.grab.clip.id], "timeline");
      return;
    }
    const edit = current.preview ? dragEdit(current.preview) : null;
    if (!edit) {
      ghost.current = null;
      schedule();
      return;
    }
    const drawn = ghost.current;
    send([edit], (result) => {
      if (ghost.current !== drawn || !drawn) return;
      // Keep the ghost until the feed shows the result; drop it at once when refused or already shown.
      if (result && (latest.current.revision ?? -1) < result.revision) drawn.until = result.revision;
      else ghost.current = null;
      schedule();
    });
  };

  const onPointerCancel = () => {
    if (gesture.current) cancelDrag();
  };

  /** Right-click: a clip not yet selected becomes the selection, then "Ask agent" opens on it. */
  const onContextMenu = (event: MouseEvent) => {
    const box = scroller.current!;
    const rect = box.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const grab = layout && y >= RULER_HEIGHT ? grabAt(layout, state.current, x, y) : null;
    if (grab && !selected.has(grab.clip.id)) selection.selectClips([grab.clip.id], "timeline");
    openAskMenu(event);
  };

  return (
    <div className="timeline-body">
      <div className="timeline-heads">
        <div className="ruler-spacer">
          <div className="timeline-zoom" role="group" aria-label="Timeline zoom and snapping">
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
            <button
              className={`icon-button snap-toggle${snapping ? " on" : ""}`}
              aria-label="Snapping"
              aria-pressed={snapping}
              title={`Snap to clip edges and the playhead (N; hold ${isMac ? "Option" : "Alt"} to invert)`}
              onClick={() => setSnapping((on) => !on)}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 2.5v6a4 4 0 0 0 8 0v-6M4 5.5h2.5M9.5 5.5H12" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
            <button
              className="icon-button"
              aria-label="Add subtitle track"
              title="Add subtitles: the transcript words of the selected clip's track (or the first transcribed one)"
              disabled={!layout?.rows.some((row) => row.kind !== "subtitles")}
              onClick={addSubtitles}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <path d="M4.5 9.5h3.5M9.5 9.5h2M4.5 7h1.5M7.5 7h4" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
          </div>
        </div>
        <div className="timeline-heads-rows">
          <div ref={heads}>
            {layout?.rows.map((row) =>
              row.kind === "subtitles" ? (
                <button
                  key={row.id}
                  className={`track-head track-${row.kind}${selectedTrack === row.id ? " is-selected" : ""}`}
                  style={{ height: row.height }}
                  title={`${row.id}: select to set its style`}
                  aria-pressed={selectedTrack === row.id}
                  data-track={row.id}
                  onClick={() => selection.selectTrack(row.id, "timeline")}
                >
                  <span className="track-id">{row.label}</span>
                  <span className="track-label">{row.name ?? `Words of ${row.followsLabel ?? "?"}`}</span>
                </button>
              ) : (
                <div key={row.id} className={`track-head track-${row.kind}`} style={{ height: row.height }} title={row.id}>
                  <span className="track-id">{row.label}</span>
                  <span className="track-label">{row.name ?? ""}</span>
                </div>
              ),
            )}
          </div>
        </div>
      </div>
      <div
        className="timeline-lanes"
        data-testid="timeline-lanes"
        data-revision={revision ?? undefined}
        data-clips={layout?.clipCount ?? 0}
        data-selected={selectedClips.join(" ")}
        data-diff={diff?.map((mark) => `${mark.change}:${mark.clip}`).join(" ")}
        data-range={range ? `${range.from}-${range.to}` : undefined}
        ref={lanesEl}
        data-playhead={transport.get().time}
        data-dragging={dragging ? dragging.preview.part : undefined}
      >
        <canvas ref={canvas} className="timeline-canvas" aria-hidden="true" />
        <div
          ref={scroller}
          className="timeline-scroller"
          tabIndex={0}
          role="region"
          aria-label={KEYS_LABEL}
          onScroll={onScroll}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onLostPointerCapture={onPointerCancel}
          onContextMenu={onContextMenu}
          onPointerLeave={() => setHover(null)}
        >
          <div ref={sizer} className="timeline-sizer" />
        </div>
        {overlay && <div className="timeline-empty">{overlay}</div>}
        {dragging ? <DragTooltip {...dragging} fps={fps} /> : hover && <ClipTooltip hover={hover} fps={fps} />}
        <ClipList layout={layout} fps={fps} selected={selected} cues={cues} />
      </div>
    </div>
  );
}

/** Header chip while a history entry's changes are marked on the lanes: counts by kind, and a way out. */
function DiffLegend({ target, marks }: { target: string; marks: readonly ClipDiff[] | null }) {
  const counts = marks ? diffCounts(marks) : null;
  return (
    <span className="timeline-diff-legend" data-history={target}>
      <span className="panel-meta" title={`Changes of ${target}`}>
        {target}
      </span>
      {counts &&
        (["added", "removed", "moved", "changed"] as const)
          .filter((kind) => counts[kind] > 0)
          .map((kind) => <span key={kind} className={`diff-count diff-${kind}`}>{`${counts[kind]} ${kind}`}</span>)}
      <button className="icon-button" aria-label="Stop showing these changes" title="Stop showing these changes (Esc on the lanes)" onClick={() => selection.clear()}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
    </span>
  );
}

/** Ghost of a drag preview, as the painter draws it. */
function toGhost(preview: DragPreview): DragGhost {
  return {
    clip: preview.clip.id,
    row: preview.row.id,
    start: preview.start,
    end: preview.end,
    blocked: preview.blocked,
    guide: preview.snapped?.time ?? null,
  };
}

/** Header line for an applied edit of `clips` clips: energy snapping news (ADR 0003), else what was done. */
function describe(result: OperationResult, fps: number, clips: number): Status {
  const rough = result.snaps.find((snap) => !snap.clean);
  if (rough) {
    return {
      tone: "error",
      text: `No pause within ${rough.window} s of ${formatTimecode(rough.applied, fps)}: speech may be clipped there`,
    };
  }
  const moved = result.snaps.find((snap) => Math.abs(snap.applied - snap.requested) >= 0.0005);
  if (moved) return { tone: "info", text: `Edge snapped ${formatDuration(Math.abs(moved.applied - moved.requested))} into a pause` };
  const label = OP_LABELS[result.operation.op] ?? result.operation.op;
  return { tone: "info", text: clips > 1 ? `${label} of ${clips} clips saved as one step` : `${label} saved` };
}

const OP_LABELS: Record<string, string> = {
  "clip.move": "Move",
  "clip.trim": "Trim",
  "clip.split": "Split",
  "clip.remove": "Delete",
  cut: "Ripple delete",
  revert: "Undo",
  "track.add": "New track",
  "track.set": "Track change",
};

/**
 * Track a new subtitle track should follow: the selected clip's track, else
 * the first whose clips have a transcript, else the first video (then audio)
 * track; null when there is no clip track.
 */
function subtitleSource(layout: TimelineLayout | null, selectedClips: readonly string[], subtitles: SubtitlesState): string | null {
  const rows = layout?.rows.filter((row) => row.kind !== "subtitles") ?? [];
  const picked = rows.find((row) => row.clips.some((clip) => selectedClips.includes(clip.id)));
  const transcribed = rows.find((row) => row.clips.some((clip) => clip.asset !== null && subtitles.transcriptOf(clip.asset) !== null));
  // Rows list the top video layer first: the base track is the last video row.
  const base = rows.filter((row) => row.kind === "video").at(-1) ?? rows[0];
  return (picked ?? transcribed ?? base)?.id ?? null;
}

/** Why a key did nothing, in the header. */
function nothingToDo(command: EditCommand, anySelected: boolean): string {
  switch (command.kind) {
    case "split":
    case "trim":
      return anySelected ? "No selected clip under the playhead" : "No clip under the playhead";
    case "nudge":
    case "delete":
      return anySelected ? "Nothing to change" : "Select a clip first";
  }
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

/** Where the dragged clip or edge would land, next to the pointer. */
function DragTooltip({ preview, x, y, fps }: { preview: DragPreview; x: number; y: number; fps: number }) {
  const { part, clip, row } = preview;
  const title = part === "body" ? `Move ${clip.name}` : `Trim ${part === "head" ? "start" : "end"} of ${clip.name}`;
  const time = part === "tail" ? preview.end : preview.start;
  return (
    <div className="clip-tooltip drag-tooltip" style={{ left: x + 12, top: y + 14 }} role="tooltip">
      <strong>{title}</strong>
      <span>
        {formatTimecode(time, fps)}
        {part === "body" && row.id !== preview.from.id ? ` on ${row.label}` : ""}
      </span>
      <span className={preview.blocked ? "clip-tooltip-danger" : "clip-tooltip-faint"}>
        {preview.blocked
          ? "Overlaps a clip: will be refused"
          : preview.snapped
            ? `Snapped to ${preview.snapped.kind === "playhead" ? "the playhead" : "a clip edge"}`
            : formatDuration(preview.end - preview.start)}
      </span>
    </div>
  );
}

/** The canvas is opaque to assistive tech: the same clips and subtitle cues as a list, selection included, for screen readers and tests. */
function ClipList({
  layout,
  fps,
  selected,
  cues,
}: {
  layout: TimelineLayout | null;
  fps: number;
  selected: ReadonlySet<string>;
  cues: ReadonlyMap<string, readonly CueBox[]>;
}) {
  if (!layout) return null;
  return (
    <ul className="sr-only" aria-label="Timeline clips">
      {layout.rows.flatMap((row) =>
        row.kind === "subtitles"
          ? (cues.get(row.id) ?? []).map((cue) => (
              <li key={`${row.id}@${cue.start}`} data-cue={row.id}>
                {`${row.label}: "${cue.text}", ${formatTimecode(cue.start, fps)} to ${formatTimecode(cue.end, fps)}`}
              </li>
            ))
          : row.clips.map((clip) => (
              <li key={clip.id} data-clip={clip.id} data-selected={selected.has(clip.id) || undefined}>
                {`${row.label}: ${clip.name}, ${formatTimecode(clip.start, fps)} to ${formatTimecode(clip.end, fps)}`}
                {clip.problem ? `, ${clip.problem}` : ""}
                {clipBadges(clip).map((badge) => `, ${badge}`).join("")}
                {selected.has(clip.id) ? ", selected" : ""}
              </li>
            )),
      )}
    </ul>
  );
}
