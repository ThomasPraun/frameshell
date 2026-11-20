import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, normalizeLayout, resizePanel, togglePanel } from "../src/shared/layout.js";

describe("layout model", () => {
  it("falls back to defaults for anything that is not a stored layout", () => {
    expect(normalizeLayout(undefined)).toEqual(DEFAULT_LAYOUT);
    expect(normalizeLayout("garbage")).toEqual(DEFAULT_LAYOUT);
    expect(normalizeLayout([1, 2])).toEqual(DEFAULT_LAYOUT);
  });

  it("keeps valid stored fields and repairs invalid ones", () => {
    const layout = normalizeLayout({
      panels: { sidebar: { size: 300, collapsed: true }, terminal: { size: "wide" }, timeline: { size: -5 } },
      sidebarView: "history",
      centerSplit: 0.7,
    });
    expect(layout.panels.sidebar).toEqual({ size: 300, collapsed: true });
    expect(layout.panels.terminal).toEqual(DEFAULT_LAYOUT.panels.terminal);
    expect(layout.panels.timeline.size).toBe(DEFAULT_LAYOUT.panels.timeline.size);
    expect(layout.sidebarView).toBe("history");
    expect(layout.centerSplit).toBe(0.7);
  });

  it("rejects an unknown sidebar view", () => {
    expect(normalizeLayout({ sidebarView: "chat" }).sidebarView).toBe("explorer");
  });

  it("clamps panel sizes to each panel's bounds when resizing", () => {
    expect(resizePanel(DEFAULT_LAYOUT, "sidebar", 10).panels.sidebar.size).toBe(160);
    expect(resizePanel(DEFAULT_LAYOUT, "terminal", 5000).panels.terminal.size).toBe(1200);
    expect(resizePanel(DEFAULT_LAYOUT, "timeline", 240).panels.timeline.size).toBe(240);
  });

  it("starts a new project with the terminal folded and the other panels open", () => {
    expect(DEFAULT_LAYOUT.panels.terminal.collapsed).toBe(true);
    expect(DEFAULT_LAYOUT.panels.sidebar.collapsed).toBe(false);
    expect(DEFAULT_LAYOUT.panels.timeline.collapsed).toBe(false);
  });

  it("one toggle opens the folded terminal at its kept size", () => {
    expect(togglePanel(DEFAULT_LAYOUT, "terminal").panels.terminal).toEqual({ size: 520, collapsed: false });
  });

  it("keeps the terminal as a stored layout has it, open or folded", () => {
    expect(normalizeLayout({ panels: { terminal: { size: 640, collapsed: false } } }).panels.terminal).toEqual({ size: 640, collapsed: false });
    expect(normalizeLayout({ panels: { terminal: { size: 640, collapsed: true } } }).panels.terminal.collapsed).toBe(true);
  });

  it("resizing a collapsed panel expands it", () => {
    const collapsed = togglePanel(DEFAULT_LAYOUT, "sidebar");
    expect(collapsed.panels.sidebar.collapsed).toBe(true);
    expect(resizePanel(collapsed, "sidebar", 300).panels.sidebar).toEqual({ size: 300, collapsed: false });
    expect(resizePanel(DEFAULT_LAYOUT, "terminal", 500).panels.terminal).toEqual({ size: 500, collapsed: false });
  });

  it("toggling keeps the size to restore on expand", () => {
    const resized = resizePanel(DEFAULT_LAYOUT, "sidebar", 280);
    const twice = togglePanel(togglePanel(resized, "sidebar"), "sidebar");
    expect(twice.panels.sidebar).toEqual({ size: 280, collapsed: false });
  });

  it("clamps the center split between preview and editor", () => {
    expect(normalizeLayout({ centerSplit: 0.01 }).centerSplit).toBe(0.2);
    expect(normalizeLayout({ centerSplit: 2 }).centerSplit).toBe(0.8);
  });
});
