// page.evaluate bodies run in the renderer, app.evaluate bodies in main.
/// <reference lib="dom" />
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import type { FrameshellApi } from "../src/shared/api.js";
import { launch, sandbox } from "./harness.js";

// Projects created from a video (ADR 0013, #182): the welcome screen plans the folder beside the video, creates the
// project and imports the video without the terminal. The native file dialog is replaced in main.
const box = sandbox("demo");
const home = join(dirname(box.projectDir), "desktop");
mkdirSync(home, { recursive: true });
// Ingest of these bytes fails; the flow under test ends before it matters.
const interview = join(home, "interview.mp4");
writeFileSync(interview, Buffer.alloc(4096, 7));
const broll = join(home, "broll.mov");
writeFileSync(broll, Buffer.alloc(2048, 3));

/** Launch on a folder that is not a project, so the window shows the welcome screen. */
async function launchWelcome() {
  return launch({ ...box, projectDir: home });
}

test("choosing a video creates its project beside it and opens it", async () => {
  const { app, page } = await launchWelcome();
  try {
    await expect(page.locator(".welcome")).toHaveCount(1);
    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
    }, [interview, broll]);

    await page.getByRole("button", { name: "New from video…" }).click();
    const form = page.getByRole("form", { name: "New project from video" });
    await expect(form.getByText("interview.mp4, broll.mov")).toBeVisible();
    await expect(form.getByLabel("Project name")).toHaveValue("interview");
    await expect(form.locator(".welcome-place code")).toHaveText(join(home, "interview"));

    await form.getByRole("button", { name: "Create project" }).click();
    await expect(page.locator(".titlebar-project")).toHaveText("interview", { timeout: 60_000 });
    await page.locator(".tree-row", { hasText: "assets" }).click();
    await expect(page.locator(".tree-name", { hasText: "interview.mp4" })).toBeVisible();
    await expect(page.locator(".tree-name", { hasText: "broll.mov" })).toBeVisible();
    // The originals stay where the user left them.
    expect(existsSync(interview) && existsSync(broll)).toBe(true);

    // The same video again leads to the same project; a folder of that name holding something else does not.
    const again = await page.evaluate(
      (file) => (window as unknown as { frameshell: FrameshellApi }).frameshell.project.planVideos([file]),
      interview,
    );
    expect(again).toMatchObject({ dir: join(home, "interview"), existing: true });
    const other = await page.evaluate(
      (file) => (window as unknown as { frameshell: FrameshellApi }).frameshell.project.planVideos([file]),
      broll,
    );
    expect(other).toMatchObject({ dir: join(home, "broll"), existing: false });
  } finally {
    await app.close();
  }
});
