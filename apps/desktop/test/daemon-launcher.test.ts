import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  type FromSpawner,
  type SpawnerProcess,
  type ToSpawner,
  helperDaemonLauncher,
  serveDaemonSpawner,
} from "../src/main/daemon-launcher.js";
import { DaemonLink } from "../src/main/daemon-link.js";

// Seam under test: the app's daemon launcher (#112). `utilityProcess` exists only in Electron, so the helper runs
// in-process behind an in-memory channel; the e2e `daemon-stdio` spec covers the real utility process.

const socketPath = () =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-launcher-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-launch-${randomUUID().slice(0, 8)}.sock`);

const failingDaemon = fileURLToPath(new URL("./fixtures/failing-daemon.mjs", import.meta.url));

/** One in-memory helper: the main side as `SpawnerProcess`, the helper side served by `serveDaemonSpawner`. */
class FakeHelper extends EventEmitter implements SpawnerProcess {
  readonly received: ToSpawner[] = [];
  exitCode: number | undefined;
  #port = new EventEmitter();

  constructor(serve = true) {
    super();
    if (!serve) return;
    serveDaemonSpawner(
      {
        on: (event, listener) => this.#port.on(event, listener),
        postMessage: (message: FromSpawner) => queueMicrotask(() => this.emit("message", message)),
      },
      () => this.die(0),
    );
  }

  postMessage(message: ToSpawner): void {
    if (this.exitCode !== undefined) throw new Error("helper exited");
    this.received.push(message);
    queueMicrotask(() => this.#port.emit("message", { data: message }));
  }

  die(code: number): void {
    if (this.exitCode !== undefined) return;
    this.exitCode = code;
    queueMicrotask(() => this.emit("exit", code));
  }
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("helperDaemonLauncher", () => {
  it("starts the daemon from a helper, which exits once the link reached the daemon", async () => {
    const path = socketPath();
    const helpers: FakeHelper[] = [];
    const link = new DaemonLink({
      socketPath: path,
      client: "desktop/test",
      env: { ...process.env, FRAMESHELL_SOCKET: path, FRAMESHELL_IDLE_TIMEOUT_MS: "1000" },
      launch: helperDaemonLauncher(() => {
        const helper = new FakeHelper();
        helpers.push(helper);
        return helper;
      }),
    });
    cleanups.push(() => link.close());

    const status = await link.request("status", { cwd: realpathSync(tmpdir()) });
    expect(status.daemon.socketPath).toBe(path);
    expect(helpers).toHaveLength(1);
    expect(helpers[0]?.received.map((message) => message.kind)).toEqual(["start", "release"]);
    const start = helpers[0]?.received[0];
    expect(start?.kind === "start" && start.launch.execPath).toBe(process.execPath);
    await expect.poll(() => helpers[0]?.exitCode).toBe(0);
  });

  it("relays the daemon's startup error and stderr through the helper", async () => {
    const launch = helperDaemonLauncher(() => new FakeHelper());
    const daemon = launch({ execPath: process.execPath, entry: failingDaemon, env: process.env });
    cleanups.push(() => daemon.release());
    const outcome = await daemon.exited;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/exit code 1[\s\S]*cannot bind: test failure/);
    expect(daemon.stderr()).toBe("cannot bind: test failure");
  });

  it("fails the start when the helper dies before release", async () => {
    const helper = new FakeHelper(false);
    const daemon = helperDaemonLauncher(() => helper)({ execPath: process.execPath, entry: failingDaemon, env: {} });
    helper.die(3);
    const outcome = await daemon.exited;
    expect((outcome as Error).message).toMatch(/launcher exited \(code 3\)/);
    expect(() => daemon.release()).not.toThrow();
  });

  it("fails the start when the helper cannot be created", async () => {
    const daemon = helperDaemonLauncher(() => {
      throw new Error("app not ready");
    })({ execPath: process.execPath, entry: failingDaemon, env: {} });
    expect(((await daemon.exited) as Error).message).toMatch(/Could not start the frameshelld launcher: app not ready/);
  });
});
