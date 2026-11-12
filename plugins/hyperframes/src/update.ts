import { readFile, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { CommandContext, CommandResult, PluginCommand } from "@frameshell/plugin-api";
import { compositionDir } from "./adapter.js";
import { COMPOSITIONS, entryOf, scaffoldedEntries } from "./check.js";
import { MOTION_RUNTIME, MOTION_RUNTIME_FILE, MOTION_RUNTIME_VERSION } from "./motion-runtime.js";

const USAGE = "usage: frameshell hyperframes update [<composition>] [--dry-run] [--force]; <composition> is a name (`intro`), a composition directory or its HTML entry";

/** What `hyperframes update` found in one composition directory. */
export type RuntimeStatus =
  /** Same bytes as the bundled runtime. */
  | "current"
  /** An older Frameshell runtime, replaced (or that would be, under `--dry-run`). */
  | "updated"
  /** The bundled version, but the copy was edited; kept unless `--force`. */
  | "modified"
  /** A newer runtime than this plugin ships; kept unless `--force`. */
  | "newer"
  /** Not a Frameshell runtime (no header); kept unless `--force`. */
  | "foreign";

/** One composition's result in `data.compositions` of `frameshell hyperframes update`. */
export interface RuntimeUpdate {
  /** Project-relative, `/`-separated path of the runtime copy. */
  file: string;
  status: RuntimeStatus;
  /** Version the copy named before; null when it named none. */
  from: string | null;
  /** True when the file was (or under `--dry-run` would be) written. */
  written: boolean;
}

/** `data` of `frameshell hyperframes update`. */
export interface UpdateReport {
  /** Version the plugin bundles. */
  runtime: string;
  dryRun: boolean;
  compositions: RuntimeUpdate[];
}

const HEADER = /^\/\* Frameshell motion runtime (\d+)\.(\d+)\.(\d+) \(ADR 0033\)/;

/** Version named in the first line of a runtime copy, as numbers; null when it is not a Frameshell runtime. */
function versionOf(text: string): [number, number, number] | null {
  const match = HEADER.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

function parseArgs(args: readonly string[]): { composition: string | undefined; dryRun: boolean; force: boolean } {
  let composition: string | undefined;
  let [dryRun, force] = [false, false];
  for (const arg of args) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--force") force = true;
    else if (arg.startsWith("-")) throw new Error(`unknown argument ${arg}; ${USAGE}`);
    else if (composition === undefined) composition = arg;
    else throw new Error(`one composition at a time, got ${composition} and ${arg}; ${USAGE}`);
  }
  return { composition, dryRun, force };
}

/**
 * `frameshell hyperframes update [<composition>] [--dry-run] [--force]`:
 * refreshes the frozen copies of the motion runtime (`frameshell-motion.js`)
 * that `hyperframes new --template` put next to compositions (ADR 0033).
 * A copy never changes by itself, so a clip renders the same after a plugin
 * upgrade; this applies runtime fixes on request. Older Frameshell copies are
 * replaced; an edited copy, a newer one or a file that is not ours is kept
 * unless `--force`. The runtime is a cache input, so the clips that use a
 * refreshed copy re-render.
 */
export const updateRuntime: PluginCommand = {
  description: "Refresh the frozen frameshell-motion.js copies in motion compositions (--dry-run to preview)",
  async run(ctx: CommandContext): Promise<CommandResult> {
    const { composition, dryRun, force } = parseArgs(ctx.args);
    const entries = composition === undefined ? await scaffoldedEntries(ctx.project.dir) : [await entryOf(composition, ctx)];
    const report: UpdateReport = { runtime: MOTION_RUNTIME_VERSION, dryRun, compositions: [] };
    for (const entry of entries) {
      const dir = await compositionDir(ctx.project.dir, { id: entry, source: entry });
      const path = join(dir.path, MOTION_RUNTIME_FILE);
      const file = posix.join(dir.rel, MOTION_RUNTIME_FILE);
      const text = await readFile(path, "utf8").catch(() => null);
      if (text === null) {
        if (composition !== undefined) throw new Error(`${file} does not exist: ${entry} is not a motion composition (scaffold one with \`frameshell hyperframes new <name> --template <id>\`)`);
        continue;
      }
      const have = versionOf(text);
      const status: RuntimeStatus =
        text === MOTION_RUNTIME ? "current" : have === null ? "foreign" : compare(have, versionOf(MOTION_RUNTIME)!) < 0 ? "updated" : compare(have, versionOf(MOTION_RUNTIME)!) > 0 ? "newer" : "modified";
      const written = status === "updated" || (force && status !== "current");
      if (written && !dryRun) await writeFile(path, MOTION_RUNTIME);
      report.compositions.push({ file, status, from: have ? have.join(".") : null, written });
    }
    if (composition === undefined && report.compositions.length === 0) {
      return { output: `No motion compositions in ${COMPOSITIONS}/ (none has ${MOTION_RUNTIME_FILE}).`, data: report };
    }
    const lines = report.compositions.map((item) => {
      const said = {
        current: `already runtime ${report.runtime}`,
        updated: `${dryRun ? "would update" : "updated"} runtime ${item.from} -> ${report.runtime}`,
        modified: `edited copy of runtime ${item.from}${item.written ? "" : ", kept (--force replaces it)"}`,
        newer: `runtime ${item.from} is newer than this plugin's ${report.runtime}${item.written ? "" : ", kept (--force replaces it)"}`,
        foreign: `not a Frameshell runtime${item.written ? "" : ", kept (--force replaces it)"}`,
      }[item.status];
      const forced = item.written && item.status !== "updated" ? ` (--force: ${dryRun ? "would replace" : "replaced"})` : "";
      return `${item.file}: ${said}${forced}`;
    });
    if (report.compositions.some((item) => item.written && !dryRun)) lines.push("Clips that use a refreshed copy render again.");
    return { output: lines.join("\n"), data: report };
  },
};
