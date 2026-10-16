// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import type { FrameshellApi } from "../src/shared/api.js";
import { launch, sandbox } from "./harness.js";

// Media dropped from the OS (#183). A synthetic drop has no file on disk behind it, so the drop target is checked
// with a synthetic drag, and the import it calls with real paths.
const box = sandbox("demo");
const outside = dirname(box.projectDir);
const clip = join(outside, "dropped.mp4");
writeFileSync(clip, Buffer.alloc(2048, 5));
const notes = join(outside, "notes.pdf");
writeFileSync(notes, "%PDF");

test("dragging files over the window shows the drop target, outside the terminal", async () => {
  const { app, page } = await launch(box);
  try {
    const drag = (type: string, selector: string) =>
      page.evaluate(
        ({ type, selector }) => {
          const transfer = new DataTransfer();
          transfer.items.add(new File(["x"], "dropped.mp4", { type: "video/mp4" }));
          document.querySelector(selector)?.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }));
        },
        { type, selector },
      );
    await expect(page.locator(".terminal-view")).toBeVisible();
    await drag("dragenter", ".workspace");
    await drag("dragover", ".workspace");
    await expect(page.locator(".drop-target")).toBeVisible();
    await drag("dragover", ".terminal-view");
    await expect(page.locator(".drop-target")).toHaveCount(0);
    await drag("dragover", ".workspace");
    await drag("drop", ".workspace");
    await expect(page.locator(".drop-target")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("dropped media is imported into assets/ and the rest is refused", async () => {
  const { app, page } = await launch(box);
  try {
    const result = await page.evaluate(
      (paths) => (window as unknown as { frameshell: FrameshellApi }).frameshell.media.import(paths),
      [clip, notes],
    );
    expect(result).toEqual({ imported: ["assets/dropped.mp4"], refused: [notes] });
    await page.locator(".tree-row", { hasText: "assets" }).click();
    await expect(page.locator(".tree-name", { hasText: "dropped.mp4" })).toBeVisible();
  } finally {
    await app.close();
  }
});
