import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type JournalEntry, JournalEntrySchema } from "@frameshell/protocol";
import { type Timeline, parseTimeline } from "@frameshell/schema";
import { appendJsonLine, readJsonLines, writeTextAtomic } from "../fs-util.js";

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
  const entries: JournalEntry[] = [];
  for (const value of await readJsonLines(journalPath(root, id))) {
    const parsed = JournalEntrySchema.safeParse(value);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries;
}

/** Append one entry. Callers serialize writes per timeline. */
export async function appendJournal(root: string, id: string, entry: JournalEntry): Promise<void> {
  await appendJsonLine(journalPath(root, id), entry);
}

/**
 * Head snapshot path: `.frameshell/history/<id>.head.json`, the timeline as
 * the journal's last entry wrote it. Timeline ids hold no `.`, so it never
 * collides with a journal.
 */
function headPath(root: string, id: string): string {
  return join(root, ".frameshell", "history", `${id}.head.json`);
}

/**
 * Timeline content the journal last recorded, so an edit made while no daemon
 * watched can be diffed and journaled on the next open. Null when missing or
 * unreadable. Callers check it against the last entry's `hash`: a crash
 * between journal append and snapshot write leaves it one step behind.
 */
export async function readHead(root: string, id: string): Promise<Timeline | null> {
  let text: string;
  try {
    text = await readFile(headPath(root, id), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = parseTimeline(JSON.parse(text));
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}

/** Replace the head snapshot with `text` (timeline file content). Callers serialize writes per timeline. */
export async function writeHead(root: string, id: string, text: string): Promise<void> {
  await writeTextAtomic(headPath(root, id), text);
}
