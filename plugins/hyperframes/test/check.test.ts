import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { CommandResult } from "@frameshell/plugin-api";
import { type CheckReport, checkCompositions, newComposition } from "../src/index.js";
import { seekSafetyFindings } from "../src/seek-safety.js";

let project: string;

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-hyperframes-check-")));
  writeFileSync(join(project, "frameshell.json"), JSON.stringify({ resolution: { width: 1280, height: 720 } }));
});

type Outcome = Exclude<CommandResult, string | void>;

async function check(args: string[], cwd = project): Promise<{ output: string; report: CheckReport; failed: boolean }> {
  const result = (await checkCompositions.run({ args, cwd, project: { dir: project } })) as Outcome;
  return { output: result.output ?? "", report: result.data as CheckReport, failed: result.failed === true };
}

/** A composition with GSAP: valid structure, plus whatever `script` adds. */
function gsapComposition(script: string, head = ""): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <style>html, body { width: 1280px; height: 720px; margin: 0; } #card { position: absolute; left: 10%; top: 10%; }</style>
    <script src="gsap.min.js"></script>${head}
  </head>
  <body>
    <div id="stage" data-composition-id="intro" data-width="1280" data-height="720" data-duration="3">
      <div id="clip" class="clip" data-start="0" data-duration="3" data-track-index="0"><div id="card">Hi</div></div>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
${script}
      window.__timelines["intro"] = tl;
    </script>
  </body>
</html>
`;
}

function write(name: string, html: string): string {
  const dir = join(project, "compositions", "hyperframes", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), html);
  writeFileSync(join(dir, "gsap.min.js"), "window.gsap = {};");
  return `compositions/hyperframes/${name}/index.html`;
}

describe("frameshell hyperframes check", () => {
  it("passes the scaffold from `hyperframes new` with no blocking problems", async () => {
    await newComposition.run({ args: ["card", "--duration", "2"], cwd: project, project: { dir: project } });
    const { report, failed, output } = await check([]);
    expect(report.errors).toBe(0);
    expect(failed).toBe(false);
    expect(report.ok).toBe(true);
    expect(report.compositions.map((c) => c.composition)).toEqual(["compositions/hyperframes/card/index.html"]);
    expect(output).toMatch(/0 errors, \d+ warnings? in 1 composition: /);
  });

  it("reports a known lint error with file, line, rule and message, and fails", async () => {
    const entry = write("bad", gsapComposition('      tl.to("#card", { x: () => Math.random() * 100, duration: 1 }, 0);'));
    const { report, failed, output } = await check(["bad"]);
    expect(failed).toBe(true);
    expect(report.ok).toBe(false);
    const finding = report.compositions[0]!.findings.find((f) => f.rule === "non_deterministic_code");
    expect(finding).toMatchObject({ file: entry, severity: "error", line: 15 });
    expect(finding!.message).toContain("Math.random()");
    expect(finding!.fix).toContain("seeded");
    expect(output).toContain(`${entry}:15:`);
    expect(output).toContain("non_deterministic_code");
    expect(output).toMatch(/blocking: fix the errors/);
  });

  it("does not block on warnings, and blocks on them under --strict", async () => {
    write("soft", gsapComposition('      tl.to("#card", { x: 100, duration: 1, onComplete: () => {} }, 0);'));
    const lenient = await check(["soft"]);
    expect(lenient.report.errors).toBe(0);
    expect(lenient.report.warnings).toBeGreaterThan(0);
    expect(lenient.failed).toBe(false);
    const strict = await check(["soft", "--strict"]);
    expect(strict.failed).toBe(true);
    expect(strict.report.strict).toBe(true);
    expect(strict.output).toContain("--strict also blocks on warnings");
  });

  it("flags GSAP seek-safety problems the linter lacks", async () => {
    write("seek", gsapComposition('      tl.to("#card", { x: 100, delay: 1, onUpdate: () => {}, overwrite: "auto" }, 0);\n      gsap.registerPlugin(ScrollTrigger);'));
    const { report } = await check(["seek"]);
    const rules = report.compositions[0]!.findings.map((f) => f.rule);
    expect(rules).toEqual(expect.arrayContaining(["gsap_delay_chain", "gsap_callback_not_seek_safe", "gsap_overwrite_reads_state", "gsap_scrolltrigger"]));
    expect(report.compositions[0]!.findings.find((f) => f.rule === "gsap_scrolltrigger")).toMatchObject({ severity: "error", line: 16 });
    expect(report.ok).toBe(false);
  });

  it("checks every composition without an argument, and a directory, a path or a name alike", async () => {
    const a = write("a", gsapComposition('      tl.to("#card", { x: 100, duration: 1 }, 0);'));
    const b = write("b", gsapComposition('      tl.to("#card", { x: 100, duration: 1 }, 0);'));
    const all = await check([]);
    expect(all.report.compositions.map((c) => c.composition)).toEqual([a, b]);
    for (const argument of ["a", "compositions/hyperframes/a", "compositions/hyperframes/a/", a]) {
      expect((await check([argument])).report.compositions.map((c) => c.composition)).toEqual([a]);
    }
    expect((await check(["hyperframes/a"], join(project, "compositions"))).report.compositions.map((c) => c.composition)).toEqual([a]);
  });

  it("lints a composition whose entry is not index.html", async () => {
    const dir = join(project, "compositions", "hyperframes", "named");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "gsap.min.js"), "window.gsap = {};");
    writeFileSync(join(dir, "title.html"), gsapComposition('      tl.to("#card", { margin: 40, duration: 1 }, 0);'));
    const { report, failed } = await check(["compositions/hyperframes/named/title.html"]);
    expect(failed).toBe(true);
    expect(report.compositions[0]!.findings.map((f) => f.rule)).toContain("gsap_non_transform_motion");
    expect(report.compositions[0]!.findings.every((f) => f.file === "compositions/hyperframes/named/title.html")).toBe(true);
  });

  it("explains what to do when there is nothing to check, and refuses paths outside the project", async () => {
    await expect(check([])).rejects.toThrow(/no compositions.*hyperframes new/);
    await expect(check(["ghost"])).rejects.toThrow(/no composition ghost/);
    await expect(check(["../elsewhere/index.html"])).rejects.toThrow(/no composition|outside the project/);
    await expect(check(["a", "b"])).rejects.toThrow(/one composition at a time/);
    await expect(check(["--fix"])).rejects.toThrow(/unknown argument --fix/);
  });
});

describe("seekSafetyFindings", () => {
  const find = (script: string) => seekSafetyFindings(`<html>\n<script>\n${script}\n</script>\n</html>`).map((f) => `${f.rule}@${f.line}`);

  it("takes seeded randomness and finds each unseeded one with its line", () => {
    expect(find('gsap.utils.random(0, 100, 1, true);\nconst x = gsap.utils.random(0, 100);\ngsap.to(a, { x: "random(-50, 50)" });')).toEqual([
      "gsap_random_unseeded@4",
      "gsap_random_unseeded@5",
    ]);
  });

  it("ignores comments and external scripts", () => {
    const html = '<script src="x.js" onComplete: delay: ScrollTrigger></script><script>\n// delay: 1\n/* ScrollTrigger */\nconst d = 1;\n</script>';
    expect(seekSafetyFindings(html)).toEqual([]);
  });
});
