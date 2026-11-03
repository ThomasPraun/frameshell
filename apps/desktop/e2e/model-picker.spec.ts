import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";

// Transcription model picker (#427) in the transcript toolbar: a model file registered on this machine through the
// app and chosen for the project. Nothing is transcribed; the model files are tiny stand-ins with the ggml magic.
const box = sandbox("transcript");
const configFile = join(box.projectDir, "frameshell.json");

let app: ElectronApplication;
let page: Page;

const picker = () => page.getByTestId("model-picker");
const status = () => page.locator(".transcript-toolbar").getByRole("status");
const transcription = () => (JSON.parse(readFileSync(configFile, "utf8")) as { transcription?: { provider: string; model?: string } }).transcription;

/** Make the next system file dialog answer `file`. */
async function nextFile(file: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, file);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  ({ app, page } = await launch(box));
  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  await expect(picker()).toBeEnabled();
});

test.afterAll(async () => {
  await app?.close();
});

test("starts on Default and offers a custom file", async () => {
  await expect(picker()).toHaveValue("");
  await expect(picker().locator("option").first()).toHaveText(/^Default/);
  await expect(picker().locator("option").last()).toHaveText("Custom file…");
});

test("Custom file… registers the file under a name taken from it and makes it the project's model", async () => {
  const dir = join(box.dataDir, "models");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "ggml-es-small.bin");
  writeFileSync(file, "lmggfake weights");
  await nextFile(file);

  await picker().selectOption({ label: "Custom file…" });
  const form = page.getByRole("form", { name: "Register ggml-es-small.bin on this computer" });
  await expect(form.getByRole("textbox", { name: "Model name" })).toHaveValue("es-small");
  await form.getByRole("button", { name: "Register" }).click();

  await expect(status()).toHaveText("Transcription now uses es-small.");
  await expect(picker()).toHaveValue("es-small");
  expect(transcription()).toEqual({ provider: "whisper-cpp", model: "es-small" });
  const registry = JSON.parse(readFileSync(join(box.configDir, "models.json"), "utf8")) as { models: Record<string, { file: string; format: string }> };
  expect(registry.models["es-small"]).toMatchObject({ file, format: "ggml" });
  await expect(picker().locator("optgroup[label='Your model files'] option")).toHaveText(["es-small · ggml-es-small.bin"]);
});

test("Default removes the project's model", async () => {
  await picker().selectOption({ value: "" });
  await expect(status()).toHaveText(/^Transcription now uses the default/);
  await expect.poll(() => transcription()?.model).toBeUndefined();
  await expect(picker()).toHaveValue("");
});

test("a pickle checkpoint is refused with the reason, and nothing changes", async () => {
  const file = join(box.dataDir, "models", "canary.nemo");
  writeFileSync(file, "tar");
  await nextFile(file);
  await picker().selectOption({ label: "Custom file…" });
  await page.getByRole("form", { name: "Register canary.nemo on this computer" }).getByRole("button", { name: "Register" }).click();
  await expect(status()).toHaveText(/^Model not registered: .*pickle-based checkpoint/);
  await expect(page.getByRole("form", { name: /^Register canary\.nemo/ })).toBeVisible();
  expect(transcription()?.model).toBeUndefined();
  await page.getByRole("form", { name: /^Register canary\.nemo/ }).getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("form", { name: /^Register/ })).toHaveCount(0);
});
