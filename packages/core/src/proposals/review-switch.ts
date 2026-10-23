import { join } from "node:path";
import type { AppDirs } from "@frameshell/protocol";
import { z } from "zod";
import { readJsonIfExists, writeJsonAtomic } from "../fs-util.js";

const ReviewFileSchema = z.object({
  version: z.literal(1),
  projects: z.record(z.string(), z.object({ enabled: z.literal(true), since: z.string() })),
});

type ReviewFile = z.output<typeof ReviewFileSchema>;

/**
 * Key of canonical project root `root` in `review.json`. Windows paths compare case-insensitively and take
 * either separator, so there they are lower-cased with backslash separators and no trailing one; elsewhere `root` as is.
 */
export function reviewKey(root: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return root;
  const key = root.replace(/\//g, "\\").toLowerCase();
  return /^[a-z]:\\$/.test(key) ? key : key.replace(/\\+$/, "");
}

/**
 * Review mode switch per project (ADR 0019), in `<configDir>/review.json`,
 * keyed by canonical project root; only projects with review on are listed.
 * Outside the project on purpose: an agent edits project files, and the
 * switch must not change through them. A moved or cloned project starts
 * with review off. The daemon is the only writer, so the file is read once.
 */
export class ReviewSwitch {
  readonly #file: string;
  #state: Promise<ReviewFile> | null = null;

  constructor(dirs: AppDirs) {
    this.#file = join(dirs.configDir, "review.json");
  }

  /** Whether review mode is on for canonical project root `root`. A missing or corrupt file means off everywhere. */
  async enabled(root: string): Promise<boolean> {
    return Object.hasOwn((await this.#read()).projects, reviewKey(root));
  }

  /** Turn review mode on or off for canonical project root `root`. */
  async set(root: string, enabled: boolean): Promise<void> {
    const file = structuredClone(await this.#read());
    const key = reviewKey(root);
    if (enabled === Object.hasOwn(file.projects, key)) return;
    if (enabled) file.projects[key] = { enabled: true, since: new Date().toISOString() };
    else delete file.projects[key];
    await writeJsonAtomic(this.#file, file);
    this.#state = Promise.resolve(file);
  }

  #read(): Promise<ReviewFile> {
    this.#state ??= readJsonIfExists(this.#file).then(
      (value) => {
        const parsed = ReviewFileSchema.safeParse(value);
        if (!parsed.success) return { version: 1 as const, projects: {} };
        // Keys written by hand or by an older spelling still match.
        const projects = Object.fromEntries(Object.entries(parsed.data.projects).map(([root, entry]) => [reviewKey(root), entry]));
        return { version: 1 as const, projects };
      },
      () => ({ version: 1 as const, projects: {} }),
    );
    return this.#state;
  }
}
