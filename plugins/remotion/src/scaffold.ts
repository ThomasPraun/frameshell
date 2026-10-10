import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandContext, CommandResult, PluginCommand } from "@frameshell/plugin-api";

/** Composition name: becomes the composition id and, in PascalCase, the component. */
const NAME = /^[a-z][a-z0-9-]*$/;

/** Remotion version the scaffold pins: the one ADR 0009 measured. */
export const REMOTION_VERSION = "4.0.527";
/** React version the scaffold pins, as measured with {@link REMOTION_VERSION}. */
export const REACT_VERSION = "19.1.0";

/** Project-relative directory of the scaffolded Remotion project. */
export const PROJECT_DIR = "compositions/remotion";

const USAGE = "usage: frameshell remotion new <name> [--duration <seconds>]; <name> is lowercase letters, digits and dashes, e.g. `intro`";

/** Parsed `remotion new` arguments. */
interface NewArgs {
  name: string;
  duration: number;
}

function parseArgs(args: readonly string[]): NewArgs {
  const [name, ...rest] = args;
  if (!name || !NAME.test(name)) throw new Error(USAGE);
  let duration = 5;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--duration") {
      duration = Number(rest[++i]);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error("--duration takes seconds greater than 0, e.g. `--duration 8`");
    } else {
      throw new Error(`unknown argument ${flag}; ${USAGE}`);
    }
  }
  return { name, duration };
}

/**
 * `frameshell remotion new <name> [--duration s]`: add a composition to the
 * project's Remotion project at `compositions/remotion/`, creating that
 * project first (package.json pinning Remotion, entry, root) when missing.
 * The composition has the project's size and fps, no background, and timing
 * derived from `useVideoConfig()`. Never overwrites, never installs packages.
 */
export const newComposition: PluginCommand = {
  description: "Add a composition to compositions/remotion/ (creates the Remotion project when missing)",
  async run({ args, project }: CommandContext): Promise<CommandResult> {
    const { name, duration } = parseArgs(args);
    const config = JSON.parse(await readFile(join(project.dir, "frameshell.json"), "utf8")) as {
      fps?: number;
      resolution?: { width?: number; height?: number };
    };
    const format = { fps: config.fps ?? 30, width: config.resolution?.width ?? 1920, height: config.resolution?.height ?? 1080 };
    const component = pascal(name);
    const root = join(project.dir, ...PROJECT_DIR.split("/"));
    const file = `${PROJECT_DIR}/src/${component}.tsx`;
    const fresh = !(await exists(join(root, "package.json")));
    await mkdir(join(root, "src"), { recursive: true });
    try {
      await writeFile(join(root, "src", `${component}.tsx`), compositionTemplate(component), { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${file} already exists; edit it, or pick another name`, { cause: error });
      throw error;
    }
    const registration = compositionElement(name, component, duration, format);
    if (fresh) {
      await writeFile(join(root, "package.json"), packageJson(), { flag: "wx" });
      await writeFile(join(root, "tsconfig.json"), TSCONFIG, { flag: "wx" });
      await writeFile(join(root, ".gitignore"), "node_modules/\n", { flag: "wx" });
      await writeFile(join(root, "src", "index.ts"), INDEX, { flag: "wx" });
      await writeFile(join(root, "src", "Root.tsx"), rootTemplate(component, registration), { flag: "wx" });
    }
    const source = `${PROJECT_DIR}/src/index.ts`;
    const props = JSON.stringify({ composition: name, inputProps: { title: "Title" } });
    const add = `frameshell clip add <video track> --type remotion --source ${source} --start <s> --duration ${duration} --props '${props}'`;
    const steps = [
      `Created ${file} (${format.width}x${format.height}, ${format.fps} fps, ${duration} s).`,
      ...(fresh
        ? [`Created the Remotion project ${PROJECT_DIR}/ (Remotion ${REMOTION_VERSION}). Install it once: cd ${PROJECT_DIR} && npm install`]
        : [`Register it in ${PROJECT_DIR}/src/Root.tsx (import { ${component} } from "./${component}"):\n  ${registration}`]),
      `Add it to the timeline:\n  ${add}`,
    ];
    return { output: steps.join("\n"), data: { file, source, composition: name, createdProject: fresh, ...format, duration } };
  },
};

function pascal(name: string): string {
  return name
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function compositionElement(id: string, component: string, duration: number, format: { fps: number; width: number; height: number }): string {
  return (
    `<Composition id="${id}" component={${component}} durationInFrames={${Math.max(1, Math.round(duration * format.fps))}} ` +
    `fps={${format.fps}} width={${format.width}} height={${format.height}} defaultProps={{ title: "Title" }} />`
  );
}

function packageJson(): string {
  const pkg = {
    name: "frameshell-compositions",
    private: true,
    description: "Remotion compositions of this Frameshell project, rendered by @frameshell/remotion.",
    dependencies: {
      "@remotion/bundler": REMOTION_VERSION,
      "@remotion/renderer": REMOTION_VERSION,
      react: REACT_VERSION,
      "react-dom": REACT_VERSION,
      remotion: REMOTION_VERSION,
    },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

const TSCONFIG = `${JSON.stringify(
  { compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", strict: true, skipLibCheck: true, noEmit: true }, include: ["src"] },
  null,
  2,
)}\n`;

const INDEX = `// Entry of the Remotion project: Frameshell bundles this file (clip \`source\`).
import { registerRoot } from "remotion";
import { Root } from "./Root";

registerRoot(Root);
`;

function rootTemplate(component: string, registration: string): string {
  return `// Every composition a clip can name in props.composition. Frameshell renders them at the project's fps and size.
import { Composition } from "remotion";
import { ${component} } from "./${component}";

export const Root = () => (
  <>
    ${registration}
  </>
);
`;
}

function compositionTemplate(component: string): string {
  return `import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

/**
 * Title card. No background: the clip keeps alpha, so the footage below shows through.
 * Timing comes from useVideoConfig(), so the card keeps its speed at any project fps.
 */
export const ${component} = ({ title }: { title: string }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, height } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const exit = interpolate(frame, [durationInFrames - Math.round(fps / 2), durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: "6%",
          bottom: "10%",
          padding: "0.6em 1em",
          borderRadius: "0.4em",
          background: "rgba(12, 18, 40, 0.72)",
          color: "#fff",
          font: \`700 \${Math.round(height / 14)}px/1.1 system-ui, sans-serif\`,
          opacity: enter * exit,
          transform: \`translateY(\${(1 - enter) * 40}px)\`,
        }}
      >
        {title}
      </div>
    </AbsoluteFill>
  );
};
`;
}
