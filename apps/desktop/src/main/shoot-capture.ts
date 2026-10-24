// What the Shoot view can capture on this machine (ADR 0024 decisions 2 and 9): system audio support and the list of
// screens and windows, Frameshell's own list instead of the system picker.
import type { ShootScreenSource, ShootSupport } from "../shared/api.js";

/** System audio by platform: macOS 14.2+ (CoreAudio Tap) and Windows (`loopback`, untested); none on Linux. */
export function systemAudioSupport(platform: NodeJS.Platform, version: string): ShootSupport["systemAudio"] {
  if (platform === "win32") return "available";
  if (platform !== "darwin") return "linux";
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  return major > 14 || (major === 14 && minor >= 2) ? "available" : "macos-old";
}

/** What {@link screenSources} reads of a `desktopCapturer` source. */
export interface CapturerSource {
  id: string;
  name: string;
  thumbnail: { isEmpty(): boolean; toDataURL(): string };
}

/**
 * The sources to offer: screens first, then windows, leaving out Frameshell's own windows (`ownIds`, their
 * `getMediaSourceId()`), which stay out of the recording anyway.
 */
export function screenSources(sources: readonly CapturerSource[], ownIds: ReadonlySet<string>): ShootScreenSource[] {
  const offered = sources
    .filter((source) => !ownIds.has(source.id))
    .map((source): ShootScreenSource => ({
      id: source.id,
      name: source.name,
      kind: source.id.startsWith("screen:") ? "screen" : "window",
      thumbnail: source.thumbnail.isEmpty() ? "" : source.thumbnail.toDataURL(),
    }));
  return [...offered.filter((source) => source.kind === "screen"), ...offered.filter((source) => source.kind === "window")];
}
