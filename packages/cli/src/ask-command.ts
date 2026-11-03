// `frameshell ask` (ADR 0025 decision 4): read what the person sent from the app's "Chat about this", from any terminal.
// Kept apart from `run.ts` so `--take`, run by agent hooks on every prompt, loads little and never starts the daemon.
import { parseArgs } from "node:util";
import {
  type AgentReference,
  type DaemonConnection,
  ErrorCode,
  INBOX_WAIT_DEFAULT_S,
  INBOX_WAIT_MAX_S,
  RpcError,
  connectToDaemon,
  isDaemonUnavailable,
  resolveSocketPath,
} from "@frameshell/protocol";
import { connectOrStartDaemon } from "./daemon-client.js";
import { resolveAgent, resolveSession } from "./session.js";

/** Usage of `frameshell ask`. */
export const ASK_USAGE = `Usage: frameshell ask --take [--target <id>] [--json]
       frameshell ask --wait [--as <name>] [--timeout s] [--json]

Print the references the person sent from the Frameshell app ("Chat about this", Cmd/Ctrl+L): one
\`[frameshell]\` line per selected item, then any request, a blank line between references. Printing
removes them.

  --take          Print what waits and exit 0; print nothing when nothing waits, outside a project or
                  when the app's daemon is not running (never starts it). Safe for prompt hooks.
                  --target: the target to read (default: the agent this runs under, FRAMESHELL_AGENT)
  --wait          Register this terminal as a target (shown in the app's "Chat about this" menu as
                  --as, default FRAMESHELL_AGENT or \`terminal\`) and block until the person sends something
                  or --timeout seconds pass (default ${INBOX_WAIT_DEFAULT_S}, max ${INBOX_WAIT_MAX_S}). Exit code 6 when nothing
                  came (run it again)
`;

/** Flags `frameshell ask` takes besides the global ones. */
export const ASK_FLAGS: readonly string[] = ["take", "wait", "target", "as", "timeout"];

/** Exit code of `ask --wait` when nothing came before the timeout, as `proposal wait` uses it. */
const NOTHING_CAME = 6;

/** Process surface of `frameshell ask`. */
export interface AskIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Run `frameshell ask …` (`argv` after `ask`). Returns the exit code: 0 ok, 1 failed, 2 usage error, 6 nothing came. Never throws. */
export async function runAsk(argv: string[], io: AskIo): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        take: { type: "boolean", default: false },
        wait: { type: "boolean", default: false },
        target: { type: "string" },
        as: { type: "string" },
        timeout: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    }));
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\n${ASK_USAGE}`);
    return 2;
  }
  if (values.help) {
    io.stdout(ASK_USAGE);
    return 0;
  }
  const usage = (message: string) => {
    io.stderr(`${message}\n\n${ASK_USAGE}`);
    return 2;
  };
  if (values.take === values.wait) return usage("`frameshell ask` takes one of --take or --wait.");
  if (values.take && (values.as !== undefined || values.timeout !== undefined)) return usage("--as and --timeout go with --wait.");
  if (values.wait && values.target !== undefined) return usage("--target goes with --take; --wait reads its own inbox.");
  let timeout: number | undefined;
  if (values.timeout !== undefined) {
    timeout = Number(values.timeout);
    if (values.timeout.trim() === "" || !Number.isFinite(timeout) || timeout <= 0 || timeout > INBOX_WAIT_MAX_S) {
      return usage(`--timeout takes seconds from above 0 to ${INBOX_WAIT_MAX_S}, e.g. --timeout 120.`);
    }
  }
  const client = values.as ?? (io.env["FRAMESHELL_AGENT"] || "terminal");
  if (client.trim() === "") return usage("--as takes a name, e.g. --as codex.");
  const handshake = { client: "cli/ask", session: resolveSession(io.env), agent: resolveAgent(io.env) };
  const socketPath = resolveSocketPath(io.env);
  let conn: DaemonConnection | undefined;
  try {
    if (values.take) {
      try {
        conn = await connectToDaemon(socketPath, handshake);
      } catch (error) {
        if (isDaemonUnavailable(error)) return 0;
        throw error;
      }
      let result;
      try {
        result = await conn.request("inbox.take", { cwd: io.cwd, ...(values.target ? { target: values.target } : {}) });
      } catch (error) {
        if (error instanceof RpcError && error.code === ErrorCode.ProjectNotFound) return 0;
        throw error;
      }
      if (values.json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      else if (result.references.length > 0) io.stdout(formatReferences(result.references));
      return 0;
    }
    conn = await connectOrStartDaemon({ socketPath, ...handshake, env: io.env });
    await conn.request("target.register", { cwd: io.cwd, client, kind: "cli" });
    const result = await conn.request("inbox.wait", { cwd: io.cwd, ...(timeout !== undefined ? { timeout } : {}) });
    if (values.json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    else io.stdout(formatReferences(result.references));
    return result.references.length > 0 ? 0 : NOTHING_CAME;
  } catch (error) {
    const payload =
      error instanceof RpcError
        ? { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
        : { message: (error as Error)?.message ?? String(error) };
    io.stderr(values.json ? `${JSON.stringify({ error: payload }, null, 2)}\n` : `frameshell: ${payload.message}\n`);
    return 1;
  } finally {
    conn?.close();
  }
}

/** References as the app's terminals get them: their lines, a blank line between references. */
export function formatReferences(references: readonly AgentReference[]): string {
  return references.map((reference) => `${reference.lines.join("\n")}\n`).join("\n");
}
