import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ErrorCode,
  type FileWriteResult,
  type PluginPins,
  type ProjectInitResult,
  type ProjectSummary,
  RpcError,
} from "@frameshell/protocol";
import {
  type ParseResult,
  type ProjectConfig,
  createProjectConfig,
  createTimeline,
  parseProjectConfig,
  parseTimeline,
} from "@frameshell/schema";
import { exists, writeJsonAtomic, writeTextAtomic } from "./fs-util.js";

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
  readonly #onOpen: (dir: string) => void;

  /** `onOpen` runs on every open, including re-opens: keep it idempotent. */
  constructor(options: { onOpen?: (dir: string) => void } = {}) {
    this.#onOpen = options.onOpen ?? (() => {});
  }

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
    this.#onOpen(root);
    return { project, created };
  }

  /**
   * Open the project whose root is `cwd` or its nearest ancestor holding
   * `frameshell.json`. Returns `null` when none. Throws `InvalidProjectFile`
   * when the config fails validation. Re-reads on every call so edits show.
   */
  async openEnclosing(cwd: string): Promise<ProjectSummary | null> {
    const found = await readEnclosingProject(cwd);
    if (!found) return null;
    const project = { dir: found.dir, name: found.config.name, schemaVersion: found.config.schemaVersion };
    this.#open.set(found.dir, project);
    this.#onOpen(found.dir);
    return project;
  }

  /** Like {@link openEnclosing}, but throws `ProjectNotFound` instead of returning `null`. */
  async requireEnclosing(cwd: string): Promise<ProjectSummary> {
    const project = await this.openEnclosing(cwd);
    if (project) return project;
    throw new RpcError(
      ErrorCode.ProjectNotFound,
      `No Frameshell project in ${cwd} or its parents. Run \`frameshell init\` to create one.`,
      { cwd },
    );
  }

  /** Declared plugin pins of the project rooted at `root` (SPEC §5.2). */
  async readPins(root: string): Promise<PluginPins> {
    return (await readConfig(root)).config.plugins;
  }

  /** Replace the declared plugin pins, keeping every other key of `frameshell.json` as written. */
  async writePins(root: string, pins: PluginPins): Promise<void> {
    const { raw } = await readConfig(root);
    await writeJsonAtomic(join(root, PROJECT_FILE), { ...raw, plugins: pins });
  }

  /**
   * Replace a text file inside the project enclosing `path`, atomically.
   * Confinement checks real paths, not path text: symlinked dirs cannot lead
   * outside the project, and case variants of `.frameshell/` are refused on
   * case-insensitive filesystems (APFS, NTFS).
   * Throws `OutsideProject` for paths in no project, under `.frameshell/`, or
   * naming a symlink; `InvalidProjectFile` when a config or timeline fails its schema.
   */
  async writeFile(path: string, content: string): Promise<FileWriteResult> {
    const target = resolve(path);
    const configPath = await findUp(dirname(target), PROJECT_FILE);
    if (!configPath) throw notInProject(target);
    const root = dirname(configPath);
    const realRoot = await realpath(root);

    // Pre-check before mkdir so no directory is created through a symlink or under .frameshell/.
    const { real: realAncestor, rest } = await realAncestorOf(dirname(target));
    assertWritable(target, relativeTo(realRoot, join(realAncestor, ...rest, basename(target))));
    await mkdir(dirname(target), { recursive: true });

    // Re-check on the canonical parent: realpath resolves symlinks and on-disk name case.
    const realParent = await realpath(dirname(target));
    let realTarget = join(realParent, basename(target));
    const entry = await lstat(realTarget).catch(() => null);
    if (entry?.isSymbolicLink()) {
      throw new RpcError(ErrorCode.OutsideProject, `${target} is a symlink; write the file it points to instead`, {
        path: target,
      });
    }
    if (entry) realTarget = await realpath(realTarget);
    const rel = relativeTo(realRoot, realTarget);
    assertWritable(target, rel);

    const validate = VALIDATED_FILES.find(({ match }) => match(rel))?.parse;
    if (validate) {
      let parsed: ParseResult<unknown>;
      try {
        parsed = validate(JSON.parse(content));
      } catch (error) {
        throw invalid(target, (error as Error).message);
      }
      if (!parsed.ok) throw invalid(target, parsed.error);
    }
    await writeTextAtomic(realTarget, content);
    if (rel === PROJECT_FILE) await this.openEnclosing(root);
    return { project: root, path: rel };
  }

  /** Snapshot of open projects. */
  list(): ProjectSummary[] {
    return [...this.#open.values()];
  }
}

/**
 * Validated config of the project enclosing `cwd` (searching upwards), or
 * `null` outside any project. Read-only: does not open the project. Throws
 * `InvalidProjectFile` when the config fails validation.
 */
export async function readEnclosingProject(cwd: string): Promise<{ dir: string; config: ProjectConfig } | null> {
  const configPath = await findUp(resolve(cwd), PROJECT_FILE);
  if (!configPath) return null;
  const dir = dirname(configPath);
  return { dir, config: (await readConfig(dir)).config };
}

async function readConfig(root: string): Promise<{ raw: Record<string, unknown>; config: ProjectConfig }> {
  const configPath = join(root, PROJECT_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw invalid(configPath, (error as Error).message);
  }
  const parsed = parseProjectConfig(raw);
  if (!parsed.ok) throw invalid(configPath, parsed.error);
  return { raw: raw as Record<string, unknown>, config: parsed.value };
}

/** Project files whose content the daemon must be able to load; a bad write would break the project. */
const VALIDATED_FILES: { match: (rel: string) => boolean; parse: (input: unknown) => ParseResult<unknown> }[] = [
  { match: (rel) => rel === PROJECT_FILE, parse: parseProjectConfig },
  { match: (rel) => /^timelines\/[^/]+\.json$/.test(rel), parse: parseTimeline },
];

function notInProject(target: string): RpcError {
  return new RpcError(
    ErrorCode.OutsideProject,
    `${target} is not inside a Frameshell project. Run \`frameshell init\` in its folder first.`,
    { path: target },
  );
}

/** `/`-separated path of `path` under `root`, or `null` when outside it. Both must be real paths. */
function relativeTo(root: string, path: string): string | null {
  const rel = relative(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/**
 * Refuse writes outside the project or into daemon-owned `.frameshell/`.
 * Case-folds the first segment: a case-insensitive filesystem maps `.FRAMESHELL` onto `.frameshell`.
 */
function assertWritable(target: string, rel: string | null): asserts rel is string {
  if (rel === null) throw notInProject(target);
  if ((rel.split("/")[0] ?? "").toLowerCase() === ".frameshell") {
    throw new RpcError(
      ErrorCode.OutsideProject,
      `${target} is daemon-owned state under .frameshell/; it cannot be written directly`,
      { path: target },
    );
  }
}

/** Realpath of the nearest existing ancestor of `dir`, plus the missing segments below it. */
async function realAncestorOf(dir: string): Promise<{ real: string; rest: string[] }> {
  const rest: string[] = [];
  for (let current = dir; ; current = dirname(current)) {
    try {
      return { real: await realpath(current), rest };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(current) === current) throw error;
      rest.unshift(basename(current));
    }
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
