import { z } from "zod";
import { SCHEMA_VERSION, type ParseResult, formatIssues } from "./common.js";

/** Canonical `$schema` URL for a `shoots/<script slug>.json` file. */
export const SHOOT_SCHEMA_URL = `https://frameshell.dev/schema/v${SCHEMA_VERSION}/shoot.json`;

/** Project-relative directory of shoot files (ADR 0023). */
export const SHOOTS_DIR = "shoots";

/** Take id: `k_` + hex when the core generates it. */
export const TakeIdSchema = z.string().regex(/^k_[A-Za-z0-9][A-Za-z0-9_-]*$/, "must look like `k_3fa2c1`");

/** One take: a recording of part of the shoot script. */
export const ShootTakeSchema = z.strictObject({
  id: TakeIdSchema,
  asset: z.string().min(1).describe("Project-relative media file, `/`-separated, e.g. `assets/hook-2.mp4`."),
  scene: z.string().min(1).describe("Slug of the scene the take starts at, as the person or app named it; the comparison finds where it really starts."),
  recordedAt: z.string().min(1).describe("ISO 8601 time the take was recorded (or linked); newer takes are chosen by default."),
  discarded: z.boolean().optional().describe("True when the take is set aside: never chosen, still listed."),
  by: z.string().min(1).optional().describe("Author that linked the take, e.g. `cli` or `agent:claude:s1`."),
});

/** A deviation the person (or an agent) let pass. */
export const AcceptedDeviationSchema = z.strictObject({
  take: TakeIdSchema,
  deviation: z.string().min(1).describe("Deviation id from `shoot.status`; it stays the same while the script line and the heard words stay the same."),
  by: z.string().min(1).describe("Author that accepted it."),
  at: z.string().min(1).describe("ISO 8601 time it was accepted."),
});

/**
 * Zod model of `shoots/<script slug>.json` (ADR 0023): the takes of one shoot script and every
 * decision about them. Written only by the daemon. Take ids are unique; `chosen` and `accepted`
 * name existing takes.
 */
export const ShootFileSchema = z
  .strictObject({
    $schema: z.string().optional(),
    schemaVersion: z.literal(SCHEMA_VERSION),
    script: z.string().min(1).describe("Project-relative shoot script, e.g. `scripts/launch.md`."),
    timeline: z.string().min(1).optional().describe("Timeline the first cut is assembled into; default the script slug."),
    takes: z.array(ShootTakeSchema).default([]),
    chosen: z.record(z.string(), TakeIdSchema).default({}).describe("Scene slug to the take the person picked; scenes not here use the newest take covering them."),
    accepted: z.array(AcceptedDeviationSchema).default([]),
  })
  .superRefine((file, ctx) => {
    const ids = new Set<string>();
    file.takes.forEach((take, index) => {
      if (ids.has(take.id)) ctx.addIssue({ code: "custom", message: `duplicate take id ${take.id}`, path: ["takes", index, "id"] });
      ids.add(take.id);
    });
    for (const [scene, take] of Object.entries(file.chosen)) {
      if (!ids.has(take)) ctx.addIssue({ code: "custom", message: `chosen take ${take} is not in \`takes\``, path: ["chosen", scene] });
    }
    file.accepted.forEach((accepted, index) => {
      if (!ids.has(accepted.take)) ctx.addIssue({ code: "custom", message: `take ${accepted.take} is not in \`takes\``, path: ["accepted", index, "take"] });
    });
  });

/** Validated shoot file content. */
export type ShootFile = z.output<typeof ShootFileSchema>;
/** One take of a {@link ShootFile}. */
export type ShootTake = ShootFile["takes"][number];

/** An empty shoot file for `script`. */
export function createShootFile(script: string): ShootFile {
  return { $schema: SHOOT_SCHEMA_URL, schemaVersion: SCHEMA_VERSION, script, takes: [], chosen: {}, accepted: [] };
}

/** Validate a parsed shoot file. */
export function parseShootFile(input: unknown): ParseResult<ShootFile> {
  const result = ShootFileSchema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: formatIssues(result.error) };
}

/**
 * Slug of a shoot script, the name of its shoot file and default timeline: the path under
 * `scripts/` without `.md`, `/` turned into `-` (`scripts/ep/one.md` → `ep-one`).
 */
export function shootSlug(scriptPath: string): string {
  return scriptPath
    .replace(/^scripts\//, "")
    .replace(/\.md$/i, "")
    .split("/")
    .join("-");
}
