import { describe, expect, it } from "vitest";
import { MOTION_RUNTIME } from "../src/motion-runtime.js";
import { CAMERA_MATH, CURSOR_MATH } from "../src/templates/cursor-kit.js";
import { kitScript, trimScript } from "../src/templates/kit.js";
import { TYPING_MATH } from "../src/templates/typing-kit.js";
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
  journey(from: { x: number; y: number }, stops: object[], start: number, drift?: { x: number; y: number }, rate?: number): { legs: Leg[]; at(t: number): { x: number; y: number } };
  press(t: number, down: number, up: number): number;
  flat(scale: number | undefined): number | undefined;
  put(element: { style: { transform: string; opacity: string } }, pose: object): void;
  fitFirst<T extends { ready: number }>(tries: number[][], build: (...args: number[]) => T, deadline: number): T;
  latest(tail: number): number;
  camera(focus: { x: number; y: number }, e: number, zoom: number): { x: number; y: number; scale: number };
  zoomAt(t: number, a: number, b: number, c: number, d: number): number;
  rhythm(chars: string[], from: number, speed: number): { when: number[]; end: number };
  typingTries(run: number): number[][];
  CURSOR_TRIES: number[][];
}

// The same script text the templates carry, run in Node against the same runtime bundle.
const motion = new Function(`${MOTION_RUNTIME}; return FrameshellMotion;`)() as { durationFromDistance(px: number): number };
const kitFor = (duration: number): Kit =>
  new Function(
    "M",
    "unit",
    "S",
    `${CURSOR_MATH}\n${CAMERA_MATH}\n${TYPING_MATH}; return { journey, press, flat, put, inFrame, fitFirst, latest, camera, zoomAt, rhythm, typingTries, CURSOR_TRIES };`,
  )(motion, 1080, { width: 1920, height: 1080, duration }) as Kit;
const kit = kitFor(4);
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

describe("the timing guard (#549)", () => {
  const stops = (hesitate: number) => [{ x: 1000, y: 500, hesitate, wait: 0.54 }];
  /** A click as the cursor templates build it: where it lands, and when the beat is ready. */
  const click = (k: Kit) => (hesitate: number, rate: number) => {
    const trip = k.journey(FROM, stops(hesitate), 0.05, { x: 4, y: 3 }, rate);
    return { trip, ready: trip.legs[0]!.arrive + 0.04 };
  };

  it("takes the first try that fits, and the last one when none does", () => {
    const calls: number[][] = [];
    const build = (...args: number[]) => {
      calls.push(args);
      return { ready: args[0]! };
    };
    expect(kit.fitFirst([[5], [3], [1]], build, 3)).toEqual({ ready: 3 });
    expect(calls).toEqual([[5], [3]]);
    expect(kit.fitFirst([[5], [4]], build, 1)).toEqual({ ready: 4 });
  });

  it("leaves a clip that has room exactly as asked: same hesitation, same speed", () => {
    const made = kit.fitFirst(kit.CURSOR_TRIES, click(kit), kit.latest(0.5));
    const asked = click(kit)(1, 1);
    expect(made.ready).toBe(asked.ready);
    expect(made.trip.legs[0]!.arrive).toBe(asked.trip.legs[0]!.arrive);
  });

  it("gives up the hesitation first, then moves faster, so the click lands before the exit of a short clip", () => {
    const short = kitFor(1.6);
    const asked = click(short)(1, 1).ready;
    expect(asked).toBeGreaterThan(short.latest(0.5));
    const made = short.fitFirst(short.CURSOR_TRIES, click(short), short.latest(0.5));
    expect(made.ready).toBeLessThanOrEqual(short.latest(0.5));
    // A moderate overrun is fixed by dropping the hesitation alone.
    const middling = kitFor(2.2);
    expect(middling.fitFirst(middling.CURSOR_TRIES, click(middling), middling.latest(0.5)).ready).toBeCloseTo(click(middling)(0, 1).ready, 9);
  });

  it("speeds the legs up by `rate` and leaves the waits alone", () => {
    const slow = kit.journey(FROM, [{ x: 1000, y: 500, wait: 0.5 }, { x: 900, y: 700 }], 0);
    const fast = kit.journey(FROM, [{ x: 1000, y: 500, wait: 0.5 }, { x: 900, y: 700 }], 0, undefined, 2);
    expect(fast.legs[0]!.dur).toBeCloseTo(slow.legs[0]!.dur / 2, 9);
    expect(fast.legs[1]!.start - fast.legs[0]!.arrive).toBeCloseTo(0.5, 9);
  });

  it("types a long line fast enough for a short clip, and a line that fits at the speed asked", () => {
    const long = Array.from("x".repeat(80));
    const build = (k: Kit) => (factor: number, run: number) => {
      const typing = k.rhythm(long, 0.4, 6 * factor);
      return { ready: typing.end + 0.15 + 0.4 + run, run, factor };
    };
    const short = kitFor(5.5);
    expect(build(short)(1, 1).ready).toBeGreaterThan(short.latest(0.4));
    const made = short.fitFirst(short.typingTries(1.1), build(short), short.latest(0.4));
    expect(made.ready).toBeLessThanOrEqual(short.latest(0.4));
    expect(made.factor).toBeGreaterThan(1);
    expect(made.run).toBeLessThanOrEqual(0.5);
    const text = Array.from("Cut the dead air");
    const fits = short.fitFirst(short.typingTries(1.1), (factor, run) => ({ ready: short.rhythm(text, 0.4, 18 * factor).end + 0.55 + run, factor, run }), short.latest(0.4));
    expect([fits.factor, fits.run]).toEqual([1, 1.1]);
  });

  it("types the same way every time, in order, from the start", () => {
    const chars = Array.from("Cut the dead air and add captions");
    const a = kit.rhythm(chars, 0.4, 18);
    expect(kit.rhythm(chars, 0.4, 18)).toEqual(a);
    expect(a.when[0]).toBe(0.4);
    expect(a.when.every((t, i) => i === 0 || t > a.when[i - 1]!)).toBe(true);
    expect(a.end).toBeGreaterThan(a.when.at(-1)!);
    expect(kit.rhythm([], 0.4, 18)).toEqual({ when: [], end: 0.4 });
  });
});

describe("the follow camera (#549)", () => {
  it("is the whole frame at rest and zooms about the centre with the focus coming toward it", () => {
    const rest = kit.camera({ x: 1500, y: 300 }, 0, 1.6);
    expect([Math.abs(rest.x), Math.abs(rest.y), rest.scale]).toEqual([0, 0, 1]);
    const pose = kit.camera({ x: 1200, y: 600 }, 1, 1.6);
    expect(pose.scale).toBeCloseTo(1.6, 9);
    // The focus lands on the centre: centre + scale * (focus - centre) + shift.
    expect(960 + pose.scale * (1200 - 960) + pose.x).toBeCloseTo(960, 6);
    expect(540 + pose.scale * (600 - 540) + pose.y).toBeCloseTo(540, 6);
  });

  it("never lets the scene's edge into the frame, even for a focus outside it", () => {
    for (const focus of [{ x: 2100, y: 950 }, { x: -200, y: -100 }, { x: 960, y: 540 }]) {
      for (const e of [0.3, 0.7, 1]) {
        const pose = kit.camera(focus, e, 2);
        const z = pose.scale;
        expect(960 - z * 960 + pose.x).toBeLessThanOrEqual(1e-9);
        expect(960 + z * 960 + pose.x).toBeGreaterThanOrEqual(1920 - 1e-9);
        expect(540 - z * 540 + pose.y).toBeLessThanOrEqual(1e-9);
        expect(540 + z * 540 + pose.y).toBeGreaterThanOrEqual(1080 - 1e-9);
      }
    }
  });

  it("zooms in over [a, b], holds, and out over [c, d]", () => {
    expect(kit.zoomAt(0, 0.1, 1, 3, 4)).toBe(0);
    expect(kit.zoomAt(2, 0.1, 1, 3, 4)).toBe(1);
    expect(kit.zoomAt(5, 0.1, 1, 3, 4)).toBe(0);
    expect(kit.zoomAt(0.5, 0.1, 1, 3, 4)).toBeGreaterThan(0);
    expect(kit.zoomAt(3.5, 0.1, 1, 3, 4)).toBeLessThan(1);
  });
});

describe("kitScript", () => {
  it("drops comments and blank lines and writes each top-level function on one line", () => {
    const code = ["      // note", "", "      var a = 1;", "      function f(x) {", "        // inside", "        var y = x + 1;", "        return y;", "      }", "      var b = f(a);"].join("\n");
    const out = kitScript(code);
    expect(out).toBe(["      var a = 1;", "      function f(x) { var y = x + 1; return y; }", "      var b = f(a);"].join("\n"));
    expect(new Function(`${out}; return b;`)()).toBe(2);
  });

  it("keeps a function with a trailing comment on its own lines, so the comment cannot swallow the rest", () => {
    const code = ["      function f(x) {", "        var y = x + 1; // note", "        return y;", "      }"].join("\n");
    expect(kitScript(code)).toBe(code);
  });

  it("trims the page script of a template and nothing else", () => {
    const html = '<script src="a.js"></script>\n<script>\n  // c\n\n  var a = 1;\n</script>\n<p>\n\n</p>';
    expect(trimScript(html)).toBe('<script src="a.js"></script>\n<script>\n  var a = 1;\n    </script>\n<p>\n\n</p>');
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
