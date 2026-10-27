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

/** `BrowserWindow.setContentProtection` works on macOS and Windows only; elsewhere it does nothing. */
export function contentProtectionSupport(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32";
}

/** What {@link screenSources} reads of a `desktopCapturer` source. */
export interface CapturerSource {
  id: string;
  name: string;
  thumbnail: { isEmpty(): boolean; toDataURL(): string };
}

/** A window `desktopCapturer` leaves out on macOS: on another Space, in full screen, minimized or hidden. */
export interface OffDesktopWindow {
  /** `window:<CGWindowID>:0`, the id Chromium's window capture takes. */
  id: string;
  name: string;
}

/** Smallest width and height, in points, of an off-desktop window worth offering; smaller ones are popovers and helpers. */
const MIN_WINDOW_SIZE = 100;

/**
 * The windows to add from `CGWindowListCopyWindowInfo(kCGWindowListOptionAll)` (its dictionaries as JSON): app
 * windows (layer 0) with a title, off screen, not transparent, shareable, of a useful size, not owned by `ownPid`.
 * Anything malformed is skipped.
 */
export function offDesktopWindows(list: unknown, ownPid: number): OffDesktopWindow[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): OffDesktopWindow[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const info = entry as Record<string, unknown>;
    const bounds = (typeof info.kCGWindowBounds === "object" && info.kCGWindowBounds) || {};
    const { Width: width, Height: height } = bounds as Record<string, unknown>;
    const name = typeof info.kCGWindowName === "string" ? info.kCGWindowName.trim() : "";
    const offered =
      Number.isInteger(info.kCGWindowNumber) &&
      info.kCGWindowLayer === 0 &&
      name !== "" &&
      info.kCGWindowIsOnscreen !== true &&
      info.kCGWindowOwnerPID !== ownPid &&
      info.kCGWindowSharingState !== 0 &&
      info.kCGWindowAlpha !== 0 &&
      typeof width === "number" &&
      typeof height === "number" &&
      width >= MIN_WINDOW_SIZE &&
      height >= MIN_WINDOW_SIZE;
    return offered ? [{ id: `window:${info.kCGWindowNumber as number}:0`, name }] : [];
  });
}

/**
 * The sources to offer: screens first, then windows, then the `offDesktop` windows `sources` lacks (no thumbnail),
 * leaving out Frameshell's own windows (`ownIds`, their `getMediaSourceId()`), which stay out of the recording anyway.
 */
export function screenSources(
  sources: readonly CapturerSource[],
  ownIds: ReadonlySet<string>,
  offDesktop: readonly OffDesktopWindow[] = [],
): ShootScreenSource[] {
  const offered = sources
    .filter((source) => !ownIds.has(source.id))
    .map((source): ShootScreenSource => ({
      id: source.id,
      name: source.name,
      kind: source.id.startsWith("screen:") ? "screen" : "window",
      thumbnail: source.thumbnail.isEmpty() ? "" : source.thumbnail.toDataURL(),
    }));
  const listed = new Set(sources.map((source) => source.id));
  const away = offDesktop
    .filter((window) => !ownIds.has(window.id) && !listed.has(window.id))
    .map((window): ShootScreenSource => ({ id: window.id, name: window.name, kind: "window", thumbnail: "", offDesktop: true }));
  return [...offered.filter((source) => source.kind === "screen"), ...offered.filter((source) => source.kind === "window"), ...away];
}
