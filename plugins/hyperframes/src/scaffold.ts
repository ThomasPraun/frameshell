import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CommandContext, CommandResult, PluginCommand } from "@frameshell/plugin-api";
import { MOTION_RUNTIME, MOTION_RUNTIME_FILE, MOTION_RUNTIME_VERSION } from "./motion-runtime.js";
import { TEMPLATES, type Template, type TemplateVariable, findTemplate, fontSetup, readTokens } from "./templates/index.js";

/** Composition name: becomes a directory and the composition id. */
const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Parsed `hyperframes new` arguments. */
interface NewArgs {
  name: string;
  duration: number | undefined;
  template: Template | undefined;
}

const USAGE = `usage: frameshell hyperframes new <name> [--template <${TEMPLATES.map((t) => t.id).join("|")}>] [--duration <seconds>]; <name> is lowercase letters, digits and dashes, e.g. \`intro\``;

function parseArgs(args: readonly string[]): NewArgs {
  const [name, ...rest] = args;
  if (!name || !NAME.test(name)) {
    throw new Error(USAGE);
  }
  let duration: number | undefined;
  let template: Template | undefined;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--duration") {
      duration = Number(rest[++i]);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error("--duration takes seconds greater than 0, e.g. `--duration 8`");
    } else if (flag === "--template") {
      const id = rest[++i];
      template = id === undefined ? undefined : findTemplate(id);
      if (!template) throw new Error(`--template takes one of ${TEMPLATES.map((t) => t.id).join(", ")}${id ? `; got ${id}` : ""}`);
    } else {
      throw new Error(`unknown argument ${flag}; ${USAGE}`);
    }
  }
  return { name, duration, template };
}

/**
 * `frameshell hyperframes new <name> [--template t] [--duration s]`: scaffold
 * `compositions/hyperframes/<name>/index.html` at the project resolution.
 * Without a template: a transparent background, one clip and a CSS animation
 * driven by the HyperFrames clock. With `--template` (ADR 0033, #466): a motion
 * composition painted by the Frameshell motion runtime, which is copied next
 * to it (frozen per composition; `hyperframes update` refreshes it), with typed
 * props and the brand values of `style.json` as their defaults. Never overwrites.
 */
export const newComposition: PluginCommand = {
  description: "Scaffold compositions/hyperframes/<name>/index.html at the project resolution (--template for a motion template)",
  async run({ args, project }: CommandContext): Promise<CommandResult> {
    const parsed = parseArgs(args);
    const { name, template } = parsed;
    const duration = parsed.duration ?? template?.defaultDuration ?? 5;
    const config = JSON.parse(await readFile(join(project.dir, "frameshell.json"), "utf8")) as {
      resolution?: { width?: number; height?: number };
    };
    const width = config.resolution?.width ?? 1920;
    const height = config.resolution?.height ?? 1080;
    const dir = join(project.dir, "compositions", "hyperframes", name);
    const entry = `compositions/hyperframes/${name}/index.html`;
    const tokens = await readTokens(project.dir);
    const input = { id: name, width, height, duration, tokens };
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(join(dir, "index.html"), template ? template.render(input) : plainHtml(name, width, height, duration), { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${entry} already exists; edit it, or pick another name`, { cause: error });
      throw error;
    }
    const add = `frameshell clip add <video track> --type hyperframes --source ${entry} --start <s> --duration ${duration}`;
    if (!template) {
      return {
        output: `Created ${entry} (${width}x${height}, ${duration} s). Add it to the timeline:\n  ${add}`,
        data: { source: entry, width, height, duration },
      };
    }
    await writeFile(join(dir, MOTION_RUNTIME_FILE), MOTION_RUNTIME);
    for (const { from, to } of fontSetup(tokens).copies) {
      await mkdir(dirname(join(dir, to)), { recursive: true });
      await copyFile(join(project.dir, ...from.split("/")), join(dir, to));
    }
    const variables = template.variables(input);
    const lines = [
      `Created ${entry} from the ${template.id} template (${width}x${height}, ${duration} s) with ${MOTION_RUNTIME_FILE} (runtime ${MOTION_RUNTIME_VERSION}, frozen for this clip: \`frameshell hyperframes update\` refreshes it).`,
      tokens.used.length > 0
        ? `From style.json: ${tokens.used.join(", ")}. Everything else is a placeholder default.`
        : "No style.json values used: colours, fonts and texts are placeholder defaults.",
      ...(tokens.problem ? [`Note: ${tokens.problem}.`] : []),
      "Props (change one with `frameshell clip set <clip> --props '{...}'`):",
      ...variables.map((variable) => `  ${variable.id}  ${describeVariable(variable)}`),
      "Add it to the timeline:",
      `  ${add}`,
    ];
    return {
      output: lines.join("\n"),
      data: {
        source: entry,
        width,
        height,
        duration,
        template: template.id,
        runtime: MOTION_RUNTIME_VERSION,
        tokens: tokens.used,
        props: variables,
      },
    };
  },
};

function describeVariable(variable: TemplateVariable): string {
  const shown = JSON.stringify(variable.default);
  switch (variable.type) {
    case "number":
      return `number, ${variable.min} to ${variable.max}, default ${shown}: ${variable.label}`;
    case "enum":
      return `one of ${variable.options.map((option) => option.value).join(", ")}, default ${shown}: ${variable.label}`;
    case "image":
      return `image path inside the composition directory, default ${shown}: ${variable.label}`;
    default:
      return `${variable.type}, default ${shown}: ${variable.label}`;
  }
}

function plainHtml(id: string, width: number, height: number, duration: number): string {
  return `<!doctype html>
<html lang="en" data-composition-variables='[{"id":"title","type":"string","label":"Title","default":"Title"}]'>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <title>${id}</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      /* No page background: the render keeps alpha, so the footage shows through. */
      html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
      #stage { position: relative; width: 100%; height: 100%; }
      .clip { position: absolute; inset: 0; }
      #card {
        position: absolute; left: 6%; bottom: 10%; padding: 0.6em 1em; border-radius: 0.4em;
        background: rgba(12, 18, 40, 0.72); color: #fff;
        font: 700 ${Math.round(height / 14)}px/1.1 system-ui, sans-serif;
        animation: enter 0.6s ease-out both;
      }
      @keyframes enter { from { opacity: 0; transform: translateY(40px); } to { opacity: 1; transform: none; } }
    </style>
  </head>
  <body>
    <!-- Composition root: size and length of the render. CSS animations register no GSAP timeline, and
         data-no-timeline says so: without it the render first waits 45 s for window.__timelines["${id}"]. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}" data-no-timeline>
      <div class="clip" data-start="0" data-duration="${duration}" data-track-index="0">
        <div id="card"></div>
      </div>
    </div>
    <script>
      // Clip props arrive as composition variables, merged over the defaults declared in data-composition-variables.
      var vars = (window.__hyperframes && window.__hyperframes.getVariables()) || { title: "Title" };
      document.getElementById("card").textContent = vars.title;
    </script>
  </body>
</html>
`;
}
