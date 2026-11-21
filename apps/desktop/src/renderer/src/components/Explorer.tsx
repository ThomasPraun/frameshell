import { isScriptPath } from "@frameshell/schema";
import { type MouseEvent, useEffect, useMemo, useState } from "react";
import type { FileNode } from "../../../shared/api.js";
import { t } from "../i18n.js";
import { askItems, openAskMenu } from "../ask/ask-agent.js";
import { selection, useSelection } from "../selection.js";
import { soundFilesIn } from "../audition/model.js";
import { auditionItems, placeItems, voiceoverItems } from "../file-commands.js";
import { windowOf } from "../windows.js";
import { useProjectKind } from "../preview/useProgram.js";
import { addToTimeline, isTimelineMedia, startMediaDrag } from "../timeline/media-drag.js";
import { type MenuItem, contextMenu } from "./ContextMenu.js";

/** Folders a fresh project shows open: where the agent writes first. */
const INITIALLY_OPEN = new Set(["scripts", "timelines"]);

/** Media under here has no editor: a click selects it (for "Chat about this") as well as opening it. */
const ASSETS_DIR = "assets/";

/** Every file path of a tree. */
function filePaths(nodes: readonly FileNode[]): string[] {
  return nodes.flatMap((node) => (node.kind === "dir" ? filePaths(node.children) : [node.path]));
}

/**
 * Project tree, refreshed live from the main-process watcher. Files are
 * selectable in the shared selection store for "Chat about this": a click on an
 * asset, Cmd/Ctrl-click on any file (toggles, without opening), or a
 * right-click, which opens its menu ("Chat about this", Open, Add to timeline for media in `assets/` (#738), Audition for two or more
 * selected sounds, Reveal, Copy path, Move to Trash; a folder gets Audition of its
 * sounds and the last three). Media in `assets/` can also be dragged onto the timeline. Deleted files leave the selection.
 */
export function Explorer({ onOpenFile, activeFile }: { onOpenFile: (path: string) => void; activeFile: string | null }) {
  const [tree, setTree] = useState<FileNode[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(INITIALLY_OPEN);
  const { files } = useSelection();
  const picked = useMemo(() => new Set(files), [files]);
  // An image project puts pictures on as layers (drops, its Layers panel), not as clips in time.
  const video = useProjectKind() !== "image";

  useEffect(() => {
    let live = true;
    const refresh = () =>
      void window.frameshell.files.tree().then((nodes) => {
        if (!live) return;
        selection.retainFiles(new Set(filePaths(nodes)));
        setTree(nodes);
      });
    refresh();
    const unsubscribe = window.frameshell.files.onChanged(refresh);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  if (!tree) return null;
  if (tree.length === 0) return <p className="empty">{t.editor.folderEmpty}</p>;

  const toggle = (path: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <ul className="tree" role="tree" aria-label={t.editor.projectFiles}>
      <Nodes nodes={tree} depth={0} open={open} onToggle={toggle} onOpenFile={onOpenFile} activeFile={activeFile} picked={picked} video={video} />
    </ul>
  );
}

function Nodes({
  nodes,
  depth,
  open,
  onToggle,
  onOpenFile,
  activeFile,
  picked,
  video,
}: {
  nodes: FileNode[];
  depth: number;
  open: Set<string>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  activeFile: string | null;
  /** Files in the shared selection. */
  picked: ReadonlySet<string>;
  /** A video project: media can go on its timeline from here (#738). */
  video: boolean;
}) {
  /** The media a menu or a drag on `node` acts on: the selected media when `node` is among them, else `node` alone. */
  const mediaOf = (node: FileNode) => (picked.has(node.path) ? [...picked] : [node.path]).filter((path) => path.startsWith(ASSETS_DIR) && isTimelineMedia(path));
  const onClick = (event: MouseEvent, node: FileNode) => {
    if (node.kind === "dir") return onToggle(node.path);
    if (event.metaKey || event.ctrlKey || event.shiftKey) return selection.toggleFile(node.path, "explorer");
    if (node.path.startsWith(ASSETS_DIR)) selection.selectFiles([node.path], "explorer");
    onOpenFile(node.path);
  };
  const onContextMenu = (event: MouseEvent, node: FileNode) => {
    if (node.kind === "dir") {
      event.preventDefault();
      if (!picked.has(node.path)) selection.selectFiles([node.path], "explorer");
      const view = windowOf(event.target);
      contextMenu.open(event.clientX, event.clientY, [...askItems(), ...auditionItems(soundFilesIn(node), t.audition.folderItem, view), ...placeItems(node.path)], view);
      return;
    }
    if (!picked.has(node.path)) selection.selectFiles([node.path], "explorer");
    // Several sound files selected (Cmd/Ctrl-click) and this one among them: they can be heard side by side.
    const audition = picked.has(node.path) ? auditionItems([...picked], t.audition.explorerItem, windowOf(event.target)) : [];
    const media = video ? mediaOf(node) : [];
    const items = (voiceover: readonly MenuItem[]): MenuItem[] => [
      { label: t.editor.open, run: () => onOpenFile(node.path) },
      ...(media.length > 0 ? [{ label: t.editor.addToTimeline, run: () => void addToTimeline(media) }] : []),
      ...audition,
      ...voiceover,
      ...placeItems(node.path),
    ];
    if (!isScriptPath(node.path)) return openAskMenu(event, items([]));
    // Whether it is a voiceover script is in the file's frontmatter: read it, then open the menu where the pointer was.
    event.preventDefault();
    const { clientX, clientY, target } = event;
    void voiceoverItems(node.path, windowOf(target)).then((voiceover) => contextMenu.open(clientX, clientY, [...askItems(), ...items(voiceover)], windowOf(target)));
  };
  return (
    <>
      {nodes.map((node) => {
        const isOpen = node.kind === "dir" && open.has(node.path);
        return (
          <li
            key={node.path}
            role="treeitem"
            aria-label={node.path}
            aria-expanded={node.kind === "dir" ? isOpen : undefined}
            aria-selected={node.path === activeFile}
          >
            <button
              draggable={video && node.kind === "file" && node.path.startsWith(ASSETS_DIR) && isTimelineMedia(node.path)}
              onDragStart={(event) => {
                if (!startMediaDrag(event.dataTransfer, mediaOf(node))) event.preventDefault();
              }}
              className={`tree-row${node.path === activeFile ? " is-active" : ""}${picked.has(node.path) ? " is-picked" : ""}`}
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={(event) => onClick(event, node)}
              onContextMenu={(event) => onContextMenu(event, node)}
              data-tip={node.path}
              data-picked={picked.has(node.path) || undefined}
            >
              <span className={`tree-glyph ${node.kind === "dir" ? (isOpen ? "dir-open" : "dir") : fileKind(node.name)}`} />
              <span className="tree-name">{node.name}</span>
            </button>
            {node.kind === "dir" && isOpen && (
              <ul role="group">
                <Nodes
                  nodes={node.children}
                  depth={depth + 1}
                  open={open}
                  onToggle={onToggle}
                  onOpenFile={onOpenFile}
                  activeFile={activeFile}
                  picked={picked}
                  video={video}
                />
              </ul>
            )}
          </li>
        );
      })}
    </>
  );
}

/** Coarse kind for the glyph color: matches timeline track colors where it applies. */
function fileKind(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (["mp4", "mov", "mkv", "webm", "avi"].includes(ext)) return "video";
  if (["wav", "mp3", "aac", "m4a", "flac", "ogg"].includes(ext)) return "audio";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return "image";
  if (["md", "markdown", "txt"].includes(ext)) return "text";
  if (ext === "json") return "data";
  return "other";
}
