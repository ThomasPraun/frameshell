import { describe, expect, it } from "vitest";
import { MOTION_RUNTIME } from "../src/motion-runtime.js";
import { CURSOR_MATH } from "../src/templates/cursor-kit.js";
import { TEMPLATES, type Template, type TemplateVariable } from "../src/templates/index.js";

interface Leg {
  start: number;
  dur: number;
  arrive: number;
  leave: number;
  cx: number;
  cy: number;
}
interface Kit {
  journey(from: { x: number; y: number }, stops: object[], start: number, drift?: { x: number; y: number }): { legs: Leg[]; at(t: number): { x: number; y: number } };
  press(t: number, down: number, up: number): number;
  flat(scale: number | undefined): number | undefined;
  put(element: { style: { transform: string; opacity: string } }, pose: object): void;
}

// The same script text the templates carry, run in Node against the same runtime bundle.
const motion = new Function(`${MOTION_RUNTIME}; return FrameshellMotion;`)() as { durationFromDistance(px: number): number };
const kit = new Function("M", "unit", "S", `${CURSOR_MATH}; return { journey, press, flat, put, inFrame };`)(motion, 1080, { width: 1920, height: 1080 }) as Kit;
const FROM = { x: 2000, y: 500 };

const variablesOf = (id: string): TemplateVariable[] => {
  const template = TEMPLATES.find((t) => t.id === id) as Template;
  return template.variables({ id: "spot", width: 1920, height: 1080, duration: template.defaultDuration, tokens: { colors: {}, brand: {}, used: [], problem: null } });
};

describe("the cursor kit (#466)", () => {
  it("clicks as the ticket measures it: 0.84 after 0.1 s, back to 1 by 0.22 s later, untouched before", () => {
    expect(kit.press(0.9, 1, 1.1)).toBe(1);
    expect(kit.press(1.1, 1, 1.1)).toBeCloseTo(0.84, 6);
    expect(kit.press(1.32, 1, 1.1)).toBeCloseTo(1, 6);
    expect(kit.press(5, 1, 1.1)).toBeCloseTo(1, 6);
    // Held down for a drag: it stays at 0.84 until the release.
    expect(kit.press(1.8, 1, 2)).toBeCloseTo(0.84, 6);
  });

  it("moves on an arc whose control point is 15 % of the leg off the chord, and lands exactly on the target", () => {
    const trip = kit.journey(FROM, [{ x: 1000, y: 500 }], 0.05);
    const leg = trip.legs[0]!;
    expect(leg.start).toBe(0.05);
    expect(leg.dur).toBeCloseTo(motion.durationFromDistance(1000), 9);
    expect(leg.cx).toBeCloseTo(1500, 6);
    expect(Math.abs(leg.cy - 500)).toBeCloseTo(150, 6);
    expect(trip.at(0.05)).toEqual(FROM);
    expect(trip.at(leg.arrive)).toEqual({ x: 1000, y: 500 });
    expect(Math.abs(trip.at(leg.start + leg.dur / 2).y - 500)).toBeGreaterThan(20);
    expect(trip.at(0.4)).toEqual(trip.at(0.4));
  });

  it("hesitates: it stops short of the target, creeps, and arrives later by the pause", () => {
    const plain = kit.journey(FROM, [{ x: 1000, y: 500 }], 0).legs[0]!;
    const slow = kit.journey(FROM, [{ x: 1000, y: 500, hesitate: 0.4 }], 0);
    expect(slow.legs[0]!.arrive).toBeCloseTo(plain.dur * 1.2 + 0.4, 9);
    // In the middle of the pause the cursor has covered about 87 % of the leg and barely moves.
    const covered = (FROM.x - slow.at(plain.dur * 0.7 + 0.2).x) / 1000;
    expect(covered).toBeGreaterThan(0.8);
    expect(covered).toBeLessThan(0.95);
    expect(Math.abs(slow.at(plain.dur * 0.7 + 0.35).x - slow.at(plain.dur * 0.7 + 0.2).x)).toBeLessThan(10);
  });

  it("waits at each stop, then keeps drifting after the last", () => {
    const trip = kit.journey(FROM, [{ x: 1000, y: 500, wait: 0.5 }, { x: 900, y: 700 }], 0, { x: 10, y: 5 });
    const [first, second] = trip.legs as [Leg, Leg];
    expect(second.start).toBeCloseTo(first.arrive + 0.5, 9);
    expect(trip.at(first.arrive + 0.25)).toEqual({ x: 1000, y: 500 });
    expect(trip.at(second.arrive)).toEqual({ x: 900, y: 700 });
    expect(trip.at(second.arrive + 2)).toEqual({ x: 920, y: 710 });
  });

  it("writes a scale within 0.6 % of 1 as exactly 1 (Chrome keeps an earlier raster for it), and leaves the rest alone", () => {
    expect(kit.flat(0.995)).toBe(1);
    expect(kit.flat(1.005)).toBe(1);
    expect(kit.flat(0.99)).toBe(0.99);
    expect(kit.flat(0.84)).toBe(0.84);
    expect(kit.flat(undefined)).toBeUndefined();
    const element = { style: { transform: "", opacity: "" } };
    kit.put(element, { x: 3, scale: 0.997, opacity: 0.5 });
    expect(element.style).toEqual({ transform: "translate(3px, 0px) rotate(0deg) scale(1, 1)", opacity: "0.5" });
  });
});

describe("the UI demo templates", () => {
  it.each(["cursor-click", "cursor-drag-drop", "cursor-marquee", "cursor-text-select", "app-window", "typing-field"])("%s declares the cursor props in the ticket's range", (id) => {
    const variables = variablesOf(id);
    expect(variables.find((v) => v.id === "cursorSize")).toMatchObject({ type: "number", min: 0.04, max: 0.07 });
    expect(variables.find((v) => v.id === "pointer")).toMatchObject({ type: "color" });
    expect(variables.find((v) => v.id === "hesitate")).toMatchObject({ type: "number", min: 0 });
  });

  it("app-window and typing-field work without the cursor, and app-window paints its own background", () => {
    for (const id of ["app-window", "typing-field"]) {
      const cursor = variablesOf(id).find((v) => v.id === "cursor");
      expect(cursor).toMatchObject({ type: "enum", default: "on" });
      expect(cursor?.type === "enum" && cursor.options.map((o) => o.value)).toEqual(["on", "off"]);
    }
    expect(TEMPLATES.find((t) => t.id === "app-window")?.overlay).toBe(false);
    expect(variablesOf("app-window").map((v) => v.id)).not.toContain("backdrop");
  });
});
