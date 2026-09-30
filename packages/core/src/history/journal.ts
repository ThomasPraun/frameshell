import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type JournalEntry, JournalEntrySchema } from "@frameshell/protocol";

/**
 * Operation journal of one timeline (SPEC §6.2): `.frameshell/history/<timeline>.jsonl`,
 * one {@link JournalEntry} per line, append-only. Local and not shared: losing
 * it loses undo, never timeline content.
 */

/** Absolute journal path of timeline `id`. */
export function journalPath(root: string, id: string): string {
  return join(root, ".frameshell", "history", `${id}.jsonl`);
}

/**
 * Entries oldest first; empty when there is no journal. Lines that do not
 * parse (a write cut short by a crash, a hand edit) are skipped: history
 * degrades, the timeline stays usable.
 */
export async function readJournal(root: string, id: string): Promise<JournalEntry[]> {
  let text: string;
  try {
    text = await readFile(journalPath(root, id), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: JournalEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = JournalEntrySchema.safeParse(value);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries;
}

/** Append one entry. Callers serialize writes per timeline. */
export async function appendJournal(root: string, id: string, entry: JournalEntry): Promise<void> {
  const path = journalPath(root, id);
  await mkdir(dirname(path), { recursive: true });
  // A crash may leave a partial last line; start ours on a fresh one so only that line is lost.
  const prefix = await endsWithoutNewline(path);
  await appendFile(path, `${prefix ? "\n" : ""}${JSON.stringify(entry)}\n`);
}

async function endsWithoutNewline(path: string): Promise<boolean> {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    const { size } = await file.stat();
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    await file.read(last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    await file.close();
  }
}
