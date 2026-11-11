import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { MOTION_RUNTIME } from "../../../plugins/hyperframes/src/motion-runtime.js";
import { bind, write } from "../src/index.js";

const execFileAsync = promisify(execFile);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

type Listener = (event: { detail?: { time?: unknown } }) => void;

/** Stands in for the page's `window`: the timeline registry, `hf-seek` listeners and one composition root. */
function fakePage(duration = "4") {
  const listeners: Listener[] = [];
  const root = { getAttribute: (name: string) => ({ "data-composition-id": "intro", "data-duration": duration })[name] ?? null };
  const page = {
    __timelines: undefined as Record<string, unknown> | undefined,
    addEventListener: (_type: string, listener: Listener) => listeners.push(listener),
    document: { querySelectorAll: () => [root] },
  };
  Object.assign(globalThis, page);
  return {
    hfSeek: (time: unknown) => listeners.forEach((listener) => listener({ detail: { time } })),
    get registry() {
      return (globalThis as unknown as typeof page).__timelines;
    },
  };
}

afterEach(() => {
  for (const key of ["__timelines", "addEventListener", "document"]) delete (globalThis as Record<string, unknown>)[key];
});

describe("bind", () => {
  it("paints frame 0 at once and registers a seek-only timeline under the composition id", () => {
    const page = fakePage();
    const painted: number[] = [];
    const timeline = bind("intro", (t) => painted.push(t));
    expect(painted).toEqual([0]);
    expect(page.registry?.["intro"]).toBe(timeline);
    expect(typeof timeline.play).toBe("function");
    expect(typeof timeline.pause).toBe("function");
    expect(timeline.duration()).toBe(4);
    timeline.seek(1.5).seek(-2).seek(Number.NaN);
    expect(painted).toEqual([0, 1.5, 0, 0]);
    expect(timeline.time()).toBe(0);
    expect(timeline.play()).toBe(timeline);
  });

  it("paints on hf-seek until the timeline is driven, then only through the timeline", () => {
    const page = fakePage();
    const painted: number[] = [];
    const timeline = bind("intro", (t) => painted.push(t));
    page.hfSeek(0.5);
    page.hfSeek("0.75");
    timeline.seek(1);
    page.hfSeek(2);
    expect(painted).toEqual([0, 0.5, 0.75, 1]);
  });

  it("refuses a second binding of one composition", () => {
    fakePage();
    bind("intro", () => {});
    expect(() => bind("intro", () => {})).toThrow(/already registered/);
  });
});

describe("write", () => {
  it("writes only transform (2D) and opacity, every field every time, opacity clamped", () => {
    const writes: string[] = [];
    const style = new Proxy({ transform: "", opacity: "" } as Record<string, string>, {
      set(target, key, value) {
        writes.push(String(key));
        target[String(key)] = String(value);
        return true;
      },
    });
    const element = { style } as unknown as { style: { transform: string; opacity: string } };
    write(element, { x: 12.34567, y: -3, rotate: 5, scale: 1.2, opacity: 1.3 });
    expect(element.style).toEqual({ transform: "translate(12.346px, -3px) rotate(5deg) scale(1.2, 1.2)", opacity: "1" });
    write(element, { scaleY: 0.5, opacity: -0.2 });
    expect(element.style).toEqual({ transform: "translate(0px, 0px) rotate(0deg) scale(1, 0.5)", opacity: "0" });
    expect(new Set(writes)).toEqual(new Set(["transform", "opacity"]));
  });
});

describe("motion runtime bundle", () => {
  it("is current (run `pnpm gen:motion` after editing packages/motion or packages/schema/src/motion.ts)", async () => {
    const script = fileURLToPath(new URL("../scripts/build-runtime.mjs", import.meta.url));
    await expect(execFileAsync(process.execPath, [script, "--check"])).resolves.toBeDefined();
  });

  it("never reads a clock, frame callbacks, timers or a random source, in its sources or the bundle", () => {
    const forbidden = /\bDate\b|requestAnimationFrame|performance\.now|Math\.random|setTimeout|setInterval|crypto\./;
    for (const text of [read("../src/index.ts"), read("../../schema/src/motion.ts"), MOTION_RUNTIME]) expect(text).not.toMatch(forbidden);
  });

  it("never writes element-adjustment properties, 3D transforms or will-change", () => {
    expect(MOTION_RUNTIME).not.toMatch(/\.style\.(translate|scale|rotate|willChange)\b|translate3d|rotate[XYZ3]|perspective/);
    expect(MOTION_RUNTIME).not.toMatch(/<\/script/i);
  });

  it("defines window.FrameshellMotion with bind, write and the motion math", () => {
    const scope: Record<string, unknown> = {};
    new Function("self", `${MOTION_RUNTIME}\nself.FrameshellMotion = FrameshellMotion;`)(scope);
    const motion = scope["FrameshellMotion"] as Record<string, unknown>;
    for (const name of ["bind", "write", "spring", "springStep", "settle", "track", "ease", "stagger", "durationFromDistance", "SPRING_PRESETS", "version"]) {
      expect(motion[name], name).toBeDefined();
    }
    expect((motion["spring"] as (p: string, t: number) => number)("heavy", 10)).toBeCloseTo(1, 9);
  });
});
