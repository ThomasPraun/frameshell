import { mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canClone, planVideoProject, projectName } from "../src/main/video-project.js";

function folder(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "frameshell-video-project-")));
}

function video(dir: string, name = "interview.mp4", bytes = 16): string {
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(bytes, 1));
  return path;
}

/** A project folder made from `source`: `frameshell.json` plus `assets/<name>` of `bytes`. */
function projectFrom(dir: string, name: string, bytes: number): void {
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "frameshell.json"), "{}");
  writeFileSync(join(dir, "assets", name), Buffer.alloc(bytes, 1));
}

describe("projectName", () => {
  it("keeps a plain name and replaces characters no folder may hold", () => {
    expect(projectName("Launch video")).toBe("Launch video");
    expect(projectName('a/b\\c:d*e?f"g<h>i|j')).toBe("a-b-c-d-e-f-g-h-i-j");
  });

  it("drops trailing dots and spaces, and never returns an empty name", () => {
    expect(projectName("take 1. ")).toBe("take 1");
    expect(projectName("   ")).toBe("Untitled video");
    expect(projectName("..")).toBe("Untitled video");
  });
});

describe("planVideoProject", () => {
  it("puts the project beside the first video, named after it", async () => {
    const dir = folder();
    const first = video(dir);
    const second = video(dir, "broll.mov", 8);
    const plan = await planVideoProject([first, second]);
    expect(plan).toMatchObject({
      files: [first, second],
      parent: dir,
      name: "interview",
      dir: join(dir, "interview"),
      existing: false,
      totalBytes: 24,
    });
  });

  it("opens the project already made from the same video", async () => {
    const dir = folder();
    const first = video(dir);
    projectFrom(join(dir, "interview"), "interview.mp4", 16);
    expect(await planVideoProject([first])).toMatchObject({ dir: join(dir, "interview"), existing: true, askMode: false });
  });

  it("takes the next free name when the folder holds something else", async () => {
    const dir = folder();
    const first = video(dir);
    mkdirSync(join(dir, "interview"));
    projectFrom(join(dir, "interview (2)"), "interview.mp4", 99);
    expect(await planVideoProject([first])).toMatchObject({ dir: join(dir, "interview (3)"), existing: false });
  });

  it("uses the parent and name given", async () => {
    const dir = folder();
    const elsewhere = folder();
    const plan = await planVideoProject([video(dir)], { parent: elsewhere, name: "Launch: final" });
    expect(plan).toMatchObject({ parent: elsewhere, name: "Launch- final", dir: join(elsewhere, "Launch- final") });
  });

  it("never asks copy or link for small videos", async () => {
    const dir = folder();
    const plan = await planVideoProject([video(dir)]);
    // Small files never ask, whatever the volume does.
    expect(plan.askMode).toBe(false);
    expect(plan.clones).toBe(await canClone(plan.files[0] ?? "", dir));
  });

  it("rejects a missing file and an empty list", async () => {
    const dir = folder();
    await expect(planVideoProject([join(dir, "gone.mp4")])).rejects.toThrow("is not a file");
    await expect(planVideoProject([])).rejects.toThrow("Choose at least one video");
  });
});

describe("canClone", () => {
  it("leaves no test file behind", async () => {
    const dir = folder();
    const source = video(dir);
    await canClone(source, dir);
    expect(readdirSync(dir)).toEqual(["interview.mp4"]);
  });

  it("is false for a folder that does not exist", async () => {
    const dir = folder();
    expect(await canClone(video(dir), join(dir, "missing"))).toBe(false);
  });
});
