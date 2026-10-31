import type { ClipDiff, OperationResult } from "@frameshell/protocol";
import type { Clip } from "@frameshell/schema";
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
import type { EditOptions, HistoryCommand, TimelineEdit } from "../../../shared/api.js";
import { turnsKey } from "../angles/model.js";
import { useGroupsTurns } from "../angles/useTurns.js";
import { openAskMenu } from "../ask/ask-agent.js";
import { revealItem } from "../file-commands.js";
import { diffCounts } from "../history/model.js";
import { editsText, handleTimelineHistory } from "../history-commands.js";
import { rich, t } from "../i18n.js";
import { listenEverywhere, windowOf } from "../windows.js";
import { useHistoryDiff } from "../history/useHistory.js";
import { showSide } from "../review/store.js";
import { useProposalMarks } from "../review/useProposalMarks.js";
import { sourceSeconds } from "../preview/program.js";
import { transport } from "../preview/transport.js";
import { useAssets, useNestedViews, useProjectKind } from "../preview/useProgram.js";
import { SELECTION_TIMELINE, type SelectedScene, revealSeek, selection, useSelection } from "../selection.js";
import { type CueBox, cueBoxAt, cueBoxes, cueSelection } from "../subtitles/model.js";
import { type SubtitlesState, useSubtitles } from "../subtitles/useSubtitles.js";
import {
  type DragPreview,
  type EditCommand,
  type Grab,
  commandEdits,
  commandOptions,
  dragEdits,
  dragPreview,
  grabAt,
  historyShortcut,
  snapPoints,
  withStarts,
} from "../timeline/edit.js";
import {
  type ClipBox,
  RULER_HEIGHT,
  type SceneBox,
  type TimelineLayout,
  type TrackRow,
  clampScroll,
  contentWidth,
  fitZoom,
  formatDuration,
  formatTimecode,
  layoutTimeline,
  sceneAt,
  zoomAround,
  zoomLimits,
} from "../timeline/layout.js";
import { MediaCache } from "../timeline/media.js";
import { DEFAULT_THEME, type DragGhost, type TimelineTheme, type TurnStroke, clipBadges, paintTimeline } from "../timeline/paint.js";
import { useSceneSpans } from "../timeline/scenes.js";
import { type EdgeHit, edgeAt } from "../timeline/transitions.js";
import { type PaintMode, clearEdit, laneAt, paintEdits, shotSpans, unpaintEdits } from "../timeline/turn-lanes.js";
import { useTimelineView } from "../timeline/useTimelineView.js";
import { useTranscripts } from "../transcript/useTranscripts.js";
import { uiLink } from "../ui-link.js";
import { type MenuItem, contextMenu } from "./ContextMenu.js";
import { DetachButton } from "./DetachControls.js";
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
/** Delete and ripple delete as menus show their keys (Backspace works too). */
const DELETE_KEY = isMac ? "⌫" : "Del";
const RIPPLE_DELETE_KEY = isMac ? "⇧⌫" : "Shift+Del";

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
  /** Drag over an angle's turn lane: paints who speaks over the time swept (#247). */
  | { kind: "paint"; pointer: number; row: TrackRow; angle: string; time: number; clientX: number; moving: boolean }
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
      /** Edge drags: ripple trim, the panel's mode inverted by Shift at the press. */
      ripple: boolean;
      /** Pressed with Shift on an edge: a click without a drag toggles the clip's selection, as Shift+click does. */
      toggle: boolean;
    };

/** One line of feedback in the header: what an edit did, or why the daemon refused it. */
interface Status {
  text: string;
  tone: "info" | "error";
}

/** Queue one daemon call of the panel; `done` gets its result, null when refused. */
type RunCall = (work: () => Promise<OperationResult | null>, done?: (result: OperationResult | null) => void, clips?: number) => void;

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
  detached = false,
  onDetach,
}: {
  collapsed: boolean;
  /** Collapse or expand; absent in the timeline's own window, which does not collapse. */
  onToggle?: () => void;
  /** Open the transcript view: the header's "Transcript" button. */
  onShowTranscript?: () => void;
  /** The panel is in its own window (ADR 0012). */
  detached?: boolean;
  /** Move the panel to its own window, or dock it back while `detached`. */
  onDetach?: () => void;
}) {
  const { view, error, rejection, dismissRejection } = useTimelineView(TIMELINE);
  const scenes = useSceneSpans(TIMELINE, view?.revision ?? null);
  const [status, setStatus] = useState<Status | null>(null);
  // Program tracks whose turn lanes are open, and the turns they draw (measured again when anything they hear changes).
  const [lanesOpen, setLanesOpen] = useState<ReadonlySet<string>>(new Set());
  const { sources, hashes } = useTranscripts();
  const wanted = useMemo(() => {
    const groups = new Map<string, string>();
    for (const track of view?.tracks ?? []) {
      if (track.kind !== "program" || !lanesOpen.has(track.id) || !track.group) continue;
      const group = view?.groups?.find((candidate) => candidate.id === track.group);
      if (group) groups.set(group.id, turnsKey(group.angles, sources, hashes, group.mics, group.painted));
    }
    return groups;
  }, [view, lanesOpen, sources, hashes]);
  const measured = useGroupsTurns(wanted, true);
  const turnLanes = useMemo(() => ({ open: lanesOpen, turns: new Map([...measured].map(([group, found]) => [group, found.turns])) }), [lanesOpen, measured]);
  const assets = useAssets(view?.revision ?? null);
  // A nested clip's handles are its timeline's seconds outside the window (ADR 0018 decision 5).
  const nested = useNestedViews(view ?? null);
  const transitions = useMemo(() => ({ sourceDuration: (clip: Clip) => (assets ? sourceSeconds(clip, assets, nested) : undefined) }), [assets, nested]);
  const layout = useMemo(() => (view ? layoutTimeline(view, scenes, turnLanes, transitions) : null), [view, scenes, turnLanes, transitions]);
  const empty = layout !== null && layout.clipCount === 0;
  const toggleLanes = useCallback(
    (track: string) =>
      setLanesOpen((open) => {
        const next = new Set(open);
        if (!next.delete(track)) next.add(track);
        return next;
      }),
    [],
  );
  const turnsError = [...measured.values()].find((found) => found.error !== null)?.error ?? null;
  /** Edits, undo and redo run one after another, in the order they were made. */
  const queue = useRef<Promise<void>>(Promise.resolve());
  const fpsRef = useRef(30);
  fpsRef.current = view?.fps ?? 30;

  /**
   * Queue daemon calls, one at a time; a refusal shows the daemon's message.
   * `clips` is how many clips the call edits, for the status line.
   */
  const run = useCallback<RunCall>((work, done, clips = 1) => {
    queue.current = queue.current.then(async () => {
      try {
        const result = await work();
        setStatus(result ? describe(result, fpsRef.current, clips) : null);
        done?.(result);
      } catch (error) {
        setStatus({ tone: "error", text: (error as Error).message });
        done?.(null);
      }
    });
  }, []);

  const undoRedo = useCallback(
    (direction: HistoryCommand) =>
      run(async () => {
        const result = await window.frameshell.timeline[direction](TIMELINE);
        if (!result) setStatus({ tone: "info", text: direction === "undo" ? t.timeline.nothingToUndo : t.timeline.nothingToRedo });
        return result;
      }),
    [run],
  );

  // Undo and redo anywhere in the window but text fields (#119): their keys here, the Edit menu's items via App.
  // A key handled here is prevented, so it never also reaches the menu; one in a text field is left to the field.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const command = event.defaultPrevented ? null : historyShortcut(event, isMac);
      if (!command || editsText(event.target)) return;
      event.preventDefault();
      undoRedo(command);
    };
    const offKeys = listenEverywhere("keydown", onKey);
    const off = handleTimelineHistory(undoRedo);
    return () => {
      offKeys();
      off();
    };
  }, [undoRedo]);

  // A scene picked on the band follows its words when a cut or a new take moves them.
  useEffect(() => {
    const picked = selection.get().scene;
    if (!picked) return;
    const box = scenes.find((candidate) => candidate.script === picked.script && candidate.slug === picked.slug);
    selection.retainScene(box ? { range: { from: box.start, to: box.end }, clips: box.clips } : null);
  }, [scenes]);

  // The History panel's pick, marked on the lanes: what that transaction or operation did.
  const { history } = useSelection();
  const { diff } = useHistoryDiff(TIMELINE, history, view?.revision ?? null);
  const proposed = useProposalMarks(TIMELINE);
  // A History pick wins over the proposal's marks (After, ADR 0019).
  const marks = history !== null ? (diff?.target === history ? diff.clips : null) : (proposed?.marks ?? null);

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), STATUS_MS);
    return () => clearTimeout(timer);
  }, [status]);

  return (
    <>
      <PanelHeader
        actions={onDetach && <DetachButton name={t.workspace.timeline.toLowerCase()} detached={detached} onClick={onDetach} testId="timeline-detach" />}
        onCollapse={onToggle}
        collapseLabel={collapsed ? t.timeline.showTimeline : t.timeline.hideTimeline}
        collapseSide={collapsed ? "up" : "down"}
      >
        <span className="panel-title">{t.workspace.timeline}</span>
        <span className="panel-meta">{TIMELINE}</span>
        <span className={`timeline-status${status?.tone === "error" || (!status && turnsError) ? " timeline-status-error" : ""}`} role="status" aria-live="polite">
          {status?.text ?? (turnsError ? t.timeline.turnsFailed(turnsError) : "")}
        </span>
        {history !== null ? (
          <DiffLegend target={history} marks={marks} />
        ) : (
          proposed && <DiffLegend target={proposed.tx} marks={proposed.marks} onStop={() => showSide("before")} />
        )}
        {onShowTranscript && (
          <button className="link" aria-label={t.timeline.showTranscript} title={t.timeline.transcriptTitle(TRANSCRIPT_SHORTCUT)} onClick={onShowTranscript}>
            {t.workspace.transcript}
          </button>
        )}
        {view && layout && (
          <span className="panel-meta timeline-summary">
            {`${t.workspace.clips(layout.clipCount)}, ${formatTimecode(layout.duration, view.fps)}`}
          </span>
        )}
      </PanelHeader>
      {!collapsed && rejection && (
        <div className="editor-notice is-error timeline-rejection" role="alert">
          <span>
            {t.timeline.rejected(rejection.timeline, rejection.reason, rejection.preserved, rejection.message)}
          </span>
          <button className="link" onClick={dismissRejection}>
            {t.timeline.dismiss}
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
          run={run}
          lanesOpen={lanesOpen}
          onToggleLanes={toggleLanes}
          overlay={
            error && !view ? (
              <p className="timeline-error">{error}</p>
            ) : empty || (layout && layout.rows.length === 0) ? (
              <p>{rich(t.timeline.emptyHint, { assets: <code>assets/</code> })}</p>
            ) : null
          }
        />
      )}
    </>
  );
}

/** Screen-reader summary of the lanes' mouse and keyboard controls. */
const KEYS_LABEL = t.timeline.keysLabel(isMac);

function TimelineCanvas({
  layout,
  fps,
  revision,
  diff,
  overlay,
  onStatus,
  run,
  lanesOpen,
  onToggleLanes,
}: {
  layout: TimelineLayout | null;
  fps: number;
  revision: number | null;
  /** Marks of the history entry selected in the History panel; null when none. */
  diff: readonly ClipDiff[] | null;
  overlay: ReactNode;
  onStatus: (status: Status | null) => void;
  /** The panel's call queue, shared with undo and redo. */
  run: RunCall;
  /** Program tracks whose turn lanes are open (already in `layout`). */
  lanesOpen: ReadonlySet<string>;
  onToggleLanes: (track: string) => void;
}) {
  const image = useProjectKind() === "image";
  const canvas = useRef<HTMLCanvasElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const sizer = useRef<HTMLDivElement>(null);
  const heads = useRef<HTMLDivElement>(null);
  const state = useRef<ViewState>({ pxPerSecond: 10, fit: true, scrollLeft: 0, scrollTop: 0, width: 0, height: 0 });
  const frame = useRef(0);
  /** Window whose `requestAnimationFrame` gave {@link frame}: the canvas's own (ADR 0012), so a cancel reaches it. */
  const frameView = useRef<Window>(window);
  const paints = useRef(0);
  const theme = useRef<TimelineTheme>(DEFAULT_THEME);
  const { clips: selectedClips, range, spans, reveal, track: selectedTrack, scene: selectedScene } = useSelection();
  const selected = useMemo(() => new Set(selectedClips), [selectedClips]);
  const subtitles = useSubtitles();
  const cues = useMemo(() => new Map(subtitles.tracks.map((track) => [track.track, cueBoxes(track, subtitles.fps)] as const)), [subtitles]);
  const [snapping, setSnapping] = useState(true);
  const gesture = useRef<Gesture | null>(null);
  /** Ghost drawn from a drag until the daemon's new revision shows the clip there. */
  const ghost = useRef<{ drag: DragGhost; until: number | null } | null>(null);
  /** Stroke being painted on a turn lane; the lanes keep showing it until the daemon's new revision does. */
  const stroke = useRef<{ stroke: TurnStroke; until: number | null } | null>(null);
  /** Edge drags ripple trim (R; Shift held at the press inverts it for that drag). */
  const [rippling, setRippling] = useState(false);
  /**
   * Nudges sent but not yet shown: where they put each clip, how many calls
   * are pending, and the latest revision they produced.
   */
  const inFlight = useRef<{ starts: Map<string, number>; pending: number; until: number } | null>(null);
  const latest = useRef({ layout, fps, selected, range, spans, revision, snapping, rippling, diff, cues, selectedTrack, selectedScene });
  latest.current = { layout, fps, selected, range, spans, revision, snapping, rippling, diff, cues, selectedTrack, selectedScene };
  const lanesEl = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ row: TrackRow; clip: ClipBox; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState<{ preview: DragPreview; x: number; y: number } | null>(null);

  /** Forget nudges in flight once none is pending and the shown timeline has their last revision. */
  const settleNudges = useCallback(() => {
    const flight = inFlight.current;
    if (flight && flight.pending === 0 && (latest.current.revision ?? -1) >= flight.until) inFlight.current = null;
  }, []);

  const draw = useCallback(() => {
    frame.current = 0;
    const element = canvas.current;
    const context = element?.getContext("2d");
    const { layout: current, fps: rate, selected: chosen, range: words, spans: personSpans, diff: marks, cues: subtitleCues, selectedTrack: track, selectedScene: chosenScene } = latest.current;
    const at = transport.get().time;
    const view = state.current;
    if (!element || !context || view.width === 0) return;
    const ratio = (element.ownerDocument.defaultView ?? window).devicePixelRatio || 1;
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
      layout: current ?? { scenes: [], head: RULER_HEIGHT, rows: [], duration: 0, height: RULER_HEIGHT, clipCount: 0 },
      viewport: view,
      fps: rate,
      playhead: at,
      theme: theme.current,
      media: mediaRef.current!,
      selected: chosen,
      ...(marks ? { diff: marks } : {}),
      range: words,
      spans: personSpans,
      subtitles: subtitleCues,
      selectedTrack: track,
      selectedScene: chosenScene,
      ...(drag ? { drag } : {}),
      stroke: stroke.current?.stroke ?? null,
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
    if (frame.current) return;
    frameView.current = canvas.current?.ownerDocument.defaultView ?? window;
    frame.current = frameView.current.requestAnimationFrame(draw);
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
    const painting = stroke.current;
    if (painting?.until != null && revision !== null && revision >= painting.until) stroke.current = null;
    settleNudges();
    settle();
    if (frame.current) frameView.current.cancelAnimationFrame(frame.current);
    draw();
  }, [layout, revision, selected, range, spans, diff, cues, selectedTrack, selectedScene, settle, settleNudges, draw]);

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
    const lanes = view.height - current.head;
    const top = row.top - current.head;
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
      angles: DEFAULT_THEME.angles.map((fallback, index) => read(`--angle-${index + 1}`, fallback)),
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
    const observer = new (box.ownerDocument.defaultView ?? window).ResizeObserver(measure);
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

  const send = useCallback(
    (edits: TimelineEdit[], done?: (result: OperationResult | null) => void, options: EditOptions = {}) => {
      if (edits.length === 0) {
        done?.(null);
        return;
      }
      // One call per command: main applies its edits as one transaction, one undo step.
      // A stroke over several shots is several ops but one painted turn: the status counts it once.
      const strokes = edits.every((edit) => edit.op === "multicam.paint");
      run(() => window.frameshell.timeline.edit(TIMELINE, edits, options), done, strokes ? 1 : edits.length);
    },
    [run],
  );

  /** Run `kind` on clips `ids` (default: the selection as this render saw it). */
  const command = (kind: EditCommand, ids: readonly string[] = selectedClips) => {
    const current = latest.current;
    if (!current.layout) return;
    // Nudges build on those still on their way: a held key moves on from where the last press put the clips.
    const nudging = kind.kind === "nudge";
    const base = nudging && inFlight.current ? withStarts(current.layout, inFlight.current.starts) : current.layout;
    const edits = commandEdits(kind, { layout: base, selected: ids, playhead: transport.get().time, fps: current.fps });
    if (edits.length === 0) {
      onStatus({ tone: "info", text: nothingToDo(kind, ids.length > 0) });
      return;
    }
    if (!nudging) {
      send(edits);
      return;
    }
    const flight = (inFlight.current ??= { starts: new Map(), pending: 0, until: -1 });
    // On the frame grid, as the daemon stores it: 3-decimal seconds would drift over a long held key.
    for (const edit of edits) {
      if (edit.op === "clip.move" && edit.args.start !== undefined) flight.starts.set(edit.args.clip, Math.round(edit.args.start * current.fps) / current.fps);
    }
    flight.pending++;
    send(
      edits,
      (result) => {
        if (inFlight.current !== flight) return;
        flight.pending--;
        // Refused: the daemon's timeline is the truth again.
        if (!result) inFlight.current = null;
        else flight.until = Math.max(flight.until, result.revision);
        settleNudges();
      },
      commandOptions(kind, ids),
    );
  };

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
    if (current?.kind === "paint") {
      stroke.current = null;
      schedule();
      return current.moving;
    }
    return false;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const mod = isMac ? event.metaKey : event.ctrlKey;
    const frames = event.shiftKey ? 10 : 1;
    // Undo and redo keys bubble on to the panel-wide handler in TimelinePanel.
    if (mod && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "k") command({ kind: "split" });
      else if (key === "a" && !event.shiftKey) selectAllClips();
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
    else if (event.code === "KeyR") setRippling((on) => !on);
    else return;
    event.preventDefault();
  };

  /** Select every clip of known or unknown length (not subtitle cues): the start of a group move. */
  const selectAllClips = () => {
    const ids = latest.current.layout?.rows.flatMap((row) => row.clips.map((clip) => clip.id)) ?? [];
    if (ids.length > 0) selection.selectClips(ids, "timeline");
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

  /** On the frame grid, as a stroke on a turn lane names frames the agent can address. */
  const onGrid = (time: number) => Math.max(0, Math.round(time * latest.current.fps) / latest.current.fps);

  /** What a stroke does by the keys held: Alt marks the angle silent, Shift keeps the others, else it takes the floor. */
  const paintMode = (event: { altKey: boolean; shiftKey: boolean }): PaintMode => (event.altKey ? "silent" : event.shiftKey ? "add" : "only");

  /** Right-click on a clip edge: add a dissolve or fade there, or take the transition away (every track with an edge at that time). */
  const edgeItems = (edge: EdgeHit): MenuItem[] => [
    { label: t.timeline.addDissolve, run: () => send([{ op: "transition.set", args: { at: edge.at, kind: "dissolve" } }], undefined, { label: "Add dissolve" }) },
    { label: t.timeline.addFade, run: () => send([{ op: "transition.set", args: { at: edge.at, kind: "fade" } }], undefined, { label: "Add fade" }) },
    { label: t.timeline.removeTransition, disabled: !edge.hasTransition, run: () => send([{ op: "transition.remove", args: { at: edge.at } }], undefined, { label: "Remove transition" }) },
  ];

  /** Right-click on a turn lane: take what was painted there back to the measured turns. */
  const openLaneMenu = (event: MouseEvent, hit: NonNullable<ReturnType<typeof laneAt>>) => {
    event.preventDefault();
    const { row, lane, time } = hit;
    const group = row.group ?? "";
    const shots = shotSpans(row.clips);
    const here = unpaintEdits(group, lane.angle.id, shots, lane.painted, time);
    contextMenu.open(
      event.clientX,
      event.clientY,
      [
        { label: t.timeline.backToMeasured, disabled: here.length === 0, run: () => send(here) },
        { label: t.timeline.clearAnglePainted(lane.angle.name), disabled: lane.painted.length === 0, run: () => send([clearEdit(group, lane.angle.id)]) },
        { label: t.timeline.clearAllPainted, disabled: row.lanes.every((other) => other.painted.length === 0), run: () => send([clearEdit(group, null)]) },
      ],
      windowOf(event.target),
    );
  };

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
    const scene = sceneAt(layout, state.current, at.x, at.y);
    if (scene) {
      pickScene(scene);
      return;
    }
    // Over the band but between spans: nothing under it is visible, so nothing is hit.
    if (at.y < layout.head) {
      selection.clear();
      return;
    }
    const onLane = laneAt(layout, state.current, at.x, at.y);
    if (onLane) {
      gesture.current = {
        kind: "paint",
        pointer: event.pointerId,
        row: onLane.row,
        angle: onLane.lane.angle.id,
        time: onGrid(onLane.time),
        clientX: event.clientX,
        moving: false,
      };
      box.setPointerCapture(event.pointerId);
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
    // Shift on an edge may start a ripple trim: whether it toggles the selection waits for the release.
    const toggle = event.shiftKey && grab.part !== "body" && !event.metaKey && !event.ctrlKey;
    if ((event.shiftKey || event.metaKey || event.ctrlKey) && !toggle) {
      selection.toggleClip(grab.clip.id, "timeline");
      return;
    }
    // Pressing a selected clip keeps the others selected until release: the press may start a drag.
    if (!toggle && !selected.has(grab.clip.id)) selection.selectClips([grab.clip.id], "timeline");
    gesture.current = {
      kind: "clip",
      pointer: event.pointerId,
      grab,
      time: timeAt(at.x),
      clientX: event.clientX,
      clientY: event.clientY,
      moving: false,
      preview: null,
      ripple: latest.current.rippling !== event.shiftKey,
      toggle,
    };
    box.setPointerCapture(event.pointerId);
    setHover(null);
  };

  /** A scene span of the band pressed: its time range is selected, with the scene and its clips (Ask agent names `<script>#<slug>`). */
  const pickScene = (scene: SceneBox) =>
    selection.selectScene({ script: scene.script, slug: scene.slug, title: scene.title }, scene.clips, {
      range: { from: scene.start, to: scene.end },
      origin: "timeline",
    });

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
      onStatus({ tone: "info", text: t.timeline.addTrackFirst });
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
    if (current?.kind === "paint") {
      if (!current.moving && Math.abs(event.clientX - current.clientX) < DRAG_THRESHOLD_PX) return;
      current.moving = true;
      stroke.current = { stroke: { row: current.row.id, angle: current.angle, from: current.time, to: onGrid(timeAt(x)), mode: paintMode(event) }, until: null };
      schedule();
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
      // A body drag of a selected clip moves the whole selection; none of it snaps to itself.
      const group = current.grab.part === "body" && latest.current.selected.has(current.grab.clip.id) ? [...latest.current.selected] : [];
      const exclude = new Set([current.grab.clip.id, ...group]);
      const preview = dragPreview({
        layout,
        grab: current.grab,
        delta: timeAt(x) - current.time,
        y: y + view.scrollTop,
        fps: latest.current.fps,
        snap: snap ? { points: snapPoints(layout, transport.get().time, exclude), tolerance: SNAP_PX / view.pxPerSecond } : null,
        ripple: current.ripple,
        group,
      });
      current.preview = preview;
      ghost.current = { drag: toGhost(preview), until: null };
      setDragging({ preview, x, y });
      schedule();
      return;
    }
    const grab = grabAt(layout, state.current, x, y);
    scroller.current!.style.cursor = grab ? (grab.part === "body" ? "grab" : "ew-resize") : laneAt(layout, state.current, x, y) ? "crosshair" : "";
    setHover((was) => (grab ? { row: grab.row, clip: grab.clip, x, y } : was ? null : was));
  };

  const onPointerUp = (event: PointerEvent) => {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    gesture.current = null;
    setDragging(null);
    if (current.kind === "paint") {
      const drawn = stroke.current;
      if (!current.moving || !drawn) {
        stroke.current = null;
        schedule();
        return;
      }
      const row = latest.current.layout?.rows.find((candidate) => candidate.id === current.row.id) ?? current.row;
      const { from, to } = drawn.stroke;
      const edits = paintEdits(row.group ?? "", current.angle, shotSpans(row.clips), from, to, paintMode(event));
      if (edits.length === 0) {
        stroke.current = null;
        schedule();
        onStatus({ tone: "info", text: t.timeline.noShotToPaint });
        return;
      }
      drawn.stroke.mode = paintMode(event);
      send(edits, (result) => {
        if (stroke.current !== drawn) return;
        // Keep the stroke until the feed shows the result; drop it at once when refused or already shown.
        if (result && (latest.current.revision ?? -1) < result.revision) drawn.until = result.revision;
        else stroke.current = null;
        schedule();
      });
      return;
    }
    if (current.kind !== "clip") return;
    if (!current.moving) {
      // A click (no drag) on a clip of a multi-selection selects just it; Shift on an edge toggles it.
      if (current.toggle) selection.toggleClip(current.grab.clip.id, "timeline");
      else if (!event.shiftKey && !event.metaKey && !event.ctrlKey) selection.selectClips([current.grab.clip.id], "timeline");
      return;
    }
    const edits = current.preview ? dragEdits(current.preview) : [];
    if (edits.length === 0) {
      ghost.current = null;
      schedule();
      // Sent, one member's refusal would leave the others moved: say why instead.
      if (current.preview?.blocked && current.preview.others.length > 0) {
        onStatus({ tone: "error", text: t.timeline.notMoved(current.preview.others.length + 1) });
      }
      return;
    }
    const drawn = ghost.current;
    send(edits, (result) => {
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

  /**
   * Edit commands on right-clicked clips `ids` (the selection, or the clip alone when it was not in it), as their keys
   * run them; disabled where the key would do nothing. Ids are passed on: the menu outlives this render's selection.
   */
  const clipItems = (clip: ClipBox, ids: readonly string[]): MenuItem[] => {
    const current = latest.current;
    const can = (kind: EditCommand) =>
      current.layout !== null && commandEdits(kind, { layout: current.layout, selected: ids, playhead: transport.get().time, fps: current.fps }).length > 0;
    const item = (label: string, shortcut: string, kind: EditCommand, extra: Partial<MenuItem> = {}): MenuItem => ({
      label,
      shortcut,
      disabled: !can(kind),
      run: () => command(kind, ids),
      ...extra,
    });
    const file = clip.asset ?? clip.source;
    return [
      item(t.timeline.splitAtPlayhead, "S", { kind: "split" }, { separated: true }),
      item(t.timeline.trimStartToPlayhead, "[", { kind: "trim", side: "head" }),
      item(t.timeline.trimEndToPlayhead, "]", { kind: "trim", side: "tail" }),
      ...(file ? [revealItem(file, true)] : []),
      item(t.timeline.deleteClips(ids.length), DELETE_KEY, { kind: "delete", ripple: false }, { separated: true, danger: true }),
      item(t.timeline.rippleDeleteClips(ids.length), RIPPLE_DELETE_KEY, { kind: "delete", ripple: true }, { danger: true }),
    ];
  };

  /** Right-click: a clip not yet selected becomes the selection, then "Ask agent" and its edit commands open on it. */
  const onContextMenu = (event: MouseEvent) => {
    const box = scroller.current!;
    const rect = box.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const onLane = layout ? laneAt(layout, state.current, x, y) : null;
    if (onLane) {
      openLaneMenu(event, onLane);
      return;
    }
    const edge = layout && !image ? edgeAt(layout, state.current, x, y) : null;
    const grab = layout && y >= layout.head ? grabAt(layout, state.current, x, y) : null;
    const scene = layout && !grab ? sceneAt(layout, state.current, x, y) : null;
    if (scene) pickScene(scene);
    else if (grab && !edge && !selected.has(grab.clip.id)) selection.selectClips([grab.clip.id], "timeline");
    const onClip = grab && !edge ? grab.clip : null;
    const ids = onClip ? (selected.has(onClip.id) ? selectedClips : [onClip.id]) : [];
    openAskMenu(event, edge ? edgeItems(edge) : onClip ? clipItems(onClip, ids) : []);
  };

  return (
    <div className="timeline-body">
      <div className="timeline-heads">
        <div className="ruler-spacer">
          <div className="timeline-zoom" role="group" aria-label={t.timeline.zoomGroup}>
            <button className="icon-button" aria-label={t.timeline.zoomOut} title={t.timeline.zoomOutTitle} onClick={() => zoom(1 / ZOOM_STEP)}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 8h8" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
            <button className="icon-button" aria-label={t.timeline.zoomFit} title={t.timeline.zoomFitTitle} onClick={fit}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
            <button className="icon-button" aria-label={t.timeline.zoomIn} title={t.timeline.zoomInTitle} onClick={() => zoom(ZOOM_STEP)}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 8h8M8 4v8" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
            <button
              className={`icon-button snap-toggle${snapping ? " on" : ""}`}
              aria-label={t.timeline.snapping}
              aria-pressed={snapping}
              title={t.timeline.snappingTitle(isMac)}
              onClick={() => setSnapping((on) => !on)}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 2.5v6a4 4 0 0 0 8 0v-6M4 5.5h2.5M9.5 5.5H12" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
            <button
              className={`icon-button snap-toggle${rippling ? " on" : ""}`}
              aria-label={t.timeline.rippleTrim}
              aria-pressed={rippling}
              title={t.timeline.rippleTrimTitle}
              onClick={() => setRippling((on) => !on)}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2 4.5h5v7H2M9 4.5h5v7H9M7 8h2M11.5 8l-1.5-1.5M11.5 8L10 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
            <button
              className="icon-button"
              aria-label={t.timeline.addSubtitleTrack}
              title={t.timeline.addSubtitleTitle}
              disabled={!layout?.rows.some((row) => row.kind === "video" || row.kind === "audio")}
              onClick={addSubtitles}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <path d="M4.5 9.5h3.5M9.5 9.5h2M4.5 7h1.5M7.5 7h4" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
          </div>
        </div>
        {layout && layout.scenes.length > 0 && (
          <div className="scene-spacer" style={{ height: layout.head - RULER_HEIGHT }} title={t.timeline.scenesTitle}>
            {t.timeline.scenes}
          </div>
        )}
        <div className="timeline-heads-rows">
          <div ref={heads}>
            {layout?.rows.map((row) =>
              row.kind === "program" ? (
                <div key={row.id} className="program-head" style={{ height: row.height + row.lanesHeight }} data-lanes={row.lanes.length > 0 ? "open" : "closed"}>
                  <button
                    className={`track-head track-program${selectedTrack === row.id ? " is-selected" : ""}`}
                    style={{ height: row.height }}
                    title={t.timeline.programHeadTitle(row.id)}
                    aria-pressed={selectedTrack === row.id}
                    data-track={row.id}
                    onClick={() => selection.selectTrack(row.id, "timeline")}
                  >
                    <span className="track-id">{row.label}</span>
                    <span className="track-label">{row.name ?? ""}</span>
                  </button>
                  {row.angles.length > 0 && (
                    <button
                      className={`icon-button turn-lanes-toggle${lanesOpen.has(row.id) ? " on" : ""}`}
                      aria-pressed={lanesOpen.has(row.id)}
                      aria-label={lanesOpen.has(row.id) ? t.timeline.hideTurnLanes : t.timeline.showTurnLanes}
                      title={lanesOpen.has(row.id) ? t.timeline.hideTurnLanes : t.timeline.turnLanesTitle(row.id, isMac)}
                      data-testid="turn-lanes-toggle"
                      data-track={row.id}
                      onClick={() => onToggleLanes(row.id)}
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M2 4.5h4M8 4.5h6M2 8h7M11 8h3M2 11.5h2M6 11.5h8" fill="none" stroke="currentColor" strokeWidth="1.5" />
                      </svg>
                    </button>
                  )}
                  {row.lanes.map((lane) => (
                    <div
                      key={lane.angle.id}
                      className="turn-lane-head"
                      style={{ height: lane.height, "--angle-color": `var(--angle-${lane.angle.color + 1})` } as React.CSSProperties}
                      title={t.timeline.turnLaneTitle(lane.angle.name)}
                      aria-label={t.timeline.turnLaneLabel(lane.angle.name)}
                      data-testid="turn-lane-head"
                      data-angle={lane.angle.id}
                      data-turns={lane.marks.turns.length}
                    >
                      <span className="turn-lane-name">{lane.angle.name}</span>
                    </div>
                  ))}
                </div>
              ) : row.kind === "subtitles" ? (
                <button
                  key={row.id}
                  className={`track-head track-subtitles${selectedTrack === row.id ? " is-selected" : ""}`}
                  style={{ height: row.height }}
                  title={t.timeline.subtitleHeadTitle(row.id)}
                  aria-pressed={selectedTrack === row.id}
                  data-track={row.id}
                  onClick={() => selection.selectTrack(row.id, "timeline")}
                >
                  <span className="track-id">{row.label}</span>
                  <span className="track-label">{row.name ?? t.timeline.wordsOf(row.followsLabel ?? "?")}</span>
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
        data-spans={spans.length > 0 ? spans.map((span) => `${span.from}-${span.to}`).join(" ") : undefined}
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
        <ClipList layout={layout} fps={fps} selected={selected} cues={cues} scene={selectedScene} />
      </div>
    </div>
  );
}

/** Header chip while a history entry's changes are marked on the lanes: counts by kind, and a way out. */
function DiffLegend({ target, marks, onStop = () => selection.clear() }: { target: string; marks: readonly ClipDiff[] | null; onStop?: () => void }) {
  const counts = marks ? diffCounts(marks) : null;
  return (
    <span className="timeline-diff-legend" data-history={target}>
      <span className="panel-meta" title={t.timeline.changesOf(target)}>
        {target}
      </span>
      {counts &&
        (["added", "removed", "moved", "changed"] as const)
          .filter((kind) => counts[kind] > 0)
          .map((kind) => <span key={kind} className={`diff-count diff-${kind}`}>{`${counts[kind]} ${t.timeline.diffKinds[kind]}`}</span>)}
      <button className="icon-button" aria-label={t.timeline.stopShowing} title={t.timeline.stopShowingTitle} onClick={onStop}>
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
    others: preview.others.map((member) => ({ clip: member.clip.id, row: member.row.id, start: member.start, end: member.end })),
  };
}

/** Header line for an applied edit of `clips` clips: energy snapping news (ADR 0003), else what was done. */
function describe(result: OperationResult, fps: number, clips: number): Status {
  const rough = result.snaps.find((snap) => !snap.clean);
  if (rough) {
    return {
      tone: "error",
      text: t.timeline.roughSnap(rough.window, formatTimecode(rough.applied, fps)),
    };
  }
  const moved = result.snaps.find((snap) => Math.abs(snap.applied - snap.requested) >= 0.0005);
  if (moved) return { tone: "info", text: t.timeline.edgeSnapped(formatDuration(Math.abs(moved.applied - moved.requested))) };
  const label = OP_LABELS[result.operation.op] ?? result.operation.op;
  return { tone: "info", text: clips > 1 ? t.timeline.savedMany(label, clips) : t.timeline.saved(label) };
}

const OP_LABELS: Record<string, string> = {
  "clip.move": t.timeline.ops.move,
  "clip.trim": t.timeline.ops.trim,
  "clip.split": t.timeline.ops.split,
  "clip.remove": t.timeline.ops.remove,
  cut: t.timeline.ops.cut,
  revert: t.timeline.ops.revert,
  "track.add": t.timeline.ops.trackAdd,
  "track.set": t.timeline.ops.trackSet,
  "multicam.paint": t.timeline.ops.paint,
};

/**
 * Track a new subtitle track should follow: the selected clip's track, else
 * the first whose clips have a transcript, else the first video (then audio)
 * track; null when there is no clip track.
 */
function subtitleSource(layout: TimelineLayout | null, selectedClips: readonly string[], subtitles: SubtitlesState): string | null {
  // Subtitles follow video or audio tracks only.
  const rows = layout?.rows.filter((row) => row.kind === "video" || row.kind === "audio") ?? [];
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
      return anySelected ? t.timeline.noSelectedUnderPlayhead : t.timeline.noClipUnderPlayhead;
    case "nudge":
    case "delete":
      return anySelected ? t.timeline.nothingToChange : t.timeline.selectClipFirst;
  }
}

function ClipTooltip({ hover, fps }: { hover: { row: TrackRow; clip: ClipBox; x: number; y: number }; fps: number }) {
  const { row, clip } = hover;
  return (
    <div className="clip-tooltip" style={{ left: hover.x + 12, top: hover.y + 14 }} role="tooltip">
      <strong>{clip.name}</strong>
      <span>
        {t.timeline.range(formatTimecode(clip.start, fps), formatTimecode(clip.end, fps))}
      </span>
      <span className="clip-tooltip-faint">
        {clip.problem ? clip.problem : t.timeline.clipDetail(formatDuration(clip.end - clip.start), row.label, clip.type)}
      </span>
      <span className="clip-tooltip-faint">{clip.id}</span>
    </div>
  );
}

/** Where the dragged clip or edge would land, next to the pointer. */
function DragTooltip({ preview, x, y, fps }: { preview: DragPreview; x: number; y: number; fps: number }) {
  const { part, clip, row } = preview;
  const moved = preview.others.length > 0 ? t.timeline.clipsCount(preview.others.length + 1) : clip.name;
  const title =
    part === "body" ? t.timeline.moveTitle(moved) : (part === "head" ? t.timeline.trimStart : t.timeline.trimEnd)(preview.ripple, clip.name);
  // A ripple head trim keeps the clip's left edge: its source in moves instead.
  const shift = part === "head" && preview.ripple ? (preview.edge - clip.start) * clip.speed : null;
  const time = part === "tail" ? preview.end : preview.start;
  return (
    <div className="clip-tooltip drag-tooltip" style={{ left: x + 12, top: y + 14 }} role="tooltip">
      <strong>{title}</strong>
      <span>
        {shift !== null ? t.timeline.sourceIn(shift < 0 ? "-" : "+", formatDuration(Math.abs(shift))) : formatTimecode(time, fps)}
        {part === "body" && row.id !== preview.from.id ? t.timeline.onTrack(row.label) : ""}
      </span>
      <span className={preview.blocked ? "clip-tooltip-danger" : "clip-tooltip-faint"}>
        {preview.blocked
          ? t.timeline.overlapRefused
          : preview.snapped
            ? preview.snapped.kind === "playhead" ? t.timeline.snappedPlayhead : t.timeline.snappedEdge
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
  scene,
}: {
  layout: TimelineLayout | null;
  fps: number;
  selected: ReadonlySet<string>;
  cues: ReadonlyMap<string, readonly CueBox[]>;
  scene: SelectedScene | null;
}) {
  if (!layout) return null;
  return (
    <ul className="sr-only" aria-label={t.timeline.clipListLabel}>
      {layout.scenes.map((box) => {
        const chosen = scene?.script === box.script && scene.slug === box.slug;
        return (
          <li key={`${box.script}#${box.slug}`} data-scene={`${box.script}#${box.slug}`} data-filled={box.clips.length > 0} data-selected={chosen || undefined}>
            {t.timeline.sceneItem(box.title, formatTimecode(box.start, fps), formatTimecode(box.end, fps), box.clips.length, chosen)}
          </li>
        );
      })}
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
                {selected.has(clip.id) ? `, ${t.timeline.selected}` : ""}
              </li>
            )),
      )}
    </ul>
  );
}
