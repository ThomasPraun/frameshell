import type { FileNode } from "../../../shared/api.js";

/** Project-relative paths of the `.cube` files in a file tree, sorted: the LUTs a clip's grade can pick (ADR 0031). */
export function cubeFiles(nodes: readonly FileNode[]): string[] {
  const found: string[] = [];
  const walk = (list: readonly FileNode[]) => {
    for (const node of list) {
      if (node.kind === "dir") walk(node.children);
      else if (node.name.toLowerCase().endsWith(".cube")) found.push(node.path);
    }
  };
  walk(nodes);
  return found.sort();
}
