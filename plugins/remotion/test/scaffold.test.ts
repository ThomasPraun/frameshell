import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { REACT_VERSION, REMOTION_VERSION, newComposition } from "../src/index.js";

let project: string;

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-remotion-scaffold-")));
  writeFileSync(join(project, "frameshell.json"), JSON.stringify({ fps: 25, resolution: { width: 2560, height: 1440 } }));
});

const run = (...args: string[]) => newComposition.run({ args, cwd: project, project: { dir: project } });
const read = (path: string) => readFileSync(join(project, "compositions", "remotion", ...path.split("/")), "utf8");

describe("frameshell remotion new", () => {
  it("creates the Remotion project with the first composition registered at the project's format", async () => {
    const result = await run("intro-card", "--duration", "4");
    expect(result).toMatchObject({
      data: { file: "compositions/remotion/src/IntroCard.tsx", source: "compositions/remotion/src/index.ts", composition: "intro-card", createdProject: true, fps: 25, width: 2560, height: 1440, duration: 4 },
      output: expect.stringContaining("--type remotion --source compositions/remotion/src/index.ts"),
    });
    expect((result as { output: string }).output).toContain("npm install");
    expect(JSON.parse(read("package.json")).dependencies).toEqual({
      "@remotion/bundler": REMOTION_VERSION,
      "@remotion/renderer": REMOTION_VERSION,
      react: REACT_VERSION,
      "react-dom": REACT_VERSION,
      remotion: REMOTION_VERSION,
    });
    expect(read("src/index.ts")).toContain("registerRoot(Root)");
    expect(read("src/Root.tsx")).toContain(
      '<Composition id="intro-card" component={IntroCard} durationInFrames={100} fps={25} width={2560} height={1440} defaultProps={{ title: "Title" }} />',
    );
    const component = read("src/IntroCard.tsx");
    expect(component).toContain("export const IntroCard");
    expect(component).toContain("useVideoConfig()");
    expect(component).not.toMatch(/AbsoluteFill style=\{\{[^}]*background/);
    expect(read(".gitignore")).toBe("node_modules/\n");
  });

  it("adds later compositions without touching the project files, printing the registration", async () => {
    await run("intro");
    const root = read("src/Root.tsx");
    const result = (await run("outro", "--duration", "2")) as { output: string; data: { createdProject: boolean } };
    expect(result.data.createdProject).toBe(false);
    expect(read("src/Root.tsx")).toBe(root);
    expect(existsSync(join(project, "compositions", "remotion", "src", "Outro.tsx"))).toBe(true);
    expect(result.output).toContain('import { Outro } from "./Outro"');
    expect(result.output).toContain('<Composition id="outro" component={Outro} durationInFrames={50}');
  });

  it("never overwrites, and rejects bad names and flags", async () => {
    await run("intro");
    await expect(run("intro")).rejects.toThrow(/already exists/);
    await expect(run("Intro")).rejects.toThrow(/usage/);
    await expect(run("1intro")).rejects.toThrow(/usage/);
    await expect(run("x", "--duration", "0")).rejects.toThrow(/--duration/);
    await expect(run("x", "--fps", "30")).rejects.toThrow(/unknown argument --fps/);
  });
});
