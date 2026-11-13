import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { CommandResult } from "@frameshell/plugin-api";
import { type CheckReport, type UpdateReport, checkCompositions, newComposition, updateRuntime } from "../src/index.js";
import { MOTION_RUNTIME, MOTION_RUNTIME_FILE, MOTION_RUNTIME_VERSION } from "../src/motion-runtime.js";
import { TEMPLATES, type TemplateVariable } from "../src/templates/index.js";

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

  it("rejects unknown flags and a second composition", async () => {
    await expect(update(["--nope"])).rejects.toThrow(/unknown argument/);
    await expect(update(["a", "b"])).rejects.toThrow(/one composition at a time/);
  });
});
