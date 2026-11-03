// Edits of other programs' JSON config files (Claude Desktop, Claude Code): change only Frameshell's keys, keep every
// other byte, back up first. Shared by the app's "Connect …" buttons and `frameshell setup`.
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { ParseError } from "jsonc-parser";

// Required, not imported: its Node entry is UMD (no ESM named exports), while bundlers pick its ESM build.
const { applyEdits, modify, parse } = createRequire(import.meta.url)("jsonc-parser") as typeof import("jsonc-parser");

/** The config is not JSON (or not the shape Frameshell edits): Frameshell leaves it alone. */
export class InvalidConfigError extends Error {
  constructor(
    readonly file: string,
    detail = "is not valid JSON",
  ) {
    super(`${file} ${detail}`);
  }
}

/** Key of Frameshell's server under `mcpServers`. */
export const SERVER_KEY = "frameshell";

/** A place in a JSON document: object keys and array indexes. */
export type JsonPath = (string | number)[];

/** Parse JSON with comments and trailing commas; throws {@link InvalidConfigError} unless the top level is an object. */
export function parseConfig(text: string, file: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0 || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidConfigError(file);
  }
  return value as Record<string, unknown>;
}

/** The value at `path` of a parsed config, or undefined. */
export function valueAt(config: unknown, path: JsonPath): unknown {
  let current = config;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

/**
 * `text` with `value` set at `path` (removed when undefined; `insert`: put it into the array at that index instead of
 * replacing the item there). Formatted like the file's tool writes it when that leaves every other byte as it was
 * (checked by taking the value out again); else inserted as is, unformatted, so a file someone formatted by hand keeps
 * its layout.
 */
export function withValue(text: string, path: JsonPath, value: unknown, insert = false): string {
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" };
  const options = insert ? { isArrayInsertion: true } : {};
  const formatted = applyEdits(text, modify(text, path, value, { ...options, formattingOptions }));
  const plain = applyEdits(text, modify(text, path, value, options));
  const undo = (edited: string) => {
    try {
      return applyEdits(edited, modify(edited, path, undefined, {}));
    } catch {
      // Nothing left at `path` to take out (it was a removal).
      return edited;
    }
  };
  if (value !== undefined && valueAt(parse(text), path.slice(0, -1)) === undefined) return formatted;
  return undo(formatted) === undo(plain) ? formatted : plain;
}

/**
 * Change the config at `file` through `change(text)`, which returns the new text or null for no change. A missing file
 * is `{}` to `change`, and is created only when something changes. The file as it was goes to
 * `<file>.frameshell-backup` first. Returns the backup path, or null when nothing was backed up (no file, or no change).
 */
export async function editConfigFile(file: string, change: (text: string) => string | null): Promise<string | null> {
  const before = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const after = change(before ?? "{}\n");
  if (after === null || after === before) return null;
  await mkdir(dirname(file), { recursive: true });
  let backup: string | null = null;
  if (before !== null) {
    backup = `${file}.frameshell-backup`;
    await copyFile(file, backup);
  }
  // Written beside and renamed: the other program never reads half a file.
  const temp = join(dirname(file), `.${SERVER_KEY}-${process.pid}.tmp`);
  await writeFile(temp, after);
  await rename(temp, file);
  return backup;
}

/** Frameshell's server as an MCP client runs it. */
export interface ServerEntry {
  command: string;
  args: string[];
}

/**
 * The entry running `shim mcp`. On Windows through `cmd /c`: Claude Desktop and Claude Code start servers without a
 * shell, which cannot run a `.cmd` file directly.
 */
export function serverEntry(shim: string, platform: NodeJS.Platform): ServerEntry {
  return platform === "win32" ? { command: "cmd", args: ["/c", shim, "mcp"] } : { command: shim, args: ["mcp"] };
}
