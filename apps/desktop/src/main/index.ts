// Electron main: windows, IPC, terminals, explorer watcher, daemon link (SPEC §3.2).
// Env: FRAMESHELL_DATA_DIR / FRAMESHELL_CONFIG_DIR isolate user dirs (tests); FRAMESHELL_SOCKET picks the daemon;
// FRAMESHELL_PREVIEW_PROBE=1 exposes preview measurement hooks (ADR 0001 harness) and keeps hidden windows at full rate.
// Args: --project <dir> opens that folder at startup.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BaseWindow, BrowserWindow, Menu, type WebContents, app, dialog, ipcMain, protocol, screen, shell, utilityProcess } from "electron";
import { BinaryManager } from "@frameshell/core/binaries";
import { resolveAppDirs, resolveSocketPath } from "@frameshell/protocol";
import type { TimelineRejection, UiView } from "@frameshell/protocol";
import {
  type AssetChange,
  Channel,
  type EditOptions,
  type HistoryCommand,
  type LiveClipPage,
  type MenuCommand,
  type OpenOutcome,
  type Outcome,
  type ProjectView,
  type TimelineChange,
  type TimelineEdit,
  type ProjectSetup,
  type VideoProjectPlan,
} from "../shared/api.js";
import { type DetachablePanel, type Layout, normalizeLayout } from "../shared/layout.js";
import {
  type CliInstallHost,
  type CliInstallOutcome,
  cliInstallBlocker,
  installCli,
  systemCliInstallHost,
  uninstallCli,
} from "./cli-install.js";
import { writeCliShim } from "./cli-shim.js";
import { captureContextFrame } from "./context-frames.js";
import { helperDaemonLauncher } from "./daemon-launcher.js";
import { DaemonLink, type LinkSubscription } from "./daemon-link.js";
import { editMenu } from "./edit-menu.js";
import { LayoutStore } from "./layout-store.js";
import { LIVE_SCHEME, LivePages, serveLive } from "./live-protocol.js";
import { MEDIA_SCHEME, MediaRoots, serveMedia } from "./media-protocol.js";
import { PANEL_WINDOW_MIN, PanelWindowStore, cascade, placeOnDisplays, panelWindowRequest } from "./panel-windows.js";
import { type ProjectFiles, openProjectFiles } from "./project-files.js";
import { terminalLaunch } from "./terminal-launch.js";
import { terminalToolPaths } from "./terminal-tools.js";
import { TimelineEditor } from "./timeline-editor.js";
import { TerminalManager } from "./terminals.js";
import { UiBridge } from "./ui-bridge.js";
import { MEDIA_EXTENSIONS, VIDEO_EXTENSIONS, partitionFiles } from "./media-files.js";
import { launchPaths, pathBatcher } from "./open-paths.js";
import { planVideoProject } from "./video-project.js";

// One resolver for all user-level storage: Electron state (Chromium profile, layouts, recents, CLI shim) is data.
app.setPath("userData", join(resolveAppDirs(process.env).dataDir, "desktop"));
// One packaged app per user data dir: a second launch (Open with, a click in Explorer) hands its files to this one
// (#184). Unpackaged builds skip it, so a dev build runs beside the installed app.
const primary = !app.isPackaged || app.requestSingleInstanceLock();
if (!primary) app.quit();

const APP_VERSION = app.getVersion();
const socketPath = resolveSocketPath(process.env);
// Spawning the daemon reuses process.execPath (Electron): run it as plain Node. Spawned from a utility process so it
// never holds this process's stdio handles (#112).
const daemon = new DaemonLink({
  socketPath,
  client: `desktop/${APP_VERSION}`,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  launch: helperDaemonLauncher(() =>
    utilityProcess.fork(join(import.meta.dirname, "daemon-spawner.js"), [], {
      stdio: "ignore",
      serviceName: "Frameshell daemon launcher",
    }),
  ),
});
const editor = new TimelineEditor((method, params) => daemon.request(method, params));
// SPEC §7b: each window's state to the daemon, the daemon's navigation commands to the window. Window key = webContents id.
const ui = new UiBridge({
  request: (method, params) => daemon.request(method, params),
  deliver: (view, project, message) => {
    const state = windows.get(Number(view));
    if (!state || state.project?.dir !== project || state.window.webContents.isDestroyed()) return false;
    send(state.window.webContents, Channel.uiCommand, message.id, message.command);
    return true;
  },
});
daemon.on("ui.command", (params) => ui.command(params));
daemon.onReconnect(() => ui.resync());
const layouts = new LayoutStore(join(app.getPath("userData"), "layouts"));
/** Detached panels and their windows' placement (ADR 0012): a user decision, global, so in `configDir`. */
const panelWindows = new PanelWindowStore(join(resolveAppDirs(process.env).configDir, "panel-windows.json"));
/** Projects whose synced-folder warning the user dismissed (#187): a user decision, so in `configDir`. */
const syncWarningsFile = join(resolveAppDirs(process.env).configDir, "sync-warnings-dismissed.json");
/** Placement saves wait for the window to stop moving. */
const PLACEMENT_SAVE_MS = 400;
// A dev build gets its own shim dir: the installed app's shim, which the system-wide `frameshell` links to (#139),
// must keep pointing at the installed app.
const binDir = join(app.getPath("userData"), app.isPackaged ? "bin" : "bin-dev");
const cliShim = join(binDir, process.platform === "win32" ? "frameshell.cmd" : "frameshell");
/** Same dirs as the daemon (spawned with this env): terminals see the binaries it runs. Locates only, never installs. */
const binaries = new BinaryManager(resolveAppDirs(process.env));
const recentFile = join(app.getPath("userData"), "recent.json");
const MAX_RECENT = 10;
/** Preview measurement mode: the renderer gets `?probe=1`. */
const PREVIEW_PROBE = process.env["FRAMESHELL_PREVIEW_PROBE"] === "1";
if (PREVIEW_PROBE) {
  // Real-time measurements: timers, rAF and audio must not slow down when the window loses focus.
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
}
/** Base URLs of `frameshell-media://`, one per project shown in a window. */
const mediaRoots = new MediaRoots();
/** Live pages of generated clips (ADR 0010), served under `frameshell-live://`. */
const livePages = new LivePages();

// Before ready: fetch() from renderer workers, range streaming and CORS need a privileged scheme. Live pages resolve
// relative URLs (standard) and load module scripts, fonts and media from an opaque origin (CORS).
protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  { scheme: LIVE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

/** Per-window state; a window shows at most one project. */
interface WindowState {
  window: BrowserWindow;
  project: ProjectView | null;
  files: ProjectFiles | null;
  /**
   * Daemon `timeline.changed`, `timeline.rejected`, `asset.changed` and `clip`
   * job `job.progress` of the shown project, forwarded to the renderer: nothing
   * there polls the daemon.
   */
  daemonEvents: LinkSubscription[];
  terminals: TerminalManager;
  /** Live page URL per clip id issued to this window; revoked when re-issued or the project closes. */
  live: Map<string, string>;
  /**
   * The `--project` open started with the window. The page loads meanwhile (a cold daemon can take many seconds)
   * and `project.current` awaits this, so the renderer shows its boot screen, never a premature welcome screen.
   */
  opening: Promise<unknown>;
  /**
   * Detached panel windows (ADR 0012): `about:blank` documents the project
   * renderer draws a panel into, with the panel each shows. Several may show
   * the same panel kind: one per detached terminal tab. They have no preload
   * and never send IPC; the menu routes their commands to this window.
   */
  panels: Map<BrowserWindow, DetachablePanel>;
  /** Folder the window was created to open; unset for a window made to show the welcome screen. */
  startDir: string | undefined;
  /** Videos the OS asked to open (#184), waiting for the welcome screen to take them; null when none. */
  offered: VideoProjectPlan | null;
  /**
   * The project window is closing or reloading: its panel windows close
   * with it but stay detached, so they open again with the project.
   */
  closingPanels: boolean;
}
const windows = new Map<number, WindowState>();
/** Project window state of each detached panel window, by the panel window's webContents id. */
const panelOwners = new Map<number, WindowState>();
/** The app is quitting: windows close in any order, panel windows before their project window too. */
let quitting = false;
/** Shells of closed windows still exiting; the app waits for them before it quits. */
const exitingShells = new Set<Promise<void>>();

function createWindow(projectDir?: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: "Frameshell",
    backgroundColor: "#1d1e20",
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // This renderer also drives its detached panel windows (ADR 0012): hidden or minimized, it must not slow them down.
      backgroundThrottling: false,
    },
  });
  const contents = window.webContents;
  const state: WindowState = {
    window,
    project: null,
    files: null,
    daemonEvents: [],
    live: new Map(),
    opening: Promise.resolve(),
    panels: new Map(),
    startDir: projectDir,
    offered: null,
    closingPanels: false,
    terminals: new TerminalManager({
      onData: (id, data) => send(contents, Channel.terminalData, id, data),
      onExit: (id, code) => send(contents, Channel.terminalExit, id, code),
      onAgent: (id, session, agent) => {
        send(contents, Channel.terminalAgent, id, agent);
        // History names the agent (SPEC §6.2). Daemon unreachable: the link tags again once it reconnects.
        if (session) daemon.tagSession(session, agent).catch(() => undefined);
      },
    }),
  };
  windows.set(contents.id, state);

  // Links (xterm web links) open in the browser; the app window never navigates away. The one popup allowed is a
  // detached panel's blank window (ADR 0012), sandboxed like this one, without a preload.
  contents.setWindowOpenHandler(({ url, frameName }) => {
    const panel = panelWindowRequest(url, frameName);
    if (panel) return { action: "allow", overrideBrowserWindowOptions: panelWindowOptions(state, panel) };
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("did-create-window", (child, { url, frameName }) => {
    const panel = panelWindowRequest(url, frameName);
    if (panel) adoptPanelWindow(state, panel, child);
    else child.destroy();
  });
  contents.on("will-navigate", (event) => event.preventDefault());
  // A reload drops the documents the panel windows show: close them, still detached, and the new page opens them again.
  contents.on("did-start-navigation", ({ isMainFrame, isSameDocument }) => {
    if (isMainFrame && !isSameDocument) closePanelWindows(state);
  });
  contents.on("did-finish-load", () => (state.closingPanels = false));
  window.once("ready-to-show", () => window.show());
  window.on("close", () => closePanelWindows(state));
  window.on("closed", () => {
    const exiting = state.terminals.killAll();
    exitingShells.add(exiting);
    void exiting.then(() => exitingShells.delete(exiting));
    void state.files?.close();
    for (const subscription of state.daemonEvents) void subscription.unsubscribe();
    if (state.project) mediaRoots.revoke(state.project.mediaUrl);
    revokeLive(state);
    ui.detach(String(contents.id));
    windows.delete(contents.id);
  });

  const fail = (error: unknown) => dialog.showErrorBox("Frameshell", String((error as Error)?.message ?? error));
  // Open failures show as the welcome screen (outcome `error`); only a throw is unexpected.
  if (projectDir) state.opening = openInWindow(state, projectDir).catch(fail);
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  const query: Record<string, string> = PREVIEW_PROBE ? { probe: "1" } : {};
  const load = devUrl
    ? window.loadURL(`${devUrl}${PREVIEW_PROBE ? "?probe=1" : ""}`)
    : window.loadFile(join(import.meta.dirname, "../renderer/index.html"), { query });
  load.catch(fail);
  return window;
}

/**
 * Options of a detached panel's window: where it was on these displays, else centred on the primary display;
 * shifted when windows of the same panel are already open (terminal tabs).
 */
function panelWindowOptions(state: WindowState, panel: DetachablePanel): Electron.BrowserWindowConstructorOptions {
  const displays = screen.getAllDisplays();
  const placed = placeOnDisplays(panelWindows.placement(panel, displays)?.bounds, displays, screen.getPrimaryDisplay());
  const bounds = cascade(placed, [...state.panels.values()].filter((open) => open === panel).length);
  return {
    ...bounds,
    minWidth: PANEL_WINDOW_MIN.width,
    minHeight: PANEL_WINDOW_MIN.height,
    title: "Frameshell",
    backgroundColor: "#1d1e20",
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  };
}

/**
 * Register a detached panel's window under its project window: menu
 * commands from it reach the project, it closes with the project, and its
 * placement is saved as it moves. Closed on its own, it docks its panel back.
 */
function adoptPanelWindow(state: WindowState, panel: DetachablePanel, child: BrowserWindow): void {
  const childId = child.webContents.id;
  state.panels.set(child, panel);
  panelOwners.set(childId, state);
  void panelWindows.setDetached(panel, true);
  if (panelWindows.placement(panel, screen.getAllDisplays())?.fullScreen) child.setFullScreen(true);
  child.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  child.webContents.on("will-navigate", (event) => event.preventDefault());

  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (child.isDestroyed() || child.isMinimized()) return;
      void panelWindows.place(panel, screen.getAllDisplays(), { bounds: child.getNormalBounds(), fullScreen: child.isFullScreen() });
    }, PLACEMENT_SAVE_MS);
  };
  child.on("move", save);
  child.on("resize", save);
  child.on("enter-full-screen", save);
  child.on("leave-full-screen", save);
  child.on("closed", () => {
    clearTimeout(timer);
    panelOwners.delete(childId);
    state.panels.delete(child);
    // A newer window of the same panel may have replaced this one (a quick dock and detach): the panel stays detached.
    if ([...state.panels.values()].includes(panel)) return;
    if (!quitting && !state.closingPanels) void panelWindows.setDetached(panel, false);
  });
}

/** Close a project window's panel windows, keeping their panels detached for the next time the project opens. */
function closePanelWindows(state: WindowState): void {
  state.closingPanels = true;
  for (const child of state.panels.keys()) if (!child.isDestroyed()) child.close();
}

/** The project window a window belongs to: itself, or the owner of a detached panel window. */
function projectWindowOf(base: BaseWindow | null | undefined): WindowState | undefined {
  const window = base ? BrowserWindow.fromId(base.id) : null;
  if (!window || window.isDestroyed()) return undefined;
  return windows.get(window.webContents.id) ?? panelOwners.get(window.webContents.id);
}

function send(contents: WebContents, channel: string, ...args: unknown[]): void {
  if (!contents.isDestroyed()) contents.send(channel, ...args);
}

/** Resolve `dir` to its project through the daemon and attach it to the window. */
async function openInWindow(state: WindowState, dir: string): Promise<OpenOutcome> {
  let status;
  try {
    status = await daemon.request("status", { cwd: dir });
  } catch (error) {
    return { status: "error", message: (error as Error).message };
  }
  if (!status.project) return { status: "not-a-project", dir };
  const project: ProjectView = {
    dir: status.project.dir,
    name: status.project.name,
    daemon: { version: status.daemon.daemonVersion, pid: status.daemon.pid, socketPath: status.daemon.socketPath },
    mediaUrl: mediaRoots.issue(status.project.dir),
    synced: status.synced && !(await readDismissedSync()).includes(status.project.dir) ? status.synced : null,
  };
  await state.files?.close();
  await Promise.all(state.daemonEvents.splice(0).map((subscription) => subscription.unsubscribe()));
  // The renderer publishes the new project's state once it shows it.
  ui.detach(String(state.window.webContents.id));
  const contents = state.window.webContents;
  state.files = await openProjectFiles(project.dir, (paths) => send(contents, Channel.filesChanged, paths));
  // Subscribed before the renderer first reads the timeline, so no change falls in between. The daemon
  // watches timeline files itself (SPEC §6.4): direct edits arrive here too, as author `file`.
  const subscriptions = await Promise.all([
    daemon.subscribe("timeline.changed", project.dir, {
      onEvent: ({ timeline, revision, author }) =>
        send(contents, Channel.timelineChanged, { timeline, revision, author } satisfies TimelineChange),
      onResync: () => send(contents, Channel.timelineChanged, { timeline: null } satisfies TimelineChange),
    }),
    daemon.subscribe("timeline.rejected", project.dir, {
      onEvent: ({ project: _project, ...rejection }) =>
        send(contents, Channel.timelineRejected, rejection satisfies TimelineRejection),
    }),
    daemon.subscribe("asset.changed", project.dir, {
      onEvent: ({ path, asset }) => send(contents, Channel.mediaChanged, { path, asset } satisfies AssetChange),
      onResync: () => send(contents, Channel.mediaChanged, { path: null } satisfies AssetChange),
    }),
    // Generated clip renders (SPEC §6.5): the preview shows their progress, then plays them.
    daemon.subscribe("job.progress", project.dir, {
      onEvent: ({ job }) => {
        if (job.kind === "clip") send(contents, Channel.clipsJob, job);
      },
      onResync: () => send(contents, Channel.clipsJob, null),
    }),
  ]).catch(() => []); // Daemon unreachable: `timeline.show` fails too and the panel says so.
  state.daemonEvents = subscriptions;
  if (state.project) mediaRoots.revoke(state.project.mediaUrl);
  revokeLive(state);
  state.project = project;
  state.window.setTitle(`${project.name} — Frameshell`);
  await rememberRecent(project.dir);
  return { status: "opened", project };
}

/** Stop serving every live page issued to the window. */
function revokeLive(state: WindowState): void {
  for (const url of state.live.values()) livePages.revoke(url);
  state.live.clear();
}

/** Window to open a folder in: this one while it shows the welcome screen, else a new one. */
async function openFromWindow(state: WindowState, dir: string): Promise<OpenOutcome> {
  if (!state.project) return openInWindow(state, dir);
  const existing = [...windows.values()].find((other) => other.project?.dir === dir);
  if (existing) existing.window.focus();
  else createWindow(dir);
  return { status: "cancelled" };
}

async function readDismissedSync(): Promise<string[]> {
  try {
    const list: unknown = JSON.parse(await readFile(syncWarningsFile, "utf8"));
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function dismissSync(dir: string): Promise<void> {
  const list = [...new Set([...(await readDismissedSync()), dir])];
  await mkdir(dirname(syncWarningsFile), { recursive: true });
  await writeFile(syncWarningsFile, JSON.stringify(list, null, 2));
}

async function readRecent(): Promise<string[]> {
  try {
    const list = JSON.parse(await readFile(recentFile, "utf8")) as unknown;
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function rememberRecent(dir: string): Promise<void> {
  const list = [dir, ...(await readRecent()).filter((item) => item !== dir)].slice(0, MAX_RECENT);
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(recentFile, JSON.stringify(list, null, 2));
}

async function pickFolder(window: BrowserWindow): Promise<string | undefined> {
  const result = await dialog.showOpenDialog(window, {
    title: "Open project folder",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? undefined : result.filePaths[0];
}

async function pickVideos(window: BrowserWindow): Promise<string[]> {
  const result = await dialog.showOpenDialog(window, {
    title: "Choose videos",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Videos", extensions: [...VIDEO_EXTENSIONS] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return result.canceled ? [] : result.filePaths;
}

/** Create the project a video plan names, or open it when it already exists (ADR 0013). */
async function createFromVideos(
  state: WindowState,
  request: Pick<VideoProjectPlan, "files" | "parent" | "name">,
  mode: "copy" | "link",
  transcribe: boolean,
): Promise<OpenOutcome> {
  try {
    // Planned again: the folder may have appeared since the renderer showed the plan.
    const plan = await planVideoProject(request.files, { parent: request.parent, name: request.name });
    let assets: string[] = [];
    if (!plan.existing) {
      // The project takes the first video's size, frame rate and sample rate (#197); the defaults when ffprobe
      // cannot read it, so an odd file never blocks the project.
      await daemon
        .request("project.init", { dir: plan.dir, name: plan.name, like: plan.files[0] })
        .catch(() => daemon.request("project.init", { dir: plan.dir, name: plan.name }));
      const { imported } = await daemon.request("asset.import", { cwd: plan.dir, files: plan.files, mode });
      assets = imported.map((item) => item.asset);
      await placeOnTimeline(plan.dir, assets);
    }
    const opened = await openFromWindow(state, plan.dir);
    if (transcribe && assets.length > 0) void setUpTranscription(plan.dir, assets);
    return opened;
  } catch (error) {
    return { status: "error", message: (error as Error).message };
  }
}

/**
 * Put `assets` one after another on a new video track of the main timeline,
 * as one `ui` transaction, so a single undo takes them off (#197). A video
 * that cannot be placed (unreadable) is skipped; the rest still go in.
 */
async function placeOnTimeline(dir: string, assets: string[]): Promise<void> {
  await editor.alone(async () => {
    await daemon.request("tx.begin", { label: "Place the videos", autoCommitAfter: 30 });
    try {
      const track = await daemon.request("track.add", { cwd: dir, timeline: "main", kind: "video", name: "Video" });
      const id = track.changes.added[0];
      if (id) {
        for (const asset of assets) await daemon.request("clip.add", { cwd: dir, timeline: "main", track: id, asset }).catch(() => undefined);
      }
    } finally {
      await daemon.request("tx.commit", {}).catch(() => undefined);
    }
  });
}

/** Official transcription plugin a project made from videos gets (#188). */
const TRANSCRIPTION_PLUGIN = "@frameshell/whisper-cpp";
/** Setup of each project created from videos, by project dir, while it runs and as it ended. */
const setups = new Map<string, ProjectSetup>();

function reportSetup(dir: string, setup: ProjectSetup): void {
  setups.set(dir, setup);
  for (const state of windows.values()) {
    if (state.project?.dir === dir) send(state.window.webContents, Channel.projectSetupChanged, setup);
  }
}

/**
 * Install the transcription plugin into the new project at `dir` and
 * transcribe `assets`, in the background, reporting each step (#188). The
 * user created the project, so the plugin is trusted as `plugin.install`
 * trusts it. Fails softly: the project stays usable and the agent can retry.
 */
async function setUpTranscription(dir: string, assets: string[]): Promise<void> {
  const name = (asset: string) => asset.split("/").pop() ?? asset;
  const running = (message: string, fraction: number | null = null) =>
    reportSetup(dir, { message, detail: null, fraction, state: "running" });
  // Said in the user's terms; the daemon's message goes to the tooltip.
  let failure = "Could not download the transcription plugin. Check the internet connection, then ask the agent to transcribe the videos.";
  try {
    running("Setting up transcription…");
    const { plugins } = await daemon.request("plugin.list", { cwd: dir });
    if (!plugins.some((plugin) => plugin.name === TRANSCRIPTION_PLUGIN)) {
      await daemon.request("plugin.install", { cwd: dir, spec: TRANSCRIPTION_PLUGIN });
    }
    for (const asset of assets) {
      failure = `Could not transcribe ${name(asset)}. Ask the agent to transcribe it.`;
      running(`Transcribing ${name(asset)}…`);
      await daemon.request(
        "transcribe",
        { cwd: dir, asset },
        { onProgress: (update) => running(`${name(asset)}: ${update.message}`, update.fraction ?? null) },
      );
    }
    reportSetup(dir, { message: `Transcribed ${assets.map(name).join(", ")}.`, detail: null, fraction: null, state: "done" });
  } catch (error) {
    reportSetup(dir, { message: failure, detail: (error as Error).message, fraction: null, state: "failed" });
  }
}

/** Focus the window showing project `dir`; else open it in the welcome window; else in a new window. */
function showProject(dir: string): void {
  const existing = [...windows.values()].find((state) => state.project?.dir === dir || state.startDir === dir);
  if (existing) {
    existing.window.focus();
    return;
  }
  const welcome = welcomeWindow();
  if (!welcome) {
    createWindow(dir);
    return;
  }
  // Reloaded: the new page's `project.current` waits for this open, as at a `--project` start.
  welcome.startDir = dir;
  welcome.opening = openInWindow(welcome, dir).catch(() => undefined);
  welcome.window.webContents.reload();
  welcome.window.focus();
}

/** A window on the welcome screen with nothing pending: where what the OS opens goes first. */
function welcomeWindow(): WindowState | undefined {
  return [...windows.values()].find((state) => !state.project && !state.startDir && !state.offered);
}

/**
 * Open what the OS handed the app (#184): folders as projects; videos as a
 * project made from them, offered on a welcome screen for confirmation, or
 * opened at once when their project exists already (ADR 0013). Other files are ignored.
 */
async function openPaths(paths: string[]): Promise<void> {
  const files: string[] = [];
  for (const path of paths) {
    const info = await stat(path).catch(() => null);
    if (info?.isDirectory()) showProject(path);
    else if (info?.isFile()) files.push(path);
  }
  const { accepted } = await partitionFiles(files, VIDEO_EXTENSIONS);
  if (accepted.length === 0) return;
  const plan = await planVideoProject(accepted).catch(() => null);
  if (!plan) return;
  if (plan.existing) {
    showProject(plan.dir);
    return;
  }
  const target = welcomeWindow() ?? windows.get(createWindow().webContents.id);
  if (!target) return;
  target.offered = plan;
  send(target.window.webContents, Channel.projectVideosOffered);
  target.window.focus();
}

const openLater = pathBatcher((paths) => void openPaths(paths), 500);
/** `open-file` paths from before the app was ready: they replace the empty startup window. */
const earlyOpens: string[] = [];
let ready = false;
// macOS: Open with, a drop on the Dock icon, `open -a Frameshell clip.mp4`. May fire before `ready`.
app.on("open-file", (event, path) => {
  event.preventDefault();
  if (ready) openLater(path);
  else earlyOpens.push(path);
});
app.on("second-instance", (_event, argv, workingDirectory) => {
  const paths = launchPaths(argv, 1, workingDirectory);
  if (paths.length > 0) {
    // Explorer starts one process per file of a multi-file "Edit with Frameshell": gather them into one project.
    for (const path of paths) openLater(path);
    return;
  }
  const [any] = windows.values();
  if (any) any.window.focus();
  else createWindow();
});

function stateOf(sender: WebContents): WindowState {
  const state = windows.get(sender.id) ?? panelOwners.get(sender.id);
  if (!state) throw new Error("IPC from an unknown window");
  return state;
}

/** The window's project, once its startup open settled: the page loads, and may ask, before a cold daemon answers. */
async function requireProject(state: WindowState): Promise<{ project: ProjectView; files: ProjectFiles }> {
  await state.opening;
  if (!state.project || !state.files) throw new Error("No project is open in this window");
  return { project: state.project, files: state.files };
}

/** Run `work`, turning a throw into `{ ok: false, error }` for the renderer. */
async function outcome<T>(work: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: (error as Error).message ?? String(error) };
  }
}

function registerIpc(): void {
  ipcMain.handle(Channel.projectCurrent, async (event) => {
    const state = stateOf(event.sender);
    await state.opening;
    return state.project;
  });
  ipcMain.handle(Channel.projectRecent, () => readRecent());
  ipcMain.handle(Channel.projectDismissSync, async (event) => {
    const state = stateOf(event.sender);
    const { project } = await requireProject(state);
    await dismissSync(project.dir);
    state.project = { ...project, synced: null };
  });
  ipcMain.handle(Channel.projectOpen, (event, dir: string) => openFromWindow(stateOf(event.sender), dir));
  ipcMain.handle(Channel.projectOpenFolder, async (event): Promise<OpenOutcome> => {
    const state = stateOf(event.sender);
    const dir = await pickFolder(state.window);
    return dir ? openFromWindow(state, dir) : { status: "cancelled" };
  });
  ipcMain.handle(Channel.projectInit, async (event, dir: string): Promise<OpenOutcome> => {
    try {
      await daemon.request("project.init", { dir });
    } catch (error) {
      return { status: "error", message: (error as Error).message };
    }
    return openFromWindow(stateOf(event.sender), dir);
  });

  ipcMain.handle(Channel.projectTakeOffered, (event) => {
    const state = stateOf(event.sender);
    const plan = state.offered;
    state.offered = null;
    return plan;
  });
  ipcMain.handle(Channel.projectChooseVideos, (event) =>
    outcome(async () => {
      const files = await pickVideos(stateOf(event.sender).window);
      return files.length > 0 ? planVideoProject(files) : null;
    }),
  );
  ipcMain.handle(Channel.projectPlanVideos, (_event, files: string[], place?: { parent?: string; name?: string }) =>
    outcome(async () => {
      const { accepted, refused } = await partitionFiles(files, VIDEO_EXTENSIONS);
      return { plan: accepted.length > 0 ? await planVideoProject(accepted, place) : null, refused };
    }),
  );
  ipcMain.handle(Channel.projectChooseParent, async (event) => {
    const result = await dialog.showOpenDialog(stateOf(event.sender).window, {
      title: "Choose where the project goes",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(
    Channel.projectFromVideos,
    (event, plan: Pick<VideoProjectPlan, "files" | "parent" | "name">, mode: "copy" | "link", options?: { transcribe?: boolean }) =>
      createFromVideos(stateOf(event.sender), plan, mode === "link" ? "link" : "copy", options?.transcribe === true),
  );
  ipcMain.handle(Channel.projectSetup, async (event) => {
    const { project } = await requireProject(stateOf(event.sender));
    return setups.get(project.dir) ?? null;
  });

  ipcMain.handle(Channel.mediaImport, (event, paths: string[]) =>
    outcome(async () => {
      const { project } = await requireProject(stateOf(event.sender));
      const { accepted, refused } = await partitionFiles(paths, MEDIA_EXTENSIONS);
      if (accepted.length === 0) return { imported: [], refused };
      const result = await daemon.request("asset.import", { cwd: project.dir, files: accepted, mode: "copy" });
      return { imported: result.imported.map((item) => item.asset), refused };
    }),
  );

    ipcMain.handle(Channel.filesTree, async (event) => (await requireProject(stateOf(event.sender))).files.tree());
  ipcMain.handle(Channel.filesRead, async (event, path: string) =>
    (await requireProject(stateOf(event.sender))).files.read(path),
  );
  ipcMain.handle(Channel.filesWrite, async (event, path: string, content: string) => {
    try {
      const { project } = await requireProject(stateOf(event.sender));
      // A timeline save is a `ui` operation: it must not join an open nudge burst's transaction.
      await editor.alone(() => daemon.request("file.write", { path: join(project.dir, path), content }));
      return {};
    } catch (error) {
      return { error: (error as Error).message };
    }
  });

  ipcMain.handle(Channel.terminalCreate, async (event, size: { cols: number; rows: number }) => {
    const state = stateOf(event.sender);
    const { project } = await requireProject(state);
    const session = `term-${randomBytes(4).toString("hex")}`;
    const launch = terminalLaunch({
      platform: process.platform,
      env: process.env,
      projectDir: project.dir,
      socketPath,
      session,
      binDir,
      tools: await terminalToolPaths(binaries, project.dir),
    });
    const { id, shell: shellName } = state.terminals.create(launch, size);
    return { id, session, shell: shellName };
  });
  ipcMain.handle(Channel.terminalAttach, (event, id: string) => stateOf(event.sender).terminals.attach(id));
  ipcMain.on(Channel.terminalWrite, (event, id: string, data: string) => stateOf(event.sender).terminals.write(id, data));
  ipcMain.on(Channel.terminalResize, (event, id: string, cols: number, rows: number) =>
    stateOf(event.sender).terminals.resize(id, cols, rows),
  );
  ipcMain.on(Channel.terminalKill, (event, id: string) => stateOf(event.sender).terminals.kill(id));

  ipcMain.handle(Channel.timelineShow, (event, timeline: string) =>
    outcome(async () => {
      const { project } = await requireProject(stateOf(event.sender));
      return daemon.request("timeline.show", { cwd: project.dir, timeline });
    }),
  );
  ipcMain.handle(Channel.timelineEdit, (event, timeline: string, edits: TimelineEdit[], options?: EditOptions) =>
    outcome(async () => editor.apply((await requireProject(stateOf(event.sender))).project.dir, timeline, edits, options ?? {})),
  );
  ipcMain.handle(Channel.timelineUndo, (event, timeline: string) =>
    outcome(async () => editor.undo((await requireProject(stateOf(event.sender))).project.dir, timeline)),
  );
  ipcMain.handle(Channel.timelineRedo, (event, timeline: string) =>
    outcome(async () => editor.redo((await requireProject(stateOf(event.sender))).project.dir, timeline)),
  );
  ipcMain.handle(Channel.historyList, (event, timeline: string) =>
    outcome(async () => daemon.request("history", { cwd: (await requireProject(stateOf(event.sender))).project.dir, timeline })),
  );
  ipcMain.handle(Channel.historyDiff, (event, timeline: string, target: string) =>
    outcome(async () =>
      daemon.request("history.diff", { cwd: (await requireProject(stateOf(event.sender))).project.dir, timeline, target }),
    ),
  );
  ipcMain.handle(Channel.historyRevert, (event, timeline: string, target: string) =>
    outcome(async () => editor.revert((await requireProject(stateOf(event.sender))).project.dir, timeline, target)),
  );
  ipcMain.on(Channel.uiPublish, (event, view: UiView) => {
    const { project } = stateOf(event.sender);
    if (project) ui.publish(String(event.sender.id), project.dir, view);
  });
  ipcMain.on(Channel.uiReply, (event, id: string, error: string | null, view: UiView) =>
    ui.reply(String(event.sender.id), id, error, view),
  );
  ipcMain.handle(Channel.mediaAssets, (event) =>
    outcome(async () => {
      const { project } = await requireProject(stateOf(event.sender));
      return (await daemon.request("asset.list", { cwd: project.dir })).assets;
    }),
  );
  ipcMain.handle(Channel.clipsRenders, (event, timeline: string) =>
    outcome(async () => daemon.request("clip.renders", { cwd: (await requireProject(stateOf(event.sender))).project.dir, timeline })),
  );
  ipcMain.handle(Channel.clipsLive, (event, timeline: string, clip: string) =>
    outcome(async (): Promise<LiveClipPage> => {
      const state = stateOf(event.sender);
      const { project } = await requireProject(state);
      const page = await daemon.request("clip.live", { cwd: project.dir, timeline, clip });
      // The project may have changed while the daemon answered: never serve a page of a project the window left.
      if (state.project !== project) throw new Error("The project changed while its live page loaded");
      const url = livePages.issue({ project: project.dir, root: page.root, entry: page.entry, head: page.head });
      const previous = state.live.get(clip);
      if (previous) livePages.revoke(previous);
      state.live.set(clip, url);
      return { url, key: page.key };
    }),
  );
  ipcMain.handle(Channel.mediaRead, (event, path: string) =>
    outcome(async () => (await requireProject(stateOf(event.sender))).files.readMedia(path)),
  );

  ipcMain.handle(Channel.contextWriteDetails, (event, name: string, content: string) =>
    outcome(async () => {
      const { project } = await requireProject(stateOf(event.sender));
      return (await daemon.request("context.write", { cwd: project.dir, name, content })).path;
    }),
  );
  ipcMain.handle(Channel.contextCaptureFrame, (event, at: number) =>
    outcome(async () =>
      captureContextFrame((method, params) => daemon.request(method, params), (await requireProject(stateOf(event.sender))).project.dir, at),
    ),
  );

  ipcMain.handle(Channel.layoutLoad, async (event): Promise<Layout> => {
    const state = stateOf(event.sender);
    await state.opening;
    return state.project ? layouts.load(state.project.dir) : normalizeLayout(undefined);
  });
  ipcMain.on(Channel.layoutSave, (event, layout: unknown) => {
    const { project } = stateOf(event.sender);
    if (project) void layouts.save(project.dir, normalizeLayout(layout));
  });
  ipcMain.handle(Channel.panelsDetached, () => panelWindows.detached());
}

function buildMenu(): void {
  const openFolder = async () => {
    const state = projectWindowOf(BrowserWindow.getFocusedWindow());
    if (!state) {
      createWindow();
      return;
    }
    const dir = await pickFolder(state.window);
    if (dir) await openFromWindow(state, dir);
  };
  // Aimed at the focused window (as the menu click reports it): each window has its own project and editor tabs.
  // A detached panel's window is its project's.
  const command = (name: MenuCommand, focused: BaseWindow | undefined) => {
    const state = projectWindowOf(focused ?? BrowserWindow.getFocusedWindow());
    if (state) send(state.window.webContents, Channel.menuCommand, name);
  };
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        { label: "Open Folder…", accelerator: "CmdOrCtrl+O", click: () => void openFolder() },
        { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: () => createWindow() },
        { type: "separator" },
        { label: "Install 'frameshell' Command in PATH", click: () => void cliCommand(installCli) },
        { label: "Uninstall 'frameshell' Command from PATH", click: () => void cliCommand(uninstallCli) },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    editMenu(process.platform, (history: HistoryCommand, focused) => {
      // No focused window (app in the background, a test driving the menu): the only project window, if there is just one.
      const all = [...windows.values()];
      const target = projectWindowOf(focused ?? BrowserWindow.getFocusedWindow()) ?? (all.length === 1 ? all[0] : undefined);
      if (target) send(target.window.webContents, Channel.timelineHistoryCommand, history);
    }),
    {
      label: "View",
      submenu: [
        { id: "view-transcript", label: "Transcript", accelerator: "CmdOrCtrl+Shift+T", click: (_item, focused) => command("showTranscript", focused) },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Runs the File menu's install or uninstall of the system-wide CLI (#139) and reports the outcome in a message box. */
async function cliCommand(action: (shim: string, host: CliInstallHost) => Promise<CliInstallOutcome>) {
  const parent = BrowserWindow.getFocusedWindow() ?? undefined;
  const box = (options: Electron.MessageBoxOptions) =>
    parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  const host = systemCliInstallHost({
    home: homedir(),
    confirmReplace: async (link, target) =>
      (
        await box({
          type: "question",
          message: `Replace the existing 'frameshell' command?`,
          detail: `${link} points at ${target}, which another install put there.`,
          buttons: ["Replace", "Cancel"],
          defaultId: 0,
          cancelId: 1,
        })
      ).response === 0,
  });
  const blocker = action === installCli ? cliInstallBlocker(process.platform, process.execPath, process.env) : undefined;
  if (blocker) {
    await box({ type: "warning", message: "Cannot install the 'frameshell' command from here.", detail: blocker });
    return;
  }
  try {
    const outcome = await action(cliShim, host);
    await box({ type: "info", message: outcome.message, ...(outcome.detail ? { detail: outcome.detail } : {}) });
  } catch (error) {
    await box({ type: "error", message: "Could not change the 'frameshell' command.", detail: (error as Error).message });
  }
}

function projectArg(argv: string[]): string | undefined {
  const index = argv.indexOf("--project");
  if (index !== -1) return argv[index + 1];
  return argv.find((arg) => arg.startsWith("--project="))?.slice("--project=".length);
}

app.whenReady().then(async () => {
  if (!primary) return;
  const cliEntry = fileURLToPath(import.meta.resolve("@frameshell/cli/frameshell"));
  await writeCliShim(binDir, { runtime: process.execPath, cliEntry });
  protocol.handle(MEDIA_SCHEME, (request) => serveMedia(request, mediaRoots));
  protocol.handle(LIVE_SCHEME, (request) => serveLive(request, livePages));
  await panelWindows.load();
  registerIpc();
  buildMenu();
  const startDir = projectArg(process.argv);
  const opened = [...launchPaths(process.argv, app.isPackaged ? 1 : 2, process.cwd()), ...earlyOpens];
  ready = true;
  if (startDir || opened.length === 0) createWindow(startDir);
  if (opened.length > 0) await openPaths(opened);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => (quitting = true));

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/** The quit already waited for {@link TimelineEditor.settle}: the next `will-quit` closes the daemon link and lets the app exit. */
let editorSettled = false;

app.on("will-quit", (event) => {
  if (exitingShells.size > 0) {
    // Quit once closed windows' shells are gone: see TerminalManager.killAll.
    event.preventDefault();
    void Promise.all(exitingShells).then(() => app.quit());
    return;
  }
  if (editorSettled) {
    daemon.close();
    return;
  }
  // Wait, up to 500 ms, for an open nudge burst's transaction to commit; the daemon's auto-commit covers one that outruns it.
  event.preventDefault();
  const settled = Promise.race([editor.settle().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 500))]);
  void settled.then(() => {
    editorSettled = true;
    // Next task, not this one: with nothing to settle this runs while Electron still handles the prevented quit,
    // which ignores a nested `app.quit()` and leaves the app running.
    setImmediate(() => app.quit());
  });
});
