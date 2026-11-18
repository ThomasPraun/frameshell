import { ErrorCode, RpcError } from "@frameshell/protocol";
import { type BatchRow, BatchRowIdSchema, type Timeline, parseSlotTarget } from "@frameshell/schema";
import { findClip } from "./variant.js";

/** What a CSV cell is read as. A cell is always text in the file; the slot decides what the row's value is. */
export type CsvType = "text" | "number" | "boolean" | "json";

const TYPE_NAMES: Readonly<Record<string, CsvType>> = { text: "text", string: "text", number: "number", boolean: "boolean", json: "json" };

/** One thing wrong with the file, at the physical line where the record starts. */
interface Problem {
  line: number;
  column: string | null;
  message: string;
}

/** Problems listed in the error; the rest are counted. */
const MAX_PROBLEMS = 20;

/**
 * The type each props slot of a batch gets in a CSV column that does not name one: the type of the value the template
 * clip has at that path (a number stays a number, a list or object is read as JSON). A slot whose path the template does
 * not hold has no type, so its cells are text unless the header says otherwise (`price:number`).
 */
export function templateColumnTypes(template: Timeline, slots: Readonly<Record<string, string>>): ReadonlyMap<string, CsvType> {
  const types = new Map<string, CsvType>();
  for (const [name, slot] of Object.entries(slots)) {
    const target = parseSlotTarget(slot, name);
    if (target?.kind !== "props") continue;
    const clip = findClip(template, target.clip)?.clip as { props?: unknown } | undefined;
    let value: unknown = clip?.props;
    for (const key of target.path) {
      value = typeof value === "object" && value !== null && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
    }
    if (value === undefined) continue;
    types.set(name, typeof value === "string" ? "text" : typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "json");
  }
  return types;
}

/**
 * The rows of a CSV file (RFC 4180: quoted cells may hold the delimiter, quotes doubled, line breaks; the delimiter is
 * the comma, `;` or tab the header line uses most, a BOM is ignored). The header is `id` and slot names, in any order,
 * each optionally typed (`price:number`, `text`, `number`, `boolean`, `json`); a slot without a column keeps the template's
 * value for every row, and an empty cell leaves that slot to the template for that row. Cells are typed by the header,
 * else by `types` (the template's value, see {@link templateColumnTypes}), else text: `number` reads `12.5`, `boolean` reads
 * `true`/`false`/`yes`/`no`/`1`/`0`, `json` any JSON value. Throws InvalidProjectFile listing every problem with its line
 * and column (the first {@link MAX_PROBLEMS}).
 */
export function rowsFromCsv(text: string, path: string, slots: Readonly<Record<string, string>>, types: ReadonlyMap<string, CsvType>): BatchRow[] {
  const problems: Problem[] = [];
  let total = 0;
  const report = (line: number, column: string | null, message: string) => {
    total++;
    if (problems.length < MAX_PROBLEMS) problems.push({ line, column, message });
  };
  const records = parseRecords(text.replace(/^\uFEFF/, ""), report);
  const [head, ...body] = records;
  const rows: BatchRow[] = [];
  if (!head) {
    report(1, null, "the file is empty: the first line is the header, `id` and slot names");
  } else {
    const columns = readHeader(head.cells, slots, types, (message, column) => report(head.line, column, message));
    if (body.length === 0 && total === 0) report(head.line, null, "the file has a header and no rows");
    const ids = new Map<string, number>();
    for (const record of body) {
      if (record.cells.length !== head.cells.length) {
        report(record.line, null, `has ${record.cells.length} cell${record.cells.length === 1 ? "" : "s"}, the header has ${head.cells.length}`);
        continue;
      }
      const row = readRow(record, columns, report);
      if (!row) continue;
      const first = ids.get(row.id);
      if (first !== undefined) report(record.line, "id", `row id ${row.id} is used twice (line ${first}); ids name output files`);
      else ids.set(row.id, record.line);
      rows.push(row);
    }
  }
  if (total > 0) {
    const details = [
      ...problems.map((problem) => `line ${problem.line}${problem.column === null ? "" : `, column ${problem.column}`}: ${problem.message}`),
      ...(total > problems.length ? [`... and ${total - problems.length} more`] : []),
    ].join("\n");
    throw new RpcError(ErrorCode.InvalidProjectFile, `Invalid rows file ${path}:\n${details}`, { path, details, issues: problems });
  }
  return rows;
}

/** A column of the header: where its cells go and how they are read; `slot` is `id` for the id column. */
interface Column {
  slot: string;
  name: string;
  type: CsvType;
}

function readHeader(
  cells: readonly string[],
  slots: Readonly<Record<string, string>>,
  types: ReadonlyMap<string, CsvType>,
  report: (message: string, column: string | null) => void,
): (Column | null)[] {
  const seen = new Set<string>();
  const columns = cells.map((cell, index): Column | null => {
    const label = cell.trim();
    const position = `${index + 1}`;
    if (label === "") {
      report(`column ${position} has no name`, position);
      return null;
    }
    const [name = "", suffix] = splitOnce(label, ":");
    if (seen.has(name)) {
      report(`${name} is a column twice`, label);
      return null;
    }
    seen.add(name);
    if (name === "id") {
      if (suffix !== undefined) report("`id` is the row id and takes no type", label);
      return { slot: "id", name, type: "text" };
    }
    const slot = slots[name];
    if (slot === undefined) {
      report(`unknown slot ${name}; the header is \`id\` and slot names (${Object.keys(slots).join(", ")})`, label);
      return null;
    }
    const kind = parseSlotTarget(slot, name)?.kind;
    if (suffix !== undefined) {
      const type = TYPE_NAMES[suffix.trim().toLowerCase()];
      if (!type) {
        report(`unknown type ${suffix}; use text, number, boolean or json`, label);
        return null;
      }
      if (kind !== "props" && type !== "text") {
        report(`${name} is ${kind === "asset" ? "an asset" : "a voiceover"} slot: its cells are paths, so it takes no type but text`, label);
        return null;
      }
      return { slot: name, name, type };
    }
    return { slot: name, name, type: kind === "props" ? (types.get(name) ?? "text") : "text" };
  });
  if (!seen.has("id")) report("the header has no `id` column: every row needs an id, the name of its output file", null);
  return columns;
}

function readRow(record: CsvRecord, columns: readonly (Column | null)[], report: (line: number, column: string | null, message: string) => void): BatchRow | null {
  let id: string | null = null;
  const values: Record<string, unknown> = {};
  let failed = false;
  for (const [index, column] of columns.entries()) {
    if (!column) continue;
    const cell = record.cells[index]!;
    if (column.slot === "id") {
      const parsed = BatchRowIdSchema.safeParse(cell.trim());
      if (parsed.success) id = parsed.data;
      else {
        failed = true;
        report(record.line, "id", `${JSON.stringify(cell.trim())} ${parsed.error.issues[0]?.message ?? "is not a row id"}`);
      }
      continue;
    }
    // A text cell is left as written; only the other types ignore the spaces a spreadsheet leaves around a value.
    if (column.type === "text" ? cell === "" : cell.trim() === "") continue;
    const read = readCell(cell, column.type);
    if (read.ok) values[column.slot] = read.value;
    else {
      failed = true;
      report(record.line, column.name, `${read.message}${column.type === "text" ? "" : ` (write ${column.name}:text to read it as text)`}`);
    }
  }
  return failed || id === null ? null : { id, ...values };
}

function readCell(cell: string, type: CsvType): { ok: true; value: unknown } | { ok: false; message: string } {
  const text = cell.trim();
  switch (type) {
    case "text":
      return { ok: true, value: cell };
    case "number":
      return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text) ? { ok: true, value: Number(text) } : { ok: false, message: `expected a number, got ${JSON.stringify(cell)}` };
    case "boolean": {
      const word = text.toLowerCase();
      if (word === "true" || word === "yes" || word === "1") return { ok: true, value: true };
      if (word === "false" || word === "no" || word === "0") return { ok: true, value: false };
      return { ok: false, message: `expected true, false, yes, no, 1 or 0, got ${JSON.stringify(cell)}` };
    }
    case "json":
      try {
        return { ok: true, value: JSON.parse(text) as unknown };
      } catch (error) {
        return { ok: false, message: `expected JSON, got ${JSON.stringify(cell)}: ${(error as Error).message}` };
      }
  }
}

function splitOnce(text: string, separator: string): [string, string?] {
  const at = text.indexOf(separator);
  return at < 0 ? [text] : [text.slice(0, at).trim(), text.slice(at + 1)];
}

/** One record of the file: its cells and the line it starts on (1-based; a quoted cell may span lines). */
interface CsvRecord {
  cells: string[];
  line: number;
}

/** The delimiter the first line uses most outside quotes: `,` unless `;` or tab beat it. */
function delimiterOf(text: string): string {
  const counts = new Map<string, number>([
    [",", 0],
    [";", 0],
    ["\t", 0],
  ]);
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  let best = ",";
  for (const [delimiter, count] of counts) if (count > counts.get(best)!) best = delimiter;
  return best;
}

/** Split `text` into records of cells (RFC 4180), skipping blank lines; syntax problems go to `report`. */
function parseRecords(text: string, report: (line: number, column: string | null, message: string) => void): CsvRecord[] {
  const delimiter = delimiterOf(text);
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  /** The cell was quoted and its closing quote has been read: only a delimiter or a line break may follow. */
  let closed = false;
  let line = 1;
  let recordLine = 1;
  let quoteLine = 1;
  const endCell = () => {
    cells.push(field);
    field = "";
    closed = false;
  };
  const endRecord = () => {
    endCell();
    // A blank line is a single empty cell.
    if (cells.length > 1 || cells[0] !== "") records.push({ cells, line: recordLine });
    cells = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          closed = true;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
      recordLine = line;
      continue;
    }
    if (ch === delimiter) {
      endCell();
      continue;
    }
    if (closed) {
      report(line, null, "text after the closing quote of a cell: put a delimiter after it");
      closed = false;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      quoteLine = line;
      continue;
    }
    field += ch;
  }
  if (inQuotes) report(quoteLine, null, "a quoted cell opened here is never closed");
  if (field !== "" || cells.length > 0 || closed) endRecord();
  return records;
}
