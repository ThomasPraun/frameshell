import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";

// Videos the OS asks the app to open (#184): launch arguments on Windows and Linux, `open-file` on macOS. Both end
// in the same routing; launch arguments are what an e2e can pass.
const box = sandbox("demo");
const home = join(dirname(box.projectDir), "videos");
mkdirSync(home, { recursive: true });
const take = join(home, "take.mp4");
writeFileSync(take, Buffer.alloc(1024, 2));
const notes = join(home, "notes.pdf");
writeFileSync(notes, "%PDF");

test("a video opened from the OS is offered as a new project on the welcome screen", async () => {
  const { app, page } = await launch(box, { paths: [take, notes] });
  try {
    const form = page.getByRole("form", { name: "New project from video" });
    await expect(form.getByText("take.mp4")).toBeVisible();
    await expect(form.getByLabel("Project name")).toHaveValue("take");
    // Transcription would download the plugin and a 574 MB model: covered with a dead registry in new-from-video.
    await form.getByLabel("Transcribe what is said").uncheck();
    await form.getByRole("button", { name: "Create project" }).click();
    await expect(page.locator(".titlebar-project")).toHaveText("take", { timeout: 60_000 });
    expect(app.windows()).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test("a video whose project exists opens that project, and a project folder opens as a project", async () => {
  // The first test made `videos/take/` from this video.
  const { app, page } = await launch(box, { paths: [take] });
  try {
    await expect(page.locator(".titlebar-project")).toHaveText("take", { timeout: 60_000 });
  } finally {
    await app.close();
  }
  const folder = await launch(box, { paths: [box.projectDir] });
  try {
    await expect(folder.page.locator(".titlebar-project")).toHaveText("Smoke demo", { timeout: 60_000 });
  } finally {
    await folder.app.close();
  }
});

// Unpackaged builds take no single-instance lock (a dev build runs beside the installed app), so only a packaged app
// hands a second launch's files to the running one.
test("a second launch hands its video to the running app", async () => {
  const packaged = process.env["FRAMESHELL_E2E_APP"];
  test.skip(!packaged, "needs a packaged app (FRAMESHELL_E2E_APP)");
  const { app, page } = await launch(box, { paths: [] });
  try {
    await expect(page.locator(".welcome")).toHaveCount(1);
    const second = join(home, "second.mov");
    writeFileSync(second, Buffer.alloc(512, 4));
    const env = { ...process.env, FRAMESHELL_SOCKET: box.socketPath, FRAMESHELL_DATA_DIR: box.dataDir, FRAMESHELL_CONFIG_DIR: box.configDir };
    // The second process finds the lock taken, passes its argv on and quits.
    await new Promise<void>((resolve, reject) =>
      // Ubuntu runners forbid the unprivileged user namespaces Chromium's sandbox needs, as in the harness.
      execFile(packaged ?? "", [...(process.platform === "linux" ? ["--no-sandbox"] : []), second], { env, timeout: 30_000 }, (error) => (error ? reject(error) : resolve())),
    );
    const form = page.getByRole("form", { name: "New project from video" });
    await expect(form.getByLabel("Project name")).toHaveValue("second");
    expect(app.windows()).toHaveLength(1);
  } finally {
    await app.close();
  }
});
