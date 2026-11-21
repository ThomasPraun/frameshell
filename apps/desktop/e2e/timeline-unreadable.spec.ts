import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";

// A timeline the daemon cannot read (#757): a sentence naming the file instead of the validation dump, the dump
// under Details, and the ways out (open the file, go to History).
const box = sandbox("timeline");

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  writeFileSync(join(box.projectDir, "timelines", "main.json"), JSON.stringify({ version: 1, revision: 1, tracks: "none" }));
  ({ app, page } = await launch(box));
});

test.afterAll(async () => {
  await app?.close();
});

test("an unreadable timeline says which file, keeps the details folded, and opens the file or History", async () => {
  const box = page.getByTestId("timeline-unreadable");
  await expect(box).toContainText("timelines/main.json");
  const details = box.locator("details");
  await expect(details).not.toHaveAttribute("open", "");
  await expect(box.locator("pre")).toBeHidden();
  await box.getByTestId("timeline-open-file").click();
  await expect(page.getByRole("tab", { name: "timelines/main.json" })).toHaveAttribute("aria-selected", "true");
  await box.getByTestId("timeline-show-history").click();
  await expect(page.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
});
