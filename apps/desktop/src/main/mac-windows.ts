import { execFile } from "node:child_process";

// JXA keeps this free of a native module. Window titles need Screen Recording permission, which osascript
// inherits from Frameshell as its responsible process; without it every title is empty and nothing is added.
const LIST_WINDOWS = `ObjC.import("CoreGraphics");
function run() {
  return JSON.stringify(ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0))));
}`;

/** osascript took 0.08-0.2 s on a MacBook Pro (macOS 26.3); past this the list goes without the extra windows. */
const TIMEOUT_MS = 3000;

/**
 * Every window macOS knows, `CGWindowListCopyWindowInfo(kCGWindowListOptionAll)` as parsed JSON: unlike
 * `desktopCapturer` it includes windows on other Spaces and in full screen. Null off macOS or when it fails.
 */
export function macWindowList(): Promise<unknown> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("osascript", ["-l", "JavaScript", "-e", LIST_WINDOWS], { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}
