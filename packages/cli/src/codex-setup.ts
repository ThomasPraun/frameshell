// Connect Codex (CLI, IDE extension and the ChatGPT desktop app, which share `config.toml`): Frameshell's MCP server as
// the `[mcp_servers.frameshell]` table. Only that table (and its sub-tables) change; every other byte stays, which is
// why the file is edited as text. A TOML parser checks the whole file before and after, so a file that does not parse
// is left alone and an edit that would change anything else never reaches the disk.
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import { InvalidConfigError, SERVER_KEY, type ServerSetup, type ServerState, TOOL_TIMEOUT_S, editConfigFile, sameEntry, serverEntry } from "./config-file.js";

/** Codex's own setting name for the table that holds MCP servers. */
const TABLE = "mcp_servers";

/** Seconds Codex waits for `frameshell mcp` to answer `initialize`; the first start may begin a daemon (default 10 s). */
const STARTUP_TIMEOUT_S = 60;

/** Codex's `config.toml`: under `CODEX_HOME` when set, else `~/.codex`. */
export function codexConfigPath(home: string, env: NodeJS.ProcessEnv): string {
  return join(env["CODEX_HOME"] || join(home, ".codex"), "config.toml");
}

/** Frameshell's server as the table Codex reads. */
export function codexServer(setup: ServerSetup): { command: string; args: string[]; startup_timeout_sec: number; tool_timeout_sec: number } {
  return { ...serverEntry(setup.command, setup.platform), startup_timeout_sec: STARTUP_TIMEOUT_S, tool_timeout_sec: TOOL_TIMEOUT_S };
}

/** A TOML basic string. JSON's escapes are TOML's, except that DEL must be escaped too. */
function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\u007f/g, "\\u007f");
}

/** The table text for `setup`, one key per line: what the app shows before connecting and what a person can paste. */
export function codexTable(setup: ServerSetup, eol = "\n"): string {
  const server = codexServer(setup);
  return (
    [
      `[${TABLE}.${SERVER_KEY}]`,
      `command = ${tomlString(server.command)}`,
      `args = [${server.args.map(tomlString).join(", ")}]`,
      `startup_timeout_sec = ${server.startup_timeout_sec}`,
      `tool_timeout_sec = ${server.tool_timeout_sec}`,
    ].join(eol) + eol
  );
}

/** Parse the whole file; a file that is not TOML (or whose `mcp_servers` is not a table) is {@link InvalidConfigError}. */
function parseToml(text: string, file: string): Record<string, unknown> {
  let config: Record<string, unknown>;
  try {
    config = parse(text);
  } catch (error) {
    const reason = (error as Error).message.split("\n")[0] ?? "";
    throw new InvalidConfigError(file, `is not valid TOML${reason ? ` (${reason})` : ""}`);
  }
  const servers = config[TABLE];
  if (servers !== undefined && (servers === null || typeof servers !== "object" || Array.isArray(servers))) {
    throw new InvalidConfigError(file, `has a \`${TABLE}\` that is not a table`);
  }
  return config;
}

function serverOf(config: Record<string, unknown>): unknown {
  return (config[TABLE] as Record<string, unknown> | undefined)?.[SERVER_KEY];
}

/** What `config.toml` says about Frameshell. */
export type CodexState = ServerState;

/** Read the state of the file at `file` for `setup`. Throws {@link InvalidConfigError} for a file that is not TOML. */
export async function codexState(file: string, setup: ServerSetup): Promise<CodexState> {
  const installed = await stat(dirname(file)).then(
    (info) => info.isDirectory(),
    () => false,
  );
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return { installed, connected: false, different: false };
  const current = serverOf(parseToml(text, file));
  const connected = sameEntry(current, serverEntry(setup.command, setup.platform));
  return { installed, connected, different: current !== undefined && !connected };
}

/** One line of the file with its line break, and the table it opens when it is a table header. */
interface Line {
  text: string;
  /** The key path of a `[table]` or `[[array]]` header, else null. */
  header: string[] | null;
}

const KEY = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*/y;

/** The dotted key path at the start of `text` (`a."b.c".d`), and what follows it; null when there is none. */
function keyPath(text: string): { path: string[]; rest: string } | null {
  const path: string[] = [];
  let at = 0;
  for (;;) {
    KEY.lastIndex = at;
    const match = KEY.exec(text);
    if (!match) return null;
    let key = match[2] ?? match[3] ?? "";
    if (match[1] !== undefined) {
      try {
        key = JSON.parse(`"${match[1]}"`) as string;
      } catch {
        return null;
      }
    }
    path.push(key);
    at = KEY.lastIndex;
    if (text[at] !== ".") return { path, rest: text.slice(at) };
    at += 1;
  }
}

/** The path of a table header line (`[a.b]`, `[[a.b]]`), else null. */
function headerOf(body: string): string[] | null {
  const open = /^\s*(\[\[?)/.exec(body);
  if (!open) return null;
  const parsed = keyPath(body.slice(open[0].length));
  if (!parsed) return null;
  const close = open[1] === "[[" ? "]]" : "]";
  return parsed.rest.startsWith(close) && /^\s*(#.*)?$/.test(parsed.rest.slice(close.length)) ? parsed.path : null;
}

/**
 * Split `text` into lines and find the table headers. Values that span lines (multi-line strings, arrays) are skipped
 * so a line inside one is never taken for a header.
 */
function scan(text: string): Line[] {
  const lines: Line[] = [];
  let multi: string | null = null;
  let depth = 0;
  for (const raw of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const body = raw.replace(/\r?\n$/, "");
    const header = multi === null && depth === 0 ? headerOf(body) : null;
    lines.push({ text: raw, header });
    if (header) continue;
    let i = 0;
    while (i < body.length) {
      if (multi !== null) {
        const end = body.indexOf(multi, i);
        if (end < 0) break;
        i = end + 3;
        multi = null;
        continue;
      }
      const c = body[i]!;
      if (c === "#") break;
      if (c === '"' || c === "'") {
        if (body.startsWith(c.repeat(3), i)) {
          multi = c.repeat(3);
          i += 3;
          continue;
        }
        i += 1;
        while (i < body.length && body[i] !== c) i += c === '"' && body[i] === "\\" ? 2 : 1;
        i += 1;
        continue;
      }
      if (c === "[" || c === "{") depth += 1;
      else if (c === "]" || c === "}") depth = Math.max(0, depth - 1);
      i += 1;
    }
  }
  return lines;
}

/** Line ranges `[from, to)` of Frameshell's tables: the server's and its sub-tables, without comments or blank lines after them. */
function ownRanges(lines: Line[]): [number, number][] {
  const ranges: [number, number][] = [];
  lines.forEach((line, from) => {
    if (!line.header || line.header[0] !== TABLE || line.header[1] !== SERVER_KEY) return;
    let to = from + 1;
    while (to < lines.length && !lines[to]!.header) to += 1;
    while (to > from + 1 && /^\s*(#.*)?\r?\n?$/.test(lines[to - 1]!.text)) to -= 1;
    ranges.push([from, to]);
  });
  return ranges;
}

const isBlank = (line: Line | undefined) => line !== undefined && line.text.trim() === "";

/** `text` with Frameshell's tables set to `setup`'s (replaced where the first one was, else added at the end) or, without `setup`, removed. */
function edited(text: string, setup: ServerSetup | undefined): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = scan(text);
  const ranges = ownRanges(lines);
  const [first, ...more] = ranges;
  if (setup) {
    const table = codexTable(setup, eol);
    if (!first) {
      const head = text === "" || text.endsWith("\n") ? text : text + eol;
      return head + (head === "" || /\n\r?\n$/.test(head) ? "" : eol) + table;
    }
    for (const [from, to] of more.reverse()) lines.splice(from, to - from);
    lines.splice(first[0], first[1] - first[0], { text: table, header: null });
    return lines.map((line) => line.text).join("");
  }
  for (const [from, to] of ranges.reverse()) {
    let start = from;
    let end = to;
    // What an add put there: a blank line before the table at the end of the file, else the one after it.
    if (end === lines.length && isBlank(lines[start - 1])) start -= 1;
    else if (isBlank(lines[end])) end += 1;
    lines.splice(start, end - start);
  }
  return lines.map((line) => line.text).join("");
}

/** Equal parsed TOML values; objects compare by keys only (the parser makes them without a prototype). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && String(a) === String(b);
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const [x, y] = [a as Record<string, unknown>, b as Record<string, unknown>];
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every((key) => key in y && sameValue(x[key], y[key]));
}

/** Throws unless `after` parses to `before` with Frameshell's entry set to `server` (removed when undefined) and nothing else changed. */
function checkResult(file: string, before: Record<string, unknown>, after: string, server: unknown): void {
  const servers = { ...((before[TABLE] as Record<string, unknown> | undefined) ?? {}) };
  if (server === undefined) delete servers[SERVER_KEY];
  else servers[SERVER_KEY] = server;
  const expected = { ...before, [TABLE]: servers };
  const refuse = () =>
    new InvalidConfigError(file, `keeps \`${TABLE}.${SERVER_KEY}\` in a form Frameshell cannot edit without touching other settings (inline or dotted keys); change it by hand`);
  let actual: Record<string, unknown>;
  try {
    actual = parseToml(after, file);
  } catch {
    // The edit made a file that does not parse: a second definition of the same key, say.
    throw refuse();
  }
  // A `[mcp_servers]` table that is left empty may or may not exist as such.
  for (const config of [expected, actual]) if (Object.keys((config[TABLE] as object) ?? {}).length === 0) delete config[TABLE];
  if (!sameValue(expected, actual)) throw refuse();
}

/** The backup a change made; a file that did not change, or did not exist, has none. */
export type CodexBackup = string | null;

/**
 * Add (or point again at `setup.command`) the `[mcp_servers.frameshell]` table. A file whose server already runs it is
 * left untouched (timeouts someone tuned stay); a changed file is backed up to `<file>.frameshell-backup` first. A file
 * that is not TOML, or an edit that would change anything but Frameshell's tables, throws {@link InvalidConfigError}
 * before anything is written.
 */
export function connectCodex(file: string, setup: ServerSetup): Promise<CodexBackup> {
  return editConfigFile(
    file,
    (text) => {
      const before = parseToml(text, file);
      if (sameEntry(serverOf(before), serverEntry(setup.command, setup.platform))) return null;
      const next = edited(text, setup);
      checkResult(file, before, next, codexServer(setup));
      return next;
    },
    "",
  );
}

/** Remove Frameshell's table and its sub-tables, and nothing else. Same backup and checks as {@link connectCodex}. */
export function disconnectCodex(file: string): Promise<CodexBackup> {
  return editConfigFile(
    file,
    (text) => {
      const before = parseToml(text, file);
      if (serverOf(before) === undefined) return null;
      const next = edited(text, undefined);
      checkResult(file, before, next, undefined);
      return next;
    },
    "",
  );
}
