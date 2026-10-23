import { describe, expect, it } from "vitest";
import { layerRect, placementOf } from "@frameshell/schema";
import { cutoutTransform, maskBox } from "../src/segment/cutout.js";

describe("maskBox", () => {
  it("boxes the non-black pixels and is null for an all-black mask", () => {
    const size = { width: 5, height: 4 };
    const mask = new Uint8Array(20);
    mask[1 * 5 + 3] = 255;
    mask[2 * 5 + 1] = 40;
    expect(maskBox(mask, size)).toEqual([1, 1, 3, 2]);
    expect(maskBox(new Uint8Array(20), size)).toBeNull();
  });
});

describe("cutoutTransform", () => {
  const project = { width: 1920, height: 1080 };
  const photo = { width: 4000, height: 3000 };

  it.each([
    ["a tall part, fitted by height", [500, 200, 800, 2400]],
    ["a wide part, fitted by width", [100, 2500, 3600, 300]],
    ["the whole photo", [0, 0, 4000, 3000]],
  ] as const)("lays %s exactly over that part of the placed photo", (_name, box) => {
    const transform = { x: -120, y: 40, scale: 0.7, opacity: 0.6 };
    const photoRect = layerRect(photo, project, project, placementOf(transform));
    const cut = cutoutTransform(photo, [...box], project, transform);
    const cutRect = layerRect({ width: box[2], height: box[3] }, project, project, placementOf(cut));
    const perPixel = photoRect.width / photo.width;
    // Whole-pixel rounding of both rects: within 2 px.
    expect(Math.abs(cutRect.left - (photoRect.left + box[0] * perPixel))).toBeLessThanOrEqual(2);
    expect(Math.abs(cutRect.top - (photoRect.top + box[1] * perPixel))).toBeLessThanOrEqual(2);
    expect(Math.abs(cutRect.width - box[2] * perPixel)).toBeLessThanOrEqual(2);
    expect(Math.abs(cutRect.height - box[3] * perPixel)).toBeLessThanOrEqual(2);
    expect(cut.opacity).toBe(0.6);
  });
});
