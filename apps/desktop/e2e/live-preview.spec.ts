// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { blockMean, previewPixels } from "./frames.js";
import { laidOutBox, launch, sandbox, terminalText } from "./harness.js";
import { testFfmpeg } from "./media.js";

// Live preview (ADR 0010): a generated clip whose render is not ready plays its composition in a sandboxed frame from
// `frameshell-live://`, seeked to the playhead, until the engine can play the render. The `card` fixture adapter's live
// page stores each seek in `data-seconds`; the fixture's `live.html` draws it as text. `still` is the same adapter
// without `livePreview`.
const box = sandbox("live");
const mainFile = join(box.projectDir, "timelines", "main.json");
const CARD_PLUGIN = fileURLToPath(new URL("../../../packages/core/test/fixtures/card-plugin/", import.meta.url));
const PINS = { "card-plugin": "file:card-plugin" };
const SIZE = { width: 960, height: 540 };

let app: ElectronApplication;
let page: Page;

/** Install the fixture plugin as `frameshell plugin install` would, and trust it for this project (SPEC §6.6), without npm. */
function installTrustedPlugin(): void {
  const store = join(box.projectDir, ".frameshell", "plugins");
  cpSync(CARD_PLUGIN, join(store, "node_modules", "card-plugin"), { recursive: true });
  writeFileSync(join(store, "package.json"), JSON.stringify({ name: "frameshell-project-plugins", private: true, dependencies: PINS }));
  writeFileSync(join(store, ".frameshell-pins.json"), JSON.stringify(PINS));
  const pluginsHash = createHash("sha256").update(JSON.stringify(Object.entries(PINS).sort())).digest("hex");
  mkdirSync(box.configDir, { recursive: true });
  const decision = { pluginsHash, decision: "trusted", decidedAt: new Date().toISOString() };
  writeFileSync(join(box.configDir, "trust.json"), JSON.stringify({ version: 1, projects: { [box.projectDir]: decision } }));
}

/** Replace the clips of the main timeline's tracks (`v1`, `v2`) with a direct edit (SPEC §6.4). */
function setClips(...tracks: object[][]): void {
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  for (const [i, track] of timeline.tracks.entries()) track.clips = tracks[i] ?? [];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
}

/** Focus the preview on its stage padding (a click on the picture would select a layer), then press `key`. */
async function press(key: string): Promise<void> {
  const stage = await laidOutBox(page.locator(".preview-stage"));
  await page.mouse.click(stage.x + 4, stage.y + 4);
  await page.keyboard.press(key);
}

const live = () => page.getByTestId("preview-live");
const MOD = process.platform === "darwin" ? "Meta" : "Control";
/** A reference line's ` · ` separator as a terminal shows it: PowerShell on Windows CI draws the middle dot as a blank. */
const DOT = "\\s[·\\s]?\\s?";
/** `pattern` with every literal ` · ` matching {@link DOT}. */
const line = (pattern: string) => new RegExp(pattern.split(" · ").join(DOT));

/** Move the pointer to page pixel (`x`, `y`) of a full-frame clip's live page, on the preview frame. */
async function pointAt(x: number, y: number): Promise<{ x: number; y: number }> {
  const frame = await laidOutBox(page.getByTestId("preview-frame"));
  const at = { x: frame.x + (frame.width * x) / SIZE.width, y: frame.y + (frame.height * y) / SIZE.height };
  await page.mouse.move(at.x, at.y, { steps: 3 });
  return at;
}
const liveText = () => page.frameLocator('[data-testid="preview-live"] iframe').locator("#time");

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  installTrustedPlugin();
  writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg: await testFfmpeg() } }));
  ({ app, page } = await launch(box));
  await expect(page.getByTestId("preview-frame")).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
});

test("a clip still rendering plays its live page at the playhead, labelled live, then hands over to its render", async () => {
  test.setTimeout(120_000);
  setClips([{ id: "c_slow", type: "card", source: "compositions/cards/slow.json", start: 0, in: 0.5, duration: 2 }]);

  await expect(live()).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await expect(live()).toHaveAttribute("data-clip", "c_slow");
  // The slate steps aside for a label: the picture is the composition, not the render export will use.
  await expect(page.getByTestId("preview-layer-pending")).toHaveCount(0);
  await expect(page.getByTestId("preview-live-label")).toContainText("Live,");
  // Composition time = in + (playhead - start): 0.5 s at the program's first frame.
  await expect(live()).toHaveAttribute("data-shown", "0.500");
  await expect(liveText()).toHaveText("0.500");

  // The page is laid out at the project format and scaled to the frame, like the render.
  const frame = await laidOutBox(page.getByTestId("preview-frame"));
  // The label sits in the top right corner, clear of the lower third where titles play.
  const label = await laidOutBox(page.getByTestId("preview-live-label"));
  expect(Math.abs(label.y - frame.y - 8)).toBeLessThan(2);
  expect(Math.abs(frame.x + frame.width - (label.x + label.width) - 8)).toBeLessThan(2);
  const shown = await laidOutBox(live());
  expect(Math.abs(shown.width - frame.width)).toBeLessThan(2);
  expect(Math.abs(shown.height - frame.height)).toBeLessThan(2);
  const inner = await live().locator("iframe").evaluate((element) => element.getBoundingClientRect().width);
  expect(Math.abs(inner - frame.width)).toBeLessThan(2);

  await press("Shift+ArrowRight");
  await expect(page.getByTestId("playhead")).toHaveText("00:00:01:00");
  await expect(live()).toHaveAttribute("data-shown", "1.500");
  await expect(liveText()).toHaveText("1.500");
  await page.keyboard.press("ArrowLeft");
  await expect(liveText()).toHaveText("1.467");

  // Render ready: the frame goes, the engine draws the red render.
  await expect(live()).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId("preview-live-label")).toHaveCount(0);
  await expect
    .poll(async () => {
      const [r, g, b] = blockMean(await previewPixels(page, SIZE), SIZE, 472, 262, 16);
      return r > 180 && Math.max(g, b) < 70;
    }, { timeout: 20_000 })
    .toBe(true);
});

test("a clip under another picture, or whose adapter has no live preview, keeps its slate", async () => {
  test.setTimeout(120_000);
  await press("Home");
  // V1: a card that renders for a minute. V2: a `still` clip over it, rendering too, with no live preview.
  setClips(
    [{ id: "c_held", type: "card", source: "compositions/cards/held.json", start: 0, duration: 2 }],
    [{ id: "c_still", type: "still", source: "compositions/cards/still.json", start: 0, duration: 2 }],
  );
  const pending = page.getByTestId("preview-layer-pending");
  await expect(pending).toHaveCount(2, { timeout: 30_000 });
  // Long enough for a live page to have loaded had one been allowed.
  await page.waitForTimeout(1_500);
  await expect(live()).toHaveCount(0);

  // The overlay goes: the card is now the topmost picture and plays live.
  setClips([{ id: "c_held", type: "card", source: "compositions/cards/held.json", start: 0, duration: 2 }]);
  await expect(live()).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await expect(live()).toHaveAttribute("data-clip", "c_held");
  await expect(liveText()).toHaveText("0.000");
});

test("the Pick tool outlines the element under the pointer and picks it for the agent (ADR 0011)", async () => {
  test.setTimeout(120_000);
  // c_held still renders: the pick page loads beside the live one. #time is the 64 px text block from y 64 (its margin).
  await press("i");
  await expect(page.getByRole("button", { name: "Pick" })).toHaveAttribute("aria-pressed", "true");
  await pointAt(90, 70);
  const outline = page.getByTestId("preview-pick-outline");
  await expect(outline).toHaveAttribute("data-selector", "#time", { timeout: 30_000 });
  await expect(outline).toHaveAttribute("data-clip", "c_held");
  await expect(page.getByTestId("preview-pick-page")).toHaveCount(1);
  // ↑ walks up to the page's parent of #time: body, which paints nothing, is never a step; nothing above #time here.
  await page.keyboard.press("ArrowUp");
  await expect(outline).toHaveAttribute("data-selector", "#time");

  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByTestId("preview-pick-point")).toHaveAttribute("data-selector", "#time");
  await page.keyboard.press(`${MOD}+l`);
  const picked = line(String.raw`\[frameshell\] point \(0\.09,0\.13\) @ 00:00:00\.00 · clip c_held card compositions/cards/held\.json · element #time "0\.000" · details (\.frameshell/context/e_0000_1\.json) · frame pending`);
  await expect.poll(() => terminalText(page), { timeout: 30_000 }).toMatch(picked);
  const details = JSON.parse(readFileSync(join(box.projectDir, picked.exec(await terminalText(page))![1]!), "utf8"));
  expect(details).toMatchObject({ kind: "point", target: "c_held", layers: [{ clip: "c_held", type: "card", paints: true }] });
  expect(details.elements[0]).toMatchObject({ selector: "#time", tag: "p", text: "0.000", box: { x: 0, y: 64 } });

  // The page's own background (the card colour on <html>) is what shows elsewhere: it is the hit there.
  await pointAt(800, 400);
  await expect(outline).toHaveAttribute("data-selector", "html");
  // Ask agent focused the terminal: back to the preview first.
  await press("Escape");
  await expect(page.getByTestId("preview-pick-point")).toHaveCount(0);
});

test("the Pick tool probes a clip whose render is ready, at the paused time", async () => {
  test.setTimeout(120_000);
  // c_slow rendered in the first test: the engine plays its render, and a pick page answers for it.
  setClips([{ id: "c_slow", type: "card", source: "compositions/cards/slow.json", start: 0, in: 0.5, duration: 2 }]);
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "1");
  await expect(live()).toHaveCount(0);
  await pointAt(90, 70);
  const outline = page.getByTestId("preview-pick-outline");
  await expect(outline).toHaveAttribute("data-selector", "#time", { timeout: 30_000 });
  await expect(outline).toHaveAttribute("data-clip", "c_slow");
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press(`${MOD}+l`);
  await expect
    .poll(() => terminalText(page), { timeout: 30_000 })
    .toMatch(line(String.raw`point \(0\.09,0\.13\) @ 00:00:00\.00 · clip c_slow card compositions/cards/slow\.json · element #time "0\.500" · details \S+ · frame \.frameshell/context/f_0000\.png`));
  // Escape clears the pick, then leaves the tool.
  await press("Escape");
  await expect(page.getByTestId("preview-pick-point")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Pick" })).toHaveAttribute("aria-pressed", "false");
});

test("the bridge applies the clip's element sheet, swaps it without a reload and counts matches (ADR 0021)", async () => {
  test.setTimeout(120_000);
  await press("Home");
  setClips([
    { id: "c_held", type: "card", source: "compositions/cards/held.json", start: 0, duration: 2, elements: { "#time": { y: 100 }, "#nothing": { x: 5 } } },
  ]);
  await expect(live()).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  const time = page.frameLocator('[data-testid="preview-live"] iframe').locator("#time");
  const translate = () => time.evaluate((element) => getComputedStyle(element).translate);
  const top = () => time.evaluate((element) => element.getBoundingClientRect().top);
  await expect.poll(translate).toBe("0px 100px");
  const before = await top();
  await time.evaluate(() => {
    (window as unknown as { marker: string }).marker = "same page";
  });

  // Swap from the renderer as the drag will (#334): no reload, and the answer counts each selector.
  const counts = await page.evaluate(
    (css) =>
      new Promise<Record<string, number>>((resolve) => {
        const frame = document.querySelector<HTMLIFrameElement>('[data-testid="preview-live"] iframe')!;
        window.addEventListener("message", function onMessage(event) {
          const data = event.data as { source?: string; elements?: { id: number; counts: Record<string, number> } } | null;
          if (event.source !== frame.contentWindow || data?.source !== "frameshell-live" || data.elements?.id !== 41) return;
          window.removeEventListener("message", onMessage);
          resolve(data.elements.counts);
        });
        frame.contentWindow!.postMessage({ source: "frameshell-preview", elements: { id: 41, css, selectors: ["#time", "#nothing"] } }, "*");
      }),
    "#time { translate: 0px 200px !important; }",
  );
  expect(counts).toEqual({ "#time": 1, "#nothing": 0 });
  await expect.poll(translate).toBe("0px 200px");
  expect(await time.evaluate(() => (window as unknown as { marker?: string }).marker)).toBe("same page");
  // 100 more composition px: rects inside the frame are in the page's own, unscaled pixels.
  expect((await top()) - before).toBeCloseTo(100, 0);
});

test("element mode: a double-click enters the clip's elements, a drag saves one adjustment, undo removes it (ADR 0021)", async () => {
  test.setTimeout(150_000);
  await press("Home");
  // c_slow's render is ready (first test): the engine draws it; element mode loads its page to probe and drag.
  setClips([{ id: "c_slow", type: "card", source: "compositions/cards/slow.json", start: 0, in: 0.5, duration: 2 }]);
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "1");
  await expect(live()).toHaveCount(0);
  const elementsOf = () => JSON.parse(readFileSync(mainFile, "utf8")).tracks[0].clips[0].elements;

  const at = await pointAt(90, 70);
  await page.mouse.dblclick(at.x, at.y);
  const layer = page.getByTestId("preview-element-layer");
  await expect(layer).toHaveAttribute("data-clip", "c_slow", { timeout: 30_000 });
  await expect(layer).toHaveAttribute("data-live", "true");
  // The whole clip's handles give way to the element's.
  await expect(page.getByTestId("layer-handles")).toHaveCount(0);
  // The inspector grew an Elements group, so the frame may have moved: points are measured again.
  const from = await pointAt(92, 72);
  await expect(page.getByTestId("preview-element-hover")).toHaveAttribute("data-selector", "#time", { timeout: 30_000 });

  // Drag #time by 100 × 50 composition px: the page is laid out at the 960×540 project format, unit 1.
  const frame = await laidOutBox(page.getByTestId("preview-frame"));
  const scale = frame.width / SIZE.width;
  await page.mouse.down();
  await page.mouse.move(from.x + 50 * scale, from.y + 25 * scale, { steps: 4 });
  await page.mouse.move(from.x + 100 * scale, from.y + 50 * scale, { steps: 4 });
  // While dragging, the clip's live page shows with the new sheet in place of its render.
  await expect(page.locator('[data-testid="preview-pick-page"].is-shown')).toHaveCount(1);
  const dragged = page.frameLocator('[data-testid="preview-pick-page"].is-shown iframe').locator("#time");
  const translate = () => dragged.evaluate((element) => getComputedStyle(element).translate);
  await expect.poll(translate).not.toBe("none");
  const shown = await translate();
  await page.mouse.up();

  await expect.poll(() => elementsOf(), { timeout: 30_000 }).toBeTruthy();
  const saved = elementsOf()["#time"];
  // Within a screen px or two of the frame, which may be small on a busy desktop.
  const slack = Math.ceil(2 / scale);
  expect(Math.abs(saved.x - 100)).toBeLessThanOrEqual(slack);
  expect(Math.abs(saved.y - 50)).toBeLessThanOrEqual(slack);
  expect(Object.keys(saved).sort()).toEqual(["x", "y"]);
  // The drag showed what was saved.
  expect(shown).toBe(`${saved.x}px ${saved.y}px`);
  const row = page.getByTestId("element-adjustment");
  await expect(row).toHaveAttribute("data-selector", "#time");
  // An id-anchored selector is not fragile, and it matches at the shown frame.
  await expect(row).not.toContainText("May not follow code edits");
  await expect(row).not.toHaveAttribute("data-unmatched", "true");
  await expect(page.getByTestId("element-handles")).toHaveAttribute("data-selector", "#time");

  // One undo step: the entry goes.
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => elementsOf(), { timeout: 30_000 }).toBeUndefined();
  await expect(row).toHaveCount(0);

  // Escape leaves element mode: the clip's own handles return.
  await press("Escape");
  await expect(layer).toHaveCount(0);
  await expect(page.getByTestId("layer-handles")).toHaveAttribute("data-clip", "c_slow");

  // Turning Pick on leaves element mode, so ↑/↓ reach only the Pick layer (ancestors, or photo part sizes).
  const again = await pointAt(90, 70);
  await page.mouse.dblclick(again.x, again.y);
  await expect(layer).toHaveAttribute("data-clip", "c_slow", { timeout: 30_000 });
  await press("i");
  await expect(page.getByRole("button", { name: "Pick" })).toHaveAttribute("aria-pressed", "true");
  await expect(layer).toHaveCount(0);
  await press("i");
  await expect(page.getByRole("button", { name: "Pick" })).toHaveAttribute("aria-pressed", "false");
  await expect(layer).toHaveCount(0);
});
