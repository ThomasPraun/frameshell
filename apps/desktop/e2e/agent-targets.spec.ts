import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { type DaemonConnection, connectToDaemon } from "@frameshell/protocol";
import { launch, sandbox } from "./harness.js";

// Chat about this to agents outside the app (ADR 0025, #429): a fake MCP client registers as Claude Code would
// (`target.register` with `clientInfo` `claude-code` / `Claude Code`), then reads its inbox with `inbox.take`. The app
// sends to it, names it in a submenu once a second target registers, and says in the status bar when it read.
const box = sandbox("demo");
const FILE = "scripts/intro.md";
const MOD = process.platform === "darwin" ? "Meta" : "Control";

let app: ElectronApplication;
let page: Page;
const agents: DaemonConnection[] = [];

/** A client outside the app registered as an agent target of the project. */
async function agent(client: string, kind: "mcp" | "cli", title?: string): Promise<DaemonConnection> {
  const conn = await connectToDaemon(box.socketPath, { client: `${kind}/e2e` });
  agents.push(conn);
  await conn.request("target.register", { cwd: box.projectDir, client, kind, ...(title ? { title } : {}) });
  return conn;
}

const row = () => page.getByRole("treeitem", { name: FILE, exact: true }).getByRole("button").first();

async function rightClickFile(): Promise<void> {
  const folder = page.getByRole("treeitem", { name: "scripts", exact: true });
  if ((await page.getByRole("treeitem", { name: FILE, exact: true }).count()) === 0) await folder.getByRole("button").first().click();
  await row().click({ button: "right" });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  ({ app, page } = await launch(box));
});

test.afterAll(async () => {
  for (const conn of agents) conn.close();
  await app?.close();
});

test("with one agent outside the app, Chat about this sends there, and the status bar follows it until it reads", async () => {
  const claude = await agent("claude-code", "mcp", "Claude Code");
  await rightClickFile();
  const ask = page.getByRole("menu").getByRole("menuitem", { name: /Chat about this/ });
  await expect(ask).not.toHaveAttribute("aria-haspopup", "menu");
  await ask.click();

  await expect(page.getByTestId("ask-delivery")).toHaveText("Sent to Claude Code, waiting for it to read");
  await expect(page.getByTestId("ask-pending")).toHaveText("Claude Code: 1 waiting");
  const taken = await claude.request("inbox.take", { cwd: box.projectDir });
  expect(taken.references.map((reference) => reference.lines)).toEqual([[`[frameshell] file ${FILE}`]]);
  await expect(page.getByTestId("ask-delivery")).toHaveText("Claude Code read it");
  await expect(page.getByTestId("ask-pending")).toHaveCount(0);
});

test("with several, a submenu names them and Cmd/Ctrl+L goes to the one used last", async () => {
  await agent("codex", "cli");
  await rightClickFile();
  const ask = page.getByRole("menu").getByRole("menuitem", { name: /Chat about this/ });
  await expect(ask).toHaveAttribute("aria-haspopup", "menu");
  await ask.click();
  const submenu = page.getByRole("menu", { name: "Chat about this" });
  await expect(submenu.getByRole("menuitem")).toHaveText([/^Claude Code · Smoke demo/, /^codex · Smoke demo/]);
  await submenu.getByRole("menuitem", { name: /^codex/ }).click();
  await expect(page.getByTestId("ask-delivery")).toHaveText("Sent to codex, waiting for it to read");

  // The right-click picked the file; focus stays off the editor and the terminal, where Cmd/Ctrl+L is theirs.
  await row().focus();
  await page.keyboard.press(`${MOD}+l`);
  await expect(page.getByTestId("ask-pending")).toHaveText("codex: 2 waiting");
  const listed = await agents[0]!.request("target.list", { cwd: box.projectDir });
  expect(listed.targets.map(({ id, pending }) => ({ id, pending }))).toEqual([
    { id: "claude", pending: 0 },
    { id: "codex", pending: 2 },
  ]);
});

test("an agent that leaves is no longer offered", async () => {
  agents.pop()!.close();
  await expect
    .poll(async () => (await agents[0]!.request("target.list", { cwd: box.projectDir })).targets.find((target) => target.id === "codex")?.connections)
    .toBe(0);
  await rightClickFile();
  await expect(page.getByRole("menu").getByRole("menuitem", { name: /Chat about this/ })).not.toHaveAttribute("aria-haspopup", "menu");
  await page.keyboard.press("Escape");
});
