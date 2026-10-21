import { describe, expect, it } from "vitest";
import { type ImageLayersDeps, addImageLayers, nativeScale } from "../src/main/image-layers.js";

// Seam under test: how main stacks pictures as the layers of an image project (ADR 0017), against a recording
// stand-in for the daemon.

function harness(options: { failAt?: string } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let next = 0;
  const request = (async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === options.failAt) throw new Error(`${method} failed`);
    return method === "track.add" ? { changes: { added: [`t_${++next}`] } } : {};
  }) as unknown as ImageLayersDeps["request"];
  const sizes: Record<string, { width: number; height: number }> = { "assets/back.jpg": { width: 1920, height: 1080 }, "assets/logo.png": { width: 384, height: 108 } };
  const deps: ImageLayersDeps = { request, alone: (work) => work(), resolution: { width: 1920, height: 1080 }, imageSize: (asset) => sizes[asset] ?? null };
  return { calls, deps, methods: () => calls.map((call) => call.method) };
}

describe("nativeScale", () => {
  it("undoes the fit to the frame, and leaves unknown or exact sizes alone", () => {
    expect(nativeScale({ width: 320, height: 200 }, { width: 1280, height: 720 })).toBe(0.2778);
    expect(nativeScale({ width: 3840, height: 2160 }, { width: 1920, height: 1080 })).toBe(2);
    expect(nativeScale({ width: 1920, height: 1080 }, { width: 1920, height: 1080 })).toBe(1);
    expect(nativeScale(null, { width: 1920, height: 1080 })).toBe(1);
  });
});

describe("addImageLayers", () => {
  it("puts each image on its own new video track from 0 at its pixel size, first image lowest, in one transaction", async () => {
    const { calls, deps, methods } = harness();
    expect(await addImageLayers("/p", "main", ["assets/back.jpg", "assets/talk.mp4", "assets/logo.png"], deps)).toEqual(["t_1", "t_2"]);
    expect(methods()).toEqual(["tx.begin", "track.add", "clip.add", "track.add", "clip.add", "tx.commit"]);
    expect(calls[0]?.params).toMatchObject({ label: "Add 2 layers" });
    expect(calls[1]?.params).toMatchObject({ cwd: "/p", timeline: "main", kind: "video", name: "back" });
    expect(calls[2]?.params).toEqual({ cwd: "/p", timeline: "main", track: "t_1", asset: "assets/back.jpg", start: 0 });
    expect(calls[3]?.params).toMatchObject({ name: "logo" });
    // 384x108 fits a 1920x1080 frame at 5x; scale 0.2 shows it pixel for pixel.
    expect(calls[4]?.params).toMatchObject({ asset: "assets/logo.png", transform: { scale: 0.2 } });
  });

  it("does nothing without images", async () => {
    const { deps, methods } = harness();
    expect(await addImageLayers("/p", "main", ["assets/talk.mp4"], deps)).toEqual([]);
    expect(methods()).toEqual([]);
  });

  it("commits what it placed when a step fails, and rejects", async () => {
    const { deps, methods } = harness({ failAt: "clip.add" });
    await expect(addImageLayers("/p", "main", ["assets/logo.png"], deps)).rejects.toThrow(/clip.add failed/);
    expect(methods()).toEqual(["tx.begin", "track.add", "clip.add", "tx.commit"]);
  });
});
