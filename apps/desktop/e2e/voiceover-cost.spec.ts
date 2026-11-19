import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";
import { useTestBinaries } from "./media.js";

// Generate voiceover from the Explorer (ADR 0034 decisions 12 and 20): a paid provider asks for the cost in a native dialog
// before anything is generated; the result opens in the voiceover dialog (decision 22). The daemon runs with
// `FRAMESHELL_SPEECH_STAND_IN=paid`: `stand-in-paid` says each word as a tone and charges 0.01 USD a word, so no cloud
// account is involved. The message boxes are stubbed in main. The menu items appear only on scripts with `voiceover: true`;
// the run is bound to the cost the person saw.
const box = sandbox("demo");
const SCRIPT = "scripts/vo.md";
const FREE_SCRIPT = "scripts/free-vo.md";
const EDITED_SCRIPT = "scripts/edited-vo.md";
const script = (provider: string) =>
  ["---", "voiceover: true", "language: en", `provider: ${provider}`, "---", "## Hook", "Stop scrolling.", "## Fix", "Close them all."].join("\n");

let app: ElectronApplication;
let page: Page;

/**
 * Answer the next message boxes with `responses` in turn (the index of the button pressed); {@link asked} reads what they said.
 * With `hold`, the first box stays open until {@link release}: the person is still reading it.
 */
async function answerBoxes(responses: number[], hold = false): Promise<void> {
  await app.evaluate(({ dialog }, { answers, held }) => {
    const asked: { type?: string; message: string; detail?: string; buttons?: string[] }[] = [];
    const state = globalThis as { asked?: typeof asked; release?: () => void };
    state.asked = asked;
    const gate = held ? new Promise<void>((resolve) => (state.release = resolve)) : null;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { type?: string; message: string; detail?: string; buttons?: string[] };
      asked.push({ ...(options.type ? { type: options.type } : {}), message: options.message, ...(options.detail ? { detail: options.detail } : {}), ...(options.buttons ? { buttons: options.buttons } : {}) });
      if (gate && asked.length === 1) await gate;
      return { response: answers.shift() ?? 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, { answers: responses, held: hold });
}

const release = () => app.evaluate(() => (globalThis as { release?: () => void }).release?.());

const asked = () => app.evaluate(() => (globalThis as { asked?: { type?: string; message: string; detail?: string; buttons?: string[] }[] }).asked ?? []);
const row = (path: string) => page.getByRole("treeitem", { name: path, exact: true }).getByRole("button").first();
const dialog = () => page.getByTestId("voiceover-dialog");
const report = () => page.getByTestId("voiceover-report");

async function generateFrom(path: string): Promise<void> {
  await row(path).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Generate voiceover…" }).click();
}

async function closeDialog(): Promise<void> {
  await page.getByTestId("voiceover-close").click();
  await expect(dialog()).toHaveCount(0);
}

test.beforeAll(async () => {
  mkdirSync(join(box.projectDir, "scripts"), { recursive: true });
  writeFileSync(join(box.projectDir, SCRIPT), script("stand-in-paid"));
  writeFileSync(join(box.projectDir, FREE_SCRIPT), script("stand-in"));
  writeFileSync(join(box.projectDir, EDITED_SCRIPT), script("stand-in-paid"));
  writeFileSync(join(box.projectDir, "scripts", "notes.md"), "# Notes\n\nNothing to say.\n");
  // Takes are ingested and placed with ffmpeg: the shared test copy, not a download of its own.
  await useTestBinaries(box.configDir);
  ({ app, page } = await launch(box, { env: { FRAMESHELL_SPEECH_STAND_IN: "paid" } }));
});

test.afterAll(async () => {
  await app?.close();
});

test("only voiceover scripts offer Generate voiceover and Place voiceover", async () => {
  await row(SCRIPT).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Generate voiceover…" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Place voiceover…" })).toBeVisible();
  await page.keyboard.press("Escape");
  await row("scripts/notes.md").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Open" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Generate voiceover…" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Place voiceover…" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await row("frameshell.json").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Open" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Generate voiceover…" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("a paid provider names its cost first, and nothing is generated until the person confirms", async () => {
  await answerBoxes([1]);
  await generateFrom(SCRIPT);
  await expect.poll(asked).toEqual([
    {
      type: "warning",
      message: "Generate 2 lines with stand-in-paid?",
      detail: "0.0500 USD (estimated). The provider bills this to you as each line is generated, and a finished take is kept in assets/voiceover/ so it is never paid for twice.",
      buttons: ["Generate", "Cancel"],
    },
  ]);
  // Declined: the dialog goes away with nothing generated.
  await expect(dialog()).toHaveCount(0);
  expect(existsSync(join(box.projectDir, "assets", "voiceover", "vo", "hook-1.wav"))).toBe(false);

  await answerBoxes([0]);
  await generateFrom(SCRIPT);
  await expect(report()).toContainText("2 lines were generated.");
  expect(await asked()).toHaveLength(1);
  expect((await asked())[0]!.message).toBe("Generate 2 lines with stand-in-paid?");
  // Without a transcription plugin the check is left out, and the report says so: nothing was downloaded.
  await expect(page.getByTestId("voiceover-check-note")).toContainText("no transcription plugin");
  await expect(page.getByTestId("voiceover-line-hook-1")).toHaveAttribute("data-status", "none");
  expect(existsSync(join(box.projectDir, "assets", "voiceover", "vo", "hook-1.wav"))).toBe(true);
  expect(existsSync(join(box.projectDir, "assets", "voiceover", "vo", "fix-1.wav"))).toBe(true);
  await closeDialog();
});

test("lines already generated cost nothing: running it again asks nothing", async () => {
  await answerBoxes([0]);
  await generateFrom(SCRIPT);
  await expect(report()).toContainText("0 lines were generated and 2 were already there.");
  expect(await asked()).toEqual([]);
  await closeDialog();
});

test("a free provider generates without asking", async () => {
  await answerBoxes([0]);
  await generateFrom(FREE_SCRIPT);
  await expect(dialog()).toContainText("Voiceover of free-vo.md");
  await expect(report()).toContainText("2 lines were generated.");
  expect(await asked()).toEqual([]);
  expect(existsSync(join(box.projectDir, "assets", "voiceover", "free-vo", "hook-1.wav"))).toBe(true);
  await closeDialog();
});

test("a script edited while the cost box is open is not generated on the old confirmation", async () => {
  await answerBoxes([0, 0], true);
  await generateFrom(EDITED_SCRIPT);
  await expect.poll(async () => (await asked()).length).toBe(1);
  expect((await asked())[0]).toMatchObject({ message: "Generate 2 lines with stand-in-paid?", detail: expect.stringContaining("0.0500 USD") });
  // The dialog behind the box says it waits for the cost.
  await expect(page.getByTestId("voiceover-progress")).toContainText("Waiting for you to confirm the cost");
  writeFileSync(join(box.projectDir, EDITED_SCRIPT), `${script("stand-in-paid")}\n## More\nOne more line.\n`);
  await release();
  await expect(report()).toContainText("3 lines were generated.");
  const [, again] = await asked();
  expect(again).toMatchObject({
    type: "warning",
    message: "Generate 3 lines with stand-in-paid?",
    detail: expect.stringMatching(/^The script or the price changed since you confirmed, so nothing was generated\.\n\n0\.0[0-9]+ USD/),
  });
  expect(existsSync(join(box.projectDir, "assets", "voiceover", "edited-vo", "more-1.wav"))).toBe(true);
  await closeDialog();
});
