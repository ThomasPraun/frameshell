import { type DaemonConnection, ErrorCode, RpcError } from "@frameshell/protocol";

/** Where the project of a call without `cwd` came from. */
export type ProjectSource = "server" | "app";

/** The directory a call without `cwd` acts in, and the project root there. */
export interface ResolvedProject {
  /** `cwd` to send: the server's directory, or the app window's project root. */
  cwd: string;
  root: string;
  source: ProjectSource;
}

/**
 * Default project of the MCP server (ADR 0014): the project enclosing the
 * directory it started in, else the project of the app window the user works
 * in (`ui.active`). One server registered globally (Claude Desktop) then
 * follows the window the user switches to. Resolved per call, never cached
 * across a switch; only a server directory found inside a project is kept.
 */
export class ProjectResolver {
  readonly #serverCwd: string;
  readonly #daemon: () => Promise<DaemonConnection>;
  #serverRoot: string | null = null;

  constructor(serverCwd: string, daemon: () => Promise<DaemonConnection>) {
    this.#serverCwd = serverCwd;
    this.#daemon = daemon;
  }

  /** Directory the server started in. */
  get serverCwd(): string {
    return this.#serverCwd;
  }

  /** Resolve now. Rejects with `ProjectNotFound` when neither the server's directory nor an app window has a project. */
  async resolve(): Promise<ResolvedProject> {
    if (this.#serverRoot) return { cwd: this.#serverCwd, root: this.#serverRoot, source: "server" };
    const conn = await this.#daemon();
    const status = await conn.request("status", { cwd: this.#serverCwd });
    if (status.project) {
      this.#serverRoot = status.project.dir;
      return { cwd: this.#serverCwd, root: status.project.dir, source: "server" };
    }
    const { dir } = await conn.request("ui.active", {});
    if (dir) return { cwd: dir, root: dir, source: "app" };
    throw new RpcError(
      ErrorCode.ProjectNotFound,
      `No Frameshell project: this MCP server runs in ${this.#serverCwd}, which is in no project, and no Frameshell app ` +
        "window shows one. Open a project in Frameshell, or pass cwd.",
      {
        cwd: this.#serverCwd,
        hint: "Ask the user to open the project in the Frameshell app, or pass `cwd`: an absolute directory inside the project.",
      },
    );
  }
}

/** Line added to a result whose project came from the app window, so the agent sees which project it acted on. */
export function appProjectNote(root: string): string {
  return `Project: ${root} (open in the Frameshell app window the user used last; pass \`cwd\` to act on another project).`;
}
