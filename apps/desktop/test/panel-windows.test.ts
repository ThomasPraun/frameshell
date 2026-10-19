import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type DisplayInfo,
  PANEL_WINDOW_SIZE,
  PanelWindowStore,
  cascade,
  displaySetKey,
  panelWindowRequest,
  placeOnDisplays,
} from "../src/main/panel-windows.js";

const laptop: DisplayInfo = { id: 1, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
const monitor: DisplayInfo = { id: 7, workArea: { x: 1440, y: 0, width: 2560, height: 1415 } };
const storeFile = () => join(mkdtempSync(join(tmpdir(), "frameshell-panels-")), "panel-windows.json");

describe("panelWindowRequest", () => {
  it("allows only about:blank named after a known panel", () => {
    expect(panelWindowRequest("about:blank", "frameshell-panel:preview/1")).toBe("preview");
    expect(panelWindowRequest("about:blank", "frameshell-panel:preview/27")).toBe("preview");
    expect(panelWindowRequest("about:blank", "frameshell-panel:terminal/3")).toBe("terminal");
    for (const panel of ["timeline", "editor", "explorer", "history", "plugins", "angles"]) {
      expect(panelWindowRequest("about:blank", `frameshell-panel:${panel}/1`)).toBe(panel);
    }
    expect(panelWindowRequest("about:blank", "frameshell-panel:preview")).toBeNull();
    expect(panelWindowRequest("about:blank", "frameshell-panel:preview/x")).toBeNull();
    expect(panelWindowRequest("about:blank", "frameshell-panel:debugger/1")).toBeNull();
    expect(panelWindowRequest("about:blank", "preview")).toBeNull();
    expect(panelWindowRequest("about:blank", "")).toBeNull();
    expect(panelWindowRequest("https://example.com/", "frameshell-panel:preview/1")).toBeNull();
    expect(panelWindowRequest("about:blank#x", "frameshell-panel:preview/1")).toBeNull();
    expect(panelWindowRequest("frameshell-live://t/index.html", "frameshell-panel:preview/1")).toBeNull();
  });
});

describe("placeOnDisplays", () => {
  it("keeps saved bounds that show on a connected display", () => {
    const saved = { x: 1600, y: 100, width: 1200, height: 700 };
    expect(placeOnDisplays(saved, [laptop, monitor], laptop)).toEqual(saved);
  });

  it("centres the default size on the primary display when the saved display is gone", () => {
    const placed = placeOnDisplays({ x: 1600, y: 100, width: 1200, height: 700 }, [laptop], laptop);
    expect(placed).toEqual({ x: 240, y: 163, width: PANEL_WINDOW_SIZE.width, height: PANEL_WINDOW_SIZE.height });
  });

  it("opens a never-placed panel on the primary display, shrunk to fit a small one", () => {
    const small: DisplayInfo = { id: 2, workArea: { x: 0, y: 0, width: 800, height: 500 } };
    expect(placeOnDisplays(undefined, [small], small)).toEqual({ x: 0, y: 0, width: 800, height: 500 });
  });

  it("ignores a window that only grazes a display", () => {
    const grazing = { x: 1440 - 40, y: 100, width: 600, height: 400 };
    expect(placeOnDisplays(grazing, [laptop], laptop).x).toBe(240);
  });
});

describe("PanelWindowStore", () => {
  it("remembers detached panels and placements across instances", async () => {
    const file = storeFile();
    const store = new PanelWindowStore(file);
    await store.load();
    expect(store.detached()).toEqual([]);
    expect(store.placement("preview", [laptop])).toBeNull();
    const placement = { bounds: { x: 1500, y: 40, width: 1000, height: 640 }, fullScreen: true };
    await store.setDetached("preview", true);
    await store.place("preview", [laptop, monitor], placement);

    const reopened = new PanelWindowStore(file);
    await reopened.load();
    expect(reopened.detached()).toEqual(["preview"]);
    expect(reopened.placement("preview", [monitor, laptop])).toEqual(placement);
    await reopened.setDetached("preview", false);
    expect(reopened.detached()).toEqual([]);
  });

  it("never marks a terminal detached, since its session ends with the project window, but places its windows", async () => {
    const file = storeFile();
    const store = new PanelWindowStore(file);
    await store.load();
    const placement = { bounds: { x: 200, y: 80, width: 700, height: 500 }, fullScreen: false };
    await store.setDetached("terminal", true);
    await store.place("terminal", [laptop], placement);
    expect(store.detached()).toEqual([]);
    writeFileSync(file, JSON.stringify({ version: 1, detached: ["terminal", "preview"], sets: {} }));
    await store.load();
    expect(store.detached()).toEqual(["preview"]);
    await store.place("terminal", [laptop], placement);
    const reopened = new PanelWindowStore(file);
    await reopened.load();
    expect(reopened.placement("terminal", [laptop])).toEqual(placement);
  });

  it("shifts each further window of a panel already open", () => {
    const rect = { x: 100, y: 50, width: 960, height: 600 };
    expect(cascade(rect, 0)).toEqual(rect);
    expect(cascade(rect, 2)).toEqual({ x: 156, y: 106, width: 960, height: 600 });
  });

  it("keeps one placement per display set, and falls back to the one saved last", async () => {
    const store = new PanelWindowStore(storeFile());
    await store.load();
    const alone = { bounds: { x: 100, y: 100, width: 800, height: 500 }, fullScreen: false };
    const docked = { bounds: { x: 1600, y: 100, width: 1200, height: 700 }, fullScreen: false };
    await store.place("preview", [laptop, monitor], docked);
    await store.place("preview", [laptop], alone);
    expect(store.placement("preview", [laptop, monitor])).toEqual(docked);
    expect(store.placement("preview", [laptop])).toEqual(alone);
    expect(store.placement("preview", [monitor])).toEqual(alone);
    await store.place("preview", [laptop, monitor], docked);
    expect(store.placement("preview", [monitor])).toEqual(docked);
  });

  it("repairs a corrupt or foreign file", async () => {
    const file = storeFile();
    writeFileSync(file, "{not json");
    const store = new PanelWindowStore(file);
    await store.load();
    expect(store.detached()).toEqual([]);

    writeFileSync(
      file,
      JSON.stringify({
        detached: ["preview", "debugger", 3],
        sets: { [displaySetKey([laptop])]: { preview: { bounds: { x: 0, y: 0, width: 10, height: 10 } }, other: {} }, bad: 4 },
      }),
    );
    await store.load();
    expect(store.detached()).toEqual(["preview"]);
    // Too small to be a real panel window.
    expect(store.placement("preview", [laptop])).toBeNull();
    await store.setDetached("preview", true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, detached: ["preview"], sets: { [displaySetKey([laptop])]: {} } });
  });

  it("keys display sets by their ids in any order, never as an integer-like key", () => {
    expect(displaySetKey([monitor, laptop])).toBe(displaySetKey([laptop, monitor]));
    expect(displaySetKey([laptop])).not.toMatch(/^\d+$/);
  });
});
