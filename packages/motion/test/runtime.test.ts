import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { MOTION_RUNTIME } from "../../../plugins/hyperframes/src/motion-runtime.js";
import { FRAME_RATE_META, bind, cuts, formatClass, pick, props, resolveProps, stage, write } from "../src/index.js";

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
  for (const key of ["__timelines", "addEventListener", "document", "__hyperframes"]) delete (globalThis as Record<string, unknown>)[key];
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

  it("changes the document element's filter between two values that leave pixels alone on every seek", () => {
    const page = fakePage();
    const html = { style: { filter: "" } };
    (globalThis as unknown as { document: Record<string, unknown> }).document["documentElement"] = html;
    const timeline = bind("intro", () => {});
    expect(html.style.filter).toBe("");
    const filters: string[] = [];
    page.hfSeek(0.5);
    filters.push(html.style.filter);
    for (const t of [1, 1, 2]) {
      timeline.seek(t);
      filters.push(html.style.filter);
    }
    expect(filters).toEqual(["opacity(1)", "brightness(1)", "opacity(1)", "brightness(1)"]);
  });

  it("refuses a second binding of one composition", () => {
    fakePage();
    bind("intro", () => {});
    expect(() => bind("intro", () => {})).toThrow(/already registered/);
  });
});

describe("cuts", () => {
  // Fixed-8 sample times of the producer at 30 fps, shutter 180 centred: frame f +/- (k + 0.5) / 8 * 0.5 frame - 0.25 frame.
  const samples = (frame: number) => Array.from({ length: 8 }, (_, k) => (frame - 0.25 + ((k + 0.5) / 8) * 0.5) / 30);

  it("holds the earlier samples of the frame on a cut at the cut, and leaves the frame before it alone", () => {
    const guard = cuts([2], 30);
    // Frame 59's window ends a quarter frame before the cut at frame 60.
    expect(samples(59).map(guard)).toEqual(samples(59));
    // Frame 60 sits on the cut: its earlier samples would show the outgoing scene, so they hold the cut.
    const on = samples(60).map(guard);
    expect(on.every((t) => t >= 2)).toBe(true);
    expect(on.slice(0, 4)).toEqual([2, 2, 2, 2]);
    expect(on.slice(4)).toEqual(samples(60).slice(4));
  });

  it("leaves frame times and frames away from a cut alone", () => {
    const guard = cuts([2, 0.5], 30);
    for (let frame = 0; frame < 90; frame++) expect(guard(frame / 30)).toBe(frame / 30);
    expect(samples(30).map(guard)).toEqual(samples(30));
  });

  it("clamps a sample across a cut between two frames to that side's edge: before it, the outgoing scene's last instant", () => {
    // Both cuts lie between frame 30 (1.0 s) and frame 31 (1.0333 s): 1.01 s in frame 30's window, 1.025 s in frame 31's.
    const early = cuts([1.01], 30);
    expect(early(1.012)).toBeCloseTo(1.01 - 1e-6, 9);
    expect(early(1.005)).toBe(1.005);
    const late = cuts([1.025], 30);
    expect(late(1.02)).toBe(1.025);
    expect(late(1.03)).toBe(1.03);
  });

  it("reads the frame rate a blurred render declares, and passes every time unchanged without one", () => {
    Object.assign(globalThis, { document: { querySelector: (selector: string) => (selector.includes(FRAME_RATE_META) ? { getAttribute: () => "30" } : null) } });
    expect(cuts([2])(1.996)).toBe(2);
    delete (globalThis as Record<string, unknown>)["document"];
    expect(cuts([2])(1.996)).toBe(1.996);
  });

  it("refuses negative cuts and a bad frame rate", () => {
    expect(() => cuts([-1])).toThrow(/seconds >= 0/);
    expect(() => cuts([1], 0)).toThrow(/fps/);
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
    expect(element.style).toEqual({ transform: "translate(12.34375px, -3px) rotate(5deg) scale(1.2, 1.2)", opacity: "1" });
    write(element, { scaleY: 0.5, opacity: -0.2 });
    expect(element.style).toEqual({ transform: "translate(0px, 0px) rotate(0deg) scale(1, 0.5)", opacity: "0" });
    expect(new Set(writes)).toEqual(new Set(["transform", "opacity"]));
  });

  it("writes translation on a 1/32 px grid and rotation on a 0.02° grid, so no written change is too small to repaint", () => {
    const element = { style: { transform: "", opacity: "" } };
    write(element, { x: 0.015, y: -0.016, rotate: 11.989 });
    expect(element.style.transform).toBe("translate(0px, -0.03125px) rotate(11.98deg) scale(1, 1)");
    for (let i = 0; i < 500; i++) {
      write(element, { x: -7 + i * 0.0291, rotate: -3 + i * 0.0137 });
      const [x, rotate] = /^translate\((\S+)px, 0px\) rotate\((\S+)deg\)/.exec(element.style.transform)!.slice(1).map(Number);
      expect(Number.isInteger(x! * 32)).toBe(true);
      expect(Math.abs(rotate! * 50 - Math.round(rotate! * 50))).toBeLessThan(1e-9);
    }
  });
});

/** A page with one composition root of the given frame and the variables HyperFrames would hand over. */
function sizedPage(width: number, height: number, variables?: { declared?: unknown; given?: Record<string, unknown> }) {
  const attrs: Record<string, string> = { "data-composition-id": "t", "data-width": String(width), "data-height": String(height), "data-duration": "3" };
  Object.assign(globalThis, {
    document: {
      documentElement: { getAttribute: () => (variables?.declared === undefined ? null : JSON.stringify(variables.declared)) },
      querySelector: () => ({ getAttribute: (name: string) => attrs[name] ?? null }),
    },
    __hyperframes: { getVariables: () => variables?.given ?? {} },
  });
}

describe("formats and stage", () => {
  it("classes the four built-in formats and the edges between them", () => {
    expect(formatClass(1920, 1080)).toBe("wide");
    expect(formatClass(1080, 1080)).toBe("square");
    expect(formatClass(1080, 1350)).toBe("tall");
    expect(formatClass(1080, 1920)).toBe("tall");
    expect(formatClass(1440, 1080)).toBe("wide");
    expect(formatClass(1000, 1000)).toBe("square");
  });

  it("reads the frame and length from the composition root, and picks per format", () => {
    sizedPage(1080, 1920);
    expect(stage()).toEqual({ width: 1080, height: 1920, duration: 3, format: "tall" });
    expect(pick("wide", "square", "tall")).toBe("tall");
    sizedPage(1920, 1080);
    expect(pick("wide", "square", "tall")).toBe("wide");
    sizedPage(1080, 1080);
    expect(pick({ n: 1 }, { n: 2 }, { n: 3 })).toEqual({ n: 2 });
  });

  it("refuses a page with no sized root", () => {
    Object.assign(globalThis, { document: { querySelector: () => null } });
    expect(() => stage()).toThrow(/data-width/);
  });
});

describe("props", () => {
  const declared = [
    { id: "title", type: "string", default: "Hi", maxLength: 5 },
    { id: "size", type: "number", default: 1, min: 0.5, max: 2 },
    { id: "ink", type: "color", default: "#ffffff" },
    { id: "logo", type: "image", default: "" },
    { id: "align", type: "enum", default: "auto", options: [{ value: "auto" }, { value: "left" }] },
    { id: "on", type: "boolean", default: true },
  ];

  it("keeps values that fit their type and clamps numbers to min and max", () => {
    expect(resolveProps(declared, { title: "Hello world", size: 9, ink: "#ff0000", logo: "logo.png", align: "left", on: false })).toEqual({
      title: "Hello",
      size: 2,
      ink: "#ff0000",
      logo: "logo.png",
      align: "left",
      on: false,
    });
    expect(resolveProps(declared, { size: -3 })["size"]).toBe(0.5);
  });

  it("falls back to the default for a value of the wrong type", () => {
    expect(resolveProps(declared, { title: 4, size: "big", ink: "red", logo: 7, align: "up", on: "yes" })).toEqual({
      title: "Hi",
      size: 1,
      ink: "#ffffff",
      logo: "",
      align: "auto",
      on: true,
    });
    expect(resolveProps(declared, { size: Number.NaN })["size"]).toBe(1);
  });

  it("reads an image given as { url }", () => {
    expect(resolveProps(declared, { logo: { url: "a.png" } })["logo"]).toBe("a.png");
  });

  it("props() resolves the page's declarations against getVariables()", () => {
    sizedPage(1920, 1080, { declared, given: { size: 5, title: "Yo" } });
    expect(props()).toMatchObject({ size: 2, title: "Yo", ink: "#ffffff" });
  });

  it("props() refuses declarations that are not an array", () => {
    sizedPage(1920, 1080, { declared: { title: "x" } });
    expect(() => props()).toThrow(/array/);
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
    for (const name of ["bind", "cuts", "write", "spring", "springStep", "settle", "track", "ease", "stagger", "durationFromDistance", "SPRING_PRESETS", "version", "pick", "stage", "props", "formatClass", "resolveProps"]) {
      expect(motion[name], name).toBeDefined();
    }
    expect((motion["spring"] as (p: string, t: number) => number)("heavy", 10)).toBeCloseTo(1, 9);
  });
});
