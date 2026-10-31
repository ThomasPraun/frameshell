// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, panelWindow, sandbox } from "./harness.js";
import { ffmpegRun, testFfmpeg } from "./media.js";
import { waitForIngest } from "./preview-probe.js";

// People panel (#344, ADR 0020) in the built app: a real daemon, a synthetic 8 s take with a diarized transcript
// (Ana says words 1-5, Ben the rest). The person is added, a voice linked, picked (words and spans selected),
// renamed (the transcript follows, and a rename in the transcript renames the person), every change undone with
// Cmd/Ctrl+Z; a multicam angle is suggested as a person. The voice model is offered, never fetched; a voice plays,
// seconds per person show, the transcript's speaker menu links and unlinks, and an agent picks a person over MCP.
const box = sandbox("transcript");
const mainFile = join(box.projectDir, "timelines", "main.json");
const ASSET = "assets/talk.mp4";
const TRANSCRIPT = "transcripts/talk.words.json";
const WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight"];
const cliBin = join(import.meta.dirname, "..", "..", "..", "packages", "cli", "dist", "bin", "frameshell.js");

let app: ElectronApplication;
let page: Page;
let mcp: Client | undefined;

const speakers = () => JSON.parse(readFileSync(join(box.projectDir, TRANSCRIPT), "utf8")).speakers as { id: string; name: string }[];
const panel = () => page.getByTestId("people-panel");
const person = (name: string) => page.locator(`[data-testid="person"][data-name="${name}"]`);
const label = (speaker: string) => page.locator(`.transcript-speaker[data-speaker="${speaker}"]`).first();

async function writeTake(): Promise<void> {
  const ffmpeg = await testFfmpeg();
  mkdirSync(join(box.projectDir, "assets"), { recursive: true });
  mkdirSync(box.configDir, { recursive: true });
  writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg } }));
  const staging = join(box.dataDir, "staging");
  mkdirSync(staging, { recursive: true });
  const file = join(staging, "talk.mp4");
  await ffmpegRun(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=8"],
    ...["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=8"],
    ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", file],
  ]);
  const hash = `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
  mkdirSync(join(box.projectDir, "transcripts"), { recursive: true });
  writeFileSync(
    join(box.projectDir, TRANSCRIPT),
    JSON.stringify({
      schemaVersion: 1,
      asset: ASSET,
      assetHash: hash,
      provider: "whisper-cpp",
      model: "large-v3-turbo-q5_0",
      nextWordId: WORDS.length + 1,
      words: WORDS.map((text, k) => ({ id: `w_${String(k + 1).padStart(6, "0")}`, text, start: k + 0.2, end: k + 0.7, speaker: k < 5 ? "s1" : "s2" })),
      speakers: [
        { id: "s1", name: "Ana" },
        { id: "s2", name: "Ben" },
      ],
      nextSpeakerId: 3,
      edits: {},
    }),
  );
  renameSync(file, join(box.projectDir, ASSET));
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await writeTake();
  ({ app, page } = await launch(box));
  await waitForIngest(page, ASSET);
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.tracks[0].clips = [{ id: "c_a", type: "media", asset: ASSET, start: 0, in: 0, out: 8 }];
  // One multicam angle named like nobody yet, heard as Ben: the panel suggests a new person Ben with that voice.
  timeline.groups = [{ id: "g_talk", angles: [{ id: "cam", name: "Ben", asset: ASSET, offset: 0, speaker: "s2" }] }];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "1");
  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  await page.getByRole("tab", { name: "People" }).click();
});

test.afterAll(async () => {
  await mcp?.close();
  await app?.close();
});

test("an angle suggestion adds the person behind the angle with its voice in one confirmation", async () => {
  const row = page.locator('[data-testid="suggestion"][data-kind="angle"]');
  await expect(row).toContainText("The angle Ben shows someone not in People yet");
  await expect(row.getByTestId("suggestion-also")).toHaveText("Confirm also links Ben in talk.words.json.");
  await expect(row.getByTestId("suggestion-name")).toHaveValue("Ben");
  await row.getByTestId("suggestion-confirm").click();
  await expect(person("Ben")).toBeVisible();
  await expect(person("Ben").locator('[data-testid="person-link"][data-kind="angle"]')).toHaveCount(1);
  await expect(person("Ben").locator('[data-testid="person-link"][data-kind="voice"]')).toHaveCount(1);
  await expect(row).toHaveCount(0);
});

test("with a voice linked, the panel offers the voice model with its size instead of downloading it", async () => {
  // Ben's voice is linked and Ana's is not: comparing them needs the model, which this fresh data dir lacks.
  const note = page.getByTestId("people-voice-model");
  await expect(note).toContainText("Matching voices needs a voice model (~63 MB)");
  await expect(page.getByTestId("people-voice-download")).toHaveText("Find voice matches (downloads ~63 MB once)");
  expect(existsSync(join(box.dataDir, "models"))).toBe(false);
});

test("each person shows their seconds, and a linked voice plays a stretch of that speaker", async () => {
  await expect(person("Ben").getByTestId("person-totals")).toHaveText(/^Speaks 0:0[1-9] · on screen /);
  const play = person("Ben").getByTestId("voice-play");
  await expect(play).toBeEnabled();
  await expect(play).toHaveAttribute("aria-label", "Play Ben in talk.words.json");
  await play.click();
  await expect(play).toHaveAttribute("data-playing", "true");
  await play.click();
  await expect(play).toHaveAttribute("data-playing", "false");
});

test("a person is added and a transcript speaker linked: the transcript takes the person's name", async () => {
  await expect(panel()).toBeVisible();
  await page.getByTestId("people-name").fill("Juan");
  await page.getByTestId("people-add").click();
  await expect(person("Juan")).toBeVisible();

  await person("Juan").getByTestId("person-link-pick").selectOption({ label: "Ana" });
  await expect(person("Juan").getByTestId("person-link")).toHaveAttribute("data-kind", "voice");
  // The daemon writes the name into the transcript, so the view and an agent's reading of it agree.
  await expect.poll(() => speakers()[0]).toEqual({ id: "s1", name: "Juan" });
  await expect(label("s1")).toHaveText("Juan");
  // A link made in the panel was confirmed by a person, not an agent.
  await expect(person("Juan").getByTestId("person-agent")).toHaveCount(0);
});

test("picking the person selects their words in the transcript and their spans on the timeline", async () => {
  await person("Juan").getByTestId("person-select").click();
  await expect(page.locator(".tw.is-selected")).toHaveCount(5);
  await expect(page.locator('.tw.is-selected[data-word="w_000001"]')).toHaveCount(1);
  await expect(page.locator('.tw.is-selected[data-word="w_000006"]')).toHaveCount(0);
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-spans", /^\d/);
  await expect(person("Juan").getByTestId("person-spans")).toContainText("span");
  // Their time on screen: no angle or face is linked, so nowhere.
  await person("Juan").getByTestId("person-onscreen").click();
  await expect(person("Juan").getByTestId("person-spans")).toHaveText("Nowhere on the timeline yet.");
  await expect(page.locator(".tw.is-selected")).toHaveCount(0);
});

test("a rename shows in the transcript, and Cmd/Ctrl+Z puts the name back", async () => {
  await person("Juan").getByTestId("person-rename").click();
  const input = page.getByTestId("person-rename-input");
  await input.fill("Juan Pérez");
  await input.press("Enter");
  await expect(person("Juan Pérez")).toBeVisible();
  await expect(label("s1")).toHaveText("Juan Pérez");
  await expect.poll(() => speakers()[0]!.name).toBe("Juan Pérez");

  await person("Juan Pérez").getByTestId("person-select").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(person("Juan")).toBeVisible();
  await expect(label("s1")).toHaveText("Juan");
  await expect.poll(() => speakers()[0]!.name).toBe("Juan");
  await expect(page.getByTestId("people-notice")).toContainText("Undone");
});

test("an unlink and a removal are undone one step at a time", async () => {
  await person("Juan").getByTestId("person-unlink").click();
  await expect(person("Juan").getByTestId("person-link")).toHaveCount(0);
  await person("Juan").getByTestId("person-select").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(person("Juan").getByTestId("person-link")).toHaveCount(1);

  await person("Juan").getByTestId("person-remove").click();
  await expect(person("Juan")).toHaveCount(0);
  await panel().focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(person("Juan")).toBeVisible();
  await expect(person("Juan").getByTestId("person-link")).toHaveCount(1);
  // One step, no history behind it.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("people-notice")).toContainText("Nothing to undo");
  await expect(person("Juan")).toBeVisible();
});

test("renaming a linked speaker in the transcript renames the person", async () => {
  await label("s1").dblclick();
  const field = page.getByRole("textbox", { name: "Name of Juan" });
  await field.fill("Juanito");
  await field.press("Enter");
  await expect(person("Juanito")).toBeVisible();
  await expect.poll(() => speakers()[0]!.name).toBe("Juanito");
});

test("the transcript's speaker menu unlinks a speaker from its person and links it again by name", async () => {
  const voices = () => person("Juanito").locator('[data-testid="person-link"][data-kind="voice"]');
  await label("s1").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unlink from Juanito" }).click();
  await expect(voices()).toHaveCount(0);
  await label("s1").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Link to person…" }).click();
  const field = page.getByRole("combobox", { name: "Person who is Juanito" });
  await field.fill("juanito");
  await field.press("Enter");
  await expect(voices()).toHaveCount(1);
});

test("an agent selects a person with ui_select: their words and spans, reported by ui_state", async () => {
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
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await mcp!.callTool({ name, arguments: args })) as CallToolResult;
    const text = (result.content.find((part) => part.type === "text") as { text: string } | undefined)?.text ?? "";
    return { error: result.isError === true, text };
  };
  await page.locator(".transcript-scroll").press("Escape");
  const picked = await call("ui_select", { person: { id: "Juanito" } });
  expect(picked.error, picked.text).toBe(false);
  await expect(page.locator(".tw.is-selected")).toHaveCount(5);
  await expect(person("Juanito")).toHaveAttribute("data-selected", "true");
  expect(JSON.parse(picked.text).selection.person).toMatchObject({ name: "Juanito", what: "speaks" });
  const unknown = await call("ui_select", { person: { id: "Nobody" } });
  expect(unknown).toMatchObject({ error: true, text: expect.stringContaining('no person "Nobody"') });
});

test("right-click on a person offers Rename and Remove after Ask agent (#420)", async () => {
  await person("Juanito").click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText([/Ask agent/, "Rename Juanito", "Remove Juanito"]);
  await menu.getByRole("menuitem", { name: "Rename Juanito" }).click();
  await expect(page.getByTestId("person-rename-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("person-rename-input")).toHaveCount(0);
});

test("the panel opens in its own window with the same people", async () => {
  await page.getByTestId("sidebar-detach").click();
  const detached = await panelWindow(app, "people");
  await expect(detached.locator('[data-testid="person"][data-name="Juanito"]')).toBeVisible();
});
