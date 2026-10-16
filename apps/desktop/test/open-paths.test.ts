import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { launchPaths, pathBatcher } from "../src/main/open-paths.js";

describe("launchPaths", () => {
  const cwd = resolve("/home/ana");

  it("takes the arguments after the executable, absolute against cwd", () => {
    expect(launchPaths(["/opt/Frameshell/frameshell", "clip.mp4", "/media/take.mov"], 1, cwd)).toEqual([
      join(cwd, "clip.mp4"),
      resolve("/media/take.mov"),
    ]);
  });

  it("skips the main script of an unpackaged app, flags, and --project with its folder", () => {
    const argv = ["electron", "out/main/index.js", "--no-sandbox", "--project", "/p/demo", "--allow-file-access-from-files", "a.mp4"];
    expect(launchPaths(argv, 2, cwd)).toEqual([join(cwd, "a.mp4")]);
  });

  it("returns nothing for a plain launch", () => {
    expect(launchPaths(["Frameshell.exe"], 1, cwd)).toEqual([]);
  });
});

describe("pathBatcher", () => {
  it("hands paths over together once they stop coming", () => {
    vi.useFakeTimers();
    const flushed: string[][] = [];
    const add = pathBatcher((paths) => flushed.push(paths), 300);
    add("/a.mp4");
    vi.advanceTimersByTime(200);
    add("/b.mov");
    vi.advanceTimersByTime(299);
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(flushed).toEqual([["/a.mp4", "/b.mov"]]);
    add("/c.mp4");
    vi.advanceTimersByTime(300);
    expect(flushed).toEqual([["/a.mp4", "/b.mov"], ["/c.mp4"]]);
    vi.useRealTimers();
  });
});
