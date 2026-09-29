import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Layout, normalizeLayout } from "../shared/layout.js";

/**
 * Per-project window layout, kept in app data rather than the project:
 * layout is a per-machine preference, and the daemon is the only writer of project files.
 */
export class LayoutStore {
  /** @param dir Directory holding one JSON file per project; created on first save. */
  constructor(private readonly dir: string) {}

  /** Stored layout for `projectDir`, or defaults when missing or unreadable. */
  async load(projectDir: string): Promise<Layout> {
    try {
      const stored = JSON.parse(await readFile(this.fileFor(projectDir), "utf8")) as { layout?: unknown } | null;
      return normalizeLayout(stored?.layout);
    } catch {
      return normalizeLayout(undefined);
    }
  }

  /** Persist atomically; a crash mid-write never leaves a half file. */
  async save(projectDir: string, layout: Layout): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = this.fileFor(projectDir);
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ projectDir, layout: normalizeLayout(layout) }, null, 2));
    await rename(temp, file);
  }

  /** Hashed name: project paths may hold characters invalid in file names. */
  private fileFor(projectDir: string): string {
    return join(this.dir, `${createHash("sha256").update(projectDir).digest("hex").slice(0, 16)}.json`);
  }
}
