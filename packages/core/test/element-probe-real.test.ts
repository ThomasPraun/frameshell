import { PROBE_SCRIPT, type MovableElement } from "@frameshell/protocol";
import { elementStyles } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { Chrome } from "../src/inspect/chrome.js";
import { testBinaryManager } from "./media-tools.js";

// Seam under test: the probe's `unit` (ADR 0021) on a composition sized unlike the page, in real headless Chrome
// (opt-in: FRAMESHELL_TEST_REAL_CHROME=1). A move of `x` composition px must shift the element `x * unit` page px.

const ORIGIN = "http://frameshell.test";

/** A 1920×1080 stage drawn at half size in a 960×540 page, as a composition scaled to fit a smaller project. */
const PAGE =
  `<!doctype html><html><head><script>${PROBE_SCRIPT}</script><style>html,body{margin:0}` +
  `#stage{position:absolute;left:0;top:0;width:1920px;height:1080px;transform:scale(0.5);transform-origin:0 0}` +
  `#title{position:absolute;left:400px;top:200px;width:200px;height:100px;background:#222}</style></head>` +
  `<body><div id="stage"><div id="title"></div></div></body></html>`;

describe.runIf(process.env["FRAMESHELL_TEST_REAL_CHROME"] === "1")("element probe unit in real headless Chrome", () => {
  it(
    "reports the stage's scale as the unit, and an adjustment moves the element by composition px times it",
    async () => {
      const chrome = await Chrome.launch(await testBinaryManager().ensure("chrome-headless-shell"));
      try {
        const page = await chrome.page(960, 540, ORIGIN, async () => ({ status: 200, contentType: "text/html", body: Buffer.from(PAGE) }));
        await page.navigate(`${ORIGIN}/index.html`, 30_000);
        const found = await page.evaluate<MovableElement | null>(`window.__frameshellProbe.element("#title")`, 30_000);
        expect(found?.unit).toBeCloseTo(0.5);
        expect(found?.element.box).toMatchObject({ x: 200, y: 100, width: 100, height: 50 });
        const css = elementStyles({ "#title": { x: 100, y: -40 } });
        const moved = await page.evaluate<{ x: number; y: number }>(
          `(() => { const s = document.createElement("style"); s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s);` +
            ` const r = document.querySelector("#title").getBoundingClientRect(); return { x: r.x, y: r.y }; })()`,
          30_000,
        );
        expect(moved).toEqual({ x: 200 + 100 * 0.5, y: 100 - 40 * 0.5 });
      } finally {
        await chrome.close();
      }
    },
    600_000,
  );
});
