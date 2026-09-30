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
  const { app, page } = await launch(box);
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
    await app.close();
  }
});
