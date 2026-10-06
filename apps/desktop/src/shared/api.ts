import type {
  AssetInfo,
  ClipRendersResult,
  HistoryDiffResult,
  HistoryResult,
  JobInfo,
  MethodParams,
  OperationResult,
  RevertConflict,
  TimelineRejection,
  TimelineView,
  UiCommand,
  UiView,
} from "@frameshell/protocol";
import type { Layout } from "./layout.js";

/** One explorer entry. `path` is project-relative and `/`-separated. */
export type FileNode =
  | { kind: "file"; name: string; path: string }
  | { kind: "dir"; name: string; path: string; children: FileNode[] };

/** The project a window shows, plus the daemon serving it (status bar). */
export interface ProjectView {
  dir: string;
  name: string;
  daemon: { version: string; pid: number; socketPath: string };
  /**
   * Base URL (`frameshell-media://<token>/`, trailing slash) serving this
   * project's proxies and PCM sidecars with range support; append the
   * project-relative paths `asset.list` reports. Valid while the window shows the project.
   */
  mediaUrl: string;
}

/** Outcome of opening a folder. `not-a-project` lets the UI offer `project.init`. */
export type OpenOutcome =
  | { status: "opened"; project: ProjectView }
  | { status: "cancelled" }
  | { status: "not-a-project"; dir: string }
  | { status: "error"; message: string };

/** A live terminal. `session` is its `FRAMESHELL_SESSION`. */
export interface TerminalInfo {
  id: string;
  session: string;
  /** Shell executable name for the tab title, e.g. `zsh`. */
  shell: string;
}

/**
 * A timeline of the window's project changed (daemon `timeline.changed`), or,
 * with `timeline: null`, the daemon connection was re-established and any
 * timeline may have changed meanwhile.
 */
export type TimelineChange = { timeline: string; revision: number; author: string } | { timeline: null };

/**
 * An asset of the window's project changed (daemon `asset.changed`): `asset`
 * is its `asset.list` entry now, null when the file left `assets/`. With
 * `path: null` the daemon connection was re-established and any asset may
 * have changed meanwhile: re-read them all.
 */
export type AssetChange = { path: string; asset: AssetInfo | null } | { path: null };

/**
 * Timeline operations the app sends (SPEC §10): move, trim, split, delete,
 * ripple delete from the timeline panel; the transcript view restores words
 * (rippled trim or insert); clip settings (transform, gain, mute) from the
 * clip inspector and the preview's handles; subtitle tracks added from the
 * timeline and styled from their inspector.
 */
export const TIMELINE_EDIT_OPS = ["clip.move", "clip.trim", "clip.split", "clip.remove", "cut", "clip.add", "clip.set", "track.add", "track.set"] as const;

/** One of {@link TIMELINE_EDIT_OPS}. */
export type TimelineEditOp = (typeof TIMELINE_EDIT_OPS)[number];

/**
 * One edit from the timeline panel: a daemon operation with its params minus
 * `cwd` and `timeline`, which main fills in for the window's project.
 */
export type TimelineEdit = { [K in TimelineEditOp]: { op: K; args: Omit<MethodParams<K>, "cwd" | "timeline"> } }[TimelineEditOp];

/**
 * How main groups and names the transaction of one `timeline.edit` call.
 * Both optional; main rejects values longer than {@link EDIT_OPTION_MAX_LENGTH}.
 */
export interface EditOptions {
  /** History label of the transaction. Default: from the edits, e.g. `Move clip`, `Split 3 clips`. */
  label?: string;
  /**
   * Gesture burst key, e.g. `nudge:c_a c_b`. Calls with the same key on the
   * same timeline, each soon after the previous one, share one transaction:
   * a held or repeated key makes one history entry and one undo step. The
   * first call's label names the burst, so the key should name the clips too.
   */
  burst?: string;
}

/** Longest {@link EditOptions} label or burst key main accepts. */
export const EDIT_OPTION_MAX_LENGTH = 200;

/** Undo or redo chosen in the Edit menu: the focused window picks text undo or timeline undo. */
export type HistoryCommand = "undo" | "redo";

/**
 * Result of a revert asked from the History panel. A refusal because later
 * operations changed the same clips is data, not an error: the panel lists
 * `conflicts` so the user can revert those first.
 */
export type RevertOutcome =
  | { status: "reverted"; result: OperationResult }
  | { status: "conflict"; message: string; conflicts: RevertConflict[] };

/** Reply of a main handler that can fail: Electron would bury a thrown message in IPC noise. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Everything the renderer may ask of main, exposed as `window.frameshell` by
 * the preload. The renderer never touches Node or the file system directly.
 */
export interface FrameshellApi {
  project: {
    /** Project of this window; null shows the welcome screen. */
    current(): Promise<ProjectView | null>;
    /** Pick a folder with the OS dialog and open it in this window. */
    openFolder(): Promise<OpenOutcome>;
    /** Open a known folder in this window (recent list). */
    open(dir: string): Promise<OpenOutcome>;
    /** Scaffold a project in `dir` through the daemon, then open it. */
    init(dir: string): Promise<OpenOutcome>;
    /** Recently opened project folders, newest first. */
    recent(): Promise<string[]>;
  };
  files: {
    tree(): Promise<FileNode[]>;
    read(path: string): Promise<string>;
    /** Save through the daemon (single writer). Rejects with the daemon's message on validation failure. */
    write(path: string, content: string): Promise<void>;
    /** Called with changed project-relative paths. Returns an unsubscribe function. */
    onChanged(listener: (paths: string[]) => void): () => void;
  };
  terminals: {
    create(size: { cols: number; rows: number }): Promise<TerminalInfo>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    kill(id: string): void;
    onData(listener: (id: string, data: string) => void): () => void;
    onExit(listener: (id: string, exitCode: number) => void): () => void;
    /**
     * The agent CLI running in a terminal changed (detected from its
     * foreground process): its label, e.g. `claude`, or null once it quit.
     */
    onAgent(listener: (id: string, agent: string | null) => void): () => void;
  };
  layout: {
    load(): Promise<Layout>;
    save(layout: Layout): void;
  };
  timeline: {
    /** `timeline.show` of the window's project. Rejects with the daemon's message. */
    show(timeline: string): Promise<TimelineView>;
    /** Called on every change of the project's timelines; see {@link TimelineChange}. Returns an unsubscribe function. */
    onChanged(listener: (change: TimelineChange) => void): () => void;
    /**
     * Called when the daemon refuses a direct edit of one of the project's
     * timeline files (daemon `timeline.rejected`): the file holds the daemon's
     * version again, the edit is kept at `preserved`. Returns an unsubscribe function.
     */
    onRejected(listener: (rejection: TimelineRejection) => void): () => void;
    /**
     * Apply the edits of one command, in order, as daemon operations by `ui`:
     * validated, saved and journaled at once (no unsaved state). Several edits
     * (a split of every selected clip) are one transaction, so one undo step.
     * Resolves with the last result. Rejects with the daemon's message
     * (overlap, bounds) at the first refused edit, and undoes the call's
     * earlier ones, so a group move is all or nothing (in a gesture burst,
     * earlier presses stay). `options` labels the transaction or joins a
     * gesture burst's.
     */
    edit(timeline: string, edits: TimelineEdit[], options?: EditOptions): Promise<OperationResult>;
    /** Revert the latest `ui` edit not yet undone (a `revert` operation); null when there is none. Rejects on a revert conflict. */
    undo(timeline: string): Promise<OperationResult | null>;
    /** Re-apply the latest undo by reverting its `revert`; null when there is none, e.g. after a new edit. */
    redo(timeline: string): Promise<OperationResult | null>;
    /**
     * Called when Undo or Redo is chosen in the app's Edit menu, or its key
     * reaches the menu unhandled by the page. Returns an unsubscribe function.
     */
    onHistoryCommand(listener: (command: HistoryCommand) => void): () => void;
  };
  history: {
    /** `history` of one timeline of the window's project: transactions oldest first. Rejects with the daemon's message. */
    list(timeline: string): Promise<HistoryResult>;
    /** `history.diff`: what a transaction or operation did to clips. Rejects with the daemon's message. */
    diff(timeline: string, target: string): Promise<HistoryDiffResult>;
    /**
     * Undo a transaction or one operation of any author as a `revert` by `ui`
     * (SPEC §6.2). Conflicts resolve as {@link RevertOutcome}; other failures reject.
     */
    revert(timeline: string, target: string): Promise<RevertOutcome>;
  };
  ui: {
    /**
     * Report what this window shows (SPEC §7b `ui_state`). Fire and forget:
     * main keeps one report in flight and sends the newest after it.
     */
    publish(state: UiView): void;
    /** Called with each navigation command the daemon routes to this window. Returns an unsubscribe function. */
    onCommand(listener: (id: string, command: UiCommand) => void): () => void;
    /** Answer command `id`: `error` null when applied, else why not; `state` is the window's state after it. */
    reply(id: string, error: string | null, state: UiView): void;
  };
  media: {
    /** `asset.list` of the window's project: ingest state and derived media paths. */
    assets(): Promise<AssetInfo[]>;
    /** Bytes of a derived waveform or thumbnail (project-relative path from `assets()`). */
    read(path: string): Promise<Uint8Array>;
    /** Called on every asset change of the project; see {@link AssetChange}. Returns an unsubscribe function. */
    onChanged(listener: (change: AssetChange) => void): () => void;
  };
  context: {
    /**
     * Capture the main timeline's frame at `at` (timeline seconds) for an
     * "Ask agent" region reference (SPEC §10), rendered by the daemon's
     * `frame` method under `.frameshell/context/`. Resolves with its
     * project-relative path. Rejects with the daemon's message.
     */
    captureFrame(at: number): Promise<string>;
  };
  clips: {
    /** `clip.renders` of a timeline of the window's project: render cache state per generated clip. Rejects with the daemon's message. */
    renders(timeline: string): Promise<ClipRendersResult>;
    /**
     * Called on every change of a `clip` render job of the project (daemon
     * `job.progress`); `null` after a daemon reconnect, when changes may have
     * been missed. Returns an unsubscribe function.
     */
    onJob(listener: (job: JobInfo | null) => void): () => void;
  };
}

/** IPC channel names; one place so main and preload cannot drift. */
export const Channel = {
  projectCurrent: "project:current",
  projectOpenFolder: "project:open-folder",
  projectOpen: "project:open",
  projectInit: "project:init",
  projectRecent: "project:recent",
  filesTree: "files:tree",
  filesRead: "files:read",
  filesWrite: "files:write",
  filesChanged: "files:changed",
  terminalCreate: "terminal:create",
  terminalWrite: "terminal:write",
  terminalResize: "terminal:resize",
  terminalKill: "terminal:kill",
  terminalData: "terminal:data",
  terminalExit: "terminal:exit",
  terminalAgent: "terminal:agent",
  layoutLoad: "layout:load",
  layoutSave: "layout:save",
  timelineShow: "timeline:show",
  timelineChanged: "timeline:changed",
  timelineRejected: "timeline:rejected",
  timelineEdit: "timeline:edit",
  timelineUndo: "timeline:undo",
  timelineRedo: "timeline:redo",
  timelineHistoryCommand: "timeline:history-command",
  historyList: "history:list",
  historyDiff: "history:diff",
  historyRevert: "history:revert",
  uiPublish: "ui:publish",
  uiCommand: "ui:command",
  uiReply: "ui:reply",
  mediaAssets: "media:assets",
  mediaRead: "media:read",
  mediaChanged: "media:changed",
  contextCaptureFrame: "context:capture-frame",
  clipsRenders: "clips:renders",
  clipsJob: "clips:job",
} as const;
