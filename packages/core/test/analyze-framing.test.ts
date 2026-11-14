import { describe, expect, it } from "vitest";
import { classifyChange, framingSize } from "../src/analyze/framing.js";

// The pure part of the cut classification of `analyze` (#471): two grey frames in, what the change is out.

const W = 96;
const H = 54;

/** A grey frame of a structured scene: `pattern` sets the background, a bright box at (`x`, `y`) of `box` px is the subject. */
function scene(pattern: "a" | "b", subject: { x: number; y: number; size: number } | null, zoom = 1): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      // Position in the unzoomed scene that this pixel shows.
      const x = (W - 1) / 2 + (px - (W - 1) / 2) / zoom;
      const y = (H - 1) / 2 + (py - (H - 1) / 2) / zoom;
      let grey = pattern === "a" ? 110 + 50 * Math.sin(x / 5) * Math.cos(y / 4) + 30 * (x / W) * (y / H) : 128 + 60 * Math.sin((x + 2 * y) / 6);
      if (subject && x >= subject.x && x < subject.x + subject.size && y >= subject.y && y < subject.y + subject.size) grey = 235;
      out[py * W + px] = Math.max(0, Math.min(255, Math.round(grey)));
    }
  }
  return out;
}

describe("classifyChange", () => {
  it("calls the same framing with the subject moved a jump cut", () => {
    const result = classifyChange(scene("a", { x: 20, y: 14, size: 18 }), scene("a", { x: 52, y: 20, size: 18 }), W, H);
    expect(result.kind).toBe("jump");
    expect(result.scale).toBeNull();
    expect(result.changed).toBeGreaterThan(0.08);
  });

  it("calls a small element appearing on a picture that stays a change, not a cut", () => {
    const result = classifyChange(scene("a", null), scene("a", { x: 60, y: 8, size: 6 }), W, H);
    expect(result.kind).toBe("change");
    expect(result.changed).toBeLessThan(0.08);
  });

  it("calls a flash of two flat frames a change", () => {
    const grey = new Uint8Array(W * H).fill(64);
    const white = new Uint8Array(W * H).fill(255);
    expect(classifyChange(grey, white, W, H).kind).toBe("change");
  });

  it("calls a different picture a cut", () => {
    const result = classifyChange(scene("a", { x: 20, y: 14, size: 18 }), scene("b", null), W, H);
    expect(result.kind).toBe("cut");
    expect(result.scale).toBeNull();
  });

  it("calls a flat frame next to a picture a cut", () => {
    expect(classifyChange(new Uint8Array(W * H), scene("a", null), W, H).kind).toBe("cut");
  });

  it("finds a punch-in and its scale", () => {
    const subject = { x: 36, y: 18, size: 22 };
    const result = classifyChange(scene("a", subject), scene("a", subject, 1.4), W, H);
    expect(result.kind).toBe("punch-in");
    expect(result.scale).toBeGreaterThan(1.3);
    expect(result.scale).toBeLessThan(1.5);
  });

  it("finds a punch-out as a scale under 1", () => {
    const subject = { x: 36, y: 18, size: 22 };
    const result = classifyChange(scene("a", subject, 1.6), scene("a", subject), W, H);
    expect(result.kind).toBe("punch-out");
    expect(result.scale).toBeGreaterThan(0.58);
    expect(result.scale).toBeLessThan(0.68);
  });

  it("finds a punch-in on a subject that is off centre", () => {
    const subject = { x: 55, y: 10, size: 20 };
    const result = classifyChange(scene("a", subject), scene("a", subject, 1.25), W, H);
    expect(result.kind).toBe("punch-in");
    expect(result.scale).toBeGreaterThan(1.15);
    expect(result.scale).toBeLessThan(1.35);
  });

  it("does not take two identical frames for a punch", () => {
    const frame = scene("a", { x: 30, y: 20, size: 20 });
    const result = classifyChange(frame, frame, W, H);
    expect(result.kind).toBe("change");
    expect(result.changed).toBe(0);
    expect(result.scale).toBeNull();
  });
});

describe("framingSize", () => {
  it("reads 96 px on the long side", () => {
    expect(framingSize(1920, 1080)).toEqual({ width: 96, height: 54 });
    expect(framingSize(1080, 1920)).toEqual({ width: 54, height: 96 });
    expect(framingSize(4000, 10)).toEqual({ width: 96, height: 8 });
  });
});
