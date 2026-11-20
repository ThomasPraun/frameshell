import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";

// Plugins view with no network: the official catalog of a fresh project, the trust banner once frameshell.json
// declares a plugin (never trusted here, so no plugin code runs or installs), and the machine's downloads from a
// data dir holding stand-in files. Message boxes are stubbed in main; no OpenAI key reaches the daemon.
const box = sandbox("demo");
const FFMPEG = join(box.dataDir, "binaries", "ffmpeg", "0-e2e");
const MODEL = join(box.dataDir, "models", "ggml-large-v3-turbo-q5_0", "0-e2e");
const PIN = `file:vendor/acme-titles-1.0.0.tgz#sha256=${"0".repeat(64)}`;

let app: ElectronApplication;
let page: Page;

const plugin = (name: string) => page.locator(`[data-testid="plugin"][data-name="${name}"]`);
const download = (name: string) => page.locator(`[data-testid="download"][data-name="${name}"]`);

/** Answer the next message boxes with `responses` in turn. */
async function answerBoxes(responses: number[]): Promise<void> {
  await app.evaluate(({ dialog }, answers) => {
    dialog.showMessageBox = (async () => ({ response: answers.shift() ?? 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
  }, responses);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  mkdirSync(FFMPEG, { recursive: true });
  writeFileSync(join(FFMPEG, "ffmpeg.bin"), Buffer.alloc(3_000_000));
  mkdirSync(MODEL, { recursive: true });
  writeFileSync(join(MODEL, "model.bin"), Buffer.alloc(2_000_000));
  ({ app, page } = await launch(box, { env: { OPENAI_API_KEY: "" } }));
  await page.getByRole("tab", { name: "Plugins" }).click();
});

test.afterAll(async () => {
  await app?.close();
});

test("lists every official plugin with what it needs, costs and downloads, nothing installed", async () => {
  const panel = page.getByTestId("plugins-panel");
  await expect(page.locator('[data-testid="plugin"]')).toHaveCount(6);
  await expect(page.locator('[data-testid="plugin"][data-state="not-installed"]')).toHaveCount(6);
  await expect(page.getByTestId("plugins-trust")).toHaveCount(0);
  await expect(panel).toContainText("Installing a plugin also trusts this project's plugin list");

  const whisper = plugin("@frameshell/whisper-cpp");
  await expect(whisper).toContainText("whisper.cpp transcription");
  await expect(whisper).toContainText("Not installed");
  await expect(whisper).toContainText("Free, runs on this computer.");
  await expect(whisper).toContainText(/Downloads ~\d+ MB the first time it runs \(whisper-cpp, ggml-large-v3-turbo-q5_0\)|Downloads on first use/);
  await expect(whisper.getByRole("button", { name: "Install" })).toBeEnabled();

  const openai = plugin("@frameshell/openai-transcription");
  await expect(openai).toContainText("the audio leaves this computer and OpenAI bills your own key per use");
  await expect(openai).toContainText("Key not set. Set OPENAI_API_KEY in your system environment");
  await expect(plugin("@frameshell/openai-speech")).toContainText("the text goes to OpenAI");
  await expect(plugin("@frameshell/blender")).toContainText("Needs your own Blender");
});

test("lists this machine's downloads and removes one after a confirm", async () => {
  await expect(download("ffmpeg")).toHaveAttribute("data-on-disk", "true");
  await expect(download("ffmpeg")).toContainText("3 MB");
  await expect(download("ggml-large-v3-turbo-q5_0")).toContainText("2 MB");
  await expect(page.getByTestId("downloads-total")).toHaveText("5 MB in use");
  await expect(download("chrome-headless-shell")).toHaveAttribute("data-on-disk", "false");
  await expect(download("chrome-headless-shell")).toContainText("Not downloaded yet");

  await answerBoxes([1]);
  await download("ffmpeg").getByRole("button", { name: "Remove" }).click();
  await expect(download("ffmpeg").getByRole("button", { name: "Remove" })).toBeEnabled();
  expect(existsSync(FFMPEG)).toBe(true);

  await answerBoxes([0]);
  await download("ffmpeg").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByTestId("plugins-notice")).toHaveText("ffmpeg removed: 3 MB freed.");
  await expect(download("ffmpeg")).toHaveAttribute("data-on-disk", "false");
  await expect(page.getByTestId("downloads-total")).toHaveText("2 MB in use");
  expect(existsSync(FFMPEG)).toBe(false);
});

test("a project declaring a plugin shows the trust banner and records Don't trust only on the click", async () => {
  const file = join(box.projectDir, "frameshell.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), plugins: { "@acme/titles": PIN } }, null, 2));

  const banner = page.getByTestId("plugins-trust");
  await expect(banner).toHaveAttribute("data-trust", "unknown");
  await expect(banner).toContainText("Plugins run with full access to this computer");
  await expect(banner).toContainText("Declared: @acme/titles");
  await expect(plugin("@acme/titles")).toHaveAttribute("data-state", "untrusted");
  await expect(plugin("@frameshell/whisper-cpp").getByRole("button", { name: "Install" })).toBeDisabled();
  expect(existsSync(join(box.configDir, "trust.json"))).toBe(false);

  await banner.getByRole("button", { name: "Don't trust" }).click();
  await expect(banner).toHaveAttribute("data-trust", "denied");
  await expect(banner.getByRole("button", { name: "Don't trust" })).toHaveCount(0);
  await expect(banner.getByRole("button", { name: "Trust", exact: true })).toBeVisible();
});
