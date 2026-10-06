// Electron main: windows, IPC, terminals, explorer watcher, daemon link (SPEC §3.2).
// Env: FRAMESHELL_DATA_DIR / FRAMESHELL_CONFIG_DIR isolate user dirs (tests); FRAMESHELL_SOCKET picks the daemon;
// FRAMESHELL_PREVIEW_PROBE=1 exposes preview measurement hooks (ADR 0001 harness) and keeps hidden windows at full rate.
// Args: --project <dir> opens that folder at startup.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, Menu, type WebContents, app, dialog, ipcMain, protocol, shell } from "electron";
import { resolveAppDirs, resolveSocketPath } from "@frameshell/protocol";
import type { TimelineRejection, UiView } from "@frameshell/protocol";
import {
  type AssetChange,
  Channel,
  type MenuCommand,
  type OpenOutcome,
  type Outcome,
  type ProjectView,
  type TimelineChange,
  type TimelineEdit,
} from "../shared/api.js";
import { type Layout, normalizeLayout } from "../shared/layout.js";
import { writeCliShim } from "./cli-shim.js";
import { captureContextFrame } from "./context-frames.js";
import { DaemonLink, type LinkSubscription } from "./daemon-link.js";
import { LayoutStore } from "./layout-store.js";
import { MEDIA_SCHEME, MediaRoots, serveMedia } from "./media-protocol.js";
import { type ProjectFiles, openProjectFiles } from "./project-files.js";
import { terminalLaunch } from "./terminal-launch.js";
import { TimelineEditor } from "./timeline-editor.js";
import { TerminalManager } from "./terminals.js";
import { UiBridge } from "./ui-bridge.js";

// One resolver for all user-level storage: Electron state (Chromium profile, layouts, recents, CLI shim) is data.
app.setPath("userData", join(resolveAppDirs(process.env).dataDir, "desktop"));

const APP_VERSION = app.getVersion();
const socketPath = resolveSocketPath(process.env);
// Spawning the daemon reuses process.execPath (Electron): run it as plain Node.
const daemon = new DaemonLink({
  socketPath,
  client: `desktop/${APP_VERSION}`,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
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
const binDir = join(app.getPath("userData"), "bin");
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

// Before ready: fetch() from renderer workers, range streaming and CORS need a privileged scheme.
protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
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
  /**
   * The `--project` open started with the window. The page loads meanwhile (a cold daemon can take many seconds)
   * and `project.current` awaits this, so the renderer shows its boot screen, never a premature welcome screen.
   */
  opening: Promise<unknown>;
}
const windows = new Map<number, WindowState>();
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
    },
  });
  const contents = window.webContents;
  const state: WindowState = {
    window,
    project: null,
    files: null,
    daemonEvents: [],
    opening: Promise.resolve(),
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

  // Links (xterm web links) open in the browser; the app window never navigates away.
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    const exiting = state.terminals.killAll();
    exitingShells.add(exiting);
    void exiting.then(() => exitingShells.delete(exiting));
    void state.files?.close();
    for (const subscription of state.daemonEvents) void subscription.unsubscribe();
    if (state.project) mediaRoots.revoke(state.project.mediaUrl);
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
  state.project = project;
  state.window.setTitle(`${project.name} — Frameshell`);
  await rememberRecent(project.dir);
  return { status: "opened", project };
}

/** Window to open a folder in: this one while it shows the welcome screen, else a new one. */
async function openFromWindow(state: WindowState, dir: string): Promise<OpenOutcome> {
  if (!state.project) return openInWindow(state, dir);
  const existing = [...windows.values()].find((other) => other.project?.dir === dir);
  if (existing) existing.window.focus();
  else createWindow(dir);
  return { status: "cancelled" };
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

function stateOf(sender: WebContents): WindowState {
  const state = windows.get(sender.id);
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

  ipcMain.handle(Channel.filesTree, async (event) => (await requireProject(stateOf(event.sender))).files.tree());
  ipcMain.handle(Channel.filesRead, async (event, path: string) =>
    (await requireProject(stateOf(event.sender))).files.read(path),
  );
  ipcMain.handle(Channel.filesWrite, async (event, path: string, content: string) => {
    try {
      const { project } = await requireProject(stateOf(event.sender));
      await daemon.request("file.write", { path: join(project.dir, path), content });
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
    });
    const { id, shell: shellName } = state.terminals.create(launch, size);
    return { id, session, shell: shellName };
  });
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
  ipcMain.handle(Channel.timelineEdit, (event, timeline: string, edits: TimelineEdit[]) =>
    outcome(async () => editor.apply((await requireProject(stateOf(event.sender))).project.dir, timeline, edits)),
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
  ipcMain.handle(Channel.mediaRead, (event, path: string) =>
    outcome(async () => (await requireProject(stateOf(event.sender))).files.readMedia(path)),
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
}

function buildMenu(): void {
  const openFolder = async () => {
    const focused = BrowserWindow.getFocusedWindow();
    const state = focused ? windows.get(focused.webContents.id) : undefined;
    if (!state) {
      createWindow();
      return;
    }
    const dir = await pickFolder(state.window);
    if (dir) await openFromWindow(state, dir);
  };
  // Aimed at the focused window: each window has its own project and editor tabs.
  const command = (name: MenuCommand) => BrowserWindow.getFocusedWindow()?.webContents.send(Channel.menuCommand, name);
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        { label: "Open Folder…", accelerator: "CmdOrCtrl+O", click: () => void openFolder() },
        { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: () => createWindow() },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    // Edit roles make copy/paste work in xterm and Monaco on macOS.
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Transcript", accelerator: "CmdOrCtrl+Shift+T", click: () => command("showTranscript") },
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

function projectArg(argv: string[]): string | undefined {
  const index = argv.indexOf("--project");
  if (index !== -1) return argv[index + 1];
  return argv.find((arg) => arg.startsWith("--project="))?.slice("--project=".length);
}

app.whenReady().then(async () => {
  const cliEntry = fileURLToPath(import.meta.resolve("@frameshell/cli/frameshell"));
  await writeCliShim(binDir, { runtime: process.execPath, cliEntry });
  protocol.handle(MEDIA_SCHEME, (request) => serveMedia(request, mediaRoots));
  registerIpc();
  buildMenu();
  createWindow(projectArg(process.argv));
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", (event) => {
  if (exitingShells.size > 0) {
    // Quit once closed windows' shells are gone: see TerminalManager.killAll.
    event.preventDefault();
    void Promise.all(exitingShells).then(() => app.quit());
    return;
  }
  void daemon.close();
});
