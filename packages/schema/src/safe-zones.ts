import { z } from "zod";

/**
 * Platforms whose app covers part of a played video. The one home of their safe zones
 * (ADR 0028 decision 9): styles, formats and review name a platform, never copy its numbers.
 */
export const PLATFORM_IDS = ["instagram-reels", "tiktok", "youtube-shorts", "youtube"] as const;

/** One of {@link PLATFORM_IDS}. */
export type PlatformId = (typeof PLATFORM_IDS)[number];

const Inset = (edge: string) =>
  z.number().nonnegative().describe(`Pixels from the ${edge} edge of the reference frame that the platform's UI covers: keep text and faces out.`);

/** Where a platform's UI covers the picture, in pixels of a reference frame. */
export const SafeZoneSchema = z.strictObject({
  platform: z.enum(PLATFORM_IDS),
  width: z.int().positive().describe("Reference frame width, px. Scale the insets with the frame."),
  height: z.int().positive().describe("Reference frame height, px."),
  top: Inset("top"),
  right: Inset("right"),
  bottom: Inset("bottom"),
  left: Inset("left"),
  measured: z.boolean().describe("True: measured on the platform's app. False: taken from editing guides; check before relying on it."),
  source: z.string().describe("Where the numbers come from."),
});

/** See {@link SafeZoneSchema}. */
export type SafeZone = z.output<typeof SafeZoneSchema>;

// Larger inset of two 9:16 guides per edge: a reel kit's UI zones (top 14 %, bottom 20 %, right 12 % of
// 1080x1920 = 269, 384, 130 px) and HyperFrames' text area (y 168 to 1330, so 590 px at the bottom).
const VERTICAL_GUIDES = { width: 1080, height: 1920, top: 269, right: 130, bottom: 590, left: 0 } as const;
const VERTICAL_SOURCE = "Not measured on this platform: the larger inset per edge of two 9:16 guides, a reel kit's UI zones and HyperFrames' text area (#452, #457).";

/** Safe zone of every platform. */
export const SAFE_ZONES: Readonly<Record<PlatformId, SafeZone>> = {
  "instagram-reels": {
    platform: "instagram-reels",
    width: 1080,
    height: 1920,
    top: 220,
    right: 140,
    bottom: 380,
    left: 0,
    measured: true,
    source: "Instagram Reels UI measured on a 1080x1920 frame (#452, #457).",
  },
  tiktok: { platform: "tiktok", ...VERTICAL_GUIDES, measured: false, source: VERTICAL_SOURCE },
  "youtube-shorts": { platform: "youtube-shorts", ...VERTICAL_GUIDES, measured: false, source: VERTICAL_SOURCE },
  youtube: {
    platform: "youtube",
    width: 1920,
    height: 1080,
    top: 54,
    right: 96,
    bottom: 54,
    left: 96,
    measured: false,
    source: "No UI covers a played video: titles stay 5 % inside every edge (#457).",
  },
};

/** Pixels each edge of a frame a platform's UI covers. */
export interface ZoneInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * The edges of `zone` in pixels of a `frame`-sized picture: the platform's reference numbers scaled per axis, rounded.
 * One scaling for `review`'s safe sheet and the app's preview overlay.
 */
export function zoneInsets(zone: Pick<SafeZone, "width" | "height" | "top" | "right" | "bottom" | "left">, frame: { width: number; height: number }): ZoneInsets {
  const x = frame.width / zone.width;
  const y = frame.height / zone.height;
  return { top: Math.round(zone.top * y), right: Math.round(zone.right * x), bottom: Math.round(zone.bottom * y), left: Math.round(zone.left * x) };
}

/** Whether the platform's reference frame and a `frame` are both vertical or both not (square counts as not vertical). */
export function sameOrientation(zone: Pick<SafeZone, "width" | "height">, frame: { width: number; height: number }): boolean {
  return zone.height > zone.width === frame.height > frame.width;
}
