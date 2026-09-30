import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { type RejectionRecord, TimelineRejectionSchema } from "@frameshell/protocol";
import { appendJsonLine, readJsonLines } from "../fs-util.js";

/**
 * Durable record of refused direct edits (SPEC §6.4), so `status` lists them
 * across daemon restarts. The preserved copies under `.frameshell/rejected/`
 * are the source of truth; `.frameshell/rejected.jsonl` adds the details
 * (reason, message, revisions) a file name cannot hold. Kept outside
 * `rejected/` so that directory holds only the copies users browse.
 */

/** Project-relative directory of preserved copies. */
export const REJECTED_DIR = ".frameshell/rejected";

/** `<timestamp>-[<n>-]<timeline>.json`, the timestamp being an ISO time with `:` and `.` replaced by `-`. */
const PRESERVED_FILE = /^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3}Z)-(?:\d+-)?([A-Za-z0-9][A-Za-z0-9_-]*)\.json$/;

function logPath(root: string): string {
  return join(root, ".frameshell", "rejected.jsonl");
}

/** Record the details of a rejection whose copy is already at `rejection.preserved`. */
export async function recordRejection(root: string, rejection: RejectionRecord): Promise<void> {
  await appendJsonLine(logPath(root), rejection);
}

/**
 * Rejections whose preserved copy still exists, newest first, at most
 * `limit`. A copy with no log line is listed with reason `unknown`, its time
 * and timeline taken from the file name; names that do not match are skipped.
 */
export async function listRejections(root: string, limit: number): Promise<RejectionRecord[]> {
  const names = await readdir(join(root, REJECTED_DIR)).catch(() => [] as string[]);
  const present = new Set(names.map((name) => `${REJECTED_DIR}/${name}`));
  const byPath = new Map<string, RejectionRecord>();
  for (const value of await readJsonLines(logPath(root))) {
    const parsed = TimelineRejectionSchema.safeParse(value);
    if (parsed.success && present.has(parsed.data.preserved)) byPath.set(parsed.data.preserved, parsed.data);
  }
  const records = [...byPath.values()];
  for (const name of names) {
    const preserved = `${REJECTED_DIR}/${name}`;
    if (byPath.has(preserved)) continue;
    const match = PRESERVED_FILE.exec(name);
    if (!match) continue;
    const [, hour, minute, second, millis, timeline] = match;
    records.push({
      timeline: timeline!,
      reason: "unknown",
      message:
        "Kept here with no recorded reason (its details were lost, or an older frameshelld rejected it). " +
        `Compare it with timelines/${timeline}.json and reapply what you need.`,
      preserved,
      revision: revisionOf(await readFile(join(root, preserved), "utf8").catch(() => "")),
      current: null,
      at: `${hour}:${minute}:${second}.${millis}`,
    });
  }
  // Stable sort: equal times keep log order, reversed below with the rest.
  records.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return records.reverse().slice(0, limit);
}

/** `revision` of unvalidated content, when it has a readable one. */
export function revisionOf(text: string): number | null {
  try {
    const revision = (JSON.parse(text) as { revision?: unknown } | null)?.revision;
    return Number.isInteger(revision) ? (revision as number) : null;
  } catch {
    return null;
  }
}
