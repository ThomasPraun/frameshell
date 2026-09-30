import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeClip } from "../../core/test/media-fixtures.js";
import { testBinariesDir } from "../../core/test/media-tools.js";
import { connectOrStartDaemon } from "../src/daemon-client.js";

// Black-box: built CLI, auto-started daemon, a project with one imported synthetic asset.
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-timeline-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-tl-${randomUUID().slice(0, 8)}.sock`);

/** Environment of the CLI and of the daemon it spawns. */
function cliEnv(session?: string): NodeJS.ProcessEnv {
  const { FRAMESHELL_SESSION: _inherited, ...inherited } = process.env;
  return {
    ...inherited,
    ...(session ? { FRAMESHELL_SESSION: session } : {}),
    FRAMESHELL_SOCKET: socketPath,
    FRAMESHELL_IDLE_TIMEOUT_MS: "1500",
    FRAMESHELL_DATA_DIR: testBinariesDir(),
    FRAMESHELL_CONFIG_DIR: testBinariesDir(),
  };
}

function frameshell(args: string[], cwd = project, session?: string) {
  const result = spawnSync(process.execPath, [cliBin, ...args], { cwd, encoding: "utf8", env: cliEnv(session) });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Run and parse `--json` output, failing loudly with stderr. */
function json<T = Record<string, unknown>>(args: string[], session?: string): T {
  const result = frameshell([...args, "--json"], project, session);
  if (result.code !== 0) throw new Error(`frameshell ${args.join(" ")} exited ${result.code}: ${result.stderr}`);
  return JSON.parse(result.stdout) as T;
}

const onDisk = () => JSON.parse(readFileSync(join(project, "timelines", "main.json"), "utf8"));

let project: string;
let daemonPid: number | undefined;

beforeAll(async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-timeline-")));
  project = join(parent, "talk");
  expect(frameshell(["init", project], parent).code).toBe(0);
  const footage = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-footage-")));
  await makeClip(join(footage, "take.mp4"), { durationS: 2 });
  // No --wait: timeline edits must not wait for proxies (the asset is probed on demand).
  expect(frameshell(["import", join(footage, "take.mp4")]).code).toBe(0);
  daemonPid = json<{ daemon: { pid: number } }>(["status"]).daemon.pid;
}, 120_000);

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

describe("frameshell timeline editing", () => {
  let video = "";
  let audio = "";
  let clip = "";

  it("adds tracks, printing each new revision", () => {
    const added = frameshell(["track", "add", "video", "--name", "Camera"]);
    expect(added.code).toBe(0);
    expect(added.stdout).toMatch(/^track\.add: added t_[0-9a-f]{6}\nrevision 1 · op op_[0-9a-f]{8} · tx tx_[0-9a-f]{8}\n$/);
    audio = json<{ changes: { added: string[] }; revision: number }>(["track", "add", "audio"]).changes.added[0]!;
    const list = json<{ tracks: { id: string; kind: string; name: string | null }[] }>(["track", "list"]);
    expect(list.tracks.map((t) => [t.kind, t.name])).toEqual([
      ["video", "Camera"],
      ["audio", null],
    ]);
    video = list.tracks[0]!.id;
    expect(onDisk().revision).toBe(2);
  });

  it("adds a clip with times snapped to the 30 fps grid (3 decimals) and writes the file", () => {
    const result = json<{ revision: number; changes: { added: string[] }; operation: Record<string, unknown> }>([
      "clip", "add", video, "assets/take.mp4", "--start", "0.01", "--in", "0.51", "--out", "1.74",
    ]);
    expect(result.revision).toBe(3);
    clip = result.changes.added[0]!;
    expect(clip).toMatch(/^c_[0-9a-f]{6}$/);
    expect(result.operation).toMatchObject({ op: "clip.add", author: expect.stringMatching(/^cli:sh-/), tx: expect.stringMatching(/^tx_/), revisionBefore: 2, inverse: { op: "timeline.patch" } });
    const track = onDisk().tracks[0];
    expect(track.clips).toEqual([{ id: clip, type: "media", asset: "assets/take.mp4", start: 0, in: 0.5, out: 1.733 }]);
  });

  it("rejects an overlap and an out past the source with the valid range, leaving the file untouched", () => {
    const overlap = frameshell(["clip", "add", video, "assets/take.mp4", "--start", "1"]);
    expect(overlap.code).toBe(1);
    expect(overlap.stderr).toMatch(/would overlap on track .*start the later one at 1\.233 or after/);

    const tooLong = frameshell(["clip", "add", audio, "assets/take.mp4", "--out", "5", "--json"]);
    expect(tooLong.code).toBe(1);
    const error = JSON.parse(tooLong.stderr).error;
    expect(error.message).toMatch(/out 5 is past the end of assets\/take\.mp4 \(2 s/);
    expect(error.data).toMatchObject({ op: "clip.add", field: "out", valid: { min: 0.033, max: 2 } });
    expect(onDisk().revision).toBe(3);
  });

  it("splits, trims, sets, moves and cuts, bumping the revision each time", () => {
    const split = frameshell(["clip", "split", clip, "--at", "0.5"]);
    expect(split.stdout).toMatch(/clip\.split: added c_\w+ · updated c_\w+ · 0–1\.233 s\nrevision 4/);
    expect(frameshell(["clip", "trim", clip, "--in", "0.6", "--no-snap"]).stdout).toMatch(/revision 5/);
    expect(frameshell(["clip", "set", clip, "--gain=-6", "--opacity", "0.5"]).stdout).toMatch(/revision 6/);
    expect(frameshell(["clip", "add", audio, "assets/take.mp4"]).stdout).toMatch(/revision 7/);
    expect(frameshell(["cut", "--from", "0.2", "--to", "0.4", "--no-snap"]).stdout).toMatch(/revision 8/);
    expect(frameshell(["clip", "move", clip, "--start", "3"]).stdout).toMatch(/revision 9/);

    const view = json<{ revision: number; fps: number; duration: number; tracks: { clips: Record<string, unknown>[] }[] }>([
      "timeline", "show",
    ]);
    expect(view).toMatchObject({ revision: 9, fps: 30 });
    // Cut [0.2, 0.4) split the trimmed clip (0.1–0.5) and shifted the split-off right part left by 0.2.
    expect(view.tracks[0]!.clips).toEqual([
      expect.objectContaining({ start: 0.2, end: 0.3, in: 0.9, out: 1 }),
      expect.objectContaining({ start: 0.3, end: 1.033, in: 1, out: 1.733 }),
      expect.objectContaining({ id: clip, start: 3, end: 3.1, in: 0.6, out: 0.7, audio: { gain: -6 }, transform: { opacity: 0.5 } }),
    ]);
    expect(view.tracks[1]!.clips).toEqual([
      expect.objectContaining({ start: 0, end: 0.2, in: 0, out: 0.2 }),
      expect.objectContaining({ start: 0.2, end: 1.8, in: 0.4, out: 2 }),
    ]);
    expect(view.duration).toBe(3.1);

    const human = frameshell(["timeline", "show"]).stdout;
    expect(human).toMatch(/^Timeline main · revision 9 · 30 fps · 3\.1 s\n/);
    expect(human).toContain(`  ${clip}  media assets/take.mp4  3–3.1  in 0.6 out 0.7`);
  });

  it("guards track removal and names what is missing", () => {
    const refused = frameshell(["track", "remove", video]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/has 3 clip\(s\).*--force/);
    const missing = frameshell(["clip", "remove", "c_nope"]);
    expect(missing.stderr).toMatch(/no clip "c_nope".*timeline show/);
    const noTimeline = frameshell(["timeline", "show", "--timeline", "intro"]);
    expect(noTimeline.code).toBe(1);
    expect(noTimeline.stderr).toMatch(/No timeline "intro" \(timelines\/intro\.json\).*timelines: main/);
    const removed = frameshell(["track", "remove", video, "--force"]);
    expect(removed.stdout).toMatch(/removed .*revision 10/s);
  });

  it("stays readable and editable when a nested timeline file goes missing", () => {
    // intro = a copy of main (its audio clips end at 1.8 s).
    const introPath = join(project, "timelines", "intro.json");
    writeFileSync(introPath, JSON.stringify({ ...onDisk(), id: "intro" }));
    const track = json<{ changes: { added: string[] } }>(["track", "add", "video"]).changes.added[0]!;
    const nested = json<{ changes: { added: string[] } }>(["clip", "add", track, "--type", "timeline", "--source", "intro", "--start", "10"])
      .changes.added[0]!;
    renameSync(introPath, join(project, "intro.bak"));

    const human = frameshell(["timeline", "show"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("· duration unknown\n");
    expect(human.stdout).toContain(`  ${nested}  timeline timelines/intro.json  10–?`);
    expect(human.stdout).toContain(
      `Problems (1):\n  clip ${nested} on track ${track} of timeline main nests timelines/intro.json, but its length is unknown: ` +
        `timelines/intro.json does not exist. Restore timelines/intro.json (existing timelines: main), ` +
        `or remove the clip: \`frameshell clip remove ${nested}\`.\n`,
    );
    const view = json<{ duration: number | null; problems: { clip: string; track: string }[] }>(["timeline", "show"]);
    expect(view.duration).toBeNull();
    expect(view.problems).toMatchObject([{ clip: nested, track, source: "timelines/intro.json" }]);
    const tracks = frameshell(["track", "list"]);
    expect(tracks.code).toBe(0);
    expect(tracks.stdout).toContain(`  ${track}  video  1 clip(s), end unknown`);

    // Edits that need its length name it and the fix; edits that do not, work.
    const split = frameshell(["clip", "split", nested, "--at", "11"]);
    expect(split.code).toBe(1);
    expect(split.stderr).toContain(`clip ${nested} on track ${track}`);
    expect(split.stderr).toContain(`\`frameshell clip remove ${nested}\``);
    expect(frameshell(["cut", "--from", "7", "--to", "8"]).code).toBe(0);
    const removed = frameshell(["clip", "remove", nested]);
    expect(removed.stdout).toMatch(new RegExp(`clip\\.remove: removed ${nested} · 9–\\? s\\n`));
    expect(json<{ problems: unknown[] }>(["timeline", "show"]).problems).toEqual([]);
  });

  it("exits 2 with a precise message on bad arguments", () => {
    const noAt = frameshell(["clip", "split", "c_x"]);
    expect(noAt.code).toBe(2);
    expect(noAt.stderr).toMatch(/needs --at <seconds>/);
    const notNumber = frameshell(["clip", "move", "c_x", "--start", "soon"]);
    expect(notNumber.code).toBe(2);
    expect(notNumber.stderr).toMatch(/--start: expected a number, got "soon"/);
    const wrongFlag = frameshell(["track", "list", "--force"]);
    expect(wrongFlag.code).toBe(2);
    expect(wrongFlag.stderr).toMatch(/does not take --force/);
    const badSpeed = frameshell(["clip", "set", "c_x", "--speed", "0"]);
    expect(badSpeed.code).toBe(1);
    expect(badSpeed.stderr).toMatch(/params\.speed/);
  });
});

describe("frameshell tx, history and revert", () => {
  type Op = { revision: number; operation: { id: string; tx: string; author: string } };

  it("groups an agent's labelled transaction, shows a later edit with --since, and reverts the transaction", () => {
    const names = () => json<{ tracks: { name: string | null }[] }>(["track", "list"]).tracks.map((t) => t.name);
    const before = names();
    const begun = frameshell(["tx", "begin", "add overlays"], project, "agent");
    expect(begun.stdout).toMatch(/^Began (tx_[0-9a-f]{8}) "add overlays"\n$/);
    const tx = /tx_[0-9a-f]{8}/.exec(begun.stdout)![0];
    const first = json<Op>(["track", "add", "video", "--name", "Overlay 1"], "agent");
    json<Op>(["track", "add", "video", "--name", "Overlay 2"], "agent");
    expect(first.operation).toMatchObject({ tx, author: "cli:agent" });
    expect(frameshell(["tx", "commit"], project, "agent").stdout).toBe(`Committed ${tx} "add overlays" (2 operations)\n`);

    const human = json<Op>(["track", "add", "audio", "--name", "Music"], "human");
    const since = json<{ transactions: { author: string; operations: { id: string; op: string }[] }[] }>(["history", "--since", tx]);
    expect(since.transactions).toEqual([
      expect.objectContaining({ author: "cli:human", operations: [expect.objectContaining({ id: human.operation.id, op: "track.add" })] }),
    ]);
    const listing = frameshell(["history"]).stdout;
    expect(listing).toContain(`${tx}  cli:agent "add overlays"  2 ops`);
    expect(listing).toContain(`  ${first.operation.id}  track.add`);

    const reverted = frameshell(["revert", tx], project, "agent");
    expect(reverted.code).toBe(0);
    expect(reverted.stdout).toMatch(new RegExp(`^revert: removed t_\\w+, t_\\w+\\nrevision ${human.revision + 1} · op op_\\w+ · tx tx_\\w+\\n$`));
    expect(names()).toEqual([...before, "Music"]);
  });

  it("runs a transaction without FRAMESHELL_SESSION in the shell's generated session, and rejects unknown ids", () => {
    const begun = frameshell(["tx", "begin", "no session"]);
    expect(begun.code).toBe(0);
    const tx = /tx_[0-9a-f]{8}/.exec(begun.stdout)![0];
    const added = json<Op>(["track", "add", "video", "--name", "Scratch"]);
    expect(added.operation).toMatchObject({ tx, author: expect.stringMatching(/^cli:sh-/) });
    expect(frameshell(["tx", "abort"]).code).toBe(0);
    const unknown = frameshell(["revert", "tx_00000000"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/No transaction tx_00000000 in the history of timeline main/);
    const usage = frameshell(["tx", "commit", "--timeline", "intro"]);
    expect(usage.code).toBe(2);
  });
});

describe("direct edits of the timeline file", () => {
  it("status reports a stale edit the daemon rejected, and where the edit was kept", async () => {
    // Only a daemon that read the file before the edit can call it stale. The CLI's daemon exits after 1.5 s
    // idle, and slow runners (Windows) can pass that between two CLI runs: a fresh daemon would take the
    // stale file as its first sight. A held connection keeps this daemon alive and makes it read the file.
    const hold = await connectOrStartDaemon({ socketPath, client: "test/hold", env: cliEnv() });
    try {
      await hold.request("timeline.show", { cwd: project, timeline: "main" });
      const current = onDisk();
      writeFileSync(join(project, "timelines", "main.json"), JSON.stringify({ ...current, revision: current.revision - 1, tracks: [] }));
      type Status = { rejections: { timeline: string; reason: string; preserved: string; revision: number; current: number }[] };
      let status = json<Status>(["status"]);
      for (let i = 0; i < 100 && status.rejections.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        status = json<Status>(["status"]);
      }
      expect(status.rejections).toMatchObject([
        { timeline: "main", reason: "stale", revision: current.revision - 1, current: current.revision },
      ]);
      expect(onDisk()).toEqual(current);
      const human = frameshell(["status"]).stdout;
      expect(human).toContain("Rejected direct edits (1):");
      expect(human).toContain(
        `main: stale (revision ${current.revision - 1}, current ${current.revision}), kept at ${status.rejections[0]!.preserved}`,
      );
    } finally {
      hold.close();
    }
  });
});
