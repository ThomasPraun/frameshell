import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { CommandContext, CommandResult, PluginCommand } from "@frameshell/plugin-api";
import { compositionDir } from "./adapter.js";
import { seekSafetyFindings } from "./seek-safety.js";

/** Directory of `frameshell hyperframes new` compositions, project-relative. */
export const COMPOSITIONS = "compositions/hyperframes";

/** Composition name as `hyperframes new` takes it. */
const NAME = /^[a-z0-9][a-z0-9-]*$/;

const USAGE = "usage: frameshell hyperframes check [<composition>] [--strict] [--json]; <composition> is a name (`intro`), a composition directory or its HTML entry";

/** One lint finding, located in a composition file. */
export interface CheckFinding {
  /** Project-relative, `/`-separated path of the file the finding is in. */
  file: string;
  /** One-based position; null when the rule has no unique one. */
  line: number | null;
  column: number | null;
  /** Rule id, e.g. `non_deterministic_code`. */
  rule: string;
  severity: "error" | "warning" | "info";
  message: string;
  /** How to fix it; null when the rule gives none. */
  fix: string | null;
  /** CSS selector of the element the finding is about, when the rule names one. */
  selector: string | null;
}

/** Lint result of one composition. */
export interface CheckedComposition {
  /** Project-relative HTML entry. */
  composition: string;
  errors: number;
  warnings: number;
  infos: number;
  findings: CheckFinding[];
}

/** `data` of `frameshell hyperframes check`, what `--json` prints. */
export interface CheckReport {
  /** False when the run is blocking: errors, or any warning under `--strict`. */
  ok: boolean;
  strict: boolean;
  errors: number;
  warnings: number;
  infos: number;
  compositions: CheckedComposition[];
}

interface CheckArgs {
  composition: string | undefined;
  strict: boolean;
}

function parseArgs(args: readonly string[]): CheckArgs {
  let composition: string | undefined;
  let strict = false;
  for (const arg of args) {
    if (arg === "--strict") strict = true;
    else if (arg.startsWith("-")) throw new Error(`unknown argument ${arg}; ${USAGE}`);
    else if (composition === undefined) composition = arg;
    else throw new Error(`one composition at a time, got ${composition} and ${arg}; ${USAGE}`);
  }
  return { composition, strict };
}

/** Project-relative HTML entries of every `hyperframes new` composition: `compositions/hyperframes/<name>/index.html`. */
export async function scaffoldedEntries(projectDir: string): Promise<string[]> {
  const entries = await readdir(join(projectDir, ...COMPOSITIONS.split("/")), { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const html = `${COMPOSITIONS}/${entry.name}/index.html`;
    if (await isFile(join(projectDir, ...html.split("/")))) found.push(html);
  }
  return found;
}

/**
 * Project-relative entry named by `argument`: a `hyperframes new` name, a
 * directory holding `index.html`, or an HTML file. Paths are read from the
 * project root first, then from where the command ran.
 */
export async function entryOf(argument: string, ctx: CommandContext): Promise<string> {
  if (NAME.test(argument)) {
    const scaffolded = `${COMPOSITIONS}/${argument}/index.html`;
    if (await isFile(join(ctx.project.dir, ...scaffolded.split("/")))) return scaffolded;
  }
  const given = argument.replace(/\\/g, "/").replace(/\/+$/, "");
  for (const base of [ctx.project.dir, ctx.cwd]) {
    const absolute = isAbsolute(argument) ? argument : resolve(base, given);
    const path = (await isDirectory(absolute)) ? join(absolute, "index.html") : absolute;
    if (!(await isFile(path))) continue;
    const rel = relative(ctx.project.dir, path).split(sep).join("/");
    // Out-of-project paths keep their absolute spelling so `compositionDir` refuses them with its own message.
    return rel === ".." || rel.startsWith("../") || isAbsolute(rel) ? path.split(sep).join("/") : rel;
  }
  throw new Error(`no composition ${argument}: expected a \`hyperframes new\` name, a directory with index.html, or an HTML file under ${ctx.project.dir}`);
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

/** Lints one composition: `@hyperframes/lint` over its directory, plus the seek-safety rules of {@link seekSafetyFindings}. */
async function checkComposition(projectDir: string, entry: string): Promise<CheckedComposition> {
  const { lintProject } = await import("@hyperframes/lint");
  const dir = await compositionDir(projectDir, { id: entry, source: entry });
  const name = posix.basename(entry);
  const real = await realpath(dir.path).catch(() => dir.path);
  const projectRel = (file: string): string => {
    for (const base of [dir.path, real]) {
      const rel = isAbsolute(file) ? relative(base, file) : file;
      if (!(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) return posixJoin(dir.rel, rel);
    }
    return file.split(sep).join("/");
  };
  // The composition directory is the HyperFrames project (the render copies exactly it); only `index.html` is its default entry.
  const project = await lintProject(dir.path, name === "index.html" ? undefined : join(dir.path, name), { host: "cli" });
  const findings: CheckFinding[] = [];
  for (const { file, result } of project.results) {
    for (const finding of result.findings) {
      findings.push({
        file: projectRel(finding.file ?? file),
        line: finding.line ?? null,
        column: finding.column ?? null,
        rule: finding.code,
        severity: finding.severity,
        message: finding.message,
        fix: finding.fixHint ?? null,
        selector: finding.selector ?? null,
      });
    }
    const html = await readFile(join(dir.path, ...file.split("/")), "utf8").catch(() => "");
    for (const own of seekSafetyFindings(html)) {
      findings.push({ file: projectRel(file), line: own.line, column: own.column, rule: own.rule, severity: own.severity, message: own.message, fix: own.fix, selector: null });
    }
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0));
  const count = (severity: CheckFinding["severity"]): number => findings.filter((f) => f.severity === severity).length;
  return { composition: entry, errors: count("error"), warnings: count("warning"), infos: count("info"), findings };
}

function posixJoin(dir: string, rel: string): string {
  const path = rel.split(sep).join("/");
  return dir === "" ? path : `${dir}/${path}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function describe(report: CheckReport): string {
  const lines: string[] = [];
  for (const checked of report.compositions) {
    for (const f of checked.findings.filter((finding) => finding.severity !== "info")) {
      const at = f.line === null ? f.file : `${f.file}:${f.line}${f.column === null ? "" : `:${f.column}`}`;
      lines.push(`${at}  ${f.severity}  ${f.rule}  ${f.message}`);
      if (f.fix) lines.push(`    fix: ${f.fix}`);
    }
  }
  const total = `${plural(report.errors, "error")}, ${plural(report.warnings, "warning")} in ${plural(report.compositions.length, "composition")}`;
  const verdict = report.ok
    ? report.errors + report.warnings === 0
      ? "clean"
      : "no blocking problems"
    : report.strict
      ? "blocking: --strict also blocks on warnings"
      : "blocking: fix the errors before rendering";
  lines.push(`${total}: ${verdict}.`);
  return lines.join("\n");
}

/**
 * `frameshell hyperframes check [<composition>] [--strict]`: lints HyperFrames
 * compositions in-process with `@hyperframes/lint` (no network, no telemetry)
 * plus the seek-safety rules the linter lacks. Without an argument it checks
 * every `compositions/hyperframes/<name>/index.html`. Warnings never block;
 * errors do (`failed: true`, exit 1), and `--strict` makes warnings block too.
 */
export const checkCompositions: PluginCommand = {
  description: "Lint HyperFrames compositions (errors block; --strict also warnings)",
  async run(ctx: CommandContext): Promise<CommandResult> {
    const { composition, strict } = parseArgs(ctx.args);
    const entries = composition === undefined ? await scaffoldedEntries(ctx.project.dir) : [await entryOf(composition, ctx)];
    if (entries.length === 0) {
      throw new Error(`no compositions in ${COMPOSITIONS}/; create one with \`frameshell hyperframes new <name>\`, or pass the HTML entry of one`);
    }
    const compositions: CheckedComposition[] = [];
    for (const entry of entries) compositions.push(await checkComposition(ctx.project.dir, entry));
    const { shouldBlockRender } = await import("@hyperframes/lint");
    const sum = (key: "errors" | "warnings" | "infos"): number => compositions.reduce((total, c) => total + c[key], 0);
    const [errors, warnings, infos] = [sum("errors"), sum("warnings"), sum("infos")];
    const failed = shouldBlockRender(true, strict, errors, warnings);
    const report: CheckReport = { ok: !failed, strict, errors, warnings, infos, compositions };
    return { output: describe(report), data: report, failed };
  },
};
