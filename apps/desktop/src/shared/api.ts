import type { Lang } from "./i18n/index.js";
import type {
  AssetInfo,
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
  ShootStatusResult,
  SegmentedPoint,
  TimelineRejection,
  TimelineView,
  UiCommand,
  UiView,
} from "@frameshell/protocol";
import type { DetachablePanel, Layout } from "./layout.js";

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
 * Background setup of a project created from videos (#188): installing the
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
 * timeline and styled from their inspector; shots and multicam angles from
 * the shot inspector, who speaks painted on the timeline's turn lanes; transitions from a clip edge's menu and
 * the clip inspector, which also keys properties.
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
 * `toggleReview`: turn review mode on or off (File > Review agent changes before applying, ADR 0019).
 */
export type MenuCommand = "showTranscript" | "imageFromFrame" | "toggleReview";

/**
 * Everything the renderer may ask of main, exposed as `window.frameshell` by
 * the preload. The renderer never touches Node or the file system directly.
 */
export interface FrameshellApi {
  /** UI language of the app (#189); main reloads the windows when the user changes it. */
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
    /** Stop warning that this window's project is in a synced folder (#187); kept per project in the config dir. */
    dismissSyncWarning(): Promise<void>;
    /** Choose videos or audio with the OS dialog and plan their project; null when cancelled. Rejects on unreadable files. */
    chooseVideos(): Promise<VideoProjectPlan | null>;
    /**
     * Plan the project for the videos among `files` (e.g. dropped), optionally
     * in another `parent` or under another `name`. `refused` lists what is not
     * a video file; `plan` is null when nothing is.
     */
    planVideos(files: string[], place?: { parent?: string; name?: string }): Promise<{ plan: VideoProjectPlan | null; refused: string[] }>;
    /** Videos or audio the OS asked to open in this window (Open with, #184), once: null when none or already taken. */
    takeOffered(): Promise<VideoProjectPlan | null>;
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
     * Setup still running, or just ended, for this window's project (#188);
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
    /** Absolute path of a file dropped from the OS; empty for a file that is not on disk. */
    pathOf(file: File): string;
  };
  terminals: {
    create(size: { cols: number; rows: number }): Promise<TerminalInfo>;
    /**
     * Output to feed a view mounting on terminal `id` (ADR 0012): its recent
     * output, about 10,000 lines. Data events sent before the reply are in
     * it; later ones are not. Null once the terminal was killed.
     */
    attach(id: string): Promise<string | null>;
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
  panels: {
    /**
     * Panels to open in their own window when the project shows (ADR 0012).
     * Main keeps this list: a panel window opened through `window.open`
     * marks its panel detached, and closing it docks the panel back unless
     * its project window is closing or reloading.
     */
    detached(): Promise<DetachablePanel[]>;
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
    claudeDesktop(): Promise<ClaudeDesktopStatus>;
    /** Ask, then add Frameshell to Claude Desktop's config; resolves with the state after (unchanged if declined). */
    connectClaudeDesktop(): Promise<ClaudeDesktopStatus>;
    disconnectClaudeDesktop(): Promise<ClaudeDesktopStatus>;
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
     * "Ask agent" region reference (SPEC §10), rendered by the daemon's
     * `frame` method under `.frameshell/context/`. Resolves with its
     * project-relative path. Rejects with the daemon's message.
     */
    captureFrame(at: number): Promise<string>;
    /**
     * Write an "Ask agent" details file `name` (`e_<frame>_<n>.json`) with
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
    /** `clip.renders` of a timeline of the window's project: render cache state per generated clip. Rejects with the daemon's message. */
    renders(timeline: string): Promise<ClipRendersResult>;
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
    /** Each recorder's `performance.now()` read right before its `start()`, ms: the sources' offsets. */
    started(id: string, starts: Partial<Record<ShootRole, number>>): Promise<void>;
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
    /** `shoot.status` of a shoot script of the window's project (project-relative path). Rejects with the daemon's message. */
    status(script: string): Promise<ShootStatusResult>;
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

/** A screen or window that can be recorded. */
export interface ShootScreenSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  /** Thumbnail as a data URL; empty when the OS gave none. */
  thumbnail: string;
}

/** A finished shoot session. */
export interface ShootFinish {
  id: string;
  /** Project-relative folder, `assets/shoot/<id>`. */
  folder: string;
  /** Project-relative files recorded, now being ingested. */
  files: string[];
  /** Multicam group made of it on the main timeline; null when nothing had a picture or the group was refused. */
  group: string | null;
  /** Finished on a later open: the app or the window ended while recording. */
  recovered: boolean;
  /** Daemon warnings and files that could not be repaired or held nothing, in English. */
  warnings: string[];
}

/**
 * An update of the app (#193), for the banner. `available`: a newer release
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

/** A generated clip's live page as the renderer gets it: never its HTML, only where to load it. */
export interface LiveClipPage {
  /** `frameshell-live://<token>/<entry>`, valid until the clip asks again or the project closes. */
  url: string;
  /** Render cache key the page was built for (`clip.renders` `key`): a new key means the page is stale. */
  key: string;
}

/** An agent CLI the agent guide offers (#190), and where it was found. */
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

/** Frameshell's entry in Claude Desktop's MCP config (#191). */
export interface ClaudeDesktopStatus {
  /** Claude Desktop exists on this platform (macOS, Windows). */
  available: boolean;
  /** Its settings folder exists: it is installed, or was. */
  installed: boolean;
  /** Its config runs this app's `frameshell mcp`. */
  connected: boolean;
}

/** IPC channel names; one place so main and preload cannot drift. */
export const Channel = {
  lang: "app:lang",
  agentsDetect: "agents:detect",
  agentsInstallCli: "agents:install-cli",
  agentsClaudeDesktop: "agents:claude-desktop",
  agentsConnectClaudeDesktop: "agents:connect-claude-desktop",
  agentsDisconnectClaudeDesktop: "agents:disconnect-claude-desktop",
  projectCurrent: "project:current",
  projectOpenFolder: "project:open-folder",
  projectOpen: "project:open",
  projectInit: "project:init",
  projectRecent: "project:recent",
  projectDismissSync: "project:dismiss-sync",
  projectChooseVideos: "project:choose-videos",
  projectPlanVideos: "project:plan-videos",
  projectChooseParent: "project:choose-parent",
  projectImageFromFrame: "project:image-from-frame",
  projectFromVideos: "project:from-videos",
  projectSetup: "project:setup",
  projectSetupChanged: "project:setup-changed",
  projectTakeOffered: "project:take-offered",
  projectVideosOffered: "project:videos-offered",
  mediaImport: "media:import",
  filesTree: "files:tree",
  filesRead: "files:read",
  filesWrite: "files:write",
  filesChanged: "files:changed",
  terminalCreate: "terminal:create",
  terminalAttach: "terminal:attach",
  terminalWrite: "terminal:write",
  terminalResize: "terminal:resize",
  terminalKill: "terminal:kill",
  terminalData: "terminal:data",
  terminalExit: "terminal:exit",
  terminalAgent: "terminal:agent",
  layoutLoad: "layout:load",
  layoutSave: "layout:save",
  panelsDetached: "panels:detached",
  timelineShow: "timeline:show",
  timelineChanged: "timeline:changed",
  timelineRejected: "timeline:rejected",
  timelineEdit: "timeline:edit",
  timelineReplaceImage: "timeline:replace-image",
  timelineAddLayers: "timeline:add-layers",
  timelineCutOut: "timeline:cut-out",
  timelineExportImage: "timeline:export-image",
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
  shootStatus: "shoot:status",
  updatesStatus: "updates:status",
  updatesChanged: "updates:changed",
  updatesRestart: "updates:restart",
  updatesDismiss: "updates:dismiss",
} as const;
