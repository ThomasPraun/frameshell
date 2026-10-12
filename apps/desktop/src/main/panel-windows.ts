// Detached panel windows (ADR 0012): which popups the project renderer may open, and where each panel's window goes.
import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "@frameshell/core/fs-util";
import { DETACHABLE_PANELS, type DetachablePanel, PANEL_WINDOW_PREFIX, REOPENED_PANELS } from "../shared/layout.js";

/** A screen rectangle in Electron's DIP coordinates. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What placement needs of a connected display. */
export interface DisplayInfo {
  id: number;
  workArea: Rect;
}

/** Where a detached panel's window was, and whether it was full screen. */
export interface PanelPlacement {
  /** Bounds out of full screen. */
  bounds: Rect;
  fullScreen: boolean;
}

/** Size of a panel window opened for the first time. */
export const PANEL_WINDOW_SIZE = { width: 960, height: 600 } as const;
/** Smallest panel window: the preview's transport and inspector still fit. */
export const PANEL_WINDOW_MIN = { width: 320, height: 240 } as const;
/** How far each further window of a panel already open is shifted right and down, so it does not hide the others. */
export const PANEL_WINDOW_CASCADE = 28;
/** A saved window is reused on a display only when at least this much of it, each way, lies in the display's work area. */
const MIN_VISIBLE = 80;

/**
 * The panel a `window.open` of the project renderer asks for: exactly
 * `about:blank` named `frameshell-panel:<panel>/<n>`, with a known panel
 * (`n` tells one open from the next). Null means deny, as for every other popup.
 */
export function panelWindowRequest(url: string, frameName: string): DetachablePanel | null {
  const match = /^([a-z]+)\/\d+$/.exec(frameName.slice(PANEL_WINDOW_PREFIX.length));
  if (url !== "about:blank" || !frameName.startsWith(PANEL_WINDOW_PREFIX) || !match) return null;
  const panel = match[1]!;
  return DETACHABLE_PANELS.includes(panel as DetachablePanel) ? (panel as DetachablePanel) : null;
}

/**
 * Key of a set of connected displays: placements are saved per set, so a
 * laptop alone and docked keep their own. Never an integer-like string, which
 * objects would order before the others and so lose which set was saved last.
 */
export function displaySetKey(displays: readonly DisplayInfo[]): string {
  const ids = displays.map((display) => display.id).sort((a, b) => a - b);
  return `displays:${ids.join(",")}`;
}

/**
 * Bounds for a panel window: `saved` when enough of it shows on a connected
 * display, else the default size centred on `primary` (the display it was on
 * is gone). Never larger than the display it lands on.
 */
export function placeOnDisplays(saved: Rect | undefined, displays: readonly DisplayInfo[], primary: DisplayInfo): Rect {
  if (saved) {
    const home = displays.find((display) => overlap(saved, display.workArea));
    if (home) return fitInside(saved, home.workArea);
  }
  const area = primary.workArea;
  const width = Math.min(PANEL_WINDOW_SIZE.width, area.width);
  const height = Math.min(PANEL_WINDOW_SIZE.height, area.height);
  return { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height };
}

/** `rect` moved {@link PANEL_WINDOW_CASCADE} right and down per window of the same panel already `open`. */
export function cascade(rect: Rect, open: number): Rect {
  const shift = PANEL_WINDOW_CASCADE * Math.max(0, open);
  return { ...rect, x: rect.x + shift, y: rect.y + shift };
}

function overlap(a: Rect, b: Rect): boolean {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width >= MIN_VISIBLE && height >= MIN_VISIBLE;
}

function fitInside(rect: Rect, area: Rect): Rect {
  const width = Math.min(rect.width, area.width);
  const height = Math.min(rect.height, area.height);
  return { x: rect.x, y: rect.y, width, height };
}

interface Stored {
  version: 1;
  detached: DetachablePanel[];
  /** Placement per display set, then per panel. */
  sets: Record<string, Partial<Record<DetachablePanel, PanelPlacement>>>;
}

/**
 * Which panels are detached, and their windows' placement per display set,
 * in one global file (a user decision, in `configDir`). Reads once at
 * {@link PanelWindowStore.load}, so the synchronous popup handler can place a
 * window; writes are serialized and atomic.
 */
export class PanelWindowStore {
  #stored: Stored = { version: 1, detached: [], sets: {} };
  #writing: Promise<void> = Promise.resolve();

  /** @param file JSON file holding the state; created on the first change. */
  constructor(private readonly file: string) {}

  /** Read the file; a missing or unreadable one means nothing detached and nothing placed. */
  async load(): Promise<void> {
    try {
      this.#stored = normalize(JSON.parse(await readFile(this.file, "utf8")));
    } catch {
      this.#stored = { version: 1, detached: [], sets: {} };
    }
  }

  /** Panels that open in their own window when a project window opens. */
  detached(): DetachablePanel[] {
    return [...this.#stored.detached];
  }

  /** Where `panel`'s window goes on `displays`: its placement for this display set, else the most recently saved on any. */
  placement(panel: DetachablePanel, displays: readonly DisplayInfo[]): PanelPlacement | null {
    const own = this.#stored.sets[displaySetKey(displays)]?.[panel];
    if (own) return own;
    const others = Object.values(this.#stored.sets).flatMap((set) => (set[panel] ? [set[panel]] : []));
    return others.at(-1) ?? null;
  }

  /** Mark `panel` detached or docked. A panel not in {@link REOPENED_PANELS} is never marked. */
  setDetached(panel: DetachablePanel, detached: boolean): Promise<void> {
    if (!REOPENED_PANELS.includes(panel)) return this.#writing;
    const rest = this.#stored.detached.filter((other) => other !== panel);
    this.#stored.detached = detached ? [...rest, panel] : rest;
    return this.#save();
  }

  /** Remember `panel`'s window placement for the display set `displays`. The set saved last is the fallback for unknown sets. */
  place(panel: DetachablePanel, displays: readonly DisplayInfo[], placement: PanelPlacement): Promise<void> {
    const key = displaySetKey(displays);
    const { [key]: set = {}, ...others } = this.#stored.sets;
    this.#stored.sets = { ...others, [key]: { ...set, [panel]: placement } };
    return this.#save();
  }

  #save(): Promise<void> {
    const snapshot = structuredClone(this.#stored);
    this.#writing = this.#writing.then(() => writeJsonAtomic(this.file, snapshot)).catch(() => undefined);
    return this.#writing;
  }
}

/** Repair stored JSON, entry by entry. Never throws. */
function normalize(raw: unknown): Stored {
  const input = isRecord(raw) ? raw : {};
  const detached = Array.isArray(input["detached"])
    ? REOPENED_PANELS.filter((panel) => (input["detached"] as unknown[]).includes(panel))
    : [];
  const sets: Stored["sets"] = {};
  if (isRecord(input["sets"])) {
    for (const [key, value] of Object.entries(input["sets"])) {
      if (!isRecord(value)) continue;
      const set: Partial<Record<DetachablePanel, PanelPlacement>> = {};
      for (const panel of DETACHABLE_PANELS) {
        const placement = placementOf(value[panel]);
        if (placement) set[panel] = placement;
      }
      sets[key] = set;
    }
  }
  return { version: 1, detached, sets };
}

function placementOf(raw: unknown): PanelPlacement | null {
  if (!isRecord(raw) || !isRecord(raw["bounds"])) return null;
  const bounds = raw["bounds"];
  const numbers = ["x", "y", "width", "height"].map((field) => bounds[field]);
  if (!numbers.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  const [x, y, width, height] = numbers as number[];
  if (width! < PANEL_WINDOW_MIN.width || height! < PANEL_WINDOW_MIN.height) return null;
  return { bounds: { x: x!, y: y!, width: width!, height: height! }, fullScreen: raw["fullScreen"] === true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
