// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Page, expect } from "@playwright/test";
import type { FrameshellApi } from "../src/shared/api.js";
import { BARCODE, makeSource, testFfmpeg } from "./media.js";
import type { Sandbox } from "./harness.js";

/**
 * Put a synthetic barcode clip (see `media.ts`) into the sandbox project's
 * `assets/` and point the sandbox daemon at the managed test ffmpeg (global
 * `config.json`), so the real ingest builds its proxy and sidecar.
 */
export async function addBarcodeAsset(box: Sandbox, name: string, seconds: number): Promise<void> {
  const ffmpeg = await testFfmpeg();
  mkdirSync(join(box.projectDir, "assets"), { recursive: true });
  mkdirSync(box.configDir, { recursive: true });
  writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg } }));
  // Written elsewhere first: the daemon's asset watcher must never see a half-written file.
  const staging = join(box.dataDir, "staging");
  mkdirSync(staging, { recursive: true });
  await makeSource(ffmpeg, join(staging, name), { seconds });
  renameSync(join(staging, name), join(box.projectDir, "assets", name));
}

/** Wait until `asset.list` reports `path` ingested (proxy and sidecar built). */
export async function waitForIngest(page: Page, path: string, timeout = 120_000): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(async (asset) => {
          const list = await (window as unknown as { frameshell: FrameshellApi }).frameshell.media.assets();
          const found = list.find((a) => a.path === asset);
          return found ? `${found.state}${found.error ? `: ${found.error}` : ""}` : "missing";
        }, path),
      { timeout, intervals: [250, 500, 1000] },
    )
    .toBe("ready");
}

/**
 * Install `window.readShownFrame()`: decodes the barcode of what the preview
 * canvas shows now (the source frame index), -1 when there is none (black,
 * placeholder). Same geometry as the synthetic source.
 */
export async function installFrameReader(page: Page): Promise<void> {
  await page.evaluate((geometry) => {
    const probe = document.createElement("canvas");
    const context = probe.getContext("2d", { willReadFrequently: true })!;
    (window as unknown as { readShownFrame: () => number }).readShownFrame = () => {
      const canvas = document.querySelector<HTMLCanvasElement>(".preview-canvas");
      if (!canvas || canvas.width === 0) return -1;
      const { width, height } = canvas;
      const rowHeight = Math.round(height * geometry.rowHeight);
      const cellWidth = width * geometry.cellWidth;
      probe.width = Math.ceil(cellWidth * geometry.cells);
      probe.height = rowHeight * 2;
      context.drawImage(canvas, 0, 0, probe.width, probe.height, 0, 0, probe.width, probe.height);
      const pixels = context.getImageData(0, 0, probe.width, probe.height).data;
      let bits = 0;
      let check = 0;
      for (let i = 0; i < geometry.cells; i++) {
        const x = Math.floor(cellWidth * (i + 0.5));
        if (pixels[(Math.floor(rowHeight / 2) * probe.width + x) * 4]! > 128) bits |= 1 << i;
        if (pixels[(Math.floor(rowHeight * 1.5) * probe.width + x) * 4]! > 128) check |= 1 << i;
      }
      return (bits ^ check) === 0xffff ? bits : -1;
    };
  }, BARCODE);
}

/** Source frame the preview shows now; see {@link installFrameReader}. */
export function readShownFrame(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { readShownFrame: () => number }).readShownFrame());
}
