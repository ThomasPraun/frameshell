import type { OperationResult } from "@frameshell/protocol";
import { type KeyboardEvent, type MouseEvent, useCallback, useEffect, useState } from "react";
import type { HistoryCommand, TimelineEdit } from "../../../shared/api.js";
import { openAskMenu } from "../ask/ask-agent.js";
import { editsText, handleTimelineHistory } from "../history-commands.js";
import { t } from "../i18n.js";
import { type Layer, layerLabel, layersOf, moveLayer } from "../layers/model.js";
import { SELECTION_TIMELINE, selection, useSelection } from "../selection.js";
import { historyShortcut } from "../timeline/edit.js";
import { useTimelineView } from "../timeline/useTimelineView.js";
import { listenEverywhere } from "../windows.js";
import { DetachButton } from "./DetachControls.js";
import { PanelHeader } from "./PanelHeader.js";

const TIMELINE = SELECTION_TIMELINE;
const isMac = navigator.userAgent.includes("Mac");
/** Pictures the media protocol serves from `assets/` (`main/media-protocol.ts`): those get a thumbnail. */
const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;

/**
 * The timeline's place in an image project (ADR 0017): its video tracks as
 * layers, topmost first. A click selects the layer's clip (the inspector,
 * which also replaces its image, and the preview handles follow), double-click
 * renames, the row buttons move or delete it, and right-click offers Ask agent and the same commands.
 * Every change is a `ui` edit, undoable from here as from the timeline.
 */
export function LayersPanel({
  mediaUrl,
  collapsed,
  onToggle,
  detached = false,
  onDetach,
}: {
  /** Base URL of the project's media (`ProjectView.mediaUrl`): thumbnails of image layers. */
  mediaUrl: string;
  collapsed: boolean;
  /** Collapse or expand; absent in the panel's own window. */
  onToggle?: () => void;
  detached?: boolean;
  onDetach?: () => void;
}) {
  const { view } = useTimelineView(TIMELINE);
  const { clips: selected, track: selectedTrack } = useSelection();
  const [status, setStatus] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const layers = view ? layersOf(view) : [];

  const send = useCallback(async (edits: TimelineEdit[], label: string) => {
    try {
      await window.frameshell.timeline.edit(TIMELINE, edits, { label });
      setStatus(null);
    } catch (error) {
      setStatus(t.layers.failed((error as Error).message));
    }
  }, []);

  // Undo and redo, as the timeline panel takes them when it is shown (#119).
  useEffect(() => {
    const undoRedo = (direction: HistoryCommand) =>
      void window.frameshell.timeline[direction](TIMELINE).then(
        (result: OperationResult | null) => setStatus(result ? null : direction === "undo" ? t.timeline.nothingToUndo : t.timeline.nothingToRedo),
        (error: Error) => setStatus(error.message),
      );
    const offKeys = listenEverywhere("keydown", (event) => {
      const command = event.defaultPrevented ? null : historyShortcut(event, isMac);
      if (!command || editsText(event.target)) return;
      event.preventDefault();
      undoRedo(command);
    });
    const off = handleTimelineHistory(undoRedo);
    return () => {
      offKeys();
      off();
    };
  }, []);

  const select = (layer: Layer) => {
    if (layer.clip) selection.selectClips([layer.clip.id], "timeline");
    else selection.selectTrack(layer.track, "timeline");
  };
  const isSelected = (layer: Layer) => (layer.clip ? selected.includes(layer.clip.id) : selectedTrack === layer.track);
  const move = (layer: Layer, direction: 1 | -1) => {
    const edit = view && moveLayer(view, layer.track, direction);
    if (edit) void send([edit], "Move layer");
  };
  const remove = (layer: Layer) => void send([{ op: "track.remove", args: { track: layer.track, force: true } }], "Delete layer");
  const rename = (layer: Layer, name: string) => {
    setRenaming(null);
    const next = name.trim() || null;
    if (next !== layer.name) void send([{ op: "track.set", args: { track: layer.track, name: next } }], "Rename layer");
  };

  const onRowKey = (event: KeyboardEvent, layer: Layer) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") select(layer);
    else if (event.key === "F2") setRenaming(layer.track);
    else if (event.key === "Delete" || event.key === "Backspace") remove(layer);
    else if (event.key === "ArrowUp" && event.altKey) move(layer, 1);
    else if (event.key === "ArrowDown" && event.altKey) move(layer, -1);
    else return;
    event.preventDefault();
  };
  const onContextMenu = (event: MouseEvent, layer: Layer) => {
    select(layer);
    openAskMenu(event, [
      { label: t.layers.rename, separated: true, run: () => setRenaming(layer.track) },
      { label: t.layers.moveUp, disabled: !layer.up, run: () => move(layer, 1) },
      { label: t.layers.moveDown, disabled: !layer.down, run: () => move(layer, -1) },
      { label: t.layers.remove, separated: true, danger: true, run: () => remove(layer) },
    ]);
  };

  return (
    <div className="layers-panel" data-testid="layers-panel">
      <PanelHeader
        actions={onDetach && <DetachButton name={t.workspace.layers.toLowerCase()} detached={detached} onClick={onDetach} testId="layers-detach" />}
        onCollapse={onToggle}
        collapseLabel={collapsed ? t.layers.show : t.layers.hide}
        collapseSide={collapsed ? "up" : "down"}
      >
        <span className="panel-title">{t.workspace.layers}</span>
        <span className="timeline-status timeline-status-error" role="status" aria-live="polite">
          {status ?? ""}
        </span>
      </PanelHeader>
      {!collapsed && (
        <div className="panel-body layers-body">
          {view && layers.length === 0 ? (
            <p className="layers-empty">{t.layers.empty}</p>
          ) : (
            <ul className="layers-list" aria-label={t.layers.list}>
              {layers.map((layer) => {
                const label = layerLabel(layer) ?? t.layers.emptyLayer;
                const image = layer.asset && IMAGE.test(layer.asset) ? layer.asset : null;
                return (
                  <li
                    key={layer.track}
                    className={`layers-row${isSelected(layer) ? " is-active" : ""}`}
                    data-track={layer.track}
                    tabIndex={0}
                    aria-selected={isSelected(layer)}
                    onClick={() => select(layer)}
                    onDoubleClick={() => setRenaming(layer.track)}
                    onKeyDown={(event) => onRowKey(event, layer)}
                    onContextMenu={(event) => onContextMenu(event, layer)}
                  >
                    <span className="layers-thumb" aria-hidden="true">
                      {image ? <img src={`${mediaUrl}${image}`} alt="" draggable={false} /> : <span>{layer.type === "media" ? "▶" : "◇"}</span>}
                    </span>
                    {renaming === layer.track ? (
                      <input
                        className="layers-name-input"
                        aria-label={t.layers.renameLayer(label)}
                        defaultValue={layer.name ?? ""}
                        placeholder={label}
                        autoFocus
                        onClick={(event) => event.stopPropagation()}
                        onBlur={(event) => rename(layer, event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") rename(layer, event.currentTarget.value);
                          else if (event.key === "Escape") setRenaming(null);
                          event.stopPropagation();
                        }}
                        spellCheck={false}
                      />
                    ) : (
                      <span className="layers-name">
                        <span className="layers-label">{label}</span>
                        <span className="layers-kind">{kindOf(layer)}</span>
                      </span>
                    )}
                    <span className="layers-actions" onClick={(event) => event.stopPropagation()}>
                      <button className="icon-button" aria-label={t.layers.rename} title={t.layers.rename} onClick={() => setRenaming(layer.track)}>
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M3 13l1-3.5L10.5 3 13 5.5 6.5 12z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                        </svg>
                      </button>
                      <button className="icon-button" aria-label={t.layers.moveUp} title={t.layers.moveUp} disabled={!layer.up} onClick={() => move(layer, 1)}>
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
                        </svg>
                      </button>
                      <button className="icon-button" aria-label={t.layers.moveDown} title={t.layers.moveDown} disabled={!layer.down} onClick={() => move(layer, -1)}>
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
                        </svg>
                      </button>
                      <button className="icon-button layers-remove" aria-label={t.layers.remove} title={t.layers.remove} onClick={() => remove(layer)}>
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" />
                        </svg>
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Second line of a row: what the layer shows. */
function kindOf(layer: Layer): string {
  if (!layer.type) return t.layers.emptyLayer;
  if (layer.type === "timeline") return t.layers.nestedTimeline;
  if (layer.type !== "media") return t.layers.generated(layer.type);
  return layer.asset ?? "";
}
