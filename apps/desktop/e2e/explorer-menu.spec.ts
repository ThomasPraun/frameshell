import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";

// Explorer right-click menu (#415): Open, Reveal, Copy path and Move to Trash, which main confirms in a native message
// box naming the timeline clips that use the file (daemon `file.uses`). The box and `shell.trashItem` are stubbed in
// main: the real OS trash is never touched.
const box = sandbox("demo");
const EXPORT = "exports/cut.mp4";
const BIN = process.platform === "win32" ? "Recycle Bin" : "Trash";

let app: ElectronApplication;
let page: Page;

/** Answer the next message boxes with `responses` in turn; {@link asked} reads what they asked. */
async function answerBoxes(responses: number[]): Promise<void> {
  await app.evaluate(({ dialog, shell }, answers) => {
    const asked: { message: string; detail?: string }[] = [];
    (globalThis as { asked?: typeof asked }).asked = asked;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { message: string; detail?: string };
      asked.push({ message: options.message, ...(options.detail ? { detail: options.detail } : {}) });
      return { response: answers.shift() ?? 1, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
    shell.trashItem = async (path: string) => {
      const { rm } = process.getBuiltinModule("node:fs/promises");
      await rm(path, { recursive: true, force: true });
    };
  }, responses);
}

const asked = () => app.evaluate(() => (globalThis as { asked?: { message: string; detail?: string }[] }).asked ?? []);
const row = (path: string) => page.getByRole("treeitem", { name: path, exact: true }).getByRole("button").first();

test.beforeAll(async () => {
  mkdirSync(join(box.projectDir, "exports"), { recursive: true });
  writeFileSync(join(box.projectDir, EXPORT), "not really a video");
  const mainFile = join(box.projectDir, "timelines", "main.json");
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.tracks = [{ id: "t_v1", kind: "video", clips: [{ id: "c_a", type: "media", asset: EXPORT, start: 0, in: 0, out: 1 }] }];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
  ({ app, page } = await launch(box));
});

test.afterAll(async () => {
  await app?.close();
});

test("a file's menu opens it, copies its path, and moves it to the trash after a confirm naming its uses", async () => {
  await page.getByRole("treeitem", { name: "exports", exact: true }).getByRole("button").first().click();
  await row(EXPORT).click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText([/Ask agent/, "Open", /Finder|File Explorer|file manager/, "Copy path", `Move to ${BIN}`]);
  await expect(menu.getByRole("separator")).toHaveCount(2);

  await menu.getByRole("menuitem", { name: "Copy path" }).click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(join(box.projectDir, ...EXPORT.split("/")));

  await answerBoxes([1]);
  await row(EXPORT).click({ button: "right" });
  await page.getByRole("menuitem", { name: `Move to ${BIN}` }).click();
  await expect.poll(asked).toEqual([
    { message: `Move “cut.mp4” to the ${BIN}?`, detail: `1 clip uses it (main): it shows as missing until you put it back. You can put it back from the ${BIN}.` },
  ]);
  expect(existsSync(join(box.projectDir, EXPORT))).toBe(true);

  await answerBoxes([0]);
  await row(EXPORT).click({ button: "right" });
  await page.getByRole("menuitem", { name: `Move to ${BIN}` }).click();
  await expect(row(EXPORT)).toHaveCount(0);
  expect(existsSync(join(box.projectDir, EXPORT))).toBe(false);
});

test("the project's own files stay: a message box says why", async () => {
  await answerBoxes([0]);
  await row("frameshell.json").click({ button: "right" });
  await page.getByRole("menuitem", { name: `Move to ${BIN}` }).click();
  await expect.poll(asked).toEqual([{ message: "frameshell.json holds the project itself and cannot be moved to the trash." }]);
  expect(existsSync(join(box.projectDir, "frameshell.json"))).toBe(true);
});

test("a folder's menu has the place commands only", async () => {
  await page.getByRole("treeitem", { name: "scripts", exact: true }).getByRole("button").first().click({ button: "right" });
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText([/Finder|File Explorer|file manager/, "Copy path", `Move to ${BIN}`]);
  await page.keyboard.press("Escape");
});
