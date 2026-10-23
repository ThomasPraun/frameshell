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
    return Object.hasOwn((await this.#read()).projects, root);
  }

  /** Turn review mode on or off for canonical project root `root`. */
  async set(root: string, enabled: boolean): Promise<void> {
    const file = structuredClone(await this.#read());
    if (enabled === Object.hasOwn(file.projects, root)) return;
    if (enabled) file.projects[root] = { enabled: true, since: new Date().toISOString() };
    else delete file.projects[root];
    await writeJsonAtomic(this.#file, file);
    this.#state = Promise.resolve(file);
  }

  #read(): Promise<ReviewFile> {
    this.#state ??= readJsonIfExists(this.#file).then(
      (value) => {
        const parsed = ReviewFileSchema.safeParse(value);
        return parsed.success ? parsed.data : { version: 1 as const, projects: {} };
      },
      () => ({ version: 1 as const, projects: {} }),
    );
    return this.#state;
  }
}
