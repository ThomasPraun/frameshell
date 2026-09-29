import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ErrorCode, type ProjectInitResult, type ProjectSummary, RpcError } from "@frameshell/protocol";
import { createProjectConfig, createTimeline, parseProjectConfig } from "@frameshell/schema";

/** Project config file name; its directory is the project root. */
export const PROJECT_FILE = "frameshell.json";

/** Directories scaffolded by init (SPEC §5.1). Trailing `/` marks a directory. */
const LAYOUT_DIRS = [
  "timelines/",
  "scripts/",
  "assets/",
  "compositions/",
  "transcripts/",
  ".frameshell/cache/clips/",
  ".frameshell/proxies/",
  ".frameshell/waveforms/",
  ".frameshell/thumbs/",
  ".frameshell/history/",
  ".frameshell/rejected/",
];

/** Projects the daemon holds open, keyed by absolute root directory. */
export class ProjectRegistry {
  readonly #open = new Map<string, ProjectSummary>();

  /**
   * Scaffold a project in `dir` (created if missing) and open it.
   * Throws `ProjectExists` instead of overwriting an existing `frameshell.json`.
   */
  async init(dir: string, name?: string): Promise<ProjectInitResult> {
    const root = resolve(dir);
    const configPath = join(root, PROJECT_FILE);
    if (await exists(configPath)) {
      throw new RpcError(ErrorCode.ProjectExists, `A project already exists at ${configPath}`, { path: configPath });
    }
    const created: string[] = [];
    for (const rel of LAYOUT_DIRS) {
      await mkdir(join(root, rel), { recursive: true });
      created.push(rel);
    }
    const config = createProjectConfig(name?.trim() || basename(root) || "Untitled");
    await writeJsonAtomic(join(root, config.main), createTimeline("main"));
    created.push(config.main);
    // .frameshell/ holds only regenerable or machine-local state (SPEC §2 cross-cutting rules).
    const ignorePath = join(root, ".gitignore");
    if (!(await exists(ignorePath))) {
      await writeFile(ignorePath, ".frameshell/\n");
      created.push(".gitignore");
    }
    // Config last: its presence marks a complete project.
    await writeJsonAtomic(configPath, config);
    created.push(PROJECT_FILE);

    const project = { dir: root, name: config.name, schemaVersion: config.schemaVersion };
    this.#open.set(root, project);
    return { project, created };
  }

  /**
   * Open the project whose root is `cwd` or its nearest ancestor holding
   * `frameshell.json`. Returns `null` when none. Throws `InvalidProjectFile`
   * when the config fails validation. Re-reads on every call so edits show.
   */
  async openEnclosing(cwd: string): Promise<ProjectSummary | null> {
    const configPath = await findUp(resolve(cwd), PROJECT_FILE);
    if (!configPath) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(configPath, "utf8"));
    } catch (error) {
      throw invalid(configPath, (error as Error).message);
    }
    const parsed = parseProjectConfig(raw);
    if (!parsed.ok) throw invalid(configPath, parsed.error);
    const root = dirname(configPath);
    const project = { dir: root, name: parsed.value.name, schemaVersion: parsed.value.schemaVersion };
    this.#open.set(root, project);
    return project;
  }

  /** Snapshot of open projects. */
  list(): ProjectSummary[] {
    return [...this.#open.values()];
  }
}

function invalid(path: string, details: string): RpcError {
  return new RpcError(ErrorCode.InvalidProjectFile, `Invalid ${path}:\n${details}`, { path, details });
}

async function findUp(start: string, file: string): Promise<string | null> {
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = join(dir, file);
    if (await exists(candidate)) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Temp + rename so readers never see a half-written file (SPEC §6.1). */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, path);
}
