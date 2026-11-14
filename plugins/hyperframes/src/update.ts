import { readFile, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { CommandContext, CommandResult, PluginCommand } from "@frameshell/plugin-api";
import { compositionDir } from "./adapter.js";
import { COMPOSITIONS, entryOf, scaffoldedEntries } from "./check.js";
import { MOTION_RUNTIME, MOTION_RUNTIME_FILE, MOTION_RUNTIME_VERSION } from "./motion-runtime.js";
import { THREE_HEADER, THREE_RUNTIME, THREE_RUNTIME_FILE, THREE_VERSION } from "./three-runtime.js";

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

/** One frozen copy's result in `data.compositions` of `frameshell hyperframes update`. */
export interface RuntimeUpdate {
  /** Project-relative, `/`-separated path of the copy: `frameshell-motion.js`, or `frameshell-three.js` of a 3D composition. */
  file: string;
  status: RuntimeStatus;
  /** Version the copy named before; null when it named none. */
  from: string | null;
  /** True when the file was (or under `--dry-run` would be) written. */
  written: boolean;
}

/** `data` of `frameshell hyperframes update`. */
export interface UpdateReport {
  /** Motion runtime version the plugin bundles. */
  runtime: string;
  /** three.js version the plugin bundles (ADR 0042). */
  three: string;
  dryRun: boolean;
  compositions: RuntimeUpdate[];
}

/** A script the plugin ships and scaffolding copies into compositions. */
interface Bundle {
  file: string;
  text: string;
  version: string;
  /** What the output calls it. */
  label: string;
  /** First line of a copy, capturing its version. */
  header: RegExp;
}

const MOTION: Bundle = {
  file: MOTION_RUNTIME_FILE,
  text: MOTION_RUNTIME,
  version: MOTION_RUNTIME_VERSION,
  label: "runtime",
  header: /^\/\* Frameshell motion runtime (\d+)\.(\d+)\.(\d+) \(ADR 0033\)/,
};
const THREE: Bundle = {
  file: THREE_RUNTIME_FILE,
  text: THREE_RUNTIME,
  version: THREE_VERSION,
  label: "three.js",
  header: THREE_HEADER,
};

/** Version named in the first line of a copy, as numbers; null when it is not a Frameshell copy of `bundle`. */
function versionOf(bundle: Bundle, text: string): [number, number, number] | null {
  const match = bundle.header.exec(text);
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
 * that `hyperframes new --template` put next to compositions (ADR 0033), and
 * of the three.js bundle (`frameshell-three.js`) next to 3D ones (ADR 0042).
 * A copy never changes by itself, so a clip renders the same after a plugin
 * upgrade; this applies runtime fixes on request. Older Frameshell copies are
 * replaced; an edited copy, a newer one or a file that is not ours is kept
 * unless `--force`. The runtime is a cache input, so the clips that use a
 * refreshed copy re-render.
 */
export const updateRuntime: PluginCommand = {
  description: "Refresh the frozen frameshell-motion.js (and frameshell-three.js) copies in motion compositions (--dry-run to preview)",
  async run(ctx: CommandContext): Promise<CommandResult> {
    const { composition, dryRun, force } = parseArgs(ctx.args);
    const entries = composition === undefined ? await scaffoldedEntries(ctx.project.dir) : [await entryOf(composition, ctx)];
    const report: UpdateReport = { runtime: MOTION_RUNTIME_VERSION, three: THREE_VERSION, dryRun, compositions: [] };
    const bundleOf = new Map<string, Bundle>();
    for (const entry of entries) {
      const dir = await compositionDir(ctx.project.dir, { id: entry, source: entry });
      for (const bundle of [MOTION, THREE]) {
        const path = join(dir.path, bundle.file);
        const file = posix.join(dir.rel, bundle.file);
        const text = await readFile(path, "utf8").catch(() => null);
        if (text === null) {
          if (bundle === THREE) continue;
          if (composition !== undefined) throw new Error(`${file} does not exist: ${entry} is not a motion composition (scaffold one with \`frameshell hyperframes new <name> --template <id>\`)`);
          break;
        }
        const have = versionOf(bundle, text);
        const order = have === null ? 0 : compare(have, versionOf(bundle, bundle.text)!);
        const status: RuntimeStatus = text === bundle.text ? "current" : have === null ? "foreign" : order < 0 ? "updated" : order > 0 ? "newer" : "modified";
        const written = status === "updated" || (force && status !== "current");
        if (written && !dryRun) await writeFile(path, bundle.text);
        report.compositions.push({ file, status, from: have ? have.join(".") : null, written });
        bundleOf.set(file, bundle);
      }
    }
    if (composition === undefined && report.compositions.length === 0) {
      return { output: `No motion compositions in ${COMPOSITIONS}/ (none has ${MOTION_RUNTIME_FILE}).`, data: report };
    }
    const lines = report.compositions.map((item) => {
      const { label, version } = bundleOf.get(item.file)!;
      const said = {
        current: `already ${label} ${version}`,
        updated: `${dryRun ? "would update" : "updated"} ${label} ${item.from} -> ${version}`,
        modified: `edited copy of ${label} ${item.from}${item.written ? "" : ", kept (--force replaces it)"}`,
        newer: `${label} ${item.from} is newer than this plugin's ${version}${item.written ? "" : ", kept (--force replaces it)"}`,
        foreign: `not a Frameshell ${label}${item.written ? "" : ", kept (--force replaces it)"}`,
      }[item.status];
      const forced = item.written && item.status !== "updated" ? ` (--force: ${dryRun ? "would replace" : "replaced"})` : "";
      return `${item.file}: ${said}${forced}`;
    });
    if (report.compositions.some((item) => item.written && !dryRun)) lines.push("Clips that use a refreshed copy render again.");
    return { output: lines.join("\n"), data: report };
  },
};
