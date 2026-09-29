// Bridge: the only surface the sandboxed renderer gets. Mirrors `FrameshellApi`.
import { type IpcRendererEvent, contextBridge, ipcRenderer } from "electron";
import { Channel, type FrameshellApi } from "../shared/api.js";

function subscribe<A extends unknown[]>(channel: string, listener: (...args: A) => void): () => void {
  const handler = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...(args as A));
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const api: FrameshellApi = {
  project: {
    current: () => ipcRenderer.invoke(Channel.projectCurrent),
    openFolder: () => ipcRenderer.invoke(Channel.projectOpenFolder),
    open: (dir) => ipcRenderer.invoke(Channel.projectOpen, dir),
    init: (dir) => ipcRenderer.invoke(Channel.projectInit, dir),
    recent: () => ipcRenderer.invoke(Channel.projectRecent),
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
  },
  terminals: {
    create: (size) => ipcRenderer.invoke(Channel.terminalCreate, size),
    write: (id, data) => ipcRenderer.send(Channel.terminalWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(Channel.terminalResize, id, cols, rows),
    kill: (id) => ipcRenderer.send(Channel.terminalKill, id),
    onData: (listener) => subscribe(Channel.terminalData, listener),
    onExit: (listener) => subscribe(Channel.terminalExit, listener),
  },
  layout: {
    load: () => ipcRenderer.invoke(Channel.layoutLoad),
    save: (layout) => ipcRenderer.send(Channel.layoutSave, layout),
  },
};

contextBridge.exposeInMainWorld("frameshell", api);
