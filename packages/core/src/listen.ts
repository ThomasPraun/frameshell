import { lstat, unlink } from "node:fs/promises";
import { type Server, createConnection } from "node:net";

/**
 * Listen on `socketPath`, removing a stale unix socket left by a crashed daemon.
 *
 * Stale = the path is a socket and connecting to it is refused. A live owner
 * keeps `EADDRINUSE`; a non-socket file at the path is never deleted.
 * Windows pipes die with their process, so there is nothing to clean there.
 */
export async function listenCleaningStaleSocket(server: Server, socketPath: string): Promise<void> {
  try {
    await listen(server, socketPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || process.platform === "win32") throw error;
    if (await isListening(socketPath)) throw error;
    const stats = await lstat(socketPath);
    if (!stats.isSocket()) {
      throw new Error(`${socketPath} exists and is not a socket; refusing to remove it`, { cause: error });
    }
    await unlink(socketPath);
  }
  await listen(server, socketPath);
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function isListening(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}
