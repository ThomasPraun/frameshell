// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { type DaemonConnection, connectToDaemon } from "@frameshell/protocol";
import { launch, sandbox } from "./harness.js";

// The timeline's letterbox (ADR 0043) in the built app: an agent's `letterbox.set` puts black bars over the preview
// frame at the rows export paints (138 and 139 of 1080 at 2.39), above the picture layers and under the subtitle
// canvas; `clear` takes them away. Real daemon; no media needed, the bars belong to the frame.
const box = sandbox("editing");

test.describe.configure({ mode: "serial" });

let app: ElectronApplication;
let page: Page;
let daemon: DaemonConnection;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  ({ app, page } = await launch(box));
  // The app starts its daemon with the project; the socket can appear a moment after the boot screen is gone.
  await expect
    .poll(async () => {
      daemon = await connectToDaemon(box.socketPath, { client: "cli/e2e" }).catch(() => undefined as unknown as DaemonConnection);
      return daemon !== undefined;
    }, { timeout: 60_000 })
    .toBe(true);
});

test.afterAll(async () => {
  daemon?.close();
  await app?.close();
});

/** Each bar's top and height as fractions of the preview frame, top bar first, and whether the subtitle canvas comes after it. */
const bars = () =>
  page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.getBoundingClientRect();
    const captions = document.querySelector("[data-testid=preview-subtitles]")!;
    return [...document.querySelectorAll<HTMLElement>("[data-testid=preview-letterbox]")].map((bar) => {
      const rect = bar.getBoundingClientRect();
      return {
        top: (rect.top - frame.top) / frame.height,
        height: rect.height / frame.height,
        width: rect.width / frame.width,
        underCaptions: (bar.compareDocumentPosition(captions) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        clickable: getComputedStyle(bar).pointerEvents !== "none",
      };
    });
  });

test("an agent's letterbox shows as bars over the preview, under the captions, and clears", async () => {
  const cwd = box.projectDir;
  await daemon.request("letterbox.set", { cwd, timeline: "main", aspect: 2.39 });
  await expect(page.getByTestId("preview-letterbox")).toHaveCount(2);
  const [top, bottom] = await bars();
  expect(top!.top).toBeCloseTo(0, 3);
  expect(top!.height).toBeCloseTo(138 / 1080, 3);
  expect(bottom!.top).toBeCloseTo(941 / 1080, 3);
  expect(bottom!.height).toBeCloseTo(139 / 1080, 3);
  for (const bar of [top!, bottom!]) {
    expect(bar.width).toBeCloseTo(1, 3);
    expect(bar.underCaptions).toBe(true);
    expect(bar.clickable).toBe(false);
  }

  await daemon.request("letterbox.set", { cwd, timeline: "main", aspect: 4 / 3 });
  await expect.poll(async () => (await bars()).map((bar) => Number(bar.width.toFixed(3)))).toEqual([0.125, 0.125]);

  await daemon.request("letterbox.set", { cwd, timeline: "main", clear: true });
  await expect(page.getByTestId("preview-letterbox")).toHaveCount(0);
});
