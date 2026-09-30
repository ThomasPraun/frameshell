// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { type Server, type Socket, createServer } from "node:net";
import { expect, test } from "@playwright/test";
import type { FrameshellApi } from "../src/shared/api.js";
import { launch, sandbox } from "./harness.js";

// App launch (#103): the window loads before the daemon answers. A cold daemon on a loaded machine can take longer
// than any fixed wait; the window must not hang on it, and must not fall back to the welcome screen either.
const box = sandbox("demo");

/** Listen on the sandbox socket like a daemon that accepts connections and never answers the handshake. */
async function silentDaemon(): Promise<{ server: Server; stop: () => Promise<void> }> {
  const held: Socket[] = [];
  const server = createServer((socket) => void held.push(socket));
  await new Promise<void>((resolve) => server.listen(box.socketPath, resolve));
  return {
    server,
    // Dropped unanswered: the app's link starts the real daemon on the freed socket.
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of held) socket.destroy();
      }),
  };
}

test("the window loads at once, and opens the project when a slow daemon finally answers", async () => {
  const daemon = await silentDaemon();
  const { app, page } = await launch(box, { settled: false });
  try {
    await expect(page.locator(".boot")).toHaveCount(1);
    await expect(page.locator(".welcome")).toHaveCount(0);
    // Project calls made while the daemon is still silent wait for the startup open, never fail with "no project".
    const early = page.evaluate(async () => {
      const api = (window as unknown as { frameshell: FrameshellApi }).frameshell;
      const [assets, tree] = await Promise.all([api.media.assets(), api.files.tree()]);
      return { assets: Array.isArray(assets), tree: tree !== null };
    });
    await daemon.stop();
    expect(await early).toEqual({ assets: true, tree: true });
    await expect(page.locator(".titlebar-project")).toHaveText("Smoke demo");
    await expect(page.locator(".boot")).toHaveCount(0);
  } finally {
    // [DEBUG-109] which processes keep the app's close pending.
    const pid = app.process().pid;
    const started = Date.now();
    const closing = app.close();
    const stalled = await Promise.race([closing.then(() => false), new Promise((r) => setTimeout(() => r(true), 15_000))]);
    console.log(`[DEBUG-109] close after ${Date.now() - started} ms, stalled=${stalled}, electron pid ${pid}`);
    if (stalled && process.platform === "win32") {
      const { execFileSync } = await import("node:child_process");
      const ps = "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'electron|node|powershell|conhost|OpenConsole' } | Select-Object ProcessId,ParentProcessId,Name,CreationDate,CommandLine | Format-List | Out-String -Width 400";
      console.log(`[DEBUG-109] processes:\n${execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8" })}`);
    }
    await closing;
  }
});
