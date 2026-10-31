// Bridge: the only surface the sandboxed renderer gets. Mirrors `FrameshellApi`.
import { type IpcRendererEvent, contextBridge, ipcRenderer, webUtils } from "electron";
import { Channel, type FrameshellApi, type Outcome } from "../shared/api.js";

function subscribe<A extends unknown[]>(channel: string, listener: (...args: A) => void): () => void {
  const handler = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...(args as A));
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

/** Invoke a handler replying {@link Outcome}; rethrow its message as a plain Error. */
async function invokeOutcome<T>(channel: string, ...args: unknown[]): Promise<T> {
  const reply = (await ipcRenderer.invoke(channel, ...args)) as Outcome<T>;
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

const api: FrameshellApi = {
  // Synchronous: the renderer's modules read the language as they load.
  lang: ipcRenderer.sendSync(Channel.lang) as FrameshellApi["lang"],
  project: {
    current: () => ipcRenderer.invoke(Channel.projectCurrent),
    openFolder: () => ipcRenderer.invoke(Channel.projectOpenFolder),
    open: (dir) => ipcRenderer.invoke(Channel.projectOpen, dir),
    init: (dir) => ipcRenderer.invoke(Channel.projectInit, dir),
    recent: () => ipcRenderer.invoke(Channel.projectRecent),
    forgetRecent: (dir) => ipcRenderer.invoke(Channel.projectForgetRecent, dir),
    revealRecent: (dir) => ipcRenderer.invoke(Channel.projectRevealRecent, dir),
    dismissSyncWarning: () => ipcRenderer.invoke(Channel.projectDismissSync),
    chooseVideos: () => invokeOutcome(Channel.projectChooseVideos),
    planVideos: (files, place) => invokeOutcome(Channel.projectPlanVideos, files, place),
    chooseParent: () => ipcRenderer.invoke(Channel.projectChooseParent),
    imageFromFrame: (timeline, at) => invokeOutcome(Channel.projectImageFromFrame, timeline, at),
    takeOffered: () => ipcRenderer.invoke(Channel.projectTakeOffered),
    onVideosOffered: (listener) => subscribe(Channel.projectVideosOffered, listener),
    fromVideos: (plan, mode, options) => ipcRenderer.invoke(Channel.projectFromVideos, plan, mode, options),
    setup: () => ipcRenderer.invoke(Channel.projectSetup),
    onSetup: (listener) => subscribe(Channel.projectSetupChanged, listener),
  },
  files: {
    tree: () => ipcRenderer.invoke(Channel.filesTree),
    read: (path) => ipcRenderer.invoke(Channel.filesRead, path),
    // Main replies `{ error }` instead of throwing: Electron would wrap the message in IPC noise.
    write: async (path, content) => {
      const reply = (await ipcRenderer.invoke(Channel.filesWrite, path, content)) as { error?: string };
      if (reply.error) throw new Error(reply.error);
    },
    onChanged: (listener) => subscribe(Channel.filesChanged, listener),
    trash: (path) => invokeOutcome(Channel.filesTrash, path),
    reveal: (path) => ipcRenderer.invoke(Channel.filesReveal, path),
    copyPath: (path) => ipcRenderer.invoke(Channel.filesCopyPath, path),
    pathOf: (file) => webUtils.getPathForFile(file),
  },
  terminals: {
    create: (size) => ipcRenderer.invoke(Channel.terminalCreate, size),
    attach: (id) => ipcRenderer.invoke(Channel.terminalAttach, id),
    write: (id, data) => ipcRenderer.send(Channel.terminalWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(Channel.terminalResize, id, cols, rows),
    kill: (id) => ipcRenderer.send(Channel.terminalKill, id),
    onData: (listener) => subscribe(Channel.terminalData, listener),
    onExit: (listener) => subscribe(Channel.terminalExit, listener),
    onAgent: (listener) => subscribe(Channel.terminalAgent, listener),
  },
  layout: {
    load: () => ipcRenderer.invoke(Channel.layoutLoad),
    save: (layout) => ipcRenderer.send(Channel.layoutSave, layout),
  },
  panels: {
    detached: () => ipcRenderer.invoke(Channel.panelsDetached),
  },
  timeline: {
    show: (timeline, view) => invokeOutcome(Channel.timelineShow, timeline, view),
    onChanged: (listener) => subscribe(Channel.timelineChanged, listener),
    onRejected: (listener) => subscribe(Channel.timelineRejected, listener),
    edit: (timeline, edits, options) => invokeOutcome(Channel.timelineEdit, timeline, edits, options),
    replaceImage: (timeline, clip) => invokeOutcome(Channel.timelineReplaceImage, timeline, clip),
    addLayers: (timeline, assets) => invokeOutcome(Channel.timelineAddLayers, timeline, assets),
    cutOut: (timeline, clip, mask) => invokeOutcome(Channel.timelineCutOut, timeline, clip, mask),
    exportImage: (timeline) => invokeOutcome(Channel.timelineExportImage, timeline),
    settle: () => invokeOutcome(Channel.timelineSettle),
    undo: (timeline) => invokeOutcome(Channel.timelineUndo, timeline),
    redo: (timeline) => invokeOutcome(Channel.timelineRedo, timeline),
    onHistoryCommand: (listener) => subscribe(Channel.timelineHistoryCommand, listener),
  },
  history: {
    list: (timeline) => invokeOutcome(Channel.historyList, timeline),
    diff: (timeline, target) => invokeOutcome(Channel.historyDiff, timeline, target),
    revert: (timeline, target) => invokeOutcome(Channel.historyRevert, timeline, target),
  },
  review: {
    status: () => invokeOutcome(Channel.reviewStatus),
    setEnabled: (enabled) => invokeOutcome(Channel.reviewSet, enabled),
    accept: (tx) => invokeOutcome(Channel.reviewAccept, tx),
    reject: (tx) => invokeOutcome(Channel.reviewReject, tx),
    diff: () => invokeOutcome(Channel.reviewDiff),
    onChanged: (listener) => subscribe(Channel.reviewChanged, listener),
  },
  agents: {
    detect: () => ipcRenderer.invoke(Channel.agentsDetect),
    installCli: () => ipcRenderer.invoke(Channel.agentsInstallCli),
    claudeDesktop: () => ipcRenderer.invoke(Channel.agentsClaudeDesktop),
    connectClaudeDesktop: () => ipcRenderer.invoke(Channel.agentsConnectClaudeDesktop),
    disconnectClaudeDesktop: () => ipcRenderer.invoke(Channel.agentsDisconnectClaudeDesktop),
  },
  menu: {
    onCommand: (listener) => subscribe(Channel.menuCommand, listener),
  },
  ui: {
    publish: (state) => ipcRenderer.send(Channel.uiPublish, state),
    onCommand: (listener) => subscribe(Channel.uiCommand, listener),
    reply: (id, error, state) => ipcRenderer.send(Channel.uiReply, id, error, state),
  },
  media: {
    assets: () => invokeOutcome(Channel.mediaAssets),
    read: (path) => invokeOutcome(Channel.mediaRead, path),
    onChanged: (listener) => subscribe(Channel.mediaChanged, listener),
    import: (paths) => invokeOutcome(Channel.mediaImport, paths),
  },
  context: {
    captureFrame: (at) => invokeOutcome(Channel.contextCaptureFrame, at),
    writeDetails: (name, content) => invokeOutcome(Channel.contextWriteDetails, name, content),
  },
  segment: {
    prepare: (assets) => invokeOutcome(Channel.segmentPrepare, assets),
    point: (at, x, y) => invokeOutcome(Channel.segmentPoint, at, x, y),
    onProgress: (listener) => subscribe(Channel.segmentProgress, listener),
  },
  clips: {
    renders: (timeline) => invokeOutcome(Channel.clipsRenders, timeline),
    onJob: (listener) => subscribe(Channel.clipsJob, listener),
    live: (timeline, clip) => invokeOutcome(Channel.clipsLive, timeline, clip),
  },
  multicam: {
    turns: (timeline, group) => invokeOutcome(Channel.multicamTurns, timeline, group),
  },
  people: {
    list: () => invokeOutcome(Channel.peopleList),
    add: (name) => invokeOutcome(Channel.peopleAdd, name),
    rename: (person, name) => invokeOutcome(Channel.peopleRename, person, name),
    remove: (person) => invokeOutcome(Channel.peopleRemove, person),
    link: (person, target) => invokeOutcome(Channel.peopleLink, person, target),
    unlink: (person, target) => invokeOutcome(Channel.peopleUnlink, person, target),
    scan: () => invokeOutcome(Channel.peopleScan),
    suggest: (download) => invokeOutcome(Channel.peopleSuggest, download === true),
    confirm: (suggestions, options) => invokeOutcome(Channel.peopleConfirm, suggestions, options ?? {}),
    ranges: (person, kind) => invokeOutcome(Channel.peopleRanges, person, kind),
    onChanged: (listener) => subscribe(Channel.peopleChanged, listener),
    onScan: (listener) => subscribe(Channel.peopleScanJob, listener),
    onSuggestProgress: (listener) => subscribe(Channel.peopleSuggestProgress, listener),
  },
  shoot: {
    support: () => invokeOutcome(Channel.shootSupport),
    screens: () => invokeOutcome(Channel.shootScreens),
    pickScreen: (id, systemAudio) => invokeOutcome(Channel.shootPickScreen, id, systemAudio),
    begin: (sources) => invokeOutcome(Channel.shootBegin, sources),
    started: (id, starts) => invokeOutcome(Channel.shootStarted, id, starts),
    chunk: (id, role, data) => invokeOutcome(Channel.shootChunk, id, role, data),
    end: (id) => invokeOutcome(Channel.shootEnd, id),
    recovered: () => invokeOutcome(Channel.shootRecovered),
    onRecovered: (listener) => subscribe(Channel.shootRecoveredChanged, listener),
    cut: (id, take) => invokeOutcome(Channel.shootCut, id, take),
    check: (script) => invokeOutcome(Channel.shootCheck, script),
    status: (script) => invokeOutcome(Channel.shootStatus, script),
    accept: (script, take, options) => invokeOutcome(Channel.shootAccept, script, take, options ?? {}),
    choose: (script, scene, take) => invokeOutcome(Channel.shootChoose, script, scene, take),
    assemble: (script) => invokeOutcome(Channel.shootAssemble, script),
    onChanged: (listener) => subscribe(Channel.shootChanged, listener),
    liveWarm: (install) => ipcRenderer.invoke(Channel.shootLiveWarm, install === true),
    liveAudio: (samples) => ipcRenderer.send(Channel.shootLiveAudio, samples),
    liveReset: () => ipcRenderer.send(Channel.shootLiveReset),
    onLiveStatus: (listener) => subscribe(Channel.shootLiveStatus, listener),
    onLiveHeard: (listener) => subscribe(Channel.shootLiveHeard, listener),
  },
  scripts: {
    outline: (file) => invokeOutcome(Channel.scriptsOutline, file),
  },
  updates: {
    status: () => ipcRenderer.invoke(Channel.updatesStatus),
    onStatus: (listener) => subscribe(Channel.updatesChanged, listener),
    restart: () => ipcRenderer.send(Channel.updatesRestart),
    dismiss: () => ipcRenderer.send(Channel.updatesDismiss),
  },
};

contextBridge.exposeInMainWorld("frameshell", api);
