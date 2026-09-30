import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { laidOutBox, launch, sandbox } from "./harness.js";

// MCP UI state and navigation (SPEC §7b) end to end: a scripted MCP client drives `frameshell mcp` over stdio against
// the daemon the running app uses. The app publishes what it shows; navigation reaches it only through the daemon.
const box = sandbox("navigation");
const cliBin = join(import.meta.dirname, "..", "..", "..", "packages", "cli", "dist", "bin", "frameshell.js");

test.describe.configure({ mode: "serial" });

let app: ElectronApplication;
let page: Page;
let mcp: Client;

test.beforeAll(async () => {
  ({ app, page } = await launch(box));
  mcp = new Client({ name: "e2e", version: "0.0.0" });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cliBin, "mcp"],
      cwd: box.projectDir,
      env: {
        ...(process.env as Record<string, string>),
        FRAMESHELL_SOCKET: box.socketPath,
        FRAMESHELL_DATA_DIR: box.dataDir,
        FRAMESHELL_CONFIG_DIR: box.configDir,
      },
      stderr: "inherit",
    }),
  );
});

test.afterAll(async () => {
  await mcp?.close();
  await app?.close();
});

// Tool payloads are asserted field by field; typing them here would duplicate the registry.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Payload = Record<string, any>;

/** Call a tool and parse its JSON text; failures come back as `{ error }` with the tool's message. */
async function tool(name: string, args: Record<string, unknown> = {}): Promise<Payload> {
  const result = (await mcp.callTool({ name, arguments: args })) as CallToolResult;
  const text = (result.content.find((part) => part.type === "text") as { text: string } | undefined)?.text ?? "";
  return result.isError ? { error: text } : (JSON.parse(text) as Payload);
}

const lanes = () => page.getByTestId("timeline-lanes");
const agentNotice = () => page.getByTestId("agent-notice");

/** Fixture clips (history fixture layout): lane top in content px below the ruler, span in seconds. */
const RULER = 22;
const LANE = 44;
const CLIPS = { c_two: { top: RULER + LANE, start: 4, end: 10 } } as const;

/** Screen point in the middle of a clip on the canvas. Lanes span 60 s while the timeline is under 48 s (`layout.ts`). */
async function clipPoint(id: keyof typeof CLIPS): Promise<{ x: number; y: number }> {
  const scroller = page.locator(".timeline-scroller");
  const rect = await laidOutBox(scroller);
  const { scrollLeft, pxPerSecond } = await scroller.evaluate((element) => ({
    scrollLeft: element.scrollLeft,
    pxPerSecond: element.scrollWidth / 60,
  }));
  const clip = CLIPS[id];
  return { x: rect.x + ((clip.start + clip.end) / 2) * pxPerSecond - scrollLeft, y: rect.y + clip.top + LANE / 2 };
}

test("ui_state reports what the app shows: playhead, empty selection, no tab, the visible span", async () => {
  await expect(lanes()).toHaveAttribute("data-revision", "0");
  // Polled as a whole: the first report may precede the program length and the lanes' first layout.
  await expect.poll(() => tool("ui_state"), { timeout: 30_000 }).toMatchObject({
    connected: true,
    project: box.projectDir,
    timeline: "main",
    playhead: 0,
    playing: false,
    duration: 22,
    selection: { clips: [], words: [], range: null, history: null },
    editor: { active: null, tabs: [] },
    visible: { from: 0, to: expect.any(Number) },
  });
  expect((await tool("ui_state"))["visible"].to).toBeGreaterThanOrEqual(22);
});

test("a clip clicked in the timeline is in ui_state within 200 ms", async () => {
  // Budget: 200 ms plus the tool round trip itself (the slowest of a few), measured on this machine first.
  let roundTrip = 0;
  for (let i = 0; i < 3; i++) {
    const started = Date.now();
    await tool("ui_state");
    roundTrip = Math.max(roundTrip, Date.now() - started);
  }

  const point = await clipPoint("c_two");
  await page.mouse.click(point.x, point.y);
  const clicked = Date.now();
  await expect(lanes()).toHaveAttribute("data-selected", "c_two");
  let seen = 0;
  while (Date.now() - clicked < 5_000) {
    const state = await tool("ui_state");
    if (state["selection"].clips.join(" ") === "c_two") {
      seen = Date.now();
      break;
    }
  }
  expect(seen, "selection never reached ui_state").toBeGreaterThan(0);
  expect(seen - clicked).toBeLessThan(200 + 2 * roundTrip);
});

test("a time range dragged over empty lane space is the selection ui_state reports", async () => {
  const scroller = page.locator(".timeline-scroller");
  const rect = await laidOutBox(scroller);
  const { scrollLeft, pxPerSecond } = await scroller.evaluate((element) => ({
    scrollLeft: element.scrollLeft,
    pxPerSecond: element.scrollWidth / 60,
  }));
  const at = (seconds: number) => rect.x + seconds * pxPerSecond - scrollLeft;
  // V2 holds only c_card (20 s on): 2 to 6 s of it is empty lane.
  const y = rect.y + RULER + LANE / 2;
  await page.mouse.move(at(2), y);
  await page.mouse.down();
  await page.mouse.move(at(4), y, { steps: 4 });
  await page.mouse.move(at(6), y, { steps: 4 });
  await page.mouse.up();
  await expect(lanes()).toHaveAttribute("data-selected", "");
  await expect(lanes()).toHaveAttribute("data-range", /^[\d.]+-[\d.]+$/);
  const [from, to] = (await lanes().getAttribute("data-range"))!.split("-").map(Number);
  expect(from).toBeCloseTo(2, 0);
  expect(to).toBeCloseTo(6, 0);
  await expect
    .poll(async () => (await tool("ui_state"))["selection"])
    .toEqual({ clips: [], words: [], range: { from: expect.closeTo(from!, 3), to: expect.closeTo(to!, 3) }, history: null });
});

test("ui_seek moves the shared playhead, and the status bar says the agent did it", async () => {
  const state = await tool("ui_seek", { at: 5.5 });
  expect(state).toMatchObject({ playhead: 5.5, playing: false });
  await expect(lanes()).toHaveAttribute("data-playhead", "5.5");
  await expect(agentNotice()).toHaveText("Agent moved the playhead to 00:00:05:15");
});

test("ui_play and ui_pause drive the preview's transport", async () => {
  expect(await tool("ui_play")).toMatchObject({ playing: true });
  await expect.poll(async () => Number(await lanes().getAttribute("data-playhead"))).toBeGreaterThan(5.5);
  const paused = await tool("ui_pause");
  expect(paused).toMatchObject({ playing: false });
  expect(paused["playhead"]).toBeGreaterThan(5.5);
  await expect(agentNotice()).toHaveText("Agent paused playback");
});

test("ui_select replaces the selection with clips and a time range, and refuses unknown clip ids", async () => {
  const state = await tool("ui_select", { clips: ["c_three"], range: { from: 1, to: 3 } });
  expect(state["selection"]).toEqual({ clips: ["c_three"], words: [], range: { from: 1, to: 3 }, history: null });
  await expect(lanes()).toHaveAttribute("data-selected", "c_three");
  await expect(lanes()).toHaveAttribute("data-range", "1-3");
  await expect(page.locator('li[data-clip="c_three"]')).toHaveAttribute("data-selected", "true");

  const refused = await tool("ui_select", { clips: ["c_nope"] });
  expect(refused["error"]).toMatch(/^UiCommandFailed: .*No clip c_nope on timeline main/s);
  await expect(lanes()).toHaveAttribute("data-selected", "c_three");
});

test("ui_open_file opens a project file in an active editor tab", async () => {
  const state = await tool("ui_open_file", { file: "scripts/intro.md" });
  expect(state["editor"]).toEqual({ active: "scripts/intro.md", tabs: ["scripts/intro.md"] });
  await expect(page.getByRole("tab", { name: "scripts/intro.md" })).toHaveAttribute("aria-selected", "true");
  // A short line: the editor column is narrow on CI screens and longer lines wrap.
  await expect(page.locator(".editor-host .view-line", { hasText: "Intro" })).toBeVisible();

  const missing = await tool("ui_open_file", { file: "scripts/missing.md" });
  expect(missing["error"]).toMatch(/^UiCommandFailed: .*Cannot open scripts\/missing\.md/s);
  const outside = await tool("ui_open_file", { file: "../elsewhere.md" });
  expect(outside["error"]).toMatch(/^OutsideProject: /);
});

test("ui_show_tx_diff opens the History panel on the agent's transaction and marks its changes", async () => {
  const moved = await tool("clip_move", { clip: "c_card", start: 16 });
  const tx = moved["operation"].tx as string;
  await expect(lanes()).toHaveAttribute("data-revision", "1");

  const state = await tool("ui_show_tx_diff", { target: tx });
  expect(state["selection"]).toMatchObject({ history: tx, clips: ["c_card"] });
  await expect(page.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(`.history-item[data-tx="${tx}"]`)).toHaveAttribute("data-selected", "true");
  await expect(lanes()).toHaveAttribute("data-diff", "moved:c_card");

  const unknown = await tool("ui_show_tx_diff", { target: "tx_00000000" });
  expect(unknown["error"]).toMatch(/^UiCommandFailed: /);
});

test("for a project no window shows, ui_state answers { connected: false } and navigation says to open it", async () => {
  // A second project, never opened in the app. (Closing the app itself is covered below the app: daemon tests.)
  const other = `${box.projectDir}-other`;
  expect(await tool("project_init", { dir: other })).not.toHaveProperty("error");
  expect(await tool("ui_state", { cwd: other })).toEqual({ connected: false });
  expect((await tool("ui_seek", { cwd: other, at: 1 }))["error"]).toMatch(/^UiNotConnected: /);
  expect(await tool("ui_state")).toMatchObject({ connected: true });
});
