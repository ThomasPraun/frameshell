import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CommandContext, CommandResult, PluginCommand } from "@frameshell/plugin-api";
import { projectResolution } from "./frame-size.js";
import { MOTION_RUNTIME, MOTION_RUNTIME_FILE, MOTION_RUNTIME_VERSION } from "./motion-runtime.js";
import { type ComponentPick, componentExists, pickComponents, placeFrame, readComponents, recordedLicence } from "./templates/components.js";
import { TEMPLATES, type Template, type TemplateVariable, findTemplate, fontSetup, readTokens, usesThree, withComponents } from "./templates/index.js";
import { THREE_RUNTIME, THREE_RUNTIME_FILE, THREE_VERSION } from "./three-runtime.js";

/** Composition name: becomes a directory and the composition id. */
const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Parsed `hyperframes new` arguments. */
interface NewArgs {
  name: string;
  duration: number | undefined;
  template: Template | undefined;
  /** `--component` values as given, in order. */
  components: string[];
}

const USAGE = `usage: frameshell hyperframes new <name> [--template <${TEMPLATES.map((t) => t.id).join("|")}>] [--component [<prop>=]<brand file>]... [--duration <seconds>]; <name> is lowercase letters, digits and dashes, e.g. \`intro\``;

function parseArgs(args: readonly string[]): NewArgs {
  const [name, ...rest] = args;
  if (!name || !NAME.test(name)) {
    throw new Error(USAGE);
  }
  let duration: number | undefined;
  let template: Template | undefined;
  const components: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--duration") {
      duration = Number(rest[++i]);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error("--duration takes seconds greater than 0, e.g. `--duration 8`");
    } else if (flag === "--template") {
      const id = rest[++i];
      template = id === undefined ? undefined : findTemplate(id);
      if (!template) throw new Error(`--template takes one of ${TEMPLATES.map((t) => t.id).join(", ")}${id ? `; got ${id}` : ""}`);
    } else if (flag === "--component") {
      const value = rest[++i];
      if (!value) throw new Error("--component takes a picture of `frameshell brand show`, e.g. `--component assets/brand/acme-com/logo-1.svg` (`<prop>=<file>` for a template with several pictures)");
      components.push(value);
    } else {
      throw new Error(`unknown argument ${flag}; ${USAGE}`);
    }
  }
  if (components.length > 0 && !template) throw new Error("--component needs --template: the plain scaffold has no picture prop");
  return { name, duration, template, components };
}

/**
 * `frameshell hyperframes new <name> [--template t] [--duration s]`: scaffold
 * `compositions/hyperframes/<name>/index.html` at the project resolution.
 * Without a template: a transparent background, one clip and a CSS animation
 * driven by the HyperFrames clock. With `--template` (ADR 0033, #466): a motion
 * composition painted by the Frameshell motion runtime, which is copied next
 * to it (frozen per composition; `hyperframes update` refreshes it), with typed
 * props and the brand values of `style.json` as their defaults. A 3D template
 * also gets the pinned three.js bundle the same way (ADR 0042). `--component` fills an image prop with a
 * picture of `brand.json`, copied into the composition (ADR 0044). Never overwrites.
 */
export const newComposition: PluginCommand = {
  description: "Scaffold compositions/hyperframes/<name>/index.html at the project resolution (--template for a motion template)",
  async run({ args, project }: CommandContext): Promise<CommandResult> {
    const parsed = parseArgs(args);
    const { name, template } = parsed;
    const duration = parsed.duration ?? template?.defaultDuration ?? 5;
    const { width, height } = await projectResolution(project.dir);
    const dir = join(project.dir, "compositions", "hyperframes", name);
    const entry = `compositions/hyperframes/${name}/index.html`;
    const tokens = await readTokens(project.dir);
    const picks = template && parsed.components.length > 0 ? await brandPicks(project.dir, template, parsed.components, { id: name, width, height, duration, tokens }) : [];
    const input = { id: name, width, height, duration, tokens, components: Object.fromEntries(picks.map((pick) => [pick.prop, pick.file])) };
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
    const three = usesThree(template);
    if (three) await writeFile(join(dir, THREE_RUNTIME_FILE), THREE_RUNTIME);
    for (const { from, to } of fontSetup(tokens).copies) {
      await mkdir(dirname(join(dir, to)), { recursive: true });
      await copyFile(join(project.dir, ...from.split("/")), join(dir, to));
    }
    const used: Awaited<ReturnType<typeof componentReport>>[] = [];
    for (const pick of picks) {
      await mkdir(dirname(join(dir, pick.file)), { recursive: true });
      await copyFile(join(project.dir, ...pick.component.path.split("/")), join(dir, ...pick.file.split("/")));
      used.push(await componentReport(project.dir, pick, { width, height }));
    }
    const variables = withComponents(template.variables(input), input.components);
    const lines = [
      `Created ${entry} from the ${template.id} template (${width}x${height}, ${duration} s) with ${MOTION_RUNTIME_FILE} (runtime ${MOTION_RUNTIME_VERSION}, frozen for this clip: \`frameshell hyperframes update\` refreshes it).`,
      ...(three
        ? [
            `3D: ${THREE_RUNTIME_FILE} (three.js ${THREE_VERSION}, MIT, frozen the same way) renders on the software renderer, one frame at a time; ` +
              "keep models and textures inside the composition directory.",
          ]
        : []),
      tokens.used.length > 0
        ? `From style.json: ${tokens.used.join(", ")}. Everything else is a placeholder default.`
        : "No style.json values used: colours, fonts and texts are placeholder defaults.",
      ...(tokens.problem ? [`Note: ${tokens.problem}.`] : []),
      ...used.flatMap((component) => component.lines),
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
        ...(three ? { three: THREE_VERSION } : {}),
        tokens: tokens.used,
        ...(used.length > 0 ? { components: used.map((component) => component.data) } : {}),
        props: variables,
      },
    };
  },
};

/** `--component` values resolved against `brand.json` and checked on disk, before anything is written. */
async function brandPicks(projectDir: string, template: Template, specs: readonly string[], input: Parameters<Template["variables"]>[0]): Promise<ComponentPick[]> {
  const picks = pickComponents(specs, template.id, template.variables(input), await readComponents(projectDir));
  for (const { component } of picks) {
    if (!(await componentExists(projectDir, component.path))) {
      throw new Error(`--component: ${component.path} is listed in brand.json but missing on disk; capture or import it again`);
    }
  }
  return picks;
}

/** What the scaffold says about one copied brand picture: output lines and `--json` data. */
async function componentReport(projectDir: string, pick: ComponentPick, canvas: { width: number; height: number }): Promise<{ lines: string[]; data: Record<string, unknown> }> {
  const { component, prop, file } = pick;
  const licence = await recordedLicence(projectDir, component.path);
  const frame = component.reference && component.width && component.height ? placeFrame({ width: component.width, height: component.height }, component.reference, canvas) : null;
  const lines = [`Brand picture: ${prop} = ${file} (${component.origin} ${component.role}, ${component.kind}, copied from ${component.path}).`];
  if (frame) {
    lines.push(
      `  Figma frame: the template fits it into its own box. At its folder's one scale on this ${canvas.width}x${canvas.height} canvas it is ` +
        `scale ${Math.round(frame.scale * 10000) / 10000}, x ${frame.x}, y ${frame.y} (for a composition written by hand).`,
    );
  }
  if (!licence) {
    lines.push(
      `  ${component.path} has no licence in credits.json, and \`frameshell credits\` does not check files inside a composition: ` +
        `ask the person whether this is their brand, then \`frameshell credits set ${component.path} --licence own\`.`,
    );
  }
  return { lines, data: { prop, file, source: component.path, origin: component.origin, role: component.role, kind: component.kind, licence, ...(frame ? { frame } : {}) } };
}

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
