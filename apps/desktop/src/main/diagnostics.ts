import type { DoctorResult } from "@frameshell/protocol";

/** What the report may read about the open project: counts and flags only, never file contents. */
export interface ProjectDiagnostics {
  dir: string;
  schemaVersion: number;
  jobs: readonly { state: string }[];
  rejections: number;
  transactions: number;
  openProjects: number;
  synced: { service: string } | null;
}

/** Everything the report is built from; the caller gathers it, a failed part becomes `{ error }`. */
export interface DiagnosticsInput {
  appVersion: string;
  versions: { electron: string; chrome: string; node: string };
  os: { platform: string; release: string; arch: string };
  home: string;
  dataDir: string;
  daemon: { daemonVersion: string; protocolVersion: number } | { error: string };
  doctor: DoctorResult | { error: string };
  project: ProjectDiagnostics | { error: string } | null;
}

/** Far below an issue body's limit, so the report pastes next to the bug text. */
export const DIAGNOSTICS_MAX_BYTES = 8 * 1024;

const LINE_MAX = 300;

/** Shows paths under the user's home as `~/...` (also in free text such as error messages). */
export function redactHome(text: string, home: string): string {
  const bare = home.replace(/[\\/]+$/, "");
  if (!bare) return text;
  const pattern = new RegExp(`${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "g");
  return text.replace(pattern, "~").replace(/~((?:\\[^\s\\"']+)+)/g, (_match, rest: string) => `~${rest.replaceAll("\\", "/")}`);
}

const failed = (value: object): value is { error: string } => "error" in value;

/** Builds the plain-text report "Help > Copy Diagnostics" puts on the clipboard. No env values, no file contents. */
export function buildDiagnostics(input: DiagnosticsInput): string {
  const line = (text: string) => redactHome(text, input.home).replace(/\s+/g, " ").slice(0, LINE_MAX);
  const out: string[] = ["Frameshell diagnostics", ""];
  const section = (title: string, lines: string[]) => out.push(`## ${title}`, ...lines.map(line), "");

  section("App", [
    `Frameshell ${input.appVersion}`,
    `Electron ${input.versions.electron}, Chromium ${input.versions.chrome}, Node ${input.versions.node}`,
    `Data dir: ${input.dataDir}`,
  ]);
  section("System", [`${input.os.platform} ${input.os.release} (${input.os.arch})`]);
  section(
    "Daemon",
    failed(input.daemon)
      ? [`Unreachable: ${input.daemon.error}`]
      : [`frameshelld ${input.daemon.daemonVersion}, protocol ${input.daemon.protocolVersion}`],
  );

  const doctor = input.doctor;
  if (failed(doctor)) section("Doctor", [`Failed: ${doctor.error}`]);
  else {
    section("Doctor", [
      `Platform: ${doctor.platform}`,
      ...doctor.binaries.map(
        (binary) => `${binary.name}: ${binary.installed ? (binary.version ?? "installed") : "missing"} (${binary.source})`,
      ),
      ...doctor.codecs.map((codec) => {
        const hardware = codec.hardware ? `, hardware ${codec.works === null ? "untested" : codec.works ? "works" : "fails"}` : "";
        return `${codec.kind} ${codec.name}: ${codec.compiled ? "compiled" : "absent"}${hardware}`;
      }),
      doctor.problems.length === 0 ? "Problems: none" : `Problems (${doctor.problems.length}):`,
      ...doctor.problems.map((problem) => `- ${problem}`),
    ]);
  }

  const project = input.project;
  if (!project) section("Project", ["No project open in the focused window"]);
  else if (failed(project)) section("Project", [`Status failed: ${project.error}`]);
  else {
    const states = new Map<string, number>();
    for (const job of project.jobs) states.set(job.state, (states.get(job.state) ?? 0) + 1);
    section("Project", [
      `Folder: ${project.dir}`,
      `Schema version: ${project.schemaVersion}`,
      `Jobs: ${project.jobs.length}${[...states].map(([state, count]) => `, ${count} ${state}`).join("")}`,
      `Refused direct edits: ${project.rejections}`,
      `Open transactions: ${project.transactions}`,
      `Projects open in the daemon: ${project.openProjects}`,
      `Synced folder: ${project.synced ? project.synced.service : "no"}`,
    ]);
  }

  const report = `${out.join("\n").trimEnd()}\n`;
  if (Buffer.byteLength(report) <= DIAGNOSTICS_MAX_BYTES) return report;
  const cut = Buffer.from(report).subarray(0, DIAGNOSTICS_MAX_BYTES - 32).toString("utf8").replace(/�$/, "");
  return `${cut}\n[truncated]\n`;
}
