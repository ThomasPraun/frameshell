import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";

// Generate voiceover from the Explorer (ADR 0034 decision 12): a paid provider asks for the cost in a native dialog
// before anything is generated. The daemon runs with `FRAMESHELL_SPEECH_STAND_IN=paid`: `stand-in-paid` says each word
// as a tone and charges 0.01 USD a word, so no cloud account is involved. The message boxes are stubbed in main.
// The menu item appears only on scripts with `voiceover: true`; the run is bound to the cost the person saw (#586).
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

async function generateFrom(path: string): Promise<void> {
  await row(path).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Generate voiceover…" }).click();
}

test.beforeAll(async () => {
  mkdirSync(join(box.projectDir, "scripts"), { recursive: true });
  writeFileSync(join(box.projectDir, SCRIPT), script("stand-in-paid"));
  writeFileSync(join(box.projectDir, FREE_SCRIPT), script("stand-in"));
  writeFileSync(join(box.projectDir, EDITED_SCRIPT), script("stand-in-paid"));
  writeFileSync(join(box.projectDir, "scripts", "notes.md"), "# Notes\n\nNothing to say.\n");
  ({ app, page } = await launch(box, { env: { FRAMESHELL_SPEECH_STAND_IN: "paid" } }));
});

test.afterAll(async () => {
  await app?.close();
});

test("only voiceover scripts offer Generate voiceover", async () => {
  await row(SCRIPT).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Generate voiceover…" })).toBeVisible();
  await page.keyboard.press("Escape");
  await row("scripts/notes.md").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Open" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Generate voiceover…" })).toHaveCount(0);
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
      detail: "0.05 USD (estimated). The provider bills this to you as each line is generated, and a finished take is kept in assets/voiceover/ so it is never paid for twice.",
      buttons: ["Generate", "Cancel"],
    },
  ]);
  expect(existsSync(join(box.projectDir, "assets", "voiceover", "vo", "hook-1.wav"))).toBe(false);

  await answerBoxes([0, 0]);
  await generateFrom(SCRIPT);
  await expect.poll(async () => (await asked()).length).toBe(2);
  const [cost, done] = await asked();
  expect(cost!.message).toBe("Generate 2 lines with stand-in-paid?");
  expect(done).toMatchObject({ type: "info", message: "Voiceover of vo.md is ready", detail: expect.stringContaining("2 lines were generated.") });
  expect(existsSync(join(box.projectDir, "assets", "voiceover", "vo", "hook-1.wav"))).toBe(true);
  expect(existsSync(join(box.projectDir, "assets", "voiceover", "vo", "fix-1.wav"))).toBe(true);
});

test("lines already generated cost nothing: running it again asks nothing", async () => {
  await answerBoxes([0]);
  await generateFrom(SCRIPT);
  await expect.poll(async () => (await asked()).length).toBe(1);
  expect((await asked())[0]).toMatchObject({ type: "info", detail: expect.stringContaining("0 lines were generated and 2 were already there.") });
});

test("a free provider generates without asking", async () => {
  await answerBoxes([0]);
  await generateFrom(FREE_SCRIPT);
  await expect.poll(async () => (await asked()).length).toBe(1);
  expect((await asked())[0]).toMatchObject({ type: "info", message: "Voiceover of free-vo.md is ready" });
  expect(existsSync(join(box.projectDir, "assets", "voiceover", "free-vo", "hook-1.wav"))).toBe(true);
});

test("a script edited while the cost box is open is not generated on the old confirmation", async () => {
  await answerBoxes([0, 0, 0], true);
  await generateFrom(EDITED_SCRIPT);
  await expect.poll(async () => (await asked()).length).toBe(1);
  expect((await asked())[0]).toMatchObject({ message: "Generate 2 lines with stand-in-paid?", detail: expect.stringContaining("0.05 USD") });
  writeFileSync(join(box.projectDir, EDITED_SCRIPT), `${script("stand-in-paid")}\n## More\nOne more line.\n`);
  await release();
  await expect.poll(async () => (await asked()).length).toBe(3);
  const [, again, done] = await asked();
  expect(again).toMatchObject({
    type: "warning",
    message: "Generate 3 lines with stand-in-paid?",
    detail: expect.stringMatching(/^The script or the price changed since you confirmed, so nothing was generated\.\n\n0\.0[0-9]+ USD/),
  });
  expect(done).toMatchObject({ type: "info", detail: expect.stringContaining("3 lines were generated.") });
  expect(existsSync(join(box.projectDir, "assets", "voiceover", "edited-vo", "more-1.wav"))).toBe(true);
});
