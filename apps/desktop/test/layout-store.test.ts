import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LayoutStore } from "../src/main/layout-store.js";
import { DEFAULT_LAYOUT, resizePanel, togglePanel } from "../src/shared/layout.js";

const storeDir = () => mkdtempSync(join(tmpdir(), "frameshell-layouts-"));

describe("LayoutStore", () => {
  it("gives a never-seen project the default layout", async () => {
    expect(await new LayoutStore(storeDir()).load("/videos/talk")).toEqual(DEFAULT_LAYOUT);
  });

  it("restores each project's own layout, across store instances", async () => {
    const dir = storeDir();
    const talk = togglePanel(DEFAULT_LAYOUT, "timeline");
    const promo = resizePanel(DEFAULT_LAYOUT, "terminal", 700);
    await new LayoutStore(dir).save("/videos/talk", talk);
    await new LayoutStore(dir).save("/videos/promo", promo);

    const reopened = new LayoutStore(dir);
    expect(await reopened.load("/videos/talk")).toEqual(talk);
    expect(await reopened.load("/videos/promo")).toEqual(promo);
  });

  it("falls back to defaults when the stored file is corrupt", async () => {
    const dir = storeDir();
    const store = new LayoutStore(dir);
    await store.save("/videos/talk", togglePanel(DEFAULT_LAYOUT, "sidebar"));
    const [file] = readdirSync(dir);
    writeFileSync(join(dir, file!), "{ not json");
    expect(await store.load("/videos/talk")).toEqual(DEFAULT_LAYOUT);
  });

  it("takes saves fired back to back (a panel drag), keeping one of them whole and no temp file", async () => {
    const dir = storeDir();
    const store = new LayoutStore(dir);
    const layouts = [300, 400, 500, 600].map((width) => resizePanel(DEFAULT_LAYOUT, "terminal", width));
    await Promise.all(layouts.map((layout) => store.save("/videos/talk", layout)));
    expect(layouts).toContainEqual(await store.load("/videos/talk"));
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("creates its directory on first save", async () => {
    const dir = join(storeDir(), "nested", "layouts");
    await new LayoutStore(dir).save("/videos/talk", DEFAULT_LAYOUT);
    expect(readdirSync(dir)).toHaveLength(1);
  });
});
