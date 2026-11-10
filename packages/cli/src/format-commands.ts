import type { DaemonConnection, FormatChange, FormatInfo } from "@frameshell/protocol";
import { UsageError } from "./timeline-commands.js";

/** Help text of the `format` commands (ADR 0027), in `frameshell --help`. */
export const FORMAT_USAGE = `  format list                  Delivery formats of the project, primary (= resolution) first, and the built-in ones
  format add <id> [--size WxH] [--index n]
                               Add a format: built-in 16x9 (1920x1080), 1x1 (1080x1080), 4x5 (1080x1350),
                               9x16 (1080x1920), or a custom id with --size (even), e.g. web-1600x900 --size 1600x900.
                               Untransformed media fills its frame (cropped around the centre); render --formats
                               exports it from the same edit. Journaled; prints the command that undoes it
  format remove <id>           Remove a format (never the primary)
`;

/** Flags each `format` command takes besides the global ones. */
export const FORMAT_FLAGS: Record<string, readonly string[]> = {
  "format list": [],
  "format add": ["size", "index"],
  "format remove": [],
};

/** A parsed `format` command. */
export type FormatInvocation =
  | { kind: "format.list" }
  | { kind: "format.add"; id: string; width?: number; height?: number; index?: number }
  | { kind: "format.remove"; id: string };

/** Parse `format <sub> …`; null when the shape is wrong. Throws `UsageError` for a bad flag value. */
export function parseFormat(rest: string[], options: { size?: string | undefined; index?: string | undefined }): FormatInvocation | null {
  const [sub, ...args] = rest;
  switch (sub) {
    case "list":
      return args.length === 0 ? { kind: "format.list" } : null;
    case "add": {
      if (args.length !== 1) return null;
      const size = options.size === undefined ? undefined : /^(\d+)x(\d+)$/.exec(options.size.trim());
      if (size === null) throw new UsageError(`--size takes <width>x<height> in pixels, e.g. --size 1600x900, got "${options.size}".`);
      const index = options.index === undefined ? undefined : Number(options.index);
      if (index !== undefined && (!Number.isInteger(index) || index < 1)) throw new UsageError("--index takes a whole number >= 1 (1 = right after the primary).");
      return {
        kind: "format.add",
        id: args[0]!,
        ...(size ? { width: Number(size[1]), height: Number(size[2]) } : {}),
        ...(index !== undefined ? { index } : {}),
      };
    }
    case "remove":
      return args.length === 1 ? { kind: "format.remove", id: args[0]! } : null;
    default:
      return null;
  }
}

/** Run a parsed `format` command; human output unless `json`. */
export async function executeFormat(conn: DaemonConnection, inv: FormatInvocation, cwd: string, json: boolean): Promise<string> {
  const print = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  switch (inv.kind) {
    case "format.list": {
      const result = await conn.request("format.list", { cwd });
      if (json) return print(result);
      const builtins = result.builtins.map((format) => `${format.id} ${format.width}x${format.height}`).join(", ");
      return `${result.formats.map(line).join("\n")}\nBuilt-in: ${builtins}\n`;
    }
    case "format.add": {
      const { kind: _kind, ...params } = inv;
      const result = await conn.request("format.add", { cwd, ...params });
      return json ? print(result) : changed(`Added format ${inv.id}`, result);
    }
    case "format.remove": {
      const result = await conn.request("format.remove", { cwd, id: inv.id });
      return json ? print(result) : changed(`Removed format ${inv.id}`, result);
    }
  }
}

function line(format: FormatInfo): string {
  return `${format.id}  ${format.width}x${format.height}${format.primary ? "  primary" : ""}`;
}

/** What changed, the formats now, and the command that undoes it. */
function changed(what: string, result: FormatChange): string {
  const { method, params } = result.undo;
  const undo =
    method === "format.remove"
      ? `frameshell format remove ${String(params["id"])}`
      : `frameshell format add ${String(params["id"])} --size ${String(params["width"])}x${String(params["height"])} --index ${String(params["index"])}`;
  return `${what} (${result.op}). Formats: ${result.formats.map((format) => format.id).join(", ")}\n  undo: ${undo}\n`;
}
