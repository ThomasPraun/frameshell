// The one "Connect your AI" panel's state, outside the view: it opens from the title bar, the welcome screen and the
// agent guide (which may sit in a detached terminal window), and reads the apps' settings again on every open.
import type { AiAppChange, AiAppId, AiApps } from "../../../shared/api.js";
import type { LastChange } from "./model.js";

/** What the panel shows. */
export interface ConnectState {
  /** Window the panel shows in: the project window, or a detached panel's (ADR 0012). */
  view: Window;
  /** Null while reading. */
  apps: AiApps | null;
  /** Apps with a change under way. */
  working: readonly AiAppId[];
  last: Partial<Record<AiAppId, LastChange>>;
}

let current: ConnectState | null = null;
/** Identifies the panel being shown: an answer that arrives after it closed is dropped. */
let session = 0;
const listeners = new Set<() => void>();

function publish(next: ConnectState | null): void {
  current = next;
  for (const listener of listeners) listener();
}

function read(id: number): void {
  void window.frameshell.agents.apps().then((apps) => {
    if (id === session && current) publish({ ...current, apps });
  });
}

/** The panel's actions; {@link connectPanel.get} is what it shows. */
export const connectPanel = {
  /** Open the panel in `view`, the window it was asked from, reading every app's settings. */
  open(view: Window = window): void {
    const id = ++session;
    publish({ view, apps: null, working: [], last: {} });
    if (view !== window) view.addEventListener("pagehide", () => id === session && current && publish({ ...current, view: window }), { once: true });
    read(id);
  },

  /** Read the settings again ("Check again"), forgetting the notes of earlier changes. */
  refresh(): void {
    if (!current) return;
    publish({ ...current, apps: null, last: {} });
    read(session);
  },

  /** Connect (or disconnect) app `id`; the card shows the state after, and what to do next. */
  async change(id: AiAppId, connect: boolean): Promise<void> {
    if (!current || current.working.includes(id)) return;
    const mine = session;
    publish({ ...current, working: [...current.working, id] });
    const agents = window.frameshell.agents;
    let change: AiAppChange | null = null;
    let failure: string | null = null;
    try {
      change = await (connect ? agents.connect(id) : agents.disconnect(id));
    } catch (error) {
      failure = (error as Error).message ?? String(error);
    }
    if (mine !== session || !current) return;
    const working = current.working.filter((other) => other !== id);
    const before = current.apps?.apps.find((app) => app.id === id);
    if (!change && before) change = { status: before, backups: [], problem: { kind: "failed", message: failure ?? "" } };
    if (!change) return publish({ ...current, working });
    const status = change.status;
    const apps = current.apps && { ...current.apps, apps: current.apps.apps.map((app) => (app.id === id ? status : app)) };
    publish({ ...current, apps, working, last: { ...current.last, [id]: { connect, change } } });
  },

  close(): void {
    if (!current) return;
    session++;
    publish(null);
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: (): ConnectState | null => current,
};
