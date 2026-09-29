/**
 * Window layout model (SPEC §10): pure data plus transitions, shared by the
 * renderer (applies it) and main (persists it per project).
 */

/** Panels with a draggable edge. The center (preview + editor) takes the rest. */
export type PanelId = "sidebar" | "terminal" | "timeline";

/** Views of the left sidebar. */
export type SidebarView = "explorer" | "history" | "plugins";

/** One resizable, collapsible panel. `size` is px along its drag axis and survives collapse. */
export interface PanelState {
  size: number;
  collapsed: boolean;
}

/** Everything persisted per project. Unknown or invalid stored fields fall back to defaults. */
export interface Layout {
  panels: Record<PanelId, PanelState>;
  sidebarView: SidebarView;
  /** Preview share of the center row, 0.2..0.8; the editor gets the rest. */
  centerSplit: number;
}

/** Size bounds in px per panel: small enough to fit a laptop, large enough to stay usable. */
export const PANEL_BOUNDS: Record<PanelId, { min: number; max: number }> = {
  sidebar: { min: 160, max: 600 },
  terminal: { min: 280, max: 1200 },
  timeline: { min: 100, max: 900 },
};

const SIDEBAR_VIEWS: readonly SidebarView[] = ["explorer", "history", "plugins"];
const CENTER_SPLIT = { min: 0.2, max: 0.8 };

/** Layout of a project opened for the first time. Terminal is wide: the agent lives there. */
export const DEFAULT_LAYOUT: Layout = Object.freeze({
  panels: {
    sidebar: { size: 240, collapsed: false },
    terminal: { size: 520, collapsed: false },
    timeline: { size: 220, collapsed: false },
  },
  sidebarView: "explorer",
  centerSplit: 0.5,
}) as Layout;

/** Repair stored JSON into a valid layout, field by field. Never throws. */
export function normalizeLayout(raw: unknown): Layout {
  const input = isRecord(raw) ? raw : {};
  const panels = isRecord(input["panels"]) ? input["panels"] : {};
  const panel = (id: PanelId): PanelState => {
    const stored = isRecord(panels[id]) ? panels[id] : {};
    const fallback = DEFAULT_LAYOUT.panels[id];
    const size = stored["size"];
    const { min, max } = PANEL_BOUNDS[id];
    return {
      size: typeof size === "number" && Number.isFinite(size) && size > 0 ? clamp(size, min, max) : fallback.size,
      collapsed: typeof stored["collapsed"] === "boolean" ? stored["collapsed"] : fallback.collapsed,
    };
  };
  const view = input["sidebarView"];
  const split = input["centerSplit"];
  return {
    panels: { sidebar: panel("sidebar"), terminal: panel("terminal"), timeline: panel("timeline") },
    sidebarView: SIDEBAR_VIEWS.includes(view as SidebarView) ? (view as SidebarView) : DEFAULT_LAYOUT.sidebarView,
    centerSplit:
      typeof split === "number" && Number.isFinite(split)
        ? clamp(split, CENTER_SPLIT.min, CENTER_SPLIT.max)
        : DEFAULT_LAYOUT.centerSplit,
  };
}

/** Set a panel's size within its bounds. Dragging a collapsed panel's edge expands it. */
export function resizePanel(layout: Layout, id: PanelId, size: number): Layout {
  const { min, max } = PANEL_BOUNDS[id];
  return withPanel(layout, id, { size: Math.round(clamp(size, min, max)), collapsed: false });
}

/** Collapse or expand a panel, keeping its size for the next expand. */
export function togglePanel(layout: Layout, id: PanelId): Layout {
  const current = layout.panels[id];
  return withPanel(layout, id, { ...current, collapsed: !current.collapsed });
}

/** Set the preview share of the center row, clamped. */
export function setCenterSplit(layout: Layout, split: number): Layout {
  return { ...layout, centerSplit: clamp(split, CENTER_SPLIT.min, CENTER_SPLIT.max) };
}

function withPanel(layout: Layout, id: PanelId, state: PanelState): Layout {
  return { ...layout, panels: { ...layout.panels, [id]: state } };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
