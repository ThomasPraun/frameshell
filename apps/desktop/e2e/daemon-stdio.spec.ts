import { expect, test } from "@playwright/test";
import { connectToDaemon } from "@frameshell/protocol";
import { launch, sandbox } from "./harness.js";

// #112: the daemon the app starts must not hold the app's stdio. On Windows a child spawned from Electron's main
// process inherited its stdout/stderr pipes, so whoever read the app's output (Playwright here) saw them open until
// the daemon idled out. The daemon here idles out after a minute; the app's stdout must close with the app.
const box = sandbox("demo");
const IDLE_MS = 60_000;

test("the app's output closes when the app quits, while the daemon it started keeps running", async () => {
  const { app, page } = await launch(box, { env: { FRAMESHELL_IDLE_TIMEOUT_MS: String(IDLE_MS) } });
  let daemonPid: number | undefined;
  let closing = false;
  try {
    await expect(page.locator(".titlebar-project")).toHaveText("Smoke demo");
    const connection = await connectToDaemon(box.socketPath, { client: "e2e/daemon-stdio" });
    daemonPid = (await connection.request("status", { cwd: box.projectDir })).daemon.pid;
    connection.close();

    const stdout = app.process().stdout;
    if (!stdout) throw new Error("Playwright launched the app without a stdout pipe");
    const stdoutClosed = new Promise<void>((resolve) => (stdout.closed ? resolve() : stdout.once("close", () => resolve())));
    closing = true;
    await app.close();
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      stdoutClosed.then(() => "closed"),
      new Promise<string>((resolve) => (timer = setTimeout(() => resolve("still open"), 20_000))),
    ]);
    clearTimeout(timer);
    expect(outcome).toBe("closed");
    // Still alive: the app let go of its daemon instead of taking it down.
    expect(() => process.kill(daemonPid ?? 0, 0)).not.toThrow();
  } finally {
    if (!closing) await app.close();
    try {
      if (daemonPid) process.kill(daemonPid);
    } catch {
      // Already gone.
    }
  }
});
