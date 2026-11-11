import type { StyleShowResult } from "@frameshell/protocol";

/** Help text of the `style` commands (ADR 0028), in `frameshell --help`. */
export const STYLE_USAGE = `  style show                   The project's style guide (style.json): brand, colours, fonts, type sizes, motion
                               (from its personality), sound levels, platforms with their safe zones, rules;
                               each value with where it comes from (file, personality, default)
`;

/** Flags each `style` command takes besides the global ones. */
export const STYLE_FLAGS: Record<string, readonly string[]> = {
  "style show": [],
};

type Leaf = { value: unknown; source: string };

/** Text of `style show`: one line per value, its source unless written in the file. */
export function formatStyle(result: StyleShowResult): string {
  if (!result.style) return `No ${result.path} in ${result.dir}: none is required. Write one to keep colours, fonts, motion and sound as numbers.\n`;
  const from = result.from ? ` (copied from user style ${result.from.id})` : "";
  const lines = [`Style guide ${result.path}${from}. Times in seconds, sizes in px at a 1080 short side, levels in dB, high-pass in Hz.`];
  const rows: [string, string, string][] = [];
  const walk = (node: Record<string, unknown>, path: string[]) => {
    for (const [key, child] of Object.entries(node)) {
      const at = [...path, key];
      if (isLeaf(child)) rows.push([at.join("."), shown(child.value), child.source === "file" ? "" : child.source]);
      else walk(child as Record<string, unknown>, at);
    }
  };
  walk(result.style as unknown as Record<string, unknown>, []);
  const width = Math.max(...rows.map(([path]) => path.length));
  for (const [path, value, source] of rows) lines.push(`  ${path.padEnd(width)}  ${value}${source ? `  (${source})` : ""}`);
  if (result.safeZones.length > 0) {
    lines.push("Safe zones (px of the reference frame the platform's app covers):");
    for (const zone of result.safeZones) {
      const measured = zone.measured ? "measured" : "not measured";
      lines.push(`  ${zone.platform} ${zone.width}x${zone.height}: top ${zone.top}, right ${zone.right}, bottom ${zone.bottom}, left ${zone.left} (${measured})`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function isLeaf(node: unknown): node is Leaf {
  return typeof node === "object" && node !== null && "source" in node && "value" in node;
}

function shown(value: unknown): string {
  if (value === null) return "not set";
  if (value === "?") return "? (ask the person)";
  if (Array.isArray(value) && value.length === 0) return "none";
  return typeof value === "string" ? value : JSON.stringify(value);
}
