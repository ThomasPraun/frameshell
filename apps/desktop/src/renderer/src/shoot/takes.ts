// Takes of a shoot (ADR 0023, 0024): the shoot script the Shoot view records, its status, the current scene and the
// take being recorded (T opens one, C cuts it). One store per project renderer, like the recorder it drives.
import type { MethodResult, ShootStatusResult } from "@frameshell/protocol";
import { useSyncExternalStore } from "react";
import type { FileNode } from "../../../shared/api.js";
import { listenEverywhere } from "../windows.js";
import { shoot } from "./recorder.js";
import { currentScene, sceneAfter, takeKey } from "./takes-model.js";

/** Everything the Shoot view shows about takes. */
export interface TakesState {
  /** Shoot scripts of the project (`shoot: true`), project-relative; null until listed. */
  scripts: string[] | null;
  script: string | null;
  check: MethodResult<"script.check"> | null;
  status: ShootStatusResult | null;
  /** Scene the person picked as current; null follows `status.next`. */
  picked: string | null;
  /** The take being recorded: its start on the session clock and the scene it starts at. */
  open: { start: number; scene: string } | null;
  error: string | null;
}

/** Delay before a burst of `shoot.changed` events is read once, ms. */
const REFRESH_MS = 150;

/** Create a takes store. The app has one ({@link takes}). */
export function createTakes() {
  let state: TakesState = { scripts: null, script: null, check: null, status: null, picked: null, open: null, error: null };
  const listeners = new Set<() => void>();
  let mounted = 0;
  let initialized = false;
  let refreshTimer: number | undefined;
  let assembleWanted = false;
  const set = (next: Partial<TakesState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const api = () => window.frameshell.shoot;
  const message = (error: unknown) => (error as Error)?.message ?? String(error);

  async function listScripts(): Promise<void> {
    const tree = await window.frameshell.files.tree().catch(() => [] as FileNode[]);
    const scripts = tree.find((node) => node.kind === "dir" && node.name === "scripts");
    const files = scripts?.kind === "dir" ? flatten(scripts.children).filter((path) => path.endsWith(".md")) : [];
    const shoots: string[] = [];
    for (const file of files) {
      const check = await api().check(file).catch(() => null);
      if (check?.shoot.shoot) shoots.push(file);
    }
    set({ scripts: shoots });
    if (state.script === null && shoots.length > 0) await store.selectScript(shoots[0]!);
  }

  async function refresh(): Promise<void> {
    const script = state.script;
    if (!script) return;
    try {
      const [check, status] = await Promise.all([api().check(script), api().status(script)]);
      if (state.script === script) set({ check, status, error: null });
    } catch (error) {
      set({ error: message(error) });
    }
    if (assembleWanted && mounted > 0) {
      assembleWanted = false;
      // A take compared anew joins the first cut while the view is open (ADR 0024 decision 4).
      await api().assemble(script).catch((error: unknown) => set({ error: message(error) }));
    }
  }

  const scheduleRefresh = () => {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => void refresh(), REFRESH_MS);
  };

  const store = {
    /** Current state; the same object until it changes. */
    get: (): TakesState => state,
    /** Call `listener` after every change. Returns an unsubscribe function. */
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** A Shoot view mounted: list the shoot scripts the first time, and follow their changes. Returns its unmount. */
    mount(): () => void {
      mounted++;
      if (!initialized) {
        initialized = true;
        api().onChanged((change) => {
          if (change && change.script !== state.script) return;
          if (change?.change === "analyzed") assembleWanted = true;
          scheduleRefresh();
        });
        window.frameshell.files.onChanged((paths) => {
          if (paths.some((path) => path.startsWith("scripts/"))) void listScripts();
        });
        listenEverywhere("keydown", (event) => {
          if (!shoot.clock()) return;
          const key = takeKey(event);
          if (!key) return;
          event.preventDefault();
          void (key === "take" ? store.take() : store.cut());
        });
        shoot.setBeforeEnd(() => store.cut());
        void listScripts();
      } else void refresh();
      return () => {
        mounted--;
      };
    },

    async selectScript(script: string): Promise<void> {
      set({ script, check: null, status: null, picked: null });
      await refresh();
    },

    /** Make `scene` the one the next take starts at. */
    pick(scene: string | null): void {
      set({ picked: scene });
    },

    /** The scene after the current one becomes current. */
    nextScene(): void {
      const after = sceneAfter(state.status, currentScene(state.status, state.picked));
      if (after) set({ picked: after });
    },

    /** T: start a take at the current scene, cutting the open one first (record again). */
    async take(): Promise<void> {
      const scene = currentScene(state.status, state.picked);
      if (!state.script || scene === null) return;
      if (state.open) await store.cut();
      const clock = shoot.clock();
      if (!clock) return;
      // The scene stays current once recorded, also when it is done: only Next scene or a click moves on.
      set({ open: { start: clock.seconds, scene }, picked: scene });
    },

    /** C: end the open take; the daemon transcribes and compares it. */
    async cut(): Promise<void> {
      const open = state.open;
      const clock = shoot.clock();
      const script = state.script;
      if (!open || !clock || !script) return;
      set({ open: null });
      if (clock.seconds - open.start < 0.5) return;
      try {
        await api().cut(clock.session, { script, scene: open.scene, start: round(open.start), end: round(clock.seconds), recordedAt: new Date().toISOString() });
      } catch (error) {
        set({ error: message(error) });
      }
    },

    /** Accept `deviations` of `take` (all of them when omitted). */
    async accept(take: string, deviations?: string[]): Promise<void> {
      if (!state.script) return;
      await api()
        .accept(state.script, take, deviations ? { deviations } : {})
        .catch((error: unknown) => set({ error: message(error) }));
    },

    /** Pick the take of `scene` that goes into the cut; null goes back to the newest. */
    async choose(scene: string, take: string | null): Promise<void> {
      if (!state.script) return;
      try {
        await api().choose(state.script, scene, take);
        await api().assemble(state.script);
      } catch (error) {
        set({ error: message(error) });
      }
    },
  };
  return store;
}

function flatten(nodes: readonly FileNode[]): string[] {
  return nodes.flatMap((node) => (node.kind === "file" ? [node.path] : flatten(node.children)));
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/** The app's one takes store. */
export const takes = createTakes();

/** The takes state, re-rendering on change. */
export function useTakes(): TakesState {
  return useSyncExternalStore(takes.subscribe, takes.get);
}
