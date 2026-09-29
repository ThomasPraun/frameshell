import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type FileNode, type ProjectFiles, openProjectFiles } from "../src/main/project-files.js";

const opened: ProjectFiles[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((files) => files.close()));
});

function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-files-")));
  for (const dir of ["timelines", "scripts", "assets", ".frameshell/cache", ".git", "node_modules/x"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, "frameshell.json"), "{}");
  writeFileSync(join(root, "timelines", "main.json"), "{}");
  writeFileSync(join(root, "scripts", "b.md"), "# B");
  writeFileSync(join(root, "scripts", "a.md"), "# A");
  return root;
}

async function open(root: string, onChange: (paths: string[]) => void = () => {}) {
  const files = await openProjectFiles(root, onChange);
  opened.push(files);
  return files;
}

/** Flatten to `/`-separated paths, dirs suffixed with `/`, in display order. */
function paths(nodes: FileNode[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === "dir" ? [`${node.path}/`, ...paths(node.children)] : [node.path],
  );
}

/** Collects every reported path; macOS may also report files created just before the watch started. */
function recorder(): { changed: string[]; onChange: (paths: string[]) => void } {
  const changed: string[] = [];
  return { changed, onChange: (paths) => changed.push(...paths) };
}

describe("ProjectFiles", () => {
  it("lists the project with folders first, sorted, hiding internal folders", async () => {
    const files = await open(fixture());
    expect(paths(await files.tree())).toEqual([
      "assets/",
      "scripts/",
      "scripts/a.md",
      "scripts/b.md",
      "timelines/",
      "timelines/main.json",
      "frameshell.json",
    ]);
  });

  it("reports files created on disk and lists them afterwards", async () => {
    const root = fixture();
    const changes = recorder();
    const files = await open(root, changes.onChange);
    writeFileSync(join(root, "scripts", "launch.md"), "# Launch");
    await expect.poll(() => changes.changed).toContain("scripts/launch.md");
    expect(paths(await files.tree())).toContain("scripts/launch.md");
  });

  it("reports deletions", async () => {
    const root = fixture();
    const changes = recorder();
    const files = await open(root, changes.onChange);
    rmSync(join(root, "scripts", "a.md"));
    await expect.poll(() => changes.changed).toContain("scripts/a.md");
    expect(paths(await files.tree())).not.toContain("scripts/a.md");
  });

  it("ignores churn in daemon-owned .frameshell/", async () => {
    const root = fixture();
    const changes = recorder();
    await open(root, changes.onChange);
    writeFileSync(join(root, ".frameshell", "cache", "clip.webm"), "x");
    writeFileSync(join(root, "scripts", "c.md"), "x");
    await expect.poll(() => changes.changed).toContain("scripts/c.md");
    expect(changes.changed.some((path) => path.startsWith(".frameshell"))).toBe(false);
  });

  it("reads project files as text", async () => {
    const files = await open(fixture());
    expect(await files.read("scripts/a.md")).toBe("# A");
  });

  it("refuses to read outside the project", async () => {
    const files = await open(fixture());
    await expect(files.read("../../etc/passwd")).rejects.toThrow(/outside the project/);
  });
});
