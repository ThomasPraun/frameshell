import { z } from "zod";

// Own module: `timeline.ts` keys clip overrides by it, and `formats.ts` imports `composite.ts`, which imports `timeline.ts`.

/** Image types `frameshell frame --format` also takes, so no format may be named after one. */
export const RESERVED_FORMAT_IDS = Object.freeze(["png", "jpg", "jpeg", "webp"]);

/** Format id: lowercase letters, digits and `-`, e.g. `9x16` or `web-1600x900`. */
export const FormatIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "must be lowercase letters, digits and `-`, up to 40, e.g. `9x16` or `web-1600x900`")
  .refine((id) => !RESERVED_FORMAT_IDS.includes(id), { message: `must not be an image type (${RESERVED_FORMAT_IDS.join(", ")})` })
  .describe("Format id, e.g. `9x16` or `web-1600x900`: lowercase letters, digits and `-`, up to 40; not png, jpg, jpeg or webp.");
