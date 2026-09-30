import type { AssetInfo, MethodParams, OperationResult, TimelineRejection, TimelineView } from "@frameshell/protocol";
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

/** Timeline operations the timeline panel sends (SPEC §10: move, trim, split, delete, ripple delete). */
export const TIMELINE_EDIT_OPS = ["clip.move", "clip.trim", "clip.split", "clip.remove", "cut"] as const;

/** One of {@link TIMELINE_EDIT_OPS}. */
export type TimelineEditOp = (typeof TIMELINE_EDIT_OPS)[number];

/**
 * One edit from the timeline panel: a daemon operation with its params minus
 * `cwd` and `timeline`, which main fills in for the window's project.
 */
export type TimelineEdit = { [K in TimelineEditOp]: { op: K; args: Omit<MethodParams<K>, "cwd" | "timeline"> } }[TimelineEditOp];

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
     * Apply one edit as a daemon operation by `ui`: validated, saved and
     * journaled at once (no unsaved state). Rejects with the daemon's message
     * (overlap, bounds) and nothing changes.
     */
    edit(timeline: string, edit: TimelineEdit): Promise<OperationResult>;
    /** Revert the latest `ui` edit not yet undone (a `revert` operation); null when there is none. Rejects on a revert conflict. */
    undo(timeline: string): Promise<OperationResult | null>;
    /** Re-apply the latest undo by reverting its `revert`; null when there is none, e.g. after a new edit. */
    redo(timeline: string): Promise<OperationResult | null>;
  };
  media: {
    /** `asset.list` of the window's project: ingest state and derived media paths. */
    assets(): Promise<AssetInfo[]>;
    /** Bytes of a derived waveform or thumbnail (project-relative path from `assets()`). */
    read(path: string): Promise<Uint8Array>;
    /** Called on every asset change of the project; see {@link AssetChange}. Returns an unsubscribe function. */
    onChanged(listener: (change: AssetChange) => void): () => void;
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
  layoutLoad: "layout:load",
  layoutSave: "layout:save",
  timelineShow: "timeline:show",
  timelineChanged: "timeline:changed",
  timelineRejected: "timeline:rejected",
  timelineEdit: "timeline:edit",
  timelineUndo: "timeline:undo",
  timelineRedo: "timeline:redo",
  mediaAssets: "media:assets",
  mediaRead: "media:read",
  mediaChanged: "media:changed",
} as const;
