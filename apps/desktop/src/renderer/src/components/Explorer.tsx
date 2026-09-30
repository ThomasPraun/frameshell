import { type MouseEvent, useEffect, useMemo, useState } from "react";
import type { FileNode } from "../../../shared/api.js";
import { openAskMenu } from "../ask/ask-agent.js";
import { selection, useSelection } from "../selection.js";

/** Folders a fresh project shows open: where the agent writes first. */
const INITIALLY_OPEN = new Set(["scripts", "timelines"]);

/** Media under here has no editor: a click selects it (for "Ask agent") as well as opening it. */
const ASSETS_DIR = "assets/";

/** Every file path of a tree. */
function filePaths(nodes: readonly FileNode[]): string[] {
  return nodes.flatMap((node) => (node.kind === "dir" ? filePaths(node.children) : [node.path]));
}

/**
 * Project tree, refreshed live from the main-process watcher. Files are
 * selectable in the shared selection store for "Ask agent": a click on an
 * asset, Cmd/Ctrl-click on any file (toggles, without opening), or a
 * right-click, which opens the "Ask agent" menu. Deleted files leave the selection.
 */
export function Explorer({ onOpenFile, activeFile }: { onOpenFile: (path: string) => void; activeFile: string | null }) {
  const [tree, setTree] = useState<FileNode[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(INITIALLY_OPEN);
  const { files } = useSelection();
  const picked = useMemo(() => new Set(files), [files]);

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
  if (tree.length === 0) return <p className="empty">This folder is empty.</p>;

  const toggle = (path: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <ul className="tree" role="tree" aria-label="Project files">
      <Nodes nodes={tree} depth={0} open={open} onToggle={toggle} onOpenFile={onOpenFile} activeFile={activeFile} picked={picked} />
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
}: {
  nodes: FileNode[];
  depth: number;
  open: Set<string>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  activeFile: string | null;
  /** Files in the shared selection. */
  picked: ReadonlySet<string>;
}) {
  const onClick = (event: MouseEvent, node: FileNode) => {
    if (node.kind === "dir") return onToggle(node.path);
    if (event.metaKey || event.ctrlKey || event.shiftKey) return selection.toggleFile(node.path, "explorer");
    if (node.path.startsWith(ASSETS_DIR)) selection.selectFiles([node.path], "explorer");
    onOpenFile(node.path);
  };
  const onContextMenu = (event: MouseEvent, node: FileNode) => {
    if (node.kind === "dir") return;
    if (!picked.has(node.path)) selection.selectFiles([node.path], "explorer");
    openAskMenu(event);
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
              className={`tree-row${node.path === activeFile ? " is-active" : ""}${picked.has(node.path) ? " is-picked" : ""}`}
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={(event) => onClick(event, node)}
              onContextMenu={(event) => onContextMenu(event, node)}
              title={node.path}
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
