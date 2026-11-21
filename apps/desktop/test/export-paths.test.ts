import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportsFolder, imageExportPath } from "../src/main/export-paths.js";

// #749: save dialogs start in exports/ on every OS; an image is never saved as PNG bytes under another extension.
describe("export paths", () => {
  it("makes exports/ when it is missing, and leaves it when it is there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-exports-"));
    expect(await exportsFolder(dir)).toBe(join(dir, "exports"));
    expect(statSync(join(dir, "exports")).isDirectory()).toBe(true);
    expect(await exportsFolder(dir)).toBe(join(dir, "exports"));
    expect(existsSync(join(dir, "exports"))).toBe(true);
  });

  it("adds .png to a name without extension, keeps the ones the daemon writes, refuses others", () => {
    expect(imageExportPath("/p/exports/poster")).toBe("/p/exports/poster.png");
    expect(imageExportPath("/p/exports/poster.")).toBe("/p/exports/poster.png");
    expect(imageExportPath("C:\\p\\exports\\poster.JPG")).toBe("C:\\p\\exports\\poster.JPG");
    expect(imageExportPath("/p/exports/poster.webp")).toBe("/p/exports/poster.webp");
    expect(imageExportPath("/p/exports/poster.gif")).toBeNull();
  });
});
