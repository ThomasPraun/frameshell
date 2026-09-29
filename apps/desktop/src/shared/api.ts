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
} as const;
