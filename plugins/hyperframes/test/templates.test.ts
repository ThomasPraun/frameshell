import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import type { CommandResult } from "@frameshell/plugin-api";
import { type CheckReport, type UpdateReport, checkCompositions, createHyperframesAdapter, newComposition, updateRuntime } from "../src/index.js";
import { MOTION_RUNTIME, MOTION_RUNTIME_FILE, MOTION_RUNTIME_VERSION } from "../src/motion-runtime.js";
import { CURSOR_MATH, CURSOR_SCRIPT } from "../src/templates/cursor-kit.js";
import { TEMPLATES, type TemplateVariable, usesThree } from "../src/templates/index.js";
import { THREE_RUNTIME, THREE_RUNTIME_FILE, THREE_VERSION } from "../src/three-runtime.js";
import { TITLE_TYPEFACE, TITLE_TYPEFACE_FILE, TITLE_TYPEFACE_VERSION } from "../src/title-typeface.js";

let project: string;
type Outcome = Exclude<CommandResult, string | void>;

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-hyperframes-templates-")));
  writeFileSync(join(project, "frameshell.json"), JSON.stringify({ resolution: { width: 1920, height: 1080 } }));
});

const scaffold = async (args: string[]) => (await newComposition.run({ args, cwd: project, project: { dir: project } })) as Outcome;
const dirOf = (name: string) => join(project, "compositions", "hyperframes", name);
const read = (name: string, file = "index.html") => readFileSync(join(dirOf(name), file), "utf8");
const declared = (html: string) => JSON.parse(/data-composition-variables='([^']*)'/.exec(html)![1]!.replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&amp;/g, "&")) as TemplateVariable[];
const writeStyle = (style: unknown) => writeFileSync(join(project, "style.json"), JSON.stringify(style));

describe.each(TEMPLATES.map((t) => [t.id, t] as const))("template %s", (id, template) => {
  it("scaffolds a bound motion composition with the runtime copy next to it", async () => {
    const result = await scaffold(["spot", "--template", id]);
    expect(result.output).toContain(`from the ${id} template (1920x1080, ${template.defaultDuration} s)`);
    expect(result.output).toContain("--type hyperframes --source compositions/hyperframes/spot/index.html");
    expect(result.data).toMatchObject({ source: "compositions/hyperframes/spot/index.html", template: id, runtime: MOTION_RUNTIME_VERSION });
    expect(read("spot", MOTION_RUNTIME_FILE)).toBe(MOTION_RUNTIME);
    const html = read("spot");
    // Bound through window.__timelines: data-no-timeline would make the render wait 45 s (ADR 0033).
    expect(html).not.toContain("data-no-timeline");
    expect(html).toContain(`<script src="${MOTION_RUNTIME_FILE}"></script>`);
    expect(html).toContain('M.bind("spot"');
    expect(html).toContain(`data-composition-id="spot" data-width="1920" data-height="1080" data-duration="${template.defaultDuration}"`);
    expect(html).toContain("M.pick(");
    expect(html).toContain("M.props()");
  });

  it("declares typed props the way HyperFrames reads them: an array, with bounds on numbers", async () => {
    await scaffold(["spot", "--template", id]);
    const variables = declared(read("spot"));
    expect(Array.isArray(variables)).toBe(true);
    expect(variables.map((v) => v.type)).toEqual(expect.arrayContaining(["string", "number", "color"]));
    for (const variable of variables) {
      expect(variable.id).toMatch(/^[a-z][A-Za-z0-9]*$/);
      expect(variable.label).not.toBe("");
      if (variable.type === "number") {
        expect(variable.min).toBeLessThan(variable.max);
        expect(variable.default).toBeGreaterThanOrEqual(variable.min);
        expect(variable.default).toBeLessThanOrEqual(variable.max);
      }
      if (variable.type === "color") expect(variable.default).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(variables).toEqual(placeholderVariables(template));
  });

  it("follows the project resolution", async () => {
    writeFileSync(join(project, "frameshell.json"), JSON.stringify({ resolution: { width: 1080, height: 1920 } }));
    await scaffold(["tall", "--template", id, "--duration", "2.5"]);
    const html = read("tall");
    expect(html).toContain('data-width="1080" data-height="1920" data-duration="2.5"');
    expect(html).toContain("html, body { width: 1080px; height: 1920px;");
  });

  it("passes `hyperframes check` with no blocking problem", async () => {
    await scaffold(["spot", "--template", id]);
    const checked = (await checkCompositions.run({ args: ["spot", "--strict"], cwd: project, project: { dir: project } })) as Outcome;
    const report = checked.data as CheckReport;
    expect(report.compositions[0]!.findings.filter((f) => f.severity !== "info")).toEqual([]);
    expect(checked.failed).toBe(false);
  });

  it("declares no page global that shadows a window property (var name = ... would coerce to a string)", async () => {
    await scaffold(["spot", "--template", id]);
    expect(read("spot")).not.toMatch(/\bvar (name|status|top|parent|length|self|event|origin|close|open|stop|find|history|location|screen|frames|opener|closed|focus|blur|print|scroll|menubar|toolbar)\b/);
  });

  it("uses no GSAP and none of the calls a seek-only composition must not make", async () => {
    await scaffold(["spot", "--template", id]);
    const html = read("spot");
    expect(html).not.toMatch(/gsap/i);
    expect(html).not.toMatch(/requestAnimationFrame|setTimeout|setInterval|Date\.now|new Date|Math\.random|will-change|translate3d|\btransition\s*:/);
    // The properties element adjustments own (ADR 0021) are never written by the composition.
    expect(html).not.toMatch(/style\.(translate|scale|rotate)\b/);
    expect(/<style>([\s\S]*?)<\/style>/.exec(html)![1]).not.toMatch(/(^|[\s;{])(translate|scale|rotate)\s*:/);
  });
});

/** Variables a template declares with no brand tokens, to compare with what its HTML says. */
function placeholderVariables(template: (typeof TEMPLATES)[number]): TemplateVariable[] {
  return template.variables({ id: "spot", width: 1920, height: 1080, duration: template.defaultDuration, tokens: { colors: {}, brand: {}, used: [], problem: null } });
}

describe("template cursor-text-select", () => {
  it("falls back to the default paragraph when the text prop has no word, so the page script never reads a missing span", async () => {
    await scaffold(["spot", "--template", "cursor-text-select"]);
    const html = read("spot");
    expect(html).toMatch(/if \(!words\.length\) words = "Editing a video should feel like editing a document\."\.split\(" "\);/);
    expect(html).toContain("split(/\\s+/)");
  });
});

describe("template before-after", () => {
  it("wipes down only on a tall frame (the runtime's format class), so a square wipes across", async () => {
    await scaffold(["spot", "--template", "before-after"]);
    expect(read("spot")).toContain('var down = P.direction === "down" || (P.direction === "auto" && S.format === "tall");');
  });
});

describe("template emphasis-marker", () => {
  it("marks the last two words when the phrase is empty or missing, and skips punctuation-only words when matching", async () => {
    await scaffold(["spot", "--template", "emphasis-marker"]);
    const html = read("spot");
    expect(html).toContain("if (first < 0) first = Math.max(0, n - 2);");
    expect(html).toContain("if (text) { kept.push(k); plain.push(text); }");
    expect(html).toContain("lastWord = kept[first + want.length - 1]; first = kept[first];");
  });
});

describe("template number-wheel", () => {
  it("prints numbers with the code counter uses (one format, never a copy), in slots as wide as the widest digit", async () => {
    await scaffold(["wheel", "--template", "number-wheel"]);
    await scaffold(["count", "--template", "counter"]);
    const format = (html: string) => /\/\/ Same text for the same value everywhere[\s\S]*?\n {6}}/.exec(html)![0];
    expect(format(read("wheel"))).toBe(format(read("count")));
    const html = read("wheel");
    expect(html).toContain("font-variant-numeric: tabular-nums");
    expect(html).toContain("probe.textContent = new Array(51).join(String(d));");
    // The strip is folded into its middle copy of 0 to 9, so a column always has a neighbour above and below.
    expect(html).toContain("M.write(c.strip, { y: -(10 + (((at % 10) + 10) % 10)) * row });");
  });

  it("takes a count time of 1.2 to 1.6 s by default and keeps the last column inside the clip", async () => {
    await scaffold(["wheel", "--template", "number-wheel"]);
    const defaults = Object.fromEntries(declared(read("wheel")).map((v) => [v.id, v.default]));
    expect(defaults["countTime"]).toBeGreaterThanOrEqual(1.2);
    expect(defaults["countTime"]).toBeLessThanOrEqual(1.6);
    expect(read("wheel")).toContain("var TIME = Math.min(P.countTime, Math.max(0.5, D - OUT - START - 0.6));");
  });

  it("fades the columns a shorter end text does not use, and the separators left of its first digit", async () => {
    await scaffold(["wheel", "--template", "number-wheel"]);
    const html = read("wheel");
    expect(html).toContain("var pad = count - digitsOf(last).length;");
    expect(html).toContain("blank: cols.length < pad");
    expect(html).toContain("if (cols.length <= pad) seps.push(");
  });
});

describe("template slot-roll", () => {
  it("lands on the target by its text, adds it when missing, and never spins a reel of fewer than two", async () => {
    await scaffold(["spot", "--template", "slot-roll"]);
    const html = read("spot");
    expect(html).toContain("item.toLowerCase() === want.toLowerCase()");
    expect(html).toContain('if (goal < 0) goal = items.push(want || "...") - 1;');
    expect(html).toContain('if (items.length < 2) { items.unshift("..."); goal = 1; }');
    expect(html).toContain('if (items.length < 3) items.push("...");');
    // Whole turns (a fractional `laps` from clip set is rounded) plus the way to the target: the last frame is exactly the target on the band.
    expect(html).toContain("var travel = Math.max(1, Math.round(P.laps)) * n + goal;");
    // Only rows are cut, so a wide item is never clipped at its ends.
    expect(html).toContain("clip-path: inset(0 -50%)");
  });
});

describe("template tab-indicator", () => {
  it("starts on the tab of an entry at 0 and on tab 1 otherwise, pulls a late entry in, and reads tabs by number or name", async () => {
    await scaffold(["spot", "--template", "tab-indicator"]);
    const html = read("spot");
    expect(html).toContain("if (moves.length && moves[0].at <= 0.05) home = moves.shift().index;");
    expect(html).toContain("at: Math.min(at, Math.max(0.3, D - OUT - 0.7))");
    expect(html).toContain("/^\\d+$/.test(key) ? Number(key) - 1 : names.findIndex(");
  });
});

describe("template freeze-cut", () => {
  it("is a template over an image prop, with no freeze-frame operation: the flash never starts before the cut", async () => {
    await scaffold(["spot", "--template", "freeze-cut"]);
    const html = read("spot");
    const image = declared(html).find((v) => v.id === "image")!;
    expect(image).toMatchObject({ type: "image", default: "" });
    expect(html).toContain("opacity: t < CUT ? 0 :");
    // A white layer of plain opacity: a blend mode over the film once rendered it all white.
    expect(html).not.toContain("mix-blend-mode");
  });
});

describe("template logo-sting", () => {
  it("paints its own background, falls back to a monogram with no logo, and pulls a late landing in before the exit", async () => {
    await scaffold(["spot", "--template", "logo-sting"]);
    const html = read("spot");
    expect(TEMPLATES.find((t) => t.id === "logo-sting")!.overlay).toBe(false);
    expect(declared(html).find((v) => v.id === "logo")).toMatchObject({ type: "image", default: "" });
    expect(html).toContain('mono.textContent = (Array.from(text)[0] || "\\u2022").toUpperCase();');
    expect(html).toContain("var POP = Math.min(P.popAt, Math.max(0.05, D - OUT - 1.2));");
    expect(html).not.toContain("mix-blend-mode");
  });
});

describe("template pip-card", () => {
  it("takes a picture by path only (a live video in a corner is the multicam layout) and keeps clear of a tall frame's bottom", async () => {
    await scaffold(["spot", "--template", "pip-card"]);
    const html = read("spot");
    expect(declared(html).filter((v) => v.type === "image").map((v) => v.id)).toEqual(["image"]);
    expect(html).not.toMatch(/<video|createElement\("video"\)/);
    expect(html).toContain('S.format === "tall" ? "top-right" : "bottom-right"');
    expect(html).toContain("var ENTER = Math.min(P.enterAt, Math.max(0.1, D - OUT - 0.7));");
  });
});

describe("templates that put their steps on beats (onBeats)", () => {
  const stepped = ["checklist", "notification-stack", "work-cards"];

  it("are the ones that declare onBeats, off by default, with one shared copy of the step schedule", async () => {
    expect(TEMPLATES.filter((t) => placeholderVariables(t).some((v) => v.id === "onBeats")).map((t) => t.id).sort()).toEqual(stepped);
    for (const id of stepped) {
      await scaffold([id, "--template", id]);
      const html = read(id);
      expect(declared(html).find((v) => v.id === "onBeats")).toMatchObject({ type: "boolean", default: false });
      expect(html.match(/function stepTimes\(/g)).toHaveLength(1);
      expect(html).toMatch(/P.onBeats[,)]/);
      // Asked through the prop, never a scaffolded meta tag: a plain clip keeps its key when the music moves.
      expect(html).not.toContain("frameshell-timing");
    }
  });

  it("ask the adapter for beats only while the clip's onBeats is true", async () => {
    await scaffold(["list", "--template", "checklist"]);
    const adapter = createHyperframesAdapter({ projectDir: project });
    const clip = { id: "c_1", source: "compositions/hyperframes/list/index.html" };
    expect(await adapter.timing!(clip)).toEqual([]);
    expect(await adapter.timing!({ ...clip, props: { onBeats: false } })).toEqual([]);
    expect(await adapter.timing!({ ...clip, props: { onBeats: true } })).toEqual(["beats"]);
  });
});

describe("template work-cards", () => {
  it("reads title:status lines, draws no icon, and shares one progress between the cards", async () => {
    await scaffold(["spot", "--template", "work-cards"]);
    const html = read("spot");
    const items = declared(html).find((v) => v.id === "items")!;
    expect(items).toMatchObject({ type: "string" });
    expect(html).toContain('var at = item.indexOf(":");');
    expect(html).not.toMatch(/class="icon"|<svg|<img/);
    // One curve for every card; a bar only joins it once its card has started.
    expect(html).toContain('var shared = M.ease("progress", (t - progAt) / progTime);');
    expect(html).toContain("scaleX: shared * on");
    expect(html).toContain("var progTime = Math.min(P.progressTime, Math.max(0.4, D - OUT - 0.2 - progAt));");
  });
});

describe("template light-leak", () => {
  it("is an overlay with no blend mode, seeded, clear exactly at both ends and never a full-frame wash", async () => {
    await scaffold(["spot", "--template", "light-leak"]);
    const html = read("spot");
    const leak = TEMPLATES.find((t) => t.id === "light-leak")!;
    expect(leak.overlay).toBe(true);
    expect(leak.defaultDuration).toBeGreaterThanOrEqual(0.8);
    expect(leak.defaultDuration).toBeLessThanOrEqual(1.2);
    expect(html).not.toContain("mix-blend-mode");
    expect(html).not.toMatch(/\bfilter\s*:|backdrop-filter/);
    expect(html).toContain("var seed = seedOf(P.seed);");
    // The envelope is a smoothstep of the clip's progress: 0 at the first frame and from D - END on.
    expect(html).toContain("var env = u * u * (3 - 2 * u);");
    // The strength is capped below 1 and the colour of the core is cream, not white.
    expect(html).toContain("var CAP = 0.55;");
    expect(html).toContain('mix(tint, "#fff0cf", 0.6)');
    const intensity = declared(html).find((v) => v.id === "intensity")!;
    expect(intensity).toMatchObject({ type: "number", max: 1 });
  });
});

describe("template logo-sting band", () => {
  it("leaves with the exit on a clip too short for it, so the band is never cut off", async () => {
    await scaffold(["spot", "--template", "logo-sting"]);
    expect(read("spot")).toContain("opacity: fade * fade * (1 - out) });");
  });
});

describe("template light-leak fall", () => {
  it("falls over at most 0.6 of the clip, so a very short clip still ends clear", async () => {
    await scaffold(["spot", "--template", "light-leak", "--duration", "0.2"]);
    expect(read("spot")).toContain("var END = Math.min(0.1, 0.6 * D);");
  });
});

describe("template orbit", () => {
  it("takes a logo or a word and up to 8 labels, starts from a seeded phase and ends on a ring that never depends on the seed", async () => {
    await scaffold(["spot", "--template", "orbit"]);
    const html = read("spot");
    const variables = declared(html);
    expect(variables.find((v) => v.id === "logo")).toMatchObject({ type: "image", default: "" });
    expect(variables.find((v) => v.id === "items")).toMatchObject({ type: "string" });
    expect(variables.find((v) => v.id === "turns")).toMatchObject({ type: "number", min: 0.25, max: 4 });
    expect(variables.find((v) => v.id === "backdrop")).toMatchObject({ type: "number", default: 0 });
    expect(TEMPLATES.find((t) => t.id === "orbit")!.overlay).toBe(true);
    expect(html).toContain("var labels = parts(P.items, 8);");
    // The seed only moves where the circling starts and which way it turns: the turns left are 0 once the ease has run out.
    expect(html).toContain("var phase = (jitter(seed, 1) + 1) * Math.PI;");
    expect(html).toContain('var left = 1 - M.ease("enter", (t - FIRST) / spinTime);');
    expect(html).toContain("var a = rest[i] + dir * (P.turns * 2 * Math.PI + phase) * left;");
    expect(html).not.toContain("mix-blend-mode");
  });
});

describe("template locked-on", () => {
  it("declares its target box as fractions of the frame that fit inside it, and keeps the box inside the frame with a margin", async () => {
    await scaffold(["spot", "--template", "locked-on"]);
    const html = read("spot");
    const variables = declared(html);
    const numbers = Object.fromEntries(variables.filter((v) => v.type === "number").map((v) => [v.id, v.default as number]));
    for (const key of ["x", "y", "w", "h"]) expect(variables.find((v) => v.id === key), key).toMatchObject({ type: "number" });
    expect(numbers["x"]! + numbers["w"]!).toBeLessThanOrEqual(0.96);
    expect(numbers["y"]! + numbers["h"]!).toBeLessThanOrEqual(0.96);
    expect(html).toContain("var bx = Math.min(Math.max(P.x * S.width, 0.04 * S.width), 0.96 * S.width - bw);");
    // The brackets overshoot the corner: an under-damped spring, not a preset that stops dead.
    expect(html).toContain("var SNAP = { response: 0.34, damping: 0.55 };");
    expect(html).not.toContain("mix-blend-mode");
  });
});

describe("template spotlight", () => {
  it("dims with one layer of plain alpha, two targets as fractions of the frame, no blend mode and a dim that stays under black", async () => {
    await scaffold(["spot", "--template", "spotlight"]);
    const html = read("spot");
    const variables = declared(html);
    for (const key of ["x", "y", "x2", "y2"]) expect(variables.find((v) => v.id === key), key).toMatchObject({ type: "number", min: 0, max: 1 });
    expect(variables.find((v) => v.id === "dim")).toMatchObject({ type: "number", max: 0.95 });
    expect(variables.find((v) => v.id === "shade")).toMatchObject({ type: "color" });
    expect(html).toContain('dim.style.background = "radial-gradient(circle at "');
    expect(html).not.toContain("mix-blend-mode");
    expect(html).not.toMatch(/backdrop-filter|\bmask(-image)?\s*:/);
    // Equal targets are no move.
    expect(html).toContain("var moves = a.x !== b.x || a.y !== b.y;");
  });
});

describe("template lean-in", () => {
  it("is a transparent overlay with a side, a late-start pull-in, 2D scale and rotation only, and no matte or 3D", async () => {
    await scaffold(["spot", "--template", "lean-in"]);
    const html = read("spot");
    const variables = declared(html);
    expect(TEMPLATES.find((t) => t.id === "lean-in")!.overlay).toBe(true);
    expect(variables.find((v) => v.id === "side")).toMatchObject({ type: "enum", default: "left" });
    expect(variables.find((v) => v.id === "backdrop")).toMatchObject({ type: "number", default: 0 });
    expect(variables.find((v) => v.id === "at")).toMatchObject({ type: "number", min: 0 });
    // A late start is pulled in so the slide and the tilt (about a second) are done before the 0.3 s exit.
    expect(html).toContain("var AT = Math.min(P.at, Math.max(0, D - OUT - 1));");
    // The slow lean: scale 1 to 1.06 and 1 to 2 degrees over the hold.
    expect(html).toContain("rotate: dir * (-(1 - q) * BACK + 1 + hold),");
    expect(html).toContain("scale: (0.88 + 0.12 * q) * (1 + 0.06 * hold),");
    expect(html).not.toMatch(/mix-blend-mode|perspective|rotate[XYZ]|matrix3d|mask/);
  });

  it("falls back to a default line for an empty text and hides an empty kicker", async () => {
    await scaffold(["spot", "--template", "lean-in"]);
    const html = read("spot");
    expect(html).toContain('var text = String(P.text).trim() || "Lean in";');
    expect(html).toContain("if (!kicker) kickerEl.style.display = \"none\";");
  });
});

describe("template select-resize", () => {
  it("declares the card's four sizes as fractions of the frame that fit inside it, and the two handle looks", async () => {
    await scaffold(["spot", "--template", "select-resize"]);
    const html = read("spot");
    const variables = declared(html);
    const numbers = Object.fromEntries(variables.filter((v) => v.type === "number").map((v) => [v.id, v.default as number]));
    for (const key of ["x", "y", "fromW", "fromH", "toW", "toH"]) expect(variables.find((v) => v.id === key), key).toMatchObject({ type: "number" });
    expect(numbers["x"]! + Math.max(numbers["fromW"]!, numbers["toW"]!)).toBeLessThanOrEqual(0.96);
    expect(numbers["y"]! + Math.max(numbers["fromH"]!, numbers["toH"]!)).toBeLessThanOrEqual(0.96);
    expect(numbers["toW"]!).toBeGreaterThan(numbers["fromW"]!);
    const handles = variables.find((v) => v.id === "handles");
    expect(handles?.type === "enum" && handles.options.map((o) => o.value)).toEqual(["corners", "all"]);
    expect(variables.map((v) => v.id)).toEqual(expect.arrayContaining(["camera", "zoom", "hesitate", "pointer", "cursorSize", "backdrop"]));
    expect(TEMPLATES.find((t) => t.id === "select-resize")!.overlay).toBe(true);
  });

  it("keeps whatever sizes and position a prop asks for inside the frame, with room for the handles, the cursor and the badge", async () => {
    await scaffold(["spot", "--template", "select-resize"]);
    const html = read("spot");
    expect(html).toContain("var w1 = Math.min(maxR - edge, Math.max(minW, P.toW * S.width));");
    expect(html).toContain("var h1 = Math.min(maxB - topEdge, Math.max(minH, P.toH * S.height));");
    expect(html).toContain("var bx = Math.min(Math.max(P.x * S.width, edge), maxR - Math.max(w0, w1));");
    expect(html).toContain("var by = Math.min(Math.max(P.y * S.height, topEdge), maxB - Math.max(h0, h1));");
    // The cursor's overshoot past the drop point never takes the card beyond the same limits.
    expect(html).toContain("return { w: Math.min(maxR - bx, Math.max(minW, c.x - bx)), h: Math.min(maxB - by, Math.max(minH, c.y - by)) };");
  });

  it("writes the card as layout on a 0.01 px grid, never a scale of its size, and takes the cursor from the kit (one copy)", async () => {
    await scaffold(["spot", "--template", "select-resize"]);
    const html = read("spot");
    expect(html).toContain('box.style.width = stamp(size.w) + "px";');
    expect(html).toContain('box.style.height = stamp(size.h) + "px";');
    // The card's own transform is only the entry pop (a uniform scale); its size never goes through a scale.
    expect(html).not.toMatch(/put\(box, \{[^}]*scale[XY]/);
    expect(html).not.toMatch(/mix-blend-mode|backdrop-filter/);
    // The cursor, its timing guard and its click are the kit's own text, the same in every cursor template.
    expect(html).toContain(CURSOR_MATH);
    expect(html).toContain(CURSOR_SCRIPT);
    expect(html.match(/function journey/g)).toHaveLength(1);
    // The press, the ring and the handles share one time.
    expect(html).toContain("var clickAt = trip.legs[0].arrive + 0.04;");
    expect(html).toContain('drawRipple(t, clickAt, press1.x, press1.y);');
    expect(html).toContain('opacity: M.ease("enter", (t - clickAt) / 0.1)');
  });
});

describe("template phone-fan", () => {
  it("takes one picture per phone, and paints a missing one with the code device-frame uses (one copy, never a second)", async () => {
    await scaffold(["fan", "--template", "phone-fan"]);
    await scaffold(["frame", "--template", "device-frame"]);
    const html = read("fan");
    expect(declared(html).filter((v) => v.type === "image").map((v) => v.id)).toEqual(["shotLeft", "shotMiddle", "shotRight"]);
    expect(declared(html).find((v) => v.id === "fan")).toMatchObject({ type: "number", min: 4, max: 24 });
    // The helpers are the same text in both compositions.
    const helper = (source: string, name: string) => new RegExp(`function ${name}\\([\\s\\S]*?\\n {6}}`).exec(source)![0];
    for (const name of ["paintSkeleton", "dressPhone"]) expect(helper(html, name)).toBe(helper(read("frame"), name));
    expect(html.match(/function paintSkeleton/g)).toHaveLength(1);
    // The middle phone is the last child, so it is in front.
    expect(html).toContain("var shots = [P.shotLeft, P.shotRight, P.shotMiddle];");
    expect(html).not.toContain("mix-blend-mode");
  });
});

describe("the seeded templates", () => {
  it("take the seed hash and the jitter from the kit, never a private copy", async () => {
    for (const id of ["emphasis-marker", "scene-background", "light-leak", "orbit"]) {
      await scaffold([id, "--template", id]);
      const html = read(id);
      expect(html, id).toContain("function seedOf(text)");
      // The one hash line, once per page.
      expect(html.match(/\* 31 \+ ch\.charCodeAt\(0\)/g), id).toHaveLength(1);
    }
  });
});

describe("the plugin skill", () => {
  const skill = readFileSync(fileURLToPath(new URL("../skills/hyperframes/SKILL.md", import.meta.url)), "utf8").replace(/\r\n/g, "\n");

  it.each(TEMPLATES.map((t) => [t.id, t] as const))("lists %s with every prop it declares", (id, template) => {
    const row = skill.split("\n").find((line) => line.startsWith(`| \`${id}\``));
    expect(row, `no row for ${id}`).toBeDefined();
    for (const variable of placeholderVariables(template)) expect(row, `${id} row misses ${variable.id}`).toContain(`\`${variable.id}\``);
  });
});

describe("frameshell hyperframes new --template", () => {
  it("lists the template ids when it is unknown or missing", async () => {
    const ids = TEMPLATES.map((t) => t.id).join(", ");
    await expect(scaffold(["x", "--template", "nope"])).rejects.toThrow(`${ids}; got nope`);
    await expect(scaffold(["x", "--template"])).rejects.toThrow(ids);
  });

  it("never overwrites, and writes no runtime when the scaffold is refused", async () => {
    await scaffold(["spot", "--template", "end-card"]);
    writeFileSync(join(dirOf("spot"), MOTION_RUNTIME_FILE), "edited");
    await expect(scaffold(["spot", "--template", "end-card"])).rejects.toThrow(/already exists/);
    expect(read("spot", MOTION_RUNTIME_FILE)).toBe("edited");
  });

  it("without --template scaffolds the plain composition and no runtime", async () => {
    await scaffold(["plain"]);
    expect(existsSync(join(dirOf("plain"), MOTION_RUNTIME_FILE))).toBe(false);
    expect(read("plain")).toContain("data-no-timeline");
  });

  it("takes brand tokens from style.json as the defaults of the props", async () => {
    writeStyle({
      schemaVersion: 1,
      colors: { bg: "#102030", ink: "#eeeeee", accent: "#ff3366" },
      brand: { product: "Acme's Rocket", cta: "Get yours", url: "acme.test" },
    });
    const result = await scaffold(["card", "--template", "end-card"]);
    const defaults = Object.fromEntries(declared(read("card")).map((v) => [v.id, v.default]));
    expect(defaults).toMatchObject({ bg: "#102030", ink: "#eeeeee", accent: "#ff3366", title: "Acme's Rocket", cta: "Get yours", url: "acme.test" });
    expect(result.output).toContain("From style.json: colors.bg, colors.ink, colors.accent, brand.product, brand.url, brand.cta");
    expect((result.data as { tokens: string[] }).tokens).toContain("colors.accent");
    // An apostrophe in a value cannot break the single-quoted attribute.
    expect(read("card")).toContain("Acme&#39;s Rocket");
  });

  it("keeps the placeholders without a style.json, and says so", async () => {
    const result = await scaffold(["card", "--template", "kinetic-headline"]);
    expect(result.output).toContain("No style.json values used");
    const defaults = Object.fromEntries(declared(read("card")).map((v) => [v.id, v.default]));
    expect(defaults).toMatchObject({ ink: "#ffffff", accent: "#ffb400" });
  });

  it("ignores values of the wrong shape and reports an unreadable style.json", async () => {
    writeStyle({ colors: { accent: "red", ink: 7 }, brand: { cta: "  " }, fonts: { display: { family: 3 } } });
    const result = await scaffold(["a", "--template", "end-card"]);
    expect(result.output).toContain("No style.json values used");
    writeFileSync(join(project, "style.json"), "{ nope");
    const broken = await scaffold(["b", "--template", "end-card"]);
    expect(broken.output).toContain("style.json is not valid JSON");
  });

  it("copies a style font file next to the composition and declares it with @font-face", async () => {
    mkdirSync(join(project, "assets", "fonts"), { recursive: true });
    writeFileSync(join(project, "assets", "fonts", "Brand-Bold.ttf"), "font-bytes");
    writeStyle({ schemaVersion: 1, fonts: { display: { family: "Brand Sans", file: "assets/fonts/Brand-Bold.ttf", weight: 700 } } });
    await scaffold(["card", "--template", "kinetic-headline"]);
    expect(read("card", "fonts/Brand-Bold.ttf")).toBe("font-bytes");
    const html = read("card");
    expect(html).toContain('@font-face { font-family: "Brand Sans"; src: url("fonts/Brand-Bold.ttf"); font-weight: 700; }');
    expect(html).toContain('font-family: "Brand Sans", system-ui');
    expect(html).toContain("font-weight: 700");
  });

  it("never reads a font file outside assets/fonts/", async () => {
    writeFileSync(join(project, "secret.ttf"), "x");
    writeStyle({ schemaVersion: 1, fonts: { display: { family: "Brand", file: "../secret.ttf" }, ui: { family: "Ui", file: "secret.ttf" } } });
    await scaffold(["card", "--template", "end-card"]);
    expect(existsSync(join(dirOf("card"), "fonts"))).toBe(false);
    expect(read("card")).not.toContain("@font-face");
  });
});

describe("3D templates (ADR 0042)", () => {
  const threeTemplates = TEMPLATES.filter(usesThree);

  it("product-shot, logo-3d and title-3d are 3D templates", () => {
    expect(threeTemplates.map((t) => t.id)).toEqual(expect.arrayContaining(["product-shot", "logo-3d", "title-3d"]));
  });

  it("only title-3d gets the title typeface, at the composition root where the cache key sees it", async () => {
    const result = await scaffold(["title", "--template", "title-3d"]);
    expect(read("title", TITLE_TYPEFACE_FILE)).toBe(TITLE_TYPEFACE);
    expect(result.output).toContain(`${TITLE_TYPEFACE_FILE} is frozen the same way`);
    const html = read("title");
    expect(html).toContain(`"${TITLE_TYPEFACE_FILE}"`);
    expect(html).toContain("new THREE.Font(data)");
    expect(html).toContain("new THREE.TextGeometry(");
    expect(html).not.toMatch(/opentype/i);
    for (const id of ["product-shot", "logo-3d"]) {
      await scaffold([id, "--template", id]);
      expect(existsSync(join(dirOf(id), TITLE_TYPEFACE_FILE))).toBe(false);
    }
  });

  it("title-3d names the cause of a missing typeface, a broken one and a character it lacks in the page", async () => {
    await scaffold(["title", "--template", "title-3d"]);
    const html = read("title");
    // The load helper names the file; the parse checks and the glyph check name theirs (rejections reach __hf.buildReady).
    expect(html).toContain(`title-3d cannot load " + path + ": "`);
    expect(html).toContain(`title-3d: ${TITLE_TYPEFACE_FILE} is not valid JSON`);
    expect(html).toContain(`title-3d: ${TITLE_TYPEFACE_FILE} is not a typeface`);
    expect(html).toContain("has no glyph for");
    expect(html).toContain('ready("title-3d", loaded)');
    expect(html).toContain("the text prop is empty");
    expect(html).toContain("scaffold another title-3d composition");
  });

  it("title-3d fits the title to the format's width at any size, fails on a word that does not fit, and keeps clear of the headline", async () => {
    await scaffold(["title", "--template", "title-3d"]);
    const html = read("title");
    // The width bound uses the share the camera frames (fillW * size) and the end of the push-in, so size 1.4 stays in frame.
    expect(html).toContain("var FIT = 0.9;");
    expect(html).toContain("var avail = AVAIL * Math.min(1, (FIT * 0.96) / (L.fillW * P.size)) / SIZE");
    // A single overlong word cannot wrap: it fails naming the word, as a text of more than 3 lines does.
    expect(html).toContain("does not fit the format's width even at");
    expect(html).toContain("Math.min(s, heightFit(lines.length))");
    expect(html).toContain("if (P.subtitle) room = Math.min(room,");
  });

  it.each(threeTemplates.map((t) => t.id))("%s gets the pinned three.js bundle next to it and loads it after the motion runtime", async (id) => {
    const result = await scaffold(["shot", "--template", id]);
    expect(read("shot", THREE_RUNTIME_FILE)).toBe(THREE_RUNTIME);
    expect(result.data).toMatchObject({ three: THREE_VERSION });
    expect(result.output).toContain(`${THREE_RUNTIME_FILE} (three.js ${THREE_VERSION}, MIT`);
    const html = read("shot");
    expect(html.indexOf(`<script src="${MOTION_RUNTIME_FILE}"></script>`)).toBeLessThan(html.indexOf(`<script src="${THREE_RUNTIME_FILE}"></script>`));
    // Assets gate the render through __hf.buildReady (THREE.DefaultLoadingManager gates nothing in three 0.187).
    expect(html).toContain("window.__hf.buildReady[key] = promise");
    expect(html).not.toMatch(/setAnimationLoop|THREE\.Clock|getDelta|performance\.now|TTFLoader/);
  });

  it("a 2D template gets no three.js bundle", async () => {
    const result = await scaffold(["card", "--template", "end-card"]);
    expect(existsSync(join(dirOf("card"), THREE_RUNTIME_FILE))).toBe(false);
    expect(result.data).not.toHaveProperty("three");
  });

  it("the bundle carries the MIT notice and only the pinned three package", () => {
    expect(THREE_RUNTIME).toMatch(/^\/\*! three\.js \d+\.\d+\.\d+ for Frameshell \(ADR 0042\)/);
    expect(THREE_RUNTIME).toContain("The MIT License");
    expect(THREE_RUNTIME).toContain("three.js authors");
    // logo-3d parses its SVG with the bundle's SVGLoader.
    expect(THREE_RUNTIME).toContain("SVGLoader");
    expect(THREE_RUNTIME).not.toMatch(/https:\/\/cdn\.|import\(/);
  });

  it("is current (run `pnpm gen:three` after re-pinning three)", async () => {
    const script = fileURLToPath(new URL("../scripts/build-three.mjs", import.meta.url));
    await expect(promisify(execFile)(process.execPath, [script, "--check"])).resolves.toBeDefined();
  }, 60_000);
});

describe("frameshell hyperframes update", () => {
  const update = async (args: string[] = []) => {
    const result = (await updateRuntime.run({ args, cwd: project, project: { dir: project } })) as Outcome;
    return { output: result.output ?? "", report: result.data as UpdateReport };
  };
  const runtimeOf = (name: string) => join(dirOf(name), MOTION_RUNTIME_FILE);
  const older = MOTION_RUNTIME.replace(`runtime ${MOTION_RUNTIME_VERSION}`, "runtime 0.1.0").replace("return", "return ");

  it("replaces an older frozen copy, and leaves a current one alone", async () => {
    await scaffold(["fresh", "--template", "end-card"]);
    await scaffold(["old", "--template", "end-card"]);
    writeFileSync(runtimeOf("old"), older);
    const { report, output } = await update();
    expect(report.compositions).toEqual([
      { file: "compositions/hyperframes/fresh/frameshell-motion.js", status: "current", from: MOTION_RUNTIME_VERSION, written: false },
      { file: "compositions/hyperframes/old/frameshell-motion.js", status: "updated", from: "0.1.0", written: true },
    ]);
    expect(output).toContain(`updated runtime 0.1.0 -> ${MOTION_RUNTIME_VERSION}`);
    expect(output).toContain("render again");
    expect(readFileSync(runtimeOf("old"), "utf8")).toBe(MOTION_RUNTIME);
  });

  it("previews with --dry-run and writes nothing", async () => {
    await scaffold(["old", "--template", "end-card"]);
    writeFileSync(runtimeOf("old"), older);
    const { report, output } = await update(["--dry-run"]);
    expect(report.compositions[0]).toMatchObject({ status: "updated", written: true });
    expect(output).toContain("would update");
    expect(readFileSync(runtimeOf("old"), "utf8")).toBe(older);
  });

  it("keeps an edited, a newer and a foreign file unless --force", async () => {
    for (const name of ["edited", "newer", "foreign"]) await scaffold([name, "--template", "end-card"]);
    writeFileSync(runtimeOf("edited"), `${MOTION_RUNTIME}\n/* local tweak */`);
    writeFileSync(runtimeOf("newer"), MOTION_RUNTIME.replace(`runtime ${MOTION_RUNTIME_VERSION}`, "runtime 99.0.0"));
    writeFileSync(runtimeOf("foreign"), "console.log(1)");
    const kept = await update();
    expect(kept.report.compositions.map((c) => [c.status, c.written])).toEqual([
      ["modified", false],
      ["foreign", false],
      ["newer", false],
    ]);
    expect(kept.output).toContain("--force replaces it");
    expect(readFileSync(runtimeOf("foreign"), "utf8")).toBe("console.log(1)");
    const forced = await update(["--force"]);
    expect(forced.report.compositions.every((c) => c.written)).toBe(true);
    for (const name of ["edited", "newer", "foreign"]) expect(readFileSync(runtimeOf(name), "utf8")).toBe(MOTION_RUNTIME);
  });

  it("lists the runtime that is bundled and leaves a frozen 0.4.0 copy as it is until asked (no pixel change for existing clips)", async () => {
    expect(MOTION_RUNTIME_VERSION).toBe("0.6.0");
    await scaffold(["frozen", "--template", "checklist"]);
    const frozen = MOTION_RUNTIME.replace(`runtime ${MOTION_RUNTIME_VERSION}`, "runtime 0.4.0");
    writeFileSync(runtimeOf("frozen"), frozen);
    const html = read("frozen");
    await scaffold(["next", "--template", "checklist"]);
    await checkCompositions.run({ args: ["frozen"], cwd: project, project: { dir: project } });
    const preview = await update(["--dry-run"]);
    expect(preview.report.runtime).toBe("0.6.0");
    expect(preview.report.compositions.find((c) => c.file.includes("/frozen/"))).toMatchObject({ status: "updated", from: "0.4.0" });
    expect(preview.output).toContain("runtime 0.4.0 -> 0.6.0");
    expect(readFileSync(runtimeOf("frozen"), "utf8")).toBe(frozen);
    expect(read("frozen")).toBe(html);
    await update();
    expect(readFileSync(runtimeOf("frozen"), "utf8")).toBe(MOTION_RUNTIME);
  });

  it("updates one composition by name, and refuses one without a runtime", async () => {
    await scaffold(["a", "--template", "end-card"]);
    await scaffold(["b", "--template", "end-card"]);
    writeFileSync(runtimeOf("a"), older);
    writeFileSync(runtimeOf("b"), older);
    const { report } = await update(["a"]);
    expect(report.compositions).toHaveLength(1);
    expect(readFileSync(runtimeOf("b"), "utf8")).toBe(older);
    await scaffold(["plain"]);
    await expect(update(["plain"])).rejects.toThrow(/not a motion composition/);
  });

  it("says so when no composition has a runtime copy", async () => {
    await scaffold(["plain"]);
    const { output, report } = await update();
    expect(output).toContain("No motion compositions");
    expect(report.compositions).toEqual([]);
  });

  it("refreshes an older three.js bundle of a 3D composition next to its runtime, and keeps an edited one unless --force", async () => {
    await scaffold(["shot", "--template", "product-shot"]);
    await scaffold(["edit", "--template", "product-shot"]);
    const bundle = (name: string) => join(dirOf(name), THREE_RUNTIME_FILE);
    writeFileSync(bundle("shot"), THREE_RUNTIME.replace(`three.js ${THREE_VERSION} for`, "three.js 0.180.0 for"));
    writeFileSync(bundle("edit"), `${THREE_RUNTIME}\n/* local tweak */`);
    const { report, output } = await update();
    expect(report.three).toBe(THREE_VERSION);
    expect(report.compositions).toEqual([
      { file: "compositions/hyperframes/edit/frameshell-motion.js", status: "current", from: MOTION_RUNTIME_VERSION, written: false },
      { file: "compositions/hyperframes/edit/frameshell-three.js", status: "modified", from: THREE_VERSION, written: false },
      { file: "compositions/hyperframes/shot/frameshell-motion.js", status: "current", from: MOTION_RUNTIME_VERSION, written: false },
      { file: "compositions/hyperframes/shot/frameshell-three.js", status: "updated", from: "0.180.0", written: true },
    ]);
    expect(output).toContain(`updated three.js 0.180.0 -> ${THREE_VERSION}`);
    expect(output).toContain("edited copy of three.js");
    expect(readFileSync(bundle("shot"), "utf8")).toBe(THREE_RUNTIME);
    await update(["edit", "--force"]);
    expect(readFileSync(bundle("edit"), "utf8")).toBe(THREE_RUNTIME);
  });

  it("refreshes an older title typeface of a title-3d composition and keeps an edited one unless --force", async () => {
    await scaffold(["old", "--template", "title-3d"]);
    await scaffold(["edit", "--template", "title-3d"]);
    const typeface = (name: string) => join(dirOf(name), TITLE_TYPEFACE_FILE);
    writeFileSync(typeface("old"), TITLE_TYPEFACE.replace(`"frameshellTypeface":"${TITLE_TYPEFACE_VERSION}"`, '"frameshellTypeface":"0.9.0"'));
    writeFileSync(typeface("edit"), TITLE_TYPEFACE.replace('"familyName":"Archivo Black"', '"familyName":"Mine"'));
    const { report, output } = await update();
    expect(report.typeface).toBe(TITLE_TYPEFACE_VERSION);
    expect(report.compositions.filter((item) => item.file.endsWith(TITLE_TYPEFACE_FILE))).toEqual([
      { file: `compositions/hyperframes/edit/${TITLE_TYPEFACE_FILE}`, status: "modified", from: TITLE_TYPEFACE_VERSION, written: false },
      { file: `compositions/hyperframes/old/${TITLE_TYPEFACE_FILE}`, status: "updated", from: "0.9.0", written: true },
    ]);
    expect(output).toContain(`updated title typeface 0.9.0 -> ${TITLE_TYPEFACE_VERSION}`);
    expect(output).toContain("edited copy of title typeface");
    expect(readFileSync(typeface("old"), "utf8")).toBe(TITLE_TYPEFACE);
    await update(["edit", "--force"]);
    expect(readFileSync(typeface("edit"), "utf8")).toBe(TITLE_TYPEFACE);
  });

  it("rejects unknown flags and a second composition", async () => {
    await expect(update(["--nope"])).rejects.toThrow(/unknown argument/);
    await expect(update(["a", "b"])).rejects.toThrow(/one composition at a time/);
  });
});
