import { useEffect, useState } from "react";
import type { FileNode } from "../../../shared/api.js";

/** Folders a fresh project shows open: where the agent writes first. */
const INITIALLY_OPEN = new Set(["scripts", "timelines"]);

/** Project tree, refreshed live from the main-process watcher. */
export function Explorer({ onOpenFile, activeFile }: { onOpenFile: (path: string) => void; activeFile: string | null }) {
  const [tree, setTree] = useState<FileNode[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(INITIALLY_OPEN);

  useEffect(() => {
    let live = true;
    const refresh = () => void window.frameshell.files.tree().then((nodes) => live && setTree(nodes));
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
      <Nodes nodes={tree} depth={0} open={open} onToggle={toggle} onOpenFile={onOpenFile} activeFile={activeFile} />
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
}: {
  nodes: FileNode[];
  depth: number;
  open: Set<string>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  activeFile: string | null;
}) {
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
              className={`tree-row${node.path === activeFile ? " is-active" : ""}`}
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => (node.kind === "dir" ? onToggle(node.path) : onOpenFile(node.path))}
              title={node.path}
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
