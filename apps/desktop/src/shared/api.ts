import type { Lang } from "./i18n/index.js";
import type {
  AgentTarget,
  AssetInfo,
  AudioBakesResult,
  BinariesRemoveResult,
  PluginInfo,
  MatteStatusResult,
  ClipRendersResult,
  HistoryDiffResult,
  HistoryResult,
  JobInfo,
  EventParams,
  MethodParams,
  MethodResult,
  TimelineViewName,
  OperationResult,
  RevertConflict,
  MulticamTurnsResult,
  ScriptOutlineResult,
  SegmentedPoint,
  TimelineRejection,
  TimelineView,
  UiCommand,
  UiView,
  VoiceoverGenerateResult,
  VoiceoverPlaceResult,
} from "@frameshell/protocol";
import type { DetachablePanel, Layout } from "./layout.js";
import type { HandoffKind } from "./handoff.js";

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
  /**
   * The cloud sync folder holding the project (daemon `status.synced`), for
   * the warning above the workspace; null when none or the user dismissed it.
   */
  synced: { service: string; root: string } | null;
}

/** Outcome of opening a folder. `not-a-project` lets the UI offer `project.init`. */
export type OpenOutcome =
  | { status: "opened"; project: ProjectView }
  | { status: "cancelled" }
  | { status: "not-a-project"; dir: string }
  | { status: "error"; message: string };

/**
 * Background setup of a project created from videos: installing the
 * transcription plugin, first-run downloads, transcribing. `fraction` is of
 * the current step when known. `state` `done` and `failed` end it.
 */
export interface ProjectSetup {
  message: string;
  /** The technical reason of a failure (daemon error), for the tooltip; null otherwise. */
  detail: string | null;
  fraction: number | null;
  state: "running" | "done" | "failed";
}

/**
 * Project to create from video or audio files (ADR 0013, 0015), as main planned it. The
 * renderer shows it for confirmation and passes `files`, `parent` and `name`
 * back; main plans again before creating.
 */
export interface VideoProjectPlan {
  /** Absolute paths of the videos, in the order chosen. */
  files: string[];
  /** Folder the project folder goes in: the first video's by default. */
  parent: string;
  /** Project name, also the folder name unless taken. */
  name: string;
  /** Absolute project folder: `parent`/`name`, or `name (2)`… when taken. */
  dir: string;
  /** `dir` is a project already made from the first video: create opens it. */
  existing: boolean;
  /** Bytes of all files. */
  totalBytes: number;
  /** The volume clones files, so the import copies them using no extra space. */
  clones: boolean;
  /** No clone and over 2 GB: the user picks copy or use in place before creating. */
  askMode: boolean;
  /** Every file is audio (ADR 0015): no picture, so the user picks the frame orientation before creating. */
  audioOnly: boolean;
  /** Every file is a still image (ADR 0017): an image project, each picture a layer, sized like the first. */
  imageOnly: boolean;
}

/** Frame of a project made from audio alone: 16:9 (1920x1080) or 9:16 (1080x1920). */
export type AudioOrientation = "landscape" | "portrait";

/** What the person says about a video they want made from nothing, from the Welcome form. */
export interface IdeaBrief {
  /** Name of the video; also the project's name. */
  name: string;
  /** Built-in format ids (`16x9`, `9x16`, `1x1`, `4x5`); the first is the main format and becomes the project's own size. */
  formats: string[];
  /** Rough length in seconds; null when unsure. */
  seconds: number | null;
  /** A page to take the idea from (http or https); null when none. */
  url: string | null;
  /** What the video is about, in the person's words; null when not said. Absent in briefs from before it existed. */
  about?: string | null;
}

/** A way of making a project the File menu starts on the welcome screen: from video files, or from an idea. */
export type WelcomeStart = "video" | "idea";

/** Folder a project made from an idea goes in, as main planned it: `parent`/`name`, numbered when the name is taken. */
export interface IdeaProjectPlan {
  /** Folder the project folder goes in. */
  parent: string;
  /** Folder name, made safe for any OS. */
  name: string;
  /** Absolute project folder. */
  dir: string;
}

/** A live terminal. `session` is its `FRAMESHELL_SESSION`. */
export interface TerminalInfo {
  id: string;
  session: string;
  /** Shell executable name for the tab title, e.g. `zsh`. */
  shell: string;
}

/** A terminal of the window that outlived its view, as {@link FrameshellApi.terminals} `list` reports it. */
export interface TerminalSurvivor extends TerminalInfo {
  /** Its shell's exit code once it exited; null while it runs. */
  exitCode: number | null;
  /** Agent CLI running in it now, e.g. `claude`; null when none or unknown. */
  agent: string | null;
}

/**
 * A timeline of the window's project changed (daemon `timeline.changed`), or,
 * with `timeline: null`, the daemon connection was re-established and any
 * timeline may have changed meanwhile.
 */
export type TimelineChange = { timeline: string; revision: number; author: string } | { timeline: null };

/** A change of the project's agent targets (daemon `target.changed`, ADR 0025) without the project root. */
export type TargetsChange = Omit<EventParams<"target.changed">, "project">;

/** A people change (daemon `people.changed`, ADR 0020) without the project root. */
export type PeopleChange = Omit<EventParams<"people.changed">, "project">;

/**
 * What a people link names: exactly one of a transcript speaker (no `speaker` = the whole transcript), a multicam
 * angle or a face anchor, as `people.link` and `people.unlink` take it.
 */
export type PersonTarget =
  | { speaker: { transcript: string; speaker?: string } }
  | { angle: { timeline: string; group: string; angle: string } }
  | { face: { asset: string; at: number; x: number; y: number } };

/** A shoot file change (daemon `shoot.changed`, ADR 0023) without the project root. */
export type ShootChange = Omit<EventParams<"shoot.changed">, "project">;

/** A review-mode proposal step (daemon `proposal.changed`) without the project root. */
export type ProposalChange = Omit<EventParams<"proposal.changed">, "project">;

/**
 * Review mode of the window's project changed: a proposal step, the switch turned on or off (here or in
 * another window of the project), or, with `resync`, the daemon connection was re-established and
 * `review.status` must be read again.
 */
export type ReviewEvent = { proposal: ProposalChange } | { enabled: boolean } | { resync: true };

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
 * timeline and styled from their inspector; the letterbox bars from the preview's menu (ADR 0043); shots and multicam angles from
 * the shot inspector, who speaks painted on the timeline's turn lanes; transitions from a clip edge's menu and
 * the clip inspector, which also keys properties; markers from the ruler's menu.
 */
export const TIMELINE_EDIT_OPS = [
  "clip.move",
  "clip.trim",
  "clip.split",
  "clip.remove",
  "cut",
  "clip.add",
  "clip.set",
  "clip.key",
  "transition.set",
  "transition.remove",
  "track.add",
  "track.set",
  "track.remove",
  "shot.set",
  "multicam.angle",
  "multicam.offset",
  "multicam.reframe",
  "multicam.paint",
  "marker.add",
  "marker.set",
  "marker.remove",
  "letterbox.set",
] as const;

/** One of {@link TIMELINE_EDIT_OPS}. */
export type TimelineEditOp = (typeof TIMELINE_EDIT_OPS)[number];

/**
 * One edit from the timeline panel: a daemon operation with its params minus
 * `cwd` and `timeline`, which main fills in for the window's project.
 */
export type TimelineEdit = { [K in TimelineEditOp]: { op: K; args: Omit<MethodParams<K>, "cwd" | "timeline"> } }[TimelineEditOp];

/**
 * Stands for a `clip` arg in a multi-edit call, on the edit right after a `clip.split`: the new part of that
 * split, whose id the caller cannot know before the call runs. Anywhere else it is an ordinary clip id.
 */
export const CREATED_CLIP = "$created";

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
  /**
   * With `burst`: ms the burst's transaction stays open after its latest edit, instead of the default few
   * hundred. For presses spread over a playback (cut to angle), closed early by `timeline.settle`. Positive
   * integer, at most {@link EDIT_BURST_GAP_MAX_MS}.
   */
  burstGap?: number;
}

/** Longest {@link EditOptions.burstGap} main accepts, ms: the daemon's longest `autoCommitAfter` (3600 s) less main's 15 s margin. */
export const EDIT_BURST_GAP_MAX_MS = 3_585_000;

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
 * Command an application menu entry sends to the focused project window.
 * `showTranscript`: open the transcript view (View > Transcript).
 * `imageFromFrame`: make an image project from the frame at the playhead (File > New Image from Frame, ADR 0017).
 * `exportOtio`, `exportPremiere`: save the timeline as an editor hand-off file, an OpenTimelineIO file (File > Export
 * OpenTimelineIO, ADR 0045) or a Premiere Pro XML file (File > Export Premiere XML, ADR 0047).
 * `toggleTerminal`: close or reopen the terminal panel (View > Terminal, ADR 0025 decision 8).
 * `toggleReview`: turn review mode on or off (File > Review agent changes before applying, ADR 0019).
 * `showShoot`, `showTeleprompter`: show the sidebar on the Shoot or Teleprompter view (View > Shoot, View > Teleprompter).
 */
export type MenuCommand =
  | "showTranscript"
  | "imageFromFrame"
  | "exportVideo"
  | "exportOtio"
  | "exportPremiere"
  | "toggleReview"
  | "toggleTerminal"
  | "showShoot"
  | "showTeleprompter";

export type { HandoffKind };

/**
 * Everything the renderer may ask of main, exposed as `window.frameshell` by
 * the preload. The renderer never touches Node or the file system directly.
 */
export interface FrameshellApi {
  /** UI language of the app; main reloads the windows when the user changes it. */
  readonly lang: Lang;
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
    /** Drop `dir` from the recent list (the folder stays); resolves to the list left. */
    forgetRecent(dir: string): Promise<string[]>;
    /** Show recent project folder `dir` in Finder / Explorer / the file manager; ignored for folders not in the list. */
    revealRecent(dir: string): Promise<void>;
    /** Stop warning that this window's project is in a synced folder; kept per project in the config dir. */
    dismissSyncWarning(): Promise<void>;
    /**
     * Choose videos, audio or pictures with the OS dialog and plan their project: `plan` null when none is media,
     * `refused` the chosen files that are not (#751: a `.txt` slipped into the plan). Null when cancelled.
     * Rejects on unreadable files.
     */
    chooseVideos(): Promise<{ plan: VideoProjectPlan | null; refused: string[] } | null>;
    /**
     * Plan the project for the videos among `files` (e.g. dropped), optionally
     * in another `parent` or under another `name`. `refused` lists what is not
     * a video file; `plan` is null when nothing is.
     */
    planVideos(files: string[], place?: { parent?: string; name?: string }): Promise<{ plan: VideoProjectPlan | null; refused: string[] }>;
    /** Bytes a new project downloads before it can transcribe (the tool and model, once per machine); 0 when ready. */
    transcriptionDownload(): Promise<number>;
    /** Videos or audio the OS asked to open in this window (Open with), once: null when none or already taken. */
    takeOffered(): Promise<VideoProjectPlan | null>;
    /** How File > New … asked this welcome screen to start, once: null when not asked or already taken. */
    takeStart(): Promise<WelcomeStart | null>;
    /** Called when File > New … asks this window to start; take it with {@link takeStart}. Returns an unsubscribe function. */
    onStartOffered(listener: () => void): () => void;
    /** Called when the OS offers videos to this window; take them with {@link takeOffered}. Returns an unsubscribe function. */
    onVideosOffered(listener: () => void): () => void;
    /** Pick the folder a new project goes in; null when cancelled. */
    chooseParent(): Promise<string | null>;
    /**
     * Make an image project from the frame of `timeline` at `at` seconds (ADR 0017): main asks the picture size
     * in a dialog, creates the project beside this one with the frame as its layer, and opens it in a new window.
     * Resolves with the new project's folder, or null when cancelled. Rejects with the daemon's message.
     */
    imageFromFrame(timeline: string, at: number): Promise<string | null>;
    /**
     * Create the planned project and open it in this window: `project.init`,
     * then `asset.import` of the files (`copy` clones where possible; `link`
     * uses them in place). Opens the project instead when the plan says it exists.
     */
    fromVideos(
      plan: Pick<VideoProjectPlan, "files" | "parent" | "name">,
      mode: "copy" | "link",
      options?: { transcribe?: boolean; orientation?: AudioOrientation },
    ): Promise<OpenOutcome>;
    /**
     * Where the project of an idea goes: `place.parent` (default the user's videos folder) and `place.name`
     * (default "Untitled video"), numbered when the folder exists. Nothing is created.
     */
    planIdea(place?: { parent?: string; name?: string }): Promise<IdeaProjectPlan>;
    /**
     * Create an empty project for `brief`, without footage, and open it in this window: `project.init` at the
     * size of the first format, then `format.add` for each other one, through the daemon. `parent` is the folder
     * it goes in (default the videos folder). The brief is kept in the project's `brief.md`, for {@link readIdea}.
     */
    fromIdea(brief: IdeaBrief, parent?: string): Promise<OpenOutcome>;
    /** The brief this window's project was made from (its `brief.md`, #752): null when it was not made from an idea. */
    readIdea(): Promise<IdeaBrief | null>;
    /**
     * Add built-in format `id` (`1x1`, `4x5`, `9x16`, `16x9`) to this window's project, after the others: daemon
     * `format.add`, journaled like any format change (ADR 0027, 0036). Rejects with the daemon's message.
     */
    addFormat(id: string): Promise<void>;
    /**
     * Setup still running, or just ended, for this window's project;
     * null when none. With `transcribe`, {@link fromVideos} installs the
     * transcription plugin and transcribes the videos in the background.
     */
    setup(): Promise<ProjectSetup | null>;
    /** Called on every change of {@link setup}. Returns an unsubscribe function. */
    onSetup(listener: (setup: ProjectSetup | null) => void): () => void;
  };
  files: {
    tree(): Promise<FileNode[]>;
    read(path: string): Promise<string>;
    /** Save through the daemon (single writer). Rejects with the daemon's message on validation failure. */
    write(path: string, content: string): Promise<void>;
    /** Called with changed project-relative paths. Returns an unsubscribe function. */
    onChanged(listener: (paths: string[]) => void): () => void;
    /**
     * Move a project-relative file or folder to the OS trash after a confirm naming the timeline clips that use
     * it (daemon `file.uses`). False when the person cancelled, or when it is one of the project's own files (a message box says so).
     */
    trash(path: string): Promise<boolean>;
    /** Show a project-relative file or folder in Finder / Explorer / the file manager. */
    reveal(path: string): Promise<void>;
    /** Put the absolute path of a project-relative file or folder on the clipboard. */
    copyPath(path: string): Promise<void>;
    /** Absolute path of a file dropped from the OS; empty for a file that is not on disk. */
    pathOf(file: File): string;
  };
  terminals: {
    create(size: { cols: number; rows: number }): Promise<TerminalInfo>;
    /**
     * The window's terminals not closed yet, oldest first. After a reload (a language change, Ctrl+R) the panel
     * shows these again, so the shells and agents in them go on; empty in a fresh window.
     */
    list(): Promise<TerminalSurvivor[]>;
    /**
     * Output to feed a view mounting on terminal `id` (ADR 0012): its recent
     * output, about 10,000 lines. Data events sent before the reply are in
     * it; later ones are not. Null once the terminal was killed.
     */
    attach(id: string): Promise<string | null>;
    write(id: string, data: string): void;
    /** Whether the system clipboard holds text now (#743): Ctrl+V pastes it, else the program gets its ^V. */
    clipboardHasText(): Promise<boolean>;
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
  panels: {
    /**
     * Panels to open in their own window when the project shows (ADR 0012).
     * Main keeps this list: a panel window opened through `window.open`
     * marks its panel detached, and closing it docks the panel back unless
     * its project window is closing or reloading.
     */
    detached(): Promise<DetachablePanel[]>;
    /**
     * Resolves once the window showing the preview is in full screen for good: macOS animates into it and drops a
     * request to leave during the animation, so a leave waits for this. `panel` is the detached panel whose window
     * it is, null for the project window itself. At once when that window is not entering full screen.
     */
    fullScreenSettled(panel: DetachablePanel | null): Promise<void>;
  };
  timeline: {
    /**
     * `timeline.show` of the window's project. `view: "proposal"` shows the open review-mode proposal's version
     * (ADR 0019); omitted, the file as it is. Rejects with the daemon's message.
     */
    show(timeline: string, view?: TimelineViewName): Promise<TimelineView>;
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
     * earlier calls stay, but this call's edits are still undone). `options` labels the transaction or joins a
     * gesture burst's.
     */
    edit(timeline: string, edits: TimelineEdit[], options?: EditOptions): Promise<OperationResult>;
    /**
     * Pick an image with the OS dialog and show it in `clip` (a media clip on a video track) instead of
     * what it shows, keeping its track, start and length, as one undoable step. False when cancelled.
     */
    replaceImage(timeline: string, clip: string): Promise<boolean>;
    /**
     * Put each image among `assets` (project-relative, e.g. from `media.import`) on a new video track on top,
     * starting at 0, as one undoable step: the layers of an image project (ADR 0017). Other assets are skipped.
     * Resolves with the new track ids.
     */
    addLayers(timeline: string, assets: string[]): Promise<string[]>;
    /**
     * Pick pictures with the OS dialog, import them into `assets/` and {@link addLayers} them: the Layers panel's
     * Add image button (#751). Resolves with the new track ids, or null when cancelled.
     */
    addImages(timeline: string): Promise<string[] | null>;
    /**
     * Put media among `assets` (project-relative videos, sounds, stills) on `timeline` as one undoable step (#738): with
     * `target`, from that time on that track (the drop point of a drag from Files); otherwise at the end of the first
     * track of its kind, adding one when there is none. Resolves with the new clip ids and what the daemon refused.
     */
    addMedia(timeline: string, assets: string[], target?: { track: string; start: number }): Promise<{ clips: string[]; refused: { asset: string; message: string }[] }>;
    /**
     * Cut the part of a photo that `mask` (project-relative grayscale PNG, from a Pick) marks out as a new layer
     * right above it (`image.cutout`, ADR 0022), as one undoable step. Resolves with the new clip id.
     */
    cutOut(timeline: string, clip: string, mask: string): Promise<string>;
    /**
     * Save the first frame of `timeline` as an image where the user picks in the OS dialog (PNG, JPEG or WebP
     * by the extension chosen), through the daemon's `frame`: the export of an image project. Resolves with the
     * absolute path written, or null when cancelled. Rejects with the daemon's message.
     */
    exportImage(timeline: string): Promise<string | null>;
    /**
     * Save `timeline` as an editor hand-off file of `kind` where the user picks in the OS dialog, written by the
     * daemon's `export.otio` or `export.premiereXml` (ADR 0045, 0047). Resolves with the absolute path written and what
     * the file leaves out, or null when cancelled. Rejects with the daemon's message (an image project has nothing to export).
     */
    exportHandoff(kind: HandoffKind, timeline: string): Promise<{ path: string; warnings: string[] } | null>;
    /**
     * Export `timeline` as an MP4 where the user picks in the OS dialog (#738): the daemon's `render`, a background job.
     * Resolves with the job as it started, the file it writes and what the export leaves out, or null when cancelled.
     * Rejects with the daemon's message (an empty timeline, clips it cannot render).
     */
    exportVideo(timeline: string): Promise<{ job: JobInfo; output: string; warnings: string[] } | null>;
    /** Called on every change of a video export job of the project (daemon `job.progress`, kind `render`); `null` after a daemon reconnect. */
    onExportJob(listener: (job: JobInfo | null) => void): () => void;
    /**
     * Show a file {@link exportVideo}, {@link exportImage} or {@link exportHandoff} wrote this run in Finder / Explorer /
     * the file manager; any other path is ignored.
     */
    revealExport(path: string): Promise<void>;
    /** Close the open gesture burst's transaction now (a playback ended), so the next edit starts a history entry of its own. */
    settle(): Promise<void>;
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
  review: {
    /** `proposal.status` of the window's project: the switch, the open proposal, recent decisions. Rejects with the daemon's message. */
    status(): Promise<MethodResult<"proposal.status">>;
    /** Turn review mode on or off for the window's project (`review.set` as `ui`); other windows of it follow. */
    setEnabled(enabled: boolean): Promise<void>;
    /** Apply the ready proposal `tx` (`proposal.accept` as `ui`). Rejects with the daemon's message, e.g. ProposalState `decided`. */
    accept(tx: string): Promise<void>;
    /** Discard the open proposal `tx` (`proposal.reject` as `ui`). Rejects like `accept`. */
    reject(tx: string): Promise<void>;
    /** `proposal.diff`: what the open proposal changes, per timeline. Rejects with the daemon's message. */
    diff(): Promise<MethodResult<"proposal.diff">>;
    /** Called on each {@link ReviewEvent} of the window's project. Returns an unsubscribe function. */
    onChanged(listener: (event: ReviewEvent) => void): () => void;
  };
  agents: {
    /** Agent CLIs the guide offers, with where each is installed (the login shell's PATH and usual folders). */
    detect(): Promise<AgentChoice[]>;
    /** Install the `frameshell` command for terminals outside the app (the File menu's command, with its dialogs). */
    installCli(): Promise<void>;
    /** The AI apps of "Connect your AI", read from their settings files now, and the server entry they run. */
    apps(): Promise<AiApps>;
    /** Add Frameshell's MCP server to app `id`'s settings, keeping everything else (backup first); resolves with the state after. */
    connect(id: AiAppId): Promise<AiAppChange>;
    /** Remove Frameshell's entries from app `id`'s settings, and nothing else. */
    disconnect(id: AiAppId): Promise<AiAppChange>;
    /**
     * Open desktop AI app `id`; once it opened, `phrase` (the starter text to paste there) goes on the clipboard.
     * Never rejects for an app that is missing or will not start: that is the result's `problem`.
     */
    openApp(id: DesktopAppId, phrase: string): Promise<DesktopAppOpened>;
    /** Show settings file `file` of app `id` in the system's file manager (#753); only a file that app's status lists. */
    showFile(id: AiAppId, file: string): Promise<void>;
    /** Agent targets of the window's project outside its terminals (`target.list`, ADR 0025): MCP clients, `frameshell ask --wait`. */
    targets(): Promise<AgentTarget[]>;
    /** Queue `lines` for target `id` (`inbox.put`) until it reads them. Rejects with the daemon's message. */
    send(id: string, lines: string[]): Promise<MethodResult<"inbox.put">>;
    /**
     * Called on every {@link TargetsChange} of the window's project, or with null after a daemon reconnect, when
     * changes may have been missed. Returns an unsubscribe function.
     */
    onTargets(listener: (change: TargetsChange | null) => void): () => void;
  };
  menu: {
    /** Called with each application menu command aimed at this window. Returns an unsubscribe function. */
    onCommand(listener: (command: MenuCommand) => void): () => void;
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
    /**
     * `audio.bakes` of a timeline of the window's project (ADR 0031): baked sound of clips with audio effects; queues
     * the missing bakes. `view` as for `timeline.show`. Rejects with the daemon's message.
     */
    bakes(timeline: string, view?: TimelineViewName): Promise<AudioBakesResult>;
    /**
     * `matte.status` of a timeline of the window's project (ADR 0032): subject mattes of the plates its subject layers
     * play; queues the missing ones. `view` as for `timeline.show`. Rejects with the daemon's message.
     */
    mattes(timeline: string, view?: TimelineViewName): Promise<MatteStatusResult>;
    /**
     * `audio.inspect` of project-relative sound files with their spectrograms (ADR 0038): loudness, take mark and a
     * spectrogram per file, for the Audition dialog; files with no sound come back in `skipped`. Rejects with the daemon's message.
     */
    inspect(assets: string[]): Promise<MethodResult<"audio.inspect">>;
    /** Bytes of a derived waveform or thumbnail (project-relative path from `assets()`). */
    read(path: string): Promise<Uint8Array>;
    /** Called on every asset change of the project; see {@link AssetChange}. Returns an unsubscribe function. */
    onChanged(listener: (change: AssetChange) => void): () => void;
    /**
     * Import the media files among `paths` (videos, audio, images) into the
     * project's `assets/` (`asset.import`, copied). Resolves with the asset
     * paths made and the paths refused as not media. Rejects with the daemon's message.
     */
    import(paths: string[]): Promise<{ imported: string[]; refused: string[] }>;
  };
  context: {
    /**
     * Capture the main timeline's frame at `at` (timeline seconds) for an
     * "Chat about this" region reference (SPEC §10), rendered by the daemon's
     * `frame` method under `.frameshell/context/`. Resolves with its
     * project-relative path. Rejects with the daemon's message.
     */
    captureFrame(at: number): Promise<string>;
    /**
     * Write an "Chat about this" details file `name` (`e_<frame>_<n>.json`) with
     * JSON `content` under `.frameshell/context/` through the daemon's
     * `context.write` (ADR 0011). Resolves with its project-relative path.
     */
    writeDetails(name: string, content: string): Promise<string>;
  };
  segment: {
    /**
     * Get photos (project-relative image files) ready to be pointed into (daemon `segment.prepare`, ADR 0022), one
     * after the other. The first run downloads the model; see {@link onProgress}. Rejects with the daemon's message.
     */
    prepare(assets: string[]): Promise<void>;
    /**
     * `inspect.point` with `segment` at a point of the main timeline (`x`, `y` fractions of the frame): the masks
     * of the photo part there, or why there are none. Rejects with the daemon's message.
     */
    point(at: number, x: number, y: number): Promise<{ segment: SegmentedPoint | null; unavailable: string | null }>;
    /** Called with the progress of a running {@link prepare} or {@link point}. Returns an unsubscribe function. */
    onProgress(listener: (progress: ModelProgress) => void): () => void;
  };
  clips: {
    /**
     * `clip.renders` of a timeline of the window's project: render cache state per generated clip, in project format
     * `format` when given (ADR 0027; the daemon queues that format's missing renders). Rejects with the daemon's message.
     */
    renders(timeline: string, format?: string): Promise<ClipRendersResult>;
    /**
     * Called on every change of a `clip` render job of the project (daemon
     * `job.progress`); `null` after a daemon reconnect, when changes may have
     * been missed. Returns an unsubscribe function.
     */
    onJob(listener: (job: JobInfo | null) => void): () => void;
    /**
     * Live page of a generated clip (daemon `clip.live`, ADR 0010), served
     * under `frameshell-live://` for a sandboxed iframe. A new call for the
     * same clip revokes the previous URL. Rejects with the daemon's message,
     * e.g. when the clip's adapter has no live preview.
     */
    live(timeline: string, clip: string): Promise<LiveClipPage>;
  };
  multicam: {
    /**
     * `multicam.turns` of a group of a timeline of the window's project: who speaks when, on the group clock
     * (ADR 0016). Rejects with the daemon's message.
     */
    turns(timeline: string, group: string): Promise<MulticamTurnsResult>;
  };
  voiceover: {
    /** How the misread check of a generation can run in the window's project; see {@link VoiceoverVerifyPlan}. Rejects with the daemon's message. */
    verifyPlan(): Promise<VoiceoverVerifyPlan>;
    /**
     * Generate the voiceover of a project-relative voiceover script (daemon `voiceover.generate`, ADR 0034), with the
     * misread check when `verify`. A paid provider asks first in a native dialog naming the cost (or that it is unknown);
     * main sends `yes` only after the person confirms. Progress arrives through {@link FrameshellApi.voiceover}`.onProgress`.
     * Rejects with the daemon's message when it fails.
     */
    generate(path: string, verify: boolean, provider?: string): Promise<VoiceoverRun>;
    /**
     * Stop the generations the app has running in the window's project (daemon `voiceover.cancel`, never an agent's
     * run); the takes finished stay. Resolves false when there was none to stop.
     */
    cancel(): Promise<boolean>;
    /** Called with the progress of the generation in this window's project. Returns an unsubscribe function. */
    onProgress(listener: (progress: VoiceoverProgress) => void): () => void;
    /** Labels of the markers of the main timeline: what "where to start" can name besides seconds. Empty when it has none. */
    markers(): Promise<string[]>;
    /**
     * Place the takes of a project-relative voiceover script on the main timeline (daemon `voiceover.place`, one
     * transaction). `start` is what the person typed: seconds, a marker, `beat:N` or `bar:N`; empty = after the
     * voice track's last clip (a decimal comma is a decimal point). `replace` removes the clips already playing these takes
     * first. A refusal the person can act on resolves as `refused`; anything else rejects with the daemon's message.
     */
    place(path: string, start: string, replace: boolean): Promise<VoiceoverPlaceRun>;
  };
  transcript: {
    /**
     * Transcribe a project-relative asset (daemon `transcribe`, ADR 0046). A cloud or paid provider asks the person in a
     * native box first (main sends `yes` only after they confirm); resolves `declined` when they chose not to upload,
     * nothing having been sent. Progress arrives through `onProgress`. Rejects with the daemon's message.
     */
    run(asset: string): Promise<TranscribeRun>;
    /** Called with each step of a run started by {@link run}. Returns an unsubscribe function. */
    onProgress(listener: (progress: TranscribeProgress) => void): () => void;
  };
  models: {
    /** `model.list` for the window's project: provider models, files registered on this machine, the project's choice. */
    list(): Promise<MethodResult<"model.list">>;
    /** `transcription.set`: the project's model, or null for the default. Rejects with the daemon's message, e.g. ModelNotRegistered. */
    use(model: string | null): Promise<MethodResult<"transcription.set">>;
    /** Ask for a model file in the system dialog. Resolves with its absolute path, or null when cancelled. */
    pickFile(): Promise<string | null>;
    /**
     * `model.add`: register `file` on this machine under `id`, with provider `options` (whisper.cpp `dtw`). Rejects
     * with the daemon's message, e.g. UnsupportedModelFormat for a pickle file.
     */
    add(id: string, file: string, options: Record<string, string>): Promise<MethodResult<"model.add">>;
  };
  plugins: {
    /**
     * `plugin.catalog` of the window's project, plus `plugin.list` when it declares plugins. Rejects with the
     * daemon's message.
     */
    read(): Promise<PluginsView>;
    /**
     * `plugin.install` of an official plugin by package name (others are refused); trusts the project's plugin list
     * as `plugin.install` does. Rejects with the daemon's message, e.g. ProjectNotTrusted.
     */
    install(name: string): Promise<MethodResult<"plugin.install">>;
    /** `plugin.remove` after a native confirm box. Resolves false when the person cancelled. */
    remove(name: string): Promise<boolean>;
    /** `project.trust`, sent only from the person's click on Trust or Don't trust. */
    trust(decision: "trust" | "deny"): Promise<MethodResult<"project.trust">>;
    /** Managed downloads of this machine (`doctor`, never with `install`). */
    downloads(): Promise<MachineDownloads>;
    /**
     * `binaries.remove` after a native confirm box naming `bytes`; null when the person cancelled. Rejects with the
     * daemon's message, e.g. BinaryInUse.
     */
    removeDownload(name: string, bytes: number): Promise<BinariesRemoveResult | null>;
    /** Where the OpenAI key comes from (ADR 0050); never the key itself. */
    keyState(): Promise<OpenAiKeyState>;
    /**
     * Encrypt and keep the OpenAI key typed in the Plugins view, then hand it to the daemon. Rejects when this
     * computer cannot encrypt it or it is malformed; the message never holds the key.
     */
    saveKey(key: string): Promise<OpenAiKeyState>;
    /** Forget the saved OpenAI key, in the app and the daemon. */
    removeKey(): Promise<OpenAiKeyState>;
  };
  people: {
    /** `people.list` of the window's project (ADR 0020). Rejects with the daemon's message, e.g. InvalidProjectFile. */
    list(): Promise<MethodResult<"people.list">>;
    /** `people.add`. Rejects with the daemon's message, e.g. `name taken`. */
    add(name: string): Promise<MethodResult<"people.add">>;
    /** `people.rename`: also writes the name into the person's linked transcripts. */
    rename(person: string, name: string): Promise<MethodResult<"people.rename">>;
    /** `people.remove`. */
    remove(person: string): Promise<MethodResult<"people.remove">>;
    /** `people.link`; made by the person, so the link has no `by`. */
    link(person: string, target: PersonTarget): Promise<MethodResult<"people.link">>;
    /** `people.unlink`. */
    unlink(person: string, target: PersonTarget): Promise<MethodResult<"people.unlink">>;
    /** `people.scan` of every video: resolves when the scan job ends; progress comes through {@link people.onScan}. */
    scan(): Promise<MethodResult<"people.scan">>;
    /**
     * `people.suggest`: computes voice prints on first use, so it can take seconds. Without `download` the voice model
     * is never fetched and `voiceDownload` says what it would take; with it, progress comes through {@link people.onSuggestProgress}.
     */
    suggest(download?: boolean): Promise<MethodResult<"people.suggest">>;
    /** `people.confirm`; `reject` dismisses instead. `person` names who a suggestion without a person is. */
    confirm(suggestions: string[], options?: { reject?: boolean; person?: string }): Promise<MethodResult<"people.confirm">>;
    /** `people.ranges` of the main timeline: merged spans where `person` speaks or is on screen. */
    ranges(person: string, kind: "speaks" | "onscreen"): Promise<MethodResult<"people.ranges">>;
    /**
     * Called on every {@link PeopleChange} of the project (any author), or with `null` after a daemon reconnect,
     * when changes may have been missed. Returns an unsubscribe function.
     */
    onChanged(listener: (change: PeopleChange | null) => void): () => void;
    /** Called on every change of a `people` scan job of the project; `null` after a daemon reconnect. Returns an unsubscribe function. */
    onScan(listener: (job: JobInfo | null) => void): () => void;
    /** Called with the progress of a {@link people.suggest} with `download`. Returns an unsubscribe function. */
    onSuggestProgress(listener: (progress: ModelProgress) => void): () => void;
  };
  shoot: {
    /** What this machine can record besides cameras and mics; see {@link ShootSupport}. */
    support(): Promise<ShootSupport>;
    /**
     * Screens and windows that can be recorded, with thumbnails (Frameshell's own list, never the system picker).
     * The first call may raise the OS's screen recording permission prompt. Rejects with the OS's reason.
     */
    screens(): Promise<ShootScreenSource[]>;
    /**
     * What the window's next `getDisplayMedia` captures: screen or window `id` (null: the main screen), with system
     * audio when `systemAudio`. Call right before it.
     */
    pickScreen(id: string | null, systemAudio: boolean): Promise<void>;
    /**
     * Start a shoot session (ADR 0024) recording `sources` (a mic among them): main makes its folder under
     * `assets/shoot/`, keeps its state for crash recovery and keeps the project's windows out of screen captures.
     * Resolves with the session id. Rejects when a session is already recording in this window.
     */
    begin(sources: ShootSourceSpec[]): Promise<string>;
    /**
     * Each recorder's `performance.now()` read right before its `start()`, ms: the sources' offsets. `origin` is the
     * renderer's `performance.timeOrigin`, so main can put the screen's start on the clock of its pointer track.
     * Resolves with whether the global End shortcut ({@link SHOOT_END_KEYS}) is held for this session; false when
     * another app owns it.
     */
    started(id: string, starts: Partial<Record<ShootRole, number>>, origin?: number): Promise<boolean>;
    /** Called when the global End shortcut is pressed while this window records. Returns an unsubscribe function. */
    onEndRequested(listener: () => void): () => void;
    /** Append one recorded chunk of `role` to its file, in call order per role. */
    chunk(id: string, role: ShootRole, data: Uint8Array): Promise<void>;
    /**
     * End session `id` once every recorder stopped and its chunks were handed over: final files, ingest, and one
     * multicam group on the main timeline when something has a picture. Rejects with the daemon's message.
     */
    end(id: string): Promise<ShootFinish>;
    /** Sessions of the window's project finished without an End (after a crash), oldest first, since it opened. */
    recovered(): Promise<ShootFinish[]>;
    /** Called with each session {@link recovered} adds. Returns an unsubscribe function. */
    onRecovered(listener: (finish: ShootFinish) => void): () => void;
    /**
     * Cut (key `C`, ADR 0024): the range `start`..`end` (session clock, s) of recording session `id` becomes a take of
     * `script` starting at `scene`; the daemon transcribes and compares it in a `shoot` job. Resolves with the take id.
     */
    cut(id: string, take: { script: string; scene: string; start: number; end: number; recordedAt: string }): Promise<string>;
    /** `script.check` of a script of the window's project: its scenes, lines and words. Rejects with the daemon's message. */
    check(script: string): Promise<MethodResult<"script.check">>;
    /** `shoot.status` of a shoot script. Rejects with the daemon's message. */
    status(script: string): Promise<MethodResult<"shoot.status">>;
    /** Bytes still to download before the default transcription provider transcribes a first take: its tool and model. */
    transcriptionDownload(): Promise<number>;
    /**
     * Install the default transcription provider (`@frameshell/whisper-cpp`) into the window's project; the
     * daemon then transcribes the takes that failed without it. Rejects with the daemon's message.
     */
    installTranscription(): Promise<void>;
    /** `shoot.accept`: `deviations` of `take` (all when omitted), or take them back with `undo`. */
    accept(script: string, take: string, options?: { deviations?: string[]; undo?: boolean }): Promise<MethodResult<"shoot.accept">>;
    /** `shoot.choose`: the take of `scene` that goes into the cut; null goes back to the newest. */
    choose(script: string, scene: string, take: string | null): Promise<MethodResult<"shoot.choose">>;
    /** `shoot.discard`: drop `take` from the cut, or bring it back with `restore`. */
    discard(script: string, take: string, restore: boolean): Promise<MethodResult<"shoot.discard">>;
    /** `shoot.assemble` of every scene. */
    assemble(script: string): Promise<MethodResult<"shoot.assemble">>;
    /**
     * After a call (ADR 0024 decision 8): `multicam.gallery` on the session's screen angle, adding one angle per call
     * tile to its group, heard through the system audio's mic.
     */
    gallery(finish: ShootFinish): Promise<MethodResult<"multicam.gallery">>;
    /** `transcribe.speakers` on a recorded sound file (the call's system audio), transcribing it first when it has no transcript. */
    speakers(asset: string): Promise<MethodResult<"transcribe.speakers">>;
    /** Called on every `shoot.changed` of the project, or with null after a daemon reconnect. Returns an unsubscribe function. */
    onChanged(listener: (change: ShootChange | null) => void): () => void;
    /**
     * Live recognition for the teleprompter (ADR 0024 decision 5): start and warm the resident whisper-server in the
     * project's transcription language (detected without one). Downloads it and its model first only with `install`;
     * without, stops at `download`. Resolves with the status reached; never rejects.
     */
    liveWarm(install?: boolean): Promise<LiveStatus>;
    /** 16 kHz mono 16-bit samples of the mic (mixed with system audio), in order; heard words come by {@link onLiveHeard}. */
    liveAudio(samples: Int16Array): void;
    /** Forget the audio buffered so far, e.g. when listening stops. */
    liveReset(): void;
    /** Called on every change of the live recognizer's status. Returns an unsubscribe function. */
    onLiveStatus(listener: (status: LiveStatus) => void): () => void;
    /** Called with the words of each recognized window. Returns an unsubscribe function. */
    onLiveHeard(listener: (heard: LiveHeard) => void): () => void;
  };
  scripts: {
    /**
     * `script.outline` of a script of the window's project (project-relative path): its scenes with the
     * timeline span of their transcript words (ADR 0015). Rejects with the daemon's message.
     */
    outline(file: string): Promise<ScriptOutlineResult>;
  };
  updates: {
    /** The update to show in the banner; null when none, or dismissed this session. */
    status(): Promise<UpdateStatus | null>;
    /** Called on every change of {@link status}. Returns an unsubscribe function. */
    onStatus(listener: (status: UpdateStatus | null) => void): () => void;
    /** Quit, install the downloaded update and start the new version. Only for `ready`. */
    restart(): void;
    /** Hide the banner in every window until the app restarts. */
    dismiss(): void;
  };
}

/** What a shoot session records, one file each (ADR 0024): camera, screen or window, microphone, system audio. */
export const SHOOT_ROLES = ["camera", "screen", "mic", "system"] as const;

/** One of {@link SHOOT_ROLES}. */
export type ShootRole = (typeof SHOOT_ROLES)[number];

/** A source to record, as the Shoot view asks for it. */
export interface ShootSourceSpec {
  role: ShootRole;
  /** `MediaRecorder` type it records, e.g. `video/mp4;codecs=avc1.640028`. */
  mime: string;
  /** Device or window name; names the angle or mic of the session's group. */
  label: string;
}

/**
 * System audio on this machine: `available`, or why not: `linux` (no loopback capture), `macos-old` (needs macOS
 * 14.2 or later). Where it is missing, a loopback input device can be picked as a microphone.
 */
export interface ShootSupport {
  systemAudio: "available" | "linux" | "macos-old";
  /** Frameshell's windows can be hidden from screen captures while recording (`setContentProtection`: macOS, Windows). */
  contentProtection: boolean;
}

/**
 * The teleprompter's live recognizer: `off`, `download` (whisper-server or its model not installed yet: `bytes` to
 * fetch, only on the person's say-so), `installing` (downloading, `progress` 0..1 when known), `warming` (first run,
 * Metal shaders compile), `ready`, or `unavailable` with why in `detail` (no build for this machine, a failed
 * download, a crash); the teleprompter is then moved by keys only.
 */
export interface LiveStatus {
  state: "off" | "download" | "installing" | "warming" | "ready" | "unavailable";
  /** Live model in use or being installed, e.g. `ggml-small-q5_1`. */
  model: string | null;
  detail: string | null;
  progress: number | null;
  /** `download` only: bytes to fetch. */
  bytes?: number;
}

/** Words of one recognition window (never written to the project). */
export interface LiveHeard {
  /** In order, newest last. */
  words: string[];
  /** Seconds at the window's end with no word. */
  silence: number;
  /** Language whisper used, e.g. `es`; null when it said none. */
  language: string | null;
}

/** A screen or window that can be recorded. */
export interface ShootScreenSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  /** Thumbnail as a data URL; empty when the OS gave none. */
  thumbnail: string;
  /** macOS: a window off the active Space (another desktop, full screen), minimized or hidden; no thumbnail. */
  offDesktop?: boolean;
}

/** A finished shoot session. */
export interface ShootFinish {
  id: string;
  /** Project-relative folder, `assets/shoot/<id>`. */
  folder: string;
  /** Project-relative files recorded, now being ingested. */
  files: string[];
  /** Multicam group made of it; null when nothing had a picture or the group was refused. */
  group: string | null;
  /** Timeline holding `group`: the shoot's, else `main`; null without a group. */
  timeline: string | null;
  /** Project-relative screen or window recording; null when none was recorded. */
  screen: string | null;
  /** Project-relative system audio recording (a call's other voices); null when none was recorded. */
  system: string | null;
  /** Finished on a later open: the app or the window ended while recording. */
  recovered: boolean;
  /** Daemon warnings and files that could not be repaired or held nothing, in English. */
  warnings: string[];
}

/**
 * An update of the app, for the banner. `available`: a newer release
 * to download from `url` (Windows, `.deb`, or where installing failed).
 * `ready`: downloaded and installed on restart (macOS, AppImage).
 */
export type UpdateStatus = { state: "available"; version: string; url: string } | { state: "ready"; version: string };

/**
 * Progress of a call that may first fetch a model (preparing photos for Pick, finding voice matches): `download`
 * while the model or its runtime is fetched (first use only).
 */
export interface ModelProgress {
  download: boolean;
  /** 0..1 of the current step; null when unknown. */
  fraction: number | null;
}

/**
 * Whether the misread check of a voiceover generation (ADR 0034 decision 18) can run here, so the dialog never
 * starts a download by itself: `ready` = transcription is installed with its model, `download` = it would first
 * download `bytes` (the person agrees in the dialog), `unavailable` = no transcription plugin the app can use.
 */
export type VoiceoverVerifyPlan = { kind: "ready" } | { kind: "download"; bytes: number } | { kind: "unavailable" };

/** What a generation did: the result, or that the person declined the cost, or that Cancel stopped it. */
export type VoiceoverRun =
  | { status: "done"; result: VoiceoverGenerateResult }
  | { status: "declined" }
  | { status: "canceled"; kept: number }
  /** No voice to say it (#756): the script names no provider (`missing` null) or one not in this project; `available` can be picked. */
  | { status: "no-voice"; missing: string | null; available: VoiceChoice[] };

/** A speech provider the voiceover dialog can offer: its id and the name to show. */
export interface VoiceChoice {
  id: string;
  name: string;
}

/** What placing the takes came to: placed, or refused for a reason the dialog words (#756). */
export type VoiceoverPlaceRun =
  | { status: "placed"; result: VoiceoverPlaceResult }
  | {
      status: "refused";
      reason: { kind: "replace" } | { kind: "before-zero" } | { kind: "no-tempo" } | { kind: "unknown-time"; value: string } | { kind: "other"; message: string };
    };

/** What the Plugins view reads about the window's project: the official catalog and every plugin it declares. */
export interface PluginsView {
  catalog: MethodResult<"plugin.catalog">;
  /** As `plugin.list` reports them, official or not. */
  declared: PluginInfo[];
}

/**
 * Where the OpenAI key comes from (ADR 0050): the environment (wins), the key saved in this app, or nowhere.
 * `storable` is false when this computer cannot encrypt a key, so the view offers no field.
 */
export interface OpenAiKeyState {
  source: "environment" | "app" | "none";
  storable: boolean;
}

/** Managed downloads of this machine as `doctor` reports them: on disk (`downloads`) and every tool (`binaries`). */
export type MachineDownloads = Pick<MethodResult<"doctor">, "dataDir" | "downloads" | "binaries">;

/** What {@link FrameshellApi.transcript}`.run` did: transcribed, or the person declined the upload. */
export type TranscribeRun = { status: "done" } | { status: "declined" };

/** One step of a run of {@link FrameshellApi.transcript}`.run`, in the user's language; `fraction` 0..1 or null. */
export interface TranscribeProgress {
  asset: string;
  message: string;
  fraction: number | null;
}

/**
 * One step of a running generation. `confirm`: waiting for the person to confirm a cost; `speak`: saying `line`;
 * `verify`: checking `line` against the script; `download`: fetching the transcription tools. `fraction` is of the whole
 * stage (all the lines to say, not the current one), 0..1, null when unknown.
 */
export interface VoiceoverProgress {
  stage: "confirm" | "speak" | "verify" | "download";
  line: string | null;
  fraction: number | null;
  /** Which line of how many, 1-based, when the daemon says it (#756). */
  place: { index: number; total: number } | null;
}

/** A generated clip's live page as the renderer gets it: never its HTML, only where to load it. */
export interface LiveClipPage {
  /** `frameshell-live://<token>/<entry>`, valid until the clip asks again or the project closes. */
  url: string;
  /** Render cache key the page was built for (`clip.renders` `key`): a new key means the page is stale. */
  key: string;
}

/** An agent CLI the agent guide offers, and where it was found. */
export interface AgentChoice {
  /** Also the label `agent-detect.ts` gives a terminal running it. */
  id: string;
  name: string;
  /** Typed into a terminal to start it. */
  command: string;
  /** Official install command for this platform's terminal shell. */
  install: string;
  /** Runs shell commands without asking first. */
  unattended: boolean;
  /** Where it is installed; null when not found. */
  path: string | null;
}

/**
 * AI apps "Connect your AI" connects in one step: `claude-desktop` (Claude Desktop), `codex` (the ChatGPT desktop app,
 * Codex CLI and its IDE extension, which share `~/.codex/config.toml`), `claude-code`, `gemini` (Gemini CLI).
 */
export const AI_APP_IDS = ["claude-desktop", "codex", "claude-code", "gemini"] as const;

/** One of {@link AI_APP_IDS}. */
export type AiAppId = (typeof AI_APP_IDS)[number];

/** Whether `value` (from the renderer) names an AI app. */
export function isAiAppId(value: unknown): value is AiAppId {
  return AI_APP_IDS.some((id) => id === value);
}

/** The desktop AI apps the panel can open: its two big cards. */
export const DESKTOP_APP_IDS = ["claude-desktop", "chatgpt"] as const;

/** One of {@link DESKTOP_APP_IDS}. */
export type DesktopAppId = (typeof DESKTOP_APP_IDS)[number];

/** Whether `value` (from the renderer) names a desktop AI app. */
export function isDesktopAppId(value: unknown): value is DesktopAppId {
  return DESKTOP_APP_IDS.some((id) => id === value);
}

/** The apps' official download pages, which the renderer links to. */
export const DESKTOP_APP_DOWNLOAD: Readonly<Record<DesktopAppId, string>> = {
  "claude-desktop": "https://claude.ai/download",
  chatgpt: "https://chatgpt.com/download",
};

/** The result of opening a desktop AI app. */
export type DesktopAppOpened =
  /** The app was asked to open; `copied` says whether the starter phrase reached the clipboard. */
  | { opened: true; copied: boolean }
  /** `not-found`: no such app on this computer. `failed`: it is there but would not start. */
  | { opened: false; problem: { kind: "not-found" } | { kind: "failed"; message: string } };

/** Why reading or changing an app's settings did not work. */
export type AiAppProblem =
  /** Connect refused: the app's settings folder does not exist. */
  | { kind: "not-installed" }
  /** `file` does not parse (or is not the shape Frameshell edits): left as it is. */
  | { kind: "invalid"; file: string }
  | { kind: "failed"; message: string };

/** What an AI app's settings say about Frameshell. */
export interface AiAppStatus {
  id: AiAppId;
  /** The app exists on this platform (Claude Desktop: macOS, Windows). */
  available: boolean;
  /** Its settings folder exists: it is installed, or was. */
  installed: boolean;
  /** Its settings run this app's `frameshell mcp` (Claude Code: and have the prompt hook). */
  connected: boolean;
  /** Its settings hold Frameshell entries that run something else (an older shim, `frameshell` on PATH, a hand edit). */
  different: boolean;
  /** The settings files Frameshell edits. */
  files: string[];
  /** The settings could not be read. */
  problem: AiAppProblem | null;
}

/** Every AI app's status, and Frameshell's server as text to paste into apps with no connector. */
export interface AiApps {
  apps: AiAppStatus[];
  snippets: {
    /** `{ "mcpServers": { "frameshell": … } }`: Cursor, Windsurf and most MCP clients. */
    mcpServers: string;
    /** `{ "servers": { "frameshell": { "type": "stdio", … } } }`: VS Code's `mcp.json`. */
    vscode: string;
  };
}

/** The result of Connect or Disconnect. */
export interface AiAppChange {
  /** The state after. */
  status: AiAppStatus;
  /** Copies of the files as they were before the change. */
  backups: string[];
  /** Why nothing changed; null when the change was made (or there was nothing to change). */
  problem: AiAppProblem | null;
}

/**
 * The global shortcut that ends a recording shoot from any app (#744), `Mod` standing for ⌘ on macOS and Ctrl
 * elsewhere. Main registers it only while a session records.
 */
export const SHOOT_END_KEYS = "Mod+Alt+Shift+S";

/** IPC channel names; one place so main and preload cannot drift. */
export const Channel = {
  lang: "app:lang",
  agentsDetect: "agents:detect",
  agentsInstallCli: "agents:install-cli",
  agentsApps: "agents:apps",
  agentsConnect: "agents:connect",
  agentsDisconnect: "agents:disconnect",
  agentsOpenApp: "agents:open-app",
  agentsShowFile: "agents:show-file",
  agentsTargets: "agents:targets",
  agentsSend: "agents:send",
  agentsTargetsChanged: "agents:targets-changed",
  projectCurrent: "project:current",
  projectOpenFolder: "project:open-folder",
  projectOpen: "project:open",
  projectInit: "project:init",
  projectRecent: "project:recent",
  projectForgetRecent: "project:forget-recent",
  projectRevealRecent: "project:reveal-recent",
  projectDismissSync: "project:dismiss-sync",
  projectChooseVideos: "project:choose-videos",
  projectPlanVideos: "project:plan-videos",
  projectChooseParent: "project:choose-parent",
  projectImageFromFrame: "project:image-from-frame",
  projectFromVideos: "project:from-videos",
  projectPlanIdea: "project:plan-idea",
  projectFromIdea: "project:from-idea",
  projectReadIdea: "project:read-idea",
  projectAddFormat: "project:add-format",
  projectSetup: "project:setup",
  projectSetupChanged: "project:setup-changed",
  projectTakeOffered: "project:take-offered",
  projectTranscriptionDownload: "project:transcription-download",
  projectTakeStart: "project:take-start",
  projectStartOffered: "project:start-offered",
  projectVideosOffered: "project:videos-offered",
  mediaImport: "media:import",
  filesTree: "files:tree",
  filesRead: "files:read",
  filesWrite: "files:write",
  filesChanged: "files:changed",
  filesTrash: "files:trash",
  voiceoverVerifyPlan: "voiceover:verify-plan",
  voiceoverGenerate: "voiceover:generate",
  voiceoverCancel: "voiceover:cancel",
  voiceoverProgress: "voiceover:progress",
  voiceoverMarkers: "voiceover:markers",
  voiceoverPlace: "voiceover:place",
  filesReveal: "files:reveal",
  exportsReveal: "exports:reveal",
  filesCopyPath: "files:copy-path",
  terminalCreate: "terminal:create",
  terminalAttach: "terminal:attach",
  terminalList: "terminal:list",
  terminalWrite: "terminal:write",
  terminalClipboardHasText: "terminal:clipboard-has-text",
  terminalResize: "terminal:resize",
  terminalKill: "terminal:kill",
  terminalData: "terminal:data",
  terminalExit: "terminal:exit",
  terminalAgent: "terminal:agent",
  layoutLoad: "layout:load",
  layoutSave: "layout:save",
  panelsDetached: "panels:detached",
  panelsFullScreenSettled: "panels:full-screen-settled",
  timelineShow: "timeline:show",
  timelineChanged: "timeline:changed",
  timelineRejected: "timeline:rejected",
  timelineEdit: "timeline:edit",
  timelineReplaceImage: "timeline:replace-image",
  timelineAddLayers: "timeline:add-layers",
  timelineAddImages: "timeline:add-images",
  timelineAddMedia: "timeline:add-media",
  timelineCutOut: "timeline:cut-out",
  timelineExportImage: "timeline:export-image",
  timelineExportHandoff: "timeline:export-handoff",
  timelineExportVideo: "timeline:export-video",
  timelineExportJob: "timeline:export-job",
  timelineSettle: "timeline:settle",
  timelineUndo: "timeline:undo",
  timelineRedo: "timeline:redo",
  timelineHistoryCommand: "timeline:history-command",
  historyList: "history:list",
  historyDiff: "history:diff",
  historyRevert: "history:revert",
  reviewStatus: "review:status",
  reviewSet: "review:set",
  reviewAccept: "review:accept",
  reviewReject: "review:reject",
  reviewDiff: "review:diff",
  reviewChanged: "review:changed",
  menuCommand: "menu:command",
  uiPublish: "ui:publish",
  uiCommand: "ui:command",
  uiReply: "ui:reply",
  mediaAssets: "media:assets",
  mediaBakes: "media:bakes",
  mediaMattes: "media:mattes",
  mediaInspect: "media:inspect",
  mediaRead: "media:read",
  mediaChanged: "media:changed",
  contextCaptureFrame: "context:capture-frame",
  contextWriteDetails: "context:write-details",
  clipsRenders: "clips:renders",
  clipsJob: "clips:job",
  segmentPrepare: "segment:prepare",
  segmentPoint: "segment:point",
  segmentProgress: "segment:progress",
  clipsLive: "clips:live",
  scriptsOutline: "scripts:outline",
  multicamTurns: "multicam:turns",
  transcribeRun: "transcribe:run",
  transcribeProgress: "transcribe:progress",
  modelsList: "models:list",
  modelsUse: "models:use",
  modelsPickFile: "models:pick-file",
  modelsAdd: "models:add",
  pluginsRead: "plugins:read",
  pluginsInstall: "plugins:install",
  pluginsRemove: "plugins:remove",
  pluginsTrust: "plugins:trust",
  pluginsDownloads: "plugins:downloads",
  pluginsRemoveDownload: "plugins:remove-download",
  pluginsKeyState: "plugins:key-state",
  pluginsSaveKey: "plugins:save-key",
  pluginsRemoveKey: "plugins:remove-key",
  peopleList: "people:list",
  peopleAdd: "people:add",
  peopleRename: "people:rename",
  peopleRemove: "people:remove",
  peopleLink: "people:link",
  peopleUnlink: "people:unlink",
  peopleScan: "people:scan",
  peopleSuggest: "people:suggest",
  peopleConfirm: "people:confirm",
  peopleRanges: "people:ranges",
  peopleChanged: "people:changed",
  peopleScanJob: "people:scan-job",
  peopleSuggestProgress: "people:suggest-progress",
  shootSupport: "shoot:support",
  shootScreens: "shoot:screens",
  shootPickScreen: "shoot:pick-screen",
  shootBegin: "shoot:begin",
  shootStarted: "shoot:started",
  shootChunk: "shoot:chunk",
  shootEnd: "shoot:end",
  shootRecovered: "shoot:recovered",
  shootRecoveredChanged: "shoot:recovered-changed",
  shootEndRequested: "shoot:end-requested",
  shootCut: "shoot:cut",
  shootCheck: "shoot:check",
  shootStatus: "shoot:status",
  shootTranscriptionDownload: "shoot:transcription-download",
  shootInstallTranscription: "shoot:install-transcription",
  shootAccept: "shoot:accept",
  shootChoose: "shoot:choose",
  shootDiscard: "shoot:discard",
  shootAssemble: "shoot:assemble",
  shootGallery: "shoot:gallery",
  shootSpeakers: "shoot:speakers",
  shootChanged: "shoot:changed",
  shootLiveWarm: "shoot:live-warm",
  shootLiveAudio: "shoot:live-audio",
  shootLiveReset: "shoot:live-reset",
  shootLiveStatus: "shoot:live-status",
  shootLiveHeard: "shoot:live-heard",
  updatesStatus: "updates:status",
  updatesChanged: "updates:changed",
  updatesRestart: "updates:restart",
  updatesDismiss: "updates:dismiss",
} as const;
