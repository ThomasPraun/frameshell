import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { PROTOCOL_VERSION } from "@frameshell/protocol";

/** Isolated endpoint per test: named pipe on Windows, short unix socket path elsewhere. */
export function uniqueSocketPath(): string {
  const id = randomUUID().slice(0, 8);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-test-${id}`
    : join(realpathSync(tmpdir()), `fs-test-${id}.sock`);
}

/** Raw JSON-RPC line session: bypasses the typed client to send malformed requests. */
export interface RawSession {
  /** Send one request and resolve with the reply carrying the same id. */
  call(method: string, params?: unknown): Promise<{ id: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } }>;
  close(): void;
}

/** Open a raw session; handshakes first unless `handshake` is false. */
export async function rawSession(socketPath: string, handshake = true): Promise<RawSession> {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const waiting = new Map<number, (reply: never) => void>();
  let buffer = "";
  let nextId = 1;
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const reply = JSON.parse(buffer.slice(0, newline)) as { id: number };
      buffer = buffer.slice(newline + 1);
      waiting.get(reply.id)?.(reply as never);
      waiting.delete(reply.id);
    }
  });
  const session: RawSession = {
    call: (method, params) =>
      new Promise((resolve) => {
        const id = nextId++;
        waiting.set(id, resolve);
        const message = params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
        socket.write(`${JSON.stringify(message)}\n`);
      }),
    close: () => socket.destroy(),
  };
  if (handshake) {
    const reply = await session.call("handshake", { protocolVersion: PROTOCOL_VERSION, client: "raw-test" });
    if (reply.error) throw new Error(reply.error.message);
  }
  return session;
}

/** Fresh empty directory; realpath so macOS /var vs /private/var never differs. */
export function tempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "frameshell-test-")));
}
