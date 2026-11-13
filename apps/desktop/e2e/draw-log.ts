// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import type { Page } from "@playwright/test";

// Program frames the engine drew, from every `data-shown` change of the preview frame. The engine worker draws without
// the page's main thread (ADR 0001): a page rAF that runs late misses frames that did reach the screen, so drops are
// counted from these draws (#567, #573); canvas reads only check what a frame showed and in which order.

interface DrawLog {
  values: (string | null)[];
  flush: () => void;
  current: () => string | null;
  stop: () => void;
}

/** Start logging the draws of the preview in `page`; a second call starts a new log. Read it with {@link drawnFrames}. */
export async function startDrawLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window as unknown as { frameshellDrawLog?: DrawLog };
    store.frameshellDrawLog?.stop();
    const box = document.querySelector('[data-testid="preview-frame"]')!;
    // Each record holds the value before its change: those, then the current value, are every value the attribute had.
    const values: (string | null)[] = [];
    const observer = new MutationObserver((records) => values.push(...records.map((record) => record.oldValue)));
    observer.observe(box, { attributes: true, attributeFilter: ["data-shown"], attributeOldValue: true });
    store.frameshellDrawLog = {
      values,
      flush: () => values.push(...observer.takeRecords().map((record) => record.oldValue)),
      current: () => box.getAttribute("data-shown"),
      stop: () => observer.disconnect(),
    };
  });
}

/**
 * Program frames drawn since {@link startDrawLog}, in draw order: the frame shown when it started, then each change.
 * The engine reports a draw after it, so call this a moment after the last frame of interest.
 */
export async function drawnFrames(page: Page): Promise<number[]> {
  const values = await page.evaluate(() => {
    const log = (window as unknown as { frameshellDrawLog?: DrawLog }).frameshellDrawLog;
    if (!log) throw new Error("startDrawLog was not called");
    log.flush();
    return [...log.values, log.current()];
  });
  return values.flatMap((value) => (value === null ? [] : [Number(value)]));
}

/** How many program frames in `[from, to)` are not in `drawn`. */
export function framesNeverDrawn(drawn: readonly number[], from: number, to: number): number {
  const seen = new Set(drawn);
  let missing = 0;
  for (let frame = from; frame < to; frame++) if (!seen.has(frame)) missing++;
  return missing;
}
