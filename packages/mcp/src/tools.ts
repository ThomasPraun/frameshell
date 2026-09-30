import { type MethodName, methodJsonSchemas } from "@frameshell/protocol";
import { z } from "zod";

/** Registry methods whose tool name is not the mechanical `a.b` → `a_b`. */
const RENAMED: Partial<Record<MethodName, string>> = {
  // SPEC §7b: the observe tool returns the image itself, so the model sees what it built.
  frame: "frame_capture",
};

/** MCP tool name of a registry method: `clip.add` → `clip_add`. */
export function toolName(method: string): string {
  return RENAMED[method as MethodName] ?? method.replaceAll(".", "_");
}

/** One tool the server lists. `method` is the daemon method it calls; absent for composed tools. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: { type: "object"; [key: string]: unknown };
  method?: MethodName;
  /** The params take `cwd`; the server fills it in when the caller omits it. */
  takesCwd: boolean;
}

/** Largest side of images returned by `frame_capture`: keeps a 4K frame well under model image limits. */
export const CAPTURE_MAX_SIDE = 1280;
/** Width of a `frames_strip` contact sheet. */
export const STRIP_MAX_WIDTH = 1280;

/** Params of the composed `frames_strip` tool. Same conventions as registry params. */
export const FramesStripParams = z
  .strictObject({
    cwd: z.string().optional(),
    timeline: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
      .default("main")
      .describe("Timeline id; the file is `timelines/<id>.json`. Default `main`."),
    from: z.number().nonnegative().describe("Timeline seconds of the first frame, e.g. `10`."),
    to: z
      .number()
      .nonnegative()
      .describe("Timeline seconds of the last frame, e.g. `20`; greater than `from` and before the timeline's end."),
    count: z.int().min(2).max(16).default(6).describe("Frames to sample, evenly spaced from `from` to `to` inclusive. Default 6."),
    preset: z.string().min(1).optional().describe("Export preset whose frame size to render at. Default: project resolution."),
  })
  .refine((params) => params.to > params.from, { message: "`to` must be greater than `from`", path: ["to"] });

const STRIP_DESCRIPTION =
  "See a time range at a glance: sample `count` frames evenly from `from` to `to` (timeline seconds, both included) " +
  "and return one contact sheet image, tiles left to right then top to bottom, plus the time, frame index and clip " +
  "of each tile. Frames are rendered like `frame_capture` (export compiler, matches `render`). Use it to check a cut, " +
  "find where a shot changes, or review a whole edit before rendering. Example: `{ from: 0, to: 30, count: 9 }`. " +
  "Fails like `frame_capture` (InvalidOperation with the valid range when a time is outside the timeline).";

const CAPTURE_SUFFIX =
  " Returns the frame as an image (scaled to fit " +
  `${CAPTURE_MAX_SIDE}x${CAPTURE_MAX_SIDE}) plus its frame index and clip; \`out\` is optional and also keeps the ` +
  "full-size PNG there.";

/**
 * Every tool: one per public registry method, input schema generated from the
 * method's Zod params, plus the composed `frames_strip`. `cwd` becomes
 * optional and documents `defaultCwd`, the directory the server started in.
 */
export function buildTools(defaultCwd: string): ToolSpec[] {
  const schemas = methodJsonSchemas();
  const renames = Object.keys(schemas).map((method) => [method, toolName(method)] as const);
  // Descriptions cross-reference methods in backticks; the model only knows tool names.
  const retarget = (text: string) =>
    renames.reduce((out, [method, tool]) => (method === tool ? out : out.replaceAll(`\`${method}\``, `\`${tool}\``)), text);
  const tools: ToolSpec[] = [];
  for (const [method, schema] of Object.entries(schemas) as [MethodName, (typeof schemas)[MethodName]][]) {
    if (schema.internal) continue;
    const input = withDefaultCwd(schema.params, defaultCwd);
    let description = retarget(schema.description);
    if (method === "frame") {
      optional(input.schema, "out");
      const out = (input.schema["properties"] as Record<string, { description?: string }>)["out"];
      if (out) out.description = `Optional. ${out.description ?? ""}`.trim();
      description += CAPTURE_SUFFIX;
    }
    tools.push({ name: toolName(method), description, inputSchema: input.schema, method, takesCwd: input.takesCwd });
  }
  const strip = withDefaultCwd(z.toJSONSchema(FramesStripParams, { target: "draft-2020-12", io: "input" }), defaultCwd);
  tools.push({ name: "frames_strip", description: STRIP_DESCRIPTION, inputSchema: strip.schema, takesCwd: true });
  return tools;
}

/** Copy of `params` without `$schema`, with `cwd` optional and its default spelled out. */
function withDefaultCwd(params: Record<string, unknown>, defaultCwd: string): { schema: ToolSpec["inputSchema"]; takesCwd: boolean } {
  const { $schema: _drop, ...rest } = structuredClone(params);
  const schema: ToolSpec["inputSchema"] = { ...rest, type: "object" };
  const properties = schema["properties"] as Record<string, Record<string, unknown>> | undefined;
  const cwd = properties?.["cwd"];
  if (!cwd) return { schema, takesCwd: false };
  optional(schema, "cwd");
  cwd.type = "string";
  cwd.description =
    "Absolute directory inside the project; the project is found searching upwards. " +
    `Default: \`${defaultCwd}\`, where this MCP server was started. Omit it unless working on another project.`;
  return { schema, takesCwd: true };
}

function optional(schema: Record<string, unknown>, field: string): void {
  const required = schema["required"];
  if (!Array.isArray(required)) return;
  const kept = required.filter((name) => name !== field);
  if (kept.length > 0) schema["required"] = kept;
  else delete schema["required"];
}
