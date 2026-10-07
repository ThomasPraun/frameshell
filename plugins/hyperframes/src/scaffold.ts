import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandContext, CommandResult, PluginCommand } from "@frameshell/plugin-api";

/** Composition name: becomes a directory and the composition id. */
const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Parsed `hyperframes new` arguments. */
interface NewArgs {
  name: string;
  duration: number;
}

function parseArgs(args: readonly string[]): NewArgs {
  const [name, ...rest] = args;
  if (!name || !NAME.test(name)) {
    throw new Error("usage: frameshell hyperframes new <name> [--duration <seconds>]; <name> is lowercase letters, digits and dashes, e.g. `intro`");
  }
  let duration = 5;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--duration") {
      duration = Number(rest[++i]);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error("--duration takes seconds greater than 0, e.g. `--duration 8`");
    } else {
      throw new Error(`unknown argument ${flag}; usage: frameshell hyperframes new <name> [--duration <seconds>]`);
    }
  }
  return { name, duration };
}

/**
 * `frameshell hyperframes new <name> [--duration s]`: scaffold
 * `compositions/hyperframes/<name>/index.html` at the project resolution,
 * with a transparent background, one clip, and a CSS animation driven by the
 * HyperFrames clock. Never overwrites.
 */
export const newComposition: PluginCommand = {
  description: "Scaffold compositions/hyperframes/<name>/index.html at the project resolution",
  async run({ args, project }: CommandContext): Promise<CommandResult> {
    const { name, duration } = parseArgs(args);
    const config = JSON.parse(await readFile(join(project.dir, "frameshell.json"), "utf8")) as {
      resolution?: { width?: number; height?: number };
    };
    const width = config.resolution?.width ?? 1920;
    const height = config.resolution?.height ?? 1080;
    const dir = join(project.dir, "compositions", "hyperframes", name);
    const entry = `compositions/hyperframes/${name}/index.html`;
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(join(dir, "index.html"), template(name, width, height, duration), { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${entry} already exists; edit it, or pick another name`, { cause: error });
      throw error;
    }
    const add = `frameshell clip add <video track> --type hyperframes --source ${entry} --start <s> --duration ${duration}`;
    return {
      output: `Created ${entry} (${width}x${height}, ${duration} s). Add it to the timeline:\n  ${add}`,
      data: { source: entry, width, height, duration },
    };
  },
};

function template(id: string, width: number, height: number, duration: number): string {
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
    <!-- Composition root: size and length of the render. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
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
