import type { DaemonConnection, StyleChange, StyleListResult, StyleShowResult } from "@frameshell/protocol";
import { UsageError } from "./timeline-commands.js";

/** Help text of the `style` commands (ADR 0028), in `frameshell --help`. */
export const STYLE_USAGE = `  style show                   The project's style guide (style.json): brand, colours, fonts, type sizes, motion
                               (from its personality), sound levels, platforms with their safe zones, rules;
                               each value with where it comes from (file, personality, default)
  style set <path> <value>     Set one value, e.g. style set colors.accent '#ff5500', style set type.hero 220,
                               style set banned '["emoji in captions"]'; null removes it. JSON, else text.
                               Negative numbers after --: style set sound.voice.compressor.threshold -- -18.
                               Journaled (revert undoes it); waits in the proposal in review mode
  style apply <name> [--replace]
                               Copy a user style (style list) or a motion personality (playful, premium, corporate,
                               energetic, calm) into style.json, value by value; --replace overwrites the file
  style save <name> [--force]  Save the project's style.json as a user style for other projects (--force overwrites)
  style list                   User styles on this machine and the motion personalities
`;

/** Flags each `style` command takes besides the global ones. */
export const STYLE_FLAGS: Record<string, readonly string[]> = {
  "style show": [],
  "style set": [],
  "style apply": ["replace"],
  "style save": ["force"],
  "style list": [],
};

/** A parsed `style` command. */
export type StyleInvocation =
  | { kind: "style.show" }
  | { kind: "style.set"; path: string; value: unknown }
  | { kind: "style.apply"; name: string; replace: boolean }
  | { kind: "style.save"; name: string; force: boolean }
  | { kind: "style.list" };

/** Parse `style <sub> …`; null when the shape is wrong. Throws `UsageError` for a value given in several words. */
export function parseStyle(rest: string[], options: { replace?: boolean | undefined; force?: boolean | undefined }): StyleInvocation | null {
  const [sub, ...args] = rest;
  switch (sub) {
    case "show":
      return args.length === 0 ? { kind: "style.show" } : null;
    case "list":
      return args.length === 0 ? { kind: "style.list" } : null;
    case "set": {
      if (args.length > 2) throw new UsageError("style set takes one path and one value: quote a value with spaces, e.g. style set brand.promise \"Edit video like code.\"");
      return args.length === 2 ? { kind: "style.set", path: args[0]!, value: styleValue(args[1]!) } : null;
    }
    case "apply":
      return args.length === 1 ? { kind: "style.apply", name: args[0]!, replace: options.replace === true } : null;
    case "save":
      return args.length === 1 ? { kind: "style.save", name: args[0]!, force: options.force === true } : null;
    default:
      return null;
  }
}

/** A `style set` value: JSON (number, list, object, true, null), else the text as given (`#ff5500`, `Acme`). */
export function styleValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Run a parsed `style` command; human output unless `json`. */
export async function executeStyle(conn: DaemonConnection, inv: StyleInvocation, cwd: string, json: boolean): Promise<string> {
  const print = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  switch (inv.kind) {
    case "style.show": {
      const result = await conn.request("style.show", { cwd });
      return json ? print(result) : formatStyle(result);
    }
    case "style.set": {
      const result = await conn.request("style.set", { cwd, path: inv.path, value: inv.value });
      return json ? print(result) : changed(`Set ${inv.path}`, result);
    }
    case "style.apply": {
      const result = await conn.request("style.apply", { cwd, name: inv.name, ...(inv.replace ? { replace: true } : {}) });
      return json ? print(result) : changed(`${inv.replace ? "Replaced the style with" : "Applied"} ${inv.name}`, result);
    }
    case "style.save": {
      const result = await conn.request("style.save", { cwd, name: inv.name, ...(inv.force ? { force: true } : {}) });
      return json ? print(result) : `${result.replaced ? "Replaced" : "Saved"} user style ${result.id}: ${result.path}\n  apply it in another project: frameshell style apply ${result.id}\n`;
    }
    case "style.list": {
      const result = await conn.request("style.list", {});
      return json ? print(result) : formatStyleList(result);
    }
  }
}

/** What changed, value by value, and the command that undoes it. */
function changed(what: string, result: StyleChange): string {
  const lines = result.changes.map((change) => `  ${change.path}: ${shown(change.before)} -> ${shown(change.after)}`);
  const list = lines.length > 0 ? `\n${lines.join("\n")}` : " Nothing changed: the file already held these values.";
  if (result.proposal) {
    return (
      `${what} in proposal ${result.proposal} (${result.op}): review mode is on, so ${result.path} is unchanged until the person accepts it.${list}\n` +
      "  next: frameshell proposal wait\n"
    );
  }
  return `${what} (${result.op}).${list}\n  undo: frameshell revert ${result.op}\n`;
}

function formatStyleList(result: StyleListResult): string {
  const styles = result.styles.map((style) => {
    const note = style.error ? `invalid: ${style.error.split("\n")[0]}` : style.personality ? `personality ${style.personality}` : "";
    return `  ${style.id}${note ? `  (${note})` : ""}`;
  });
  return (
    `User styles in ${result.dir}:\n${styles.length > 0 ? styles.join("\n") : "  none yet: frameshell style save <name>"}\n` +
    `Motion personalities: ${result.personalities.join(", ")}\n`
  );
}

type Leaf = { value: unknown; source: string };

/** Text of `style show`: one line per value, its source unless written in the file. */
export function formatStyle(result: StyleShowResult): string {
  if (!result.style) return `No ${result.path} in ${result.dir}: none is required. \`frameshell style set\` or \`style apply\` starts one.\n`;
  const status = { same: "", changed: "; it changed since: style apply it again to take the change", missing: "; not on this machine" };
  const from = result.from ? ` (copied from user style ${result.from.id}${status[result.from.status]})` : "";
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
