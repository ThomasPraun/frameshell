// What the agent sees and drives through MCP (SPEC §7b): the window's state published to the daemon, and the
// daemon's navigation commands applied to the shared stores. No state of its own besides the last notice shown.
import type { TimeRange, TimelineView, UiCommand, UiView, WordRef } from "@frameshell/protocol";
import { parseTranscript } from "@frameshell/schema";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { selectHistoryEntry } from "./history/useHistory.js";
import { type TransportState, createTransport, transport } from "./preview/transport.js";
import { SELECTION_TIMELINE, type SelectedWord, type Selection, selection, unionRange } from "./selection.js";
import { formatTimecode } from "./timeline/layout.js";
import { timelineState } from "./timeline/useTimelineView.js";
import { placeWord } from "./transcript/model.js";

/** Minimum gap between two reports: with IPC and the socket, a selection reaches `ui_state` well within 200 ms. */
export const PUBLISH_INTERVAL_MS = 100;

/** Facts the workspace owns (editor tabs, sidebar) and the commands that change them. */
export interface UiHost {
  /** Open editor tabs and the active one, as rendered now. */
  editor(): { active: string | null; tabs: readonly string[] };
  /** Open `path` in a tab and activate it; committed before returning, so a following {@link UiHost.editor} sees it. */
  openFile(path: string): void;
  /** Show the History panel in the sidebar, expanding the sidebar; committed before returning. */
  showHistory(): void;
}

/** Everything {@link uiView} reads. */
export interface UiViewInput {
  transport: TransportState;
  selection: Selection;
  editor: { active: string | null; tabs: readonly string[] };
  /** Timeline seconds visible in the timeline panel; null while it is hidden. */
  visible: TimeRange | null;
}

/** Times as the model reads them: milliseconds are enough, float noise is not. */
const ms = (seconds: number) => Math.round(seconds * 1000) / 1000;

/** The window's state as `ui.publish` sends it. */
export function uiView({ transport: t, selection: s, editor, visible }: UiViewInput): UiView {
  return {
    timeline: SELECTION_TIMELINE,
    playhead: ms(t.time),
    playing: t.playing,
    duration: ms(t.fps > 0 ? t.frames / t.fps : 0),
    selection: {
      clips: [...s.clips],
      words: s.words.map(({ transcript, word }) => ({ transcript, word })),
      range: s.range ? { from: ms(s.range.from), to: ms(s.range.to) } : null,
      history: s.history,
    },
    editor: { active: editor.active, tabs: [...editor.tabs] },
    visible: visible && visible.to > visible.from ? { from: ms(visible.from), to: ms(visible.to) } : null,
  };
}

/** Options for {@link createPublisher}. */
export interface PublisherOptions {
  read(): UiView;
  send(view: UiView): void;
  intervalMs?: number;
  now?(): number;
}

/**
 * Report the view after changes: the first change of a quiet period goes out
 * on the next tick (same-tick changes coalesce), later ones at most every
 * `intervalMs`; a view equal to the last one sent is not sent again.
 */
export function createPublisher(options: PublisherOptions): { changed(): void; dispose(): void } {
  const interval = options.intervalMs ?? PUBLISH_INTERVAL_MS;
  const now = options.now ?? (() => performance.now());
  let last = "";
  let lastAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const view = options.read();
    const text = JSON.stringify(view);
    if (text === last) return;
    last = text;
    lastAt = now();
    options.send(view);
  };
  return {
    changed() {
      if (timer === null) timer = setTimeout(flush, Math.max(0, lastAt + interval - now()));
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/** What {@link runUiCommand} acts on: the app's shared stores, or test doubles of them. */
export interface CommandTargets {
  transport: ReturnType<typeof createTransport>;
  host: UiHost;
  /** Latest `timeline.show` of a timeline from the shared feed; null before the first read. */
  timelineView(timeline: string): TimelineView | null;
  /** File content; rejects with the reason when it cannot be read. */
  readFile(path: string): Promise<string>;
  /** Select a History entry as the History panel does; rejects with the daemon's message. */
  selectHistory(timeline: string, target: string): Promise<void>;
}

/**
 * Apply one navigation command to the shared stores (playhead, selection,
 * editor, History panel). Resolves with a line for the status bar; rejects
 * with an Error whose message the agent reads.
 */
export async function runUiCommand(command: UiCommand, targets: CommandTargets): Promise<string> {
  const { transport: player, host } = targets;
  switch (command.kind) {
    case "seek": {
      player.seek(command.at);
      return `Agent moved the playhead to ${formatTimecode(player.get().time, player.get().fps)}`;
    }
    case "play": {
      player.play();
      if (!player.get().playing) throw new Error("The timeline is empty: there is nothing to play.");
      return "Agent started playback";
    }
    case "pause":
      player.pause();
      return "Agent paused playback";
    case "select": {
      if (command.clips.length > 0) {
        const view = targets.timelineView(SELECTION_TIMELINE);
        if (!view) throw new Error(`Timeline ${SELECTION_TIMELINE} is not loaded in the app yet; retry in a moment.`);
        const present = new Set(view.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
        const unknown = command.clips.filter((clip) => !present.has(clip));
        if (unknown.length > 0) {
          throw new Error(
            `No clip ${unknown.join(", ")} on timeline ${SELECTION_TIMELINE} (revision ${view.revision}). Use ids from timeline_show.`,
          );
        }
      }
      const { clips, reveal } = command;
      const words = await resolveWords(command.words, targets.readFile);
      const view = targets.timelineView(SELECTION_TIMELINE);
      // Without an explicit range, the words' own span, as the transcript view selects them.
      const range = command.range ?? (view && words.length > 0 ? unionRange(words.map((word) => placeWord(view, word))) : null);
      selection.select({ clips, words, range }, "agent", { reveal });
      return `Agent selected ${describeSelection(clips.length, words.length, command.range !== null)}`;
    }
    case "openFile":
      try {
        await targets.readFile(command.path);
      } catch (error) {
        throw new Error(`Cannot open ${command.path}: ${(error as Error).message}`, { cause: error });
      }
      host.openFile(command.path);
      return `Agent opened ${command.path}`;
    case "showTxDiff":
      if (command.timeline !== SELECTION_TIMELINE) {
        throw new Error(`The app shows the history of timeline ${SELECTION_TIMELINE} only, not ${command.timeline}.`);
      }
      await targets.selectHistory(command.timeline, command.target);
      host.showHistory();
      return `Agent is showing the changes of ${command.target}`;
  }
}

/**
 * Word references as the selection store holds them (asset, text as shown,
 * source span), read from their transcript files. Rejects naming an unknown
 * file or word id.
 */
export async function resolveWords(refs: readonly WordRef[], readFile: (path: string) => Promise<string>): Promise<SelectedWord[]> {
  const files = new Map<string, ReturnType<typeof parseTranscript>>();
  const words: SelectedWord[] = [];
  for (const ref of refs) {
    let parsed = files.get(ref.transcript);
    if (!parsed) {
      try {
        parsed = parseTranscript(JSON.parse(await readFile(ref.transcript)));
      } catch (error) {
        throw new Error(`Cannot read transcript ${ref.transcript}: ${(error as Error).message}`, { cause: error });
      }
      files.set(ref.transcript, parsed);
    }
    if (!parsed.ok) throw new Error(`Transcript ${ref.transcript} is invalid: ${parsed.error}`);
    const transcript = parsed.value;
    const word = transcript.words.find((candidate) => candidate.id === ref.word);
    if (!word) throw new Error(`No word ${ref.word} in ${ref.transcript}.`);
    words.push({
      transcript: ref.transcript,
      asset: transcript.asset,
      word: word.id,
      text: transcript.edits[word.id]?.text ?? word.text,
      start: word.start,
      end: word.end,
    });
  }
  return words;
}

function describeSelection(clips: number, words: number, range: boolean): string {
  const parts = [
    clips > 0 ? `${clips} ${clips === 1 ? "clip" : "clips"}` : "",
    words > 0 ? `${words} ${words === 1 ? "word" : "words"}` : "",
    range ? "a time range" : "",
  ].filter(Boolean);
  if (parts.length === 0) return "nothing";
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** Latest agent action shown in the status bar, and when. */
export interface AgentNotice {
  text: string;
  at: number;
}

let viewport: (() => TimeRange | null) | null = null;
let notice: AgentNotice | null = null;
const changeListeners = new Set<() => void>();
const noticeListeners = new Set<() => void>();

/** Panels report here what only they know; the workspace's {@link useUiLink} publishes it. */
export const uiLink = {
  /** The timeline panel's visible span, read at publish time; null when the panel is gone. */
  setViewport(reader: (() => TimeRange | null) | null): void {
    viewport = reader;
    uiLink.changed();
  },
  /** Something published changed (scroll, zoom, tabs). Cheap: reports are throttled. */
  changed(): void {
    for (const listener of changeListeners) listener();
  },
};

/** Latest agent action, for the status bar; null when none yet. */
export function useAgentNotice(): AgentNotice | null {
  return useSyncExternalStore(
    (listener) => {
      noticeListeners.add(listener);
      return () => noticeListeners.delete(listener);
    },
    () => notice,
  );
}

function announce(text: string): void {
  notice = { text, at: Date.now() };
  for (const listener of noticeListeners) listener();
}

/**
 * Publish this window's state while mounted and apply the daemon's
 * navigation commands to it. One per workspace; `host` may change identity
 * between renders.
 */
export function useUiLink(host: UiHost): void {
  const hostRef = useRef(host);
  hostRef.current = host;

  useEffect(() => {
    const read = (): UiView =>
      uiView({ transport: transport.get(), selection: selection.get(), editor: hostRef.current.editor(), visible: viewport?.() ?? null });
    const publisher = createPublisher({ read, send: (view) => window.frameshell.ui.publish(view) });
    changeListeners.add(publisher.changed);
    const offTransport = transport.subscribe(publisher.changed);
    const offSelection = selection.subscribe(publisher.changed);
    const targets: CommandTargets = {
      transport,
      host: {
        editor: () => hostRef.current.editor(),
        openFile: (path) => hostRef.current.openFile(path),
        showHistory: () => hostRef.current.showHistory(),
      },
      timelineView: (timeline) => timelineState(timeline).view,
      readFile: (path) => window.frameshell.files.read(path),
      selectHistory: (timeline, target) => selectHistoryEntry(timeline, target, "agent"),
    };
    const offCommands = window.frameshell.ui.onCommand((id, command) => {
      runUiCommand(command, targets).then(
        (text) => {
          announce(text);
          window.frameshell.ui.reply(id, null, read());
        },
        (error: unknown) => window.frameshell.ui.reply(id, (error as Error).message ?? String(error), read()),
      );
    });
    publisher.changed();
    return () => {
      offCommands();
      offTransport();
      offSelection();
      changeListeners.delete(publisher.changed);
      publisher.dispose();
    };
  }, []);
}
