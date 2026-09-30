// Electron main: windows, IPC, terminals, explorer watcher, daemon link (SPEC §3.2).
// Env: FRAMESHELL_DATA_DIR / FRAMESHELL_CONFIG_DIR isolate user dirs (tests); FRAMESHELL_SOCKET picks the daemon.
// Args: --project <dir> opens that folder at startup.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, Menu, type WebContents, app, dialog, ipcMain, shell } from "electron";
import { resolveAppDirs, resolveSocketPath } from "@frameshell/protocol";
import { Channel, type OpenOutcome, type Outcome, type ProjectView, type TimelineChange } from "../shared/api.js";
import { type Layout, normalizeLayout } from "../shared/layout.js";
import { writeCliShim } from "./cli-shim.js";
import { DaemonLink, type LinkSubscription } from "./daemon-link.js";
import { LayoutStore } from "./layout-store.js";
import { type ProjectFiles, openProjectFiles } from "./project-files.js";
import { terminalLaunch } from "./terminal-launch.js";
import { TerminalManager } from "./terminals.js";

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
const layouts = new LayoutStore(join(app.getPath("userData"), "layouts"));
const binDir = join(app.getPath("userData"), "bin");
const recentFile = join(app.getPath("userData"), "recent.json");
const MAX_RECENT = 10;

/** Per-window state; a window shows at most one project. */
interface WindowState {
  window: BrowserWindow;
  project: ProjectView | null;
  files: ProjectFiles | null;
  /** Daemon `timeline.changed` of the shown project, forwarded to the renderer. */
  timelineEvents: LinkSubscription | null;
  terminals: TerminalManager;
}
const windows = new Map<number, WindowState>();

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
    timelineEvents: null,
    terminals: new TerminalManager({
      onData: (id, data) => send(contents, Channel.terminalData, id, data),
      onExit: (id, code) => send(contents, Channel.terminalExit, id, code),
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
    state.terminals.killAll();
    void state.files?.close();
    void state.timelineEvents?.unsubscribe();
    windows.delete(contents.id);
  });

  const load = async () => {
    if (projectDir) await openInWindow(state, projectDir);
    const devUrl = process.env["ELECTRON_RENDERER_URL"];
    if (devUrl) await window.loadURL(devUrl);
    else await window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  };
  load().catch((error: unknown) => dialog.showErrorBox("Frameshell", String((error as Error)?.message ?? error)));
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
  };
  await state.files?.close();
  await state.timelineEvents?.unsubscribe();
  const contents = state.window.webContents;
  state.files = await openProjectFiles(project.dir, (paths) => send(contents, Channel.filesChanged, paths));
  // Subscribed before the renderer first reads the timeline, so no change falls in between.
  state.timelineEvents = await daemon
    .subscribe("timeline.changed", project.dir, {
      onEvent: ({ timeline, revision, author }) =>
        send(contents, Channel.timelineChanged, { timeline, revision, author } satisfies TimelineChange),
      onResync: () => send(contents, Channel.timelineChanged, { timeline: null } satisfies TimelineChange),
    })
    .catch(() => null); // Daemon unreachable: the timeline still follows file changes.
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

function requireProject(state: WindowState): { project: ProjectView; files: ProjectFiles } {
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
  ipcMain.handle(Channel.projectCurrent, (event) => stateOf(event.sender).project);
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

  ipcMain.handle(Channel.filesTree, (event) => requireProject(stateOf(event.sender)).files.tree());
  ipcMain.handle(Channel.filesRead, (event, path: string) => requireProject(stateOf(event.sender)).files.read(path));
  ipcMain.handle(Channel.filesWrite, async (event, path: string, content: string) => {
    try {
      const { project } = requireProject(stateOf(event.sender));
      await daemon.request("file.write", { path: join(project.dir, path), content });
      return {};
    } catch (error) {
      return { error: (error as Error).message };
    }
  });

  ipcMain.handle(Channel.terminalCreate, (event, size: { cols: number; rows: number }) => {
    const state = stateOf(event.sender);
    const { project } = requireProject(state);
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
      const { project } = requireProject(stateOf(event.sender));
      return daemon.request("timeline.show", { cwd: project.dir, timeline });
    }),
  );
  ipcMain.handle(Channel.mediaAssets, (event) =>
    outcome(async () => {
      const { project } = requireProject(stateOf(event.sender));
      return (await daemon.request("asset.list", { cwd: project.dir })).assets;
    }),
  );
  ipcMain.handle(Channel.mediaRead, (event, path: string) =>
    outcome(async () => requireProject(stateOf(event.sender)).files.readMedia(path)),
  );

  ipcMain.handle(Channel.layoutLoad, (event): Promise<Layout> => {
    const { project } = stateOf(event.sender);
    return project ? layouts.load(project.dir) : Promise.resolve(normalizeLayout(undefined));
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
    { role: "viewMenu" },
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

app.on("will-quit", () => {
  void daemon.close();
});
