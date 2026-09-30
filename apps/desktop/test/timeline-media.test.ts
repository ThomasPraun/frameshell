import type { AssetInfo } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import type { FrameshellApi } from "../src/shared/api.js";
import { MediaCache } from "../src/renderer/src/timeline/media.js";

// Seam: MediaCache as the timeline painter sees it (`waveform`, `thumbnails`), fed by a fake `media` bridge.

function asset(path: string, ready: boolean): AssetInfo {
  return {
    path,
    hash: ready ? "sha256:ab" : null,
    state: ready ? "ready" : "processing",
    error: null,
    media: null,
    proxy: null,
    sidecar: null,
    waveform: ready ? { path: `.frameshell/waveforms/${path.slice(7)}.json`, peaksPerSecond: 10 } : null,
    thumbnails: null,
  };
}

const PEAKS = { peaksPerSecond: 10, peaks: [[-3, 5]] };

/** A bridge whose `assets()` replies when the test says. */
function fakeMedia(files: Record<string, unknown> = {}) {
  const replies: ((assets: AssetInfo[]) => void)[] = [];
  const api: FrameshellApi["media"] = {
    assets: () => new Promise((resolve) => replies.push(resolve)),
    read: async (path) => new TextEncoder().encode(JSON.stringify(files[path] ?? PEAKS)),
    onChanged: () => () => undefined,
  };
  return { api, reply: (assets: AssetInfo[]) => replies.shift()!(assets) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("MediaCache", () => {
  it("draws an asset's waveform once an asset.changed event says it is ready", async () => {
    const media = fakeMedia();
    let loads = 0;
    const cache = new MediaCache(media.api, () => loads++);
    const refreshed = cache.refresh();
    media.reply([asset("assets/voice.wav", false)]);
    await refreshed;
    expect(cache.waveform("assets/voice.wav")).toBeNull();

    cache.apply({ path: "assets/voice.wav", asset: asset("assets/voice.wav", true) });
    expect(cache.waveform("assets/voice.wav")).toBeNull(); // Load starts on first ask.
    await tick();
    expect(cache.waveform("assets/voice.wav")).toEqual(PEAKS);
    expect(loads).toBeGreaterThanOrEqual(2);
  });

  it("forgets an asset whose file is gone", async () => {
    const media = fakeMedia();
    const cache = new MediaCache(media.api, () => undefined);
    const refreshed = cache.refresh();
    media.reply([asset("assets/voice.wav", true)]);
    await refreshed;
    cache.waveform("assets/voice.wav");
    await tick();
    expect(cache.waveform("assets/voice.wav")).toEqual(PEAKS);

    cache.apply({ path: "assets/voice.wav", asset: null });
    expect(cache.waveform("assets/voice.wav")).toBeNull();
  });

  it("keeps an event that lands while a full re-read is in flight", async () => {
    const media = fakeMedia();
    const cache = new MediaCache(media.api, () => undefined);
    const refreshed = cache.refresh();
    cache.apply({ path: "assets/voice.wav", asset: asset("assets/voice.wav", true) });
    // The re-read was answered before the asset finished: older than the event.
    media.reply([asset("assets/voice.wav", false)]);
    await refreshed;
    cache.waveform("assets/voice.wav");
    await tick();
    expect(cache.waveform("assets/voice.wav")).toEqual(PEAKS);
  });
});
