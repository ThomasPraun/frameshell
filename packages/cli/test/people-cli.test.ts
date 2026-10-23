import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Black-box: built CLI and auto-started daemon (ADR 0020). Transcripts are written by hand; no media.
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-people-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-pe-${randomUUID().slice(0, 8)}.sock`);
let project: string;
let userDirs: string;
let daemonPid: number | undefined;

function frameshell(args: string[], cwd = project) {
  const result = spawnSync(process.execPath, [cliBin, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      FRAMESHELL_SOCKET: socketPath,
      FRAMESHELL_IDLE_TIMEOUT_MS: "1500",
      FRAMESHELL_DATA_DIR: userDirs,
      FRAMESHELL_CONFIG_DIR: userDirs,
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const transcriptFile = (asset: string) => ({
  schemaVersion: 1,
  asset,
  assetHash: `sha256:${"b".repeat(64)}`,
  provider: "test",
  model: "test",
  words: [{ id: "w_000001", text: "hola", start: 0, end: 0.5, speaker: "s1" }],
  edits: {},
  speakers: [{ id: "s1", name: "Speaker 1" }],
});

beforeAll(() => {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "frameshell-people-")));
  userDirs = join(parent, "user");
  project = join(parent, "promo");
  mkdirSync(userDirs, { recursive: true });
  expect(frameshell(["init", project, "--no-skill"], parent).code).toBe(0);
  writeFileSync(join(project, "transcripts", "ep1.words.json"), JSON.stringify(transcriptFile("assets/ep1.mp4")));
  writeFileSync(join(project, "transcripts", "ep2.words.json"), JSON.stringify(transcriptFile("assets/ep2.mp4")));
  const status = JSON.parse(frameshell(["status", "--json"]).stdout) as { daemon: { pid: number } };
  daemonPid = status.daemon.pid;
});

afterAll(async () => {
  for (let i = 0; daemonPid && i < 100; i++) {
    try {
      process.kill(daemonPid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

const speakerName = (file: string) => (JSON.parse(readFileSync(join(project, "transcripts", file), "utf8")) as { speakers: { name: string }[] }).speakers[0]!.name;

describe("frameshell people", () => {
  it("rejects bad arguments with exit 2", () => {
    for (const args of [
      ["people"],
      ["people", "list", "extra"],
      ["people", "add"],
      ["people", "rename", "Juan"],
      ["people", "remove"],
      ["people", "link", "Juan"],
      ["people", "link", "Juan", "--speaker", "a", "--angle", "g:a"],
      ["people", "link", "Juan", "--angle", "onlyone"],
      ["people", "link", "Juan", "--face", "assets/a.mp4"],
      ["people", "link", "Juan", "--face", "assets/a.mp4@1:2,0.5"],
      ["people", "list", "--speaker", "x"],
      ["people", "frobnicate"],
      ["people", "suggest", "extra"],
      ["people", "confirm"],
      ["people", "confirm", "nope"],
      ["people", "list", "--reject"],
      ["clip", "remove", "c_1", "--angle", "x"],
    ]) {
      expect(frameshell(args).code, args.join(" ")).toBe(2);
    }
  });

  it("starts empty, adds people and lists them", () => {
    expect(frameshell(["people", "list"]).stdout).toContain("No people yet");
    const added = frameshell(["people", "add", "Juan"]);
    expect(added.code).toBe(0);
    expect(added.stdout).toMatch(/^Added Juan \(p_[0-9a-f]{6}\)\n$/);
    expect(frameshell(["people", "add", "juan"]).code).toBe(1);
    const listed = JSON.parse(frameshell(["people", "list", "--json"]).stdout) as { people: { id: string; name: string }[] };
    expect(listed.people.map((person) => person.name)).toEqual(["Juan"]);
    expect(frameshell(["people", "list"]).stdout).toMatch(/^Juan \(p_[0-9a-f]{6}\)\n {2}no links\n$/);
  });

  it("links a speaker (path from the working directory), writes the name, renames, lists and marks missing links", () => {
    const linked = frameshell(["people", "link", "Juan", "--speaker", "transcripts/ep1.words.json:s1"]);
    expect(linked.code).toBe(0);
    expect(linked.stdout).toContain("Linked speaker s1 of transcripts/ep1.words.json to Juan");
    expect(linked.stdout).toContain("speaker name written in transcripts/ep1.words.json");
    expect(speakerName("ep1.words.json")).toBe("Juan");
    expect(frameshell(["people", "link", "Juan", "--speaker", "ep2.words.json:s1"], join(project, "transcripts")).code).toBe(0);
    expect(speakerName("ep2.words.json")).toBe("Juan");
    expect(frameshell(["people", "link", "Juan", "--speaker", "transcripts/ep1.words.json:s1"]).stdout).toContain("Already linked");

    const renamed = frameshell(["people", "rename", "Juan", "Juan", "Pérez"]);
    expect(renamed.code).toBe(0);
    expect(renamed.stdout).toContain("Renamed Juan to Juan Pérez");
    expect(speakerName("ep1.words.json")).toBe("Juan Pérez");

    rmSync(join(project, "transcripts", "ep2.words.json"));
    const list = frameshell(["people", "list"]).stdout;
    expect(list).toContain("speaker  transcripts/ep1.words.json:s1\n");
    expect(list).toMatch(/speaker {2}transcripts\/ep2\.words\.json:s1 {2}MISSING: .*does not exist/);
    expect(list).toContain("1 link missing");
    const json = JSON.parse(frameshell(["people", "list", "--json"]).stdout) as { people: { speakers: { missing: boolean }[] }[] };
    expect(json.people[0]!.speakers.map((link) => link.missing)).toEqual([false, true]);
  });

  it("refuses a target that is not there, then unlinks and removes", () => {
    const person = JSON.parse(frameshell(["people", "list", "--json"]).stdout).people[0].id as string;
    const absent = frameshell(["people", "link", "Juan Pérez", "--angle", "main:g_none:ana"]);
    expect(absent.code).toBe(1);
    expect(absent.stderr).toContain("timeline main");
    expect(frameshell(["people", "link", person, "--face", "assets/none.mp4@3:0.2,0.8"]).code).toBe(1);

    const unlinked = frameshell(["people", "unlink", person, "--speaker", "transcripts/ep2.words.json:s1"]);
    expect(unlinked.code).toBe(0);
    expect(unlinked.stdout).toContain("Unlinked speaker s1 of transcripts/ep2.words.json from Juan Pérez");
    expect(frameshell(["people", "unlink", person, "--speaker", "transcripts/ep2.words.json:s1"]).code).toBe(1);
    expect(frameshell(["people", "remove", "Juan Pérez"]).stdout).toMatch(/^Removed Juan Pérez \(p_[0-9a-f]{6}\) and 1 link\n$/);
    expect(frameshell(["people", "list"]).stdout).toContain("No people yet");
    expect(frameshell(["people", "remove", "Juan Pérez"]).code).toBe(1);
  });

  it("suggests nothing while no person has a voice, says why, and refuses an unknown suggestion", () => {
    const suggest = frameshell(["people", "suggest"]);
    expect(suggest.code).toBe(0);
    expect(suggest.stdout).toMatch(/^No suggestions\.\n\nhint: No person has a linked transcript speaker yet/);
    const confirm = frameshell(["people", "confirm", "sg_00000000", "--reject"]);
    expect(confirm.code).toBe(1);
    expect(confirm.stderr).toContain("no current suggestion sg_00000000");
  });
});
