import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";

// UI language (#189): the OS language picks it; View > Language overrides it, saved in configDir, and reloads windows.
const box = sandbox("demo");
const home = join(dirname(box.projectDir), "desktop");
mkdirSync(home, { recursive: true });

test("a Spanish OS gets the Spanish UI; View > Language switches to English and the choice stays", async () => {
  const welcome = { ...box, projectDir: home };
  const { app, page } = await launch(welcome, { lang: "es-419" });
  try {
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    await expect(page.getByRole("button", { name: "Nuevo desde un video…" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Abrir carpeta…" })).toBeVisible();
    const menu = await app.evaluate(({ Menu }) => ({
      undo: Menu.getApplicationMenu()?.getMenuItemById("edit-undo")?.label,
      system: Menu.getApplicationMenu()?.getMenuItemById("language-system")?.checked,
    }));
    expect(menu).toEqual({ undo: "Deshacer", system: true });

    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("language-en")?.click());
    await expect(page.getByRole("button", { name: "New from video…" })).toBeVisible();
    expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("edit-undo")?.label)).toBe("Undo");
    expect(JSON.parse(readFileSync(join(box.configDir, "language.json"), "utf8"))).toEqual({ language: "en" });
  } finally {
    await app.close();
  }

  // The choice outlives the app, whatever the OS language.
  const again = await launch(welcome, { lang: "es" });
  try {
    await expect(again.page.getByRole("button", { name: "New from video…" })).toBeVisible();
  } finally {
    await again.app.close();
  }
});

test("a project window in Spanish shows its panels in Spanish", async () => {
  const { app, page } = await launch(box, { lang: "es", env: { FRAMESHELL_CONFIG_DIR: join(box.configDir, "es") } });
  try {
    await expect(page.getByRole("tab", { name: "Archivos" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Cambios" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Ocultar barra lateral" })).toBeVisible();
  } finally {
    await app.close();
  }
});
