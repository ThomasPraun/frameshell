import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DaemonConnection, connectToDaemon } from "@frameshell/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/index.js";
import { CORE_SKILL_FILES, SHIPPED_SKILL_HASHES } from "../src/skills/core-skill.js";
import { coreSkillState, refreshCoreSkill } from "../src/skills/refresh.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// A project's copy of the core agent skill kept current (#396): unedited old copies update, edited ones are left alone.

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const skillDir = (root: string) => join(root, ".claude", "skills", "frameshell");

/** A copy as an older Frameshell wrote it: the bundled files, with `SKILL.md` one shipped version back. */
function oldCopy(root: string, skill: string) {
  for (const [file, text] of Object.entries(CORE_SKILL_FILES)) {
    mkdirSync(join(skillDir(root), file, ".."), { recursive: true });
    writeFileSync(join(skillDir(root), file), file === "SKILL.md" ? skill : text);
  }
}

describe("shipped skill hashes", () => {
  it("hold every bundled file's current content (run `pnpm gen:skill` after editing skills/frameshell)", () => {
    for (const [file, text] of Object.entries(CORE_SKILL_FILES)) expect(SHIPPED_SKILL_HASHES[file], file).toContain(sha256(text));
  });

  it("hold more than one version of SKILL.md, seeded from the release tags", () => {
    expect(SHIPPED_SKILL_HASHES["SKILL.md"]!.length).toBeGreaterThan(1);
  });
});

describe("refreshCoreSkill", () => {
  let root: string;
  beforeEach(() => {
    root = tempDir();
  });

  it("updates an unedited older copy, removes a file Frameshell stopped shipping and keeps a file the person added", async () => {
    // An older shipped version is not available as text here, so stand one in by teaching the hashes about it.
    const older = "# Frameshell (older)\n";
    (SHIPPED_SKILL_HASHES as Record<string, string[]>)["SKILL.md"] = [...SHIPPED_SKILL_HASHES["SKILL.md"]!, sha256(older)];
    (SHIPPED_SKILL_HASHES as Record<string, string[]>)["reference/gone.md"] = [sha256("gone\n")];
    oldCopy(root, older);
    writeFileSync(join(skillDir(root), "reference", "gone.md"), "gone\n");
    writeFileSync(join(skillDir(root), "mine.md"), "my notes\n");
    expect(await coreSkillState(root)).toMatchObject({ state: "outdated", edited: [] });

    const result = await refreshCoreSkill(root);
    expect(result).toMatchObject({ state: "current", written: ["SKILL.md"], removed: ["reference/gone.md"] });
    expect(readFileSync(join(skillDir(root), "SKILL.md"), "utf8")).toBe(CORE_SKILL_FILES["SKILL.md"]);
    expect(readFileSync(join(skillDir(root), "mine.md"), "utf8")).toBe("my notes\n");
    expect(existsSync(join(skillDir(root), "reference", "gone.md"))).toBe(false);
  });

  it("leaves an edited copy alone unless forced, and never touches an absent one", async () => {
    oldCopy(root, "# My own Frameshell skill\n");
    expect(await refreshCoreSkill(root)).toMatchObject({ state: "edited", edited: ["SKILL.md"], written: [] });
    expect(readFileSync(join(skillDir(root), "SKILL.md"), "utf8")).toBe("# My own Frameshell skill\n");
    expect(await refreshCoreSkill(root, { force: true })).toMatchObject({ state: "current", written: ["SKILL.md"] });

    rmSync(skillDir(root), { recursive: true });
    expect(await refreshCoreSkill(root)).toMatchObject({ state: "absent", written: [] });
    expect(existsSync(skillDir(root))).toBe(false);
  });

  it("reads a copy with CRLF line ends as unedited", async () => {
    oldCopy(root, CORE_SKILL_FILES["SKILL.md"]!.replace(/\n/g, "\r\n"));
    expect(await coreSkillState(root)).toMatchObject({ state: "current", edited: [] });
  });
});

describe("skill in the daemon", () => {
  let daemon: Daemon;
  let conn: DaemonConnection;
  beforeEach(async () => {
    daemon = await startDaemon({ socketPath: uniqueSocketPath(), idleTimeoutMs: Number.POSITIVE_INFINITY });
    conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  });
  afterEach(async () => {
    conn.close();
    await daemon.close();
  });

  it("reports an edited copy in status and doctor, and skill.update --force replaces it", async () => {
    const dir = join(tempDir(), "p");
    await conn.request("project.init", { dir });
    writeFileSync(join(skillDir(dir), "SKILL.md"), "# edited\n");
    const status = await conn.request("status", { cwd: dir });
    expect(status.skill).toMatchObject({ state: "edited", edited: ["SKILL.md"], dir: ".claude/skills/frameshell" });
    expect((await conn.request("doctor", { cwd: dir })).skill).toMatchObject({ state: "edited" });
    expect(await conn.request("skill.update", { cwd: dir })).toMatchObject({ state: "edited", written: [] });
    expect(await conn.request("skill.update", { cwd: dir, force: true })).toMatchObject({ state: "current", written: ["SKILL.md"] });
  });

  it("writes the skill again into a project that has none", async () => {
    const dir = join(tempDir(), "p");
    await conn.request("project.init", { dir, agentSkill: false });
    expect((await conn.request("status", { cwd: dir })).skill).toMatchObject({ state: "absent" });
    const result = await conn.request("skill.update", { cwd: dir });
    expect(result.state).toBe("current");
    expect(result.written).toContain("SKILL.md");
  });
});
