// Safe-zone overlay of the preview (#750): which platform's zone to draw and where, pure. The numbers are
// `@frameshell/schema` `safe-zones.ts`'s (ADR 0028 decision 9), scaled by its `zoneInsets`, never copied.
import { BUILTIN_FORMATS, BUILTIN_FORMAT_IDS } from "@frameshell/schema/formats";
import { PLATFORM_IDS, type PlatformId, SAFE_ZONES, sameOrientation, zoneInsets } from "@frameshell/schema/safe-zones";

/** `localStorage` key of the viewer's choice: a per-viewer convenience, never project state. */
export const SAFE_ZONE_KEY = "frameshell.preview.safeZones";

/** Whether the overlay shows, and for which platform; `platform: null` follows the frame shown. */
export interface SafeZoneChoice {
  on: boolean;
  platform: PlatformId | null;
}

/** Off, following the frame: what a viewer who never chose sees. */
export const NO_SAFE_ZONE: SafeZoneChoice = { on: false, platform: null };

/** A stored choice, or {@link NO_SAFE_ZONE} when it is missing or not one. */
export function readSafeZoneChoice(raw: string | null): SafeZoneChoice {
  try {
    const parsed = JSON.parse(raw ?? "null") as { on?: unknown; platform?: unknown } | null;
    const platform = PLATFORM_IDS.find((id) => id === parsed?.platform) ?? null;
    return { on: parsed?.on === true, platform };
  } catch {
    return NO_SAFE_ZONE;
  }
}

/** The platform a frame is most likely for: vertical ones Instagram Reels (the measured zone), others YouTube. */
export function framePlatform(frame: { width: number; height: number }): PlatformId {
  return frame.height > frame.width ? "instagram-reels" : "youtube";
}

/** Where the zone's safe rectangle sits in a frame, as fractions of its size from each edge, and whether it fits its shape. */
export function safeRect(platform: PlatformId, frame: { width: number; height: number }): { top: number; right: number; bottom: number; left: number; sameShape: boolean } {
  const zone = SAFE_ZONES[platform];
  const insets = zoneInsets(zone, frame);
  return {
    top: insets.top / frame.height,
    right: insets.right / frame.width,
    bottom: insets.bottom / frame.height,
    left: insets.left / frame.width,
    sameShape: sameOrientation(zone, frame),
  };
}

/** A format's name in the switcher: a built-in's aspect (`9:16`), else its id. */
export function formatName(id: string): string {
  return Object.hasOwn(BUILTIN_FORMATS, id) ? id.replace("x", ":") : id;
}

/** Built-in formats a project with `formats` does not have yet, in the built-in order, with their canvases. */
export function addableFormats(formats: readonly { id: string }[]): { id: string; width: number; height: number }[] {
  return BUILTIN_FORMAT_IDS.filter((id) => !formats.some((format) => format.id === id)).map((id) => ({ id, ...BUILTIN_FORMATS[id]! }));
}
