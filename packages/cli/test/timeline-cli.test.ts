import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

  it("restores cut material: --ripple extends a clip or inserts one, pushing later clips instead of overlapping them", () => {
    type View = { tracks: { id: string; clips: { id: string; start: number; end: number; in: number; out: number }[] }[] };
    const clipsOf = () => json<View>(["timeline", "show"]).tracks.find((t) => t.id === audio)!.clips;
    const [first, second] = clipsOf();
    expect(frameshell(["clip", "trim", first!.id, "--out", "0.3", "--no-snap"]).stderr).toMatch(/overlap/);
    expect(frameshell(["clip", "trim", first!.id, "--out", "0.3", "--ripple", "--no-snap"]).code).toBe(0);
    expect(clipsOf()).toEqual([
      expect.objectContaining({ id: first!.id, start: 0, end: 0.3, out: 0.3 }),
      expect.objectContaining({ id: second!.id, start: 0.3 }),
    ]);
    const inserted = json<{ changes: { added: string[] }; snaps: { field: string }[] }>([
      "clip", "add", audio, "assets/take.mp4", "--start", "0.3", "--in", "1", "--out", "1.2", "--ripple", "--snap",
    ]);
    const added = clipsOf().find((c) => c.id === inserted.changes.added[0])!;
    expect(added.start).toBe(0.3);
    expect(clipsOf().find((c) => c.id === second!.id)!.start).toBe(added.end);
    expect(frameshell(["clip", "move", first!.id, "--ripple"]).code).toBe(2);
  });

  it("--ripple-track limits a ripple to the clip's own track plus the named ones (#131)", () => {
    type View = { tracks: { id: string; clips: { id: string; start: number; end: number }[] }[] };
    const clipsOf = (track: string) => json<View>(["timeline", "show"]).tracks.find((t) => t.id === track)!.clips;
    const other = json<{ changes: { added: string[] } }>(["track", "add", "audio"]).changes.added[0]!;
    const music = json<{ changes: { added: string[] } }>([
      "clip", "add", other, "assets/take.mp4", "--start", "5", "--in", "0", "--out", "0.5",
    ]).changes.added[0]!;
    const [first, next] = clipsOf(audio);
    const nextStart = next!.start;

    // Own track only: the other track's clip stays.
    expect(frameshell(["clip", "trim", first!.id, "--out", "0.4", "--ripple", "--ripple-track", audio, "--no-snap"]).code).toBe(0);
    expect(clipsOf(audio).find((c) => c.id === next!.id)!.start).toBeCloseTo(nextStart + 0.1, 6);
    expect(clipsOf(other)).toEqual([expect.objectContaining({ id: music, start: 5 })]);
    // Without it, every track moves; naming the other track moves it too.
    expect(frameshell(["clip", "trim", first!.id, "--out", "0.5", "--ripple", "--no-snap"]).code).toBe(0);
    expect(clipsOf(other)[0]!.start).toBeCloseTo(5.1, 6);
    expect(frameshell(["clip", "trim", first!.id, "--out", "0.6", "--ripple", "--ripple-track", other, "--no-snap"]).code).toBe(0);
    expect(clipsOf(other)[0]!.start).toBeCloseTo(5.2, 6);

    const alone = frameshell(["clip", "trim", first!.id, "--out", "0.7", "--ripple-track", other]);
    expect(alone.code).toBe(2);
    expect(alone.stderr).toMatch(/--ripple-track needs --ripple/);
    const unknown = frameshell(["clip", "add", audio, "assets/take.mp4", "--start", "0", "--in", "1", "--out", "1.1", "--ripple", "--ripple-track", "t_nope"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/t_nope/);
  });

  it("exits 2 with a precise message on bad arguments", () => {
    const noAt = frameshell(["clip", "split", "c_x"]);
    expect(noAt.code).toBe(2);
    expect(noAt.stderr).toMatch(/needs --at <seconds\|marker>/);
    const notNumber = frameshell(["clip", "trim", "c_x", "--in", "soon"]);
    expect(notNumber.code).toBe(2);
    expect(notNumber.stderr).toMatch(/--in: expected a number, got "soon"/);
    // Timeline times take marker names (TimeRef, ADR 0037): "soon" reaches the daemon, which knows no such marker.
    const notMarker = frameshell(["clip", "move", "c_x", "--start", "soon"]);
    expect(notMarker.code).toBe(1);
    expect(notMarker.stderr).toMatch(/clip\.move: start: "soon" is neither seconds nor a marker/);
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

describe("subtitle tracks", () => {
  it("adds a subtitle track with a style, changes its style, and lists it", () => {
    writeFileSync(
      join(project, "timelines", "subs.json"),
      JSON.stringify({ schemaVersion: 1, id: "subs", revision: 0, tracks: [{ id: "v1", kind: "video", clips: [] }] }),
    );
    const added = json<{ changes: { added: string[] } }>(["track", "add", "subtitles", "--follows", "v1", "--preset", "plain", "--timeline", "subs"]);
    const track = added.changes.added[0]!;
    const set = frameshell(["track", "set", track, "--position", "top", "--name", "Captions", "--timeline", "subs"]);
    expect(set.code).toBe(0);
    expect(set.stdout).toMatch(new RegExp(`^track\\.set: updated ${track}\\nrevision 2 `));
    const subs = () => JSON.parse(readFileSync(join(project, "timelines", "subs.json"), "utf8"));
    expect(subs().tracks[1]).toEqual({ id: track, kind: "subtitles", name: "Captions", follows: "v1", style: { preset: "plain", position: "top" } });
    expect(frameshell(["track", "list", "--timeline", "subs"]).stdout).toContain(`${track}  subtitles "Captions"  follows v1, plain at the top`);

    expect(frameshell(["track", "set", track, "--preset", "big-keyword", "--clear-name", "--timeline", "subs"]).code).toBe(0);
    expect(subs().tracks[1]).toEqual({ id: track, kind: "subtitles", follows: "v1", style: { preset: "big-keyword", position: "top" } });
    const bad = frameshell(["track", "set", track, "--position", "left", "--timeline", "subs"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/position.*top.*center.*bottom/);
    expect(frameshell(["track", "set", track, "--name", "x", "--clear-name", "--timeline", "subs"]).code).toBe(2);
  });

  it("sets entry and keyword tokens and gaps; --keyword-color none and --clear-gaps undo them", () => {
    const subs = () => JSON.parse(readFileSync(join(project, "timelines", "subs.json"), "utf8"));
    const track = subs().tracks[1].id as string;
    expect(frameshell(["track", "set", track, "--entry", "words", "--keyword-color", "#ff8800", "--keyword-scale", "1.2", "--gap", "1-2.5", "--gap", "4-5", "--timeline", "subs"]).code).toBe(0);
    expect(subs().tracks[1]).toMatchObject({ style: { entry: "words", keywordColor: "#ff8800", keywordScale: 1.2 }, gaps: [{ from: 1, to: 2.5 }, { from: 4, to: 5 }] });
    expect(frameshell(["track", "set", track, "--keyword-color", "none", "--clear-gaps", "--timeline", "subs"]).code).toBe(0);
    expect(subs().tracks[1].style.keywordColor).toBeNull();
    expect(subs().tracks[1].gaps).toBeUndefined();
    expect(frameshell(["track", "set", track, "--gap", "soon", "--timeline", "subs"]).code).toBe(2);
    expect(frameshell(["track", "set", track, "--entry", "wobble", "--timeline", "subs"]).code).toBe(1);
  });

  it("captions set needs its text, and not both text and file", () => {
    expect(frameshell(["captions", "set", "t_x", "--timeline", "subs"]).code).toBe(2);
    expect(frameshell(["captions", "set", "t_x", "--text", "a", "--file", "b.txt", "--timeline", "subs"]).code).toBe(2);
    expect(frameshell(["clip", "add", "v1", "--text", "x"]).code).toBe(2);
  });

  it("captions set takes --text, which cover also uses", () => {
    const track = JSON.parse(readFileSync(join(project, "timelines", "subs.json"), "utf8")).tracks[1].id as string;
    const set = frameshell(["captions", "set", track, "--text", "No need to | *editor*", "--timeline", "subs"]);
    // Reaches the daemon (no words to caption here) instead of failing as a usage error.
    expect(set.stderr).toMatch(/shows no words/);
    expect(set.code).toBe(1);
  });
});

describe("track mute and hide", () => {
  it("track set --muted/--hidden store the state, track list and timeline show print it, --unmuted/--shown clear it", () => {
    writeFileSync(
      join(project, "timelines", "states.json"),
      JSON.stringify({ schemaVersion: 1, id: "states", revision: 0, tracks: [{ id: "v1", kind: "video", clips: [] }, { id: "a1", kind: "audio", clips: [] }] }),
    );
    const states = () => JSON.parse(readFileSync(join(project, "timelines", "states.json"), "utf8"));
    expect(frameshell(["track", "set", "v1", "--muted", "--hidden", "--timeline", "states"]).code).toBe(0);
    expect(states().tracks[0]).toEqual({ id: "v1", kind: "video", muted: true, hidden: true, clips: [] });
    expect(frameshell(["track", "list", "--timeline", "states"]).stdout).toContain("v1  video  0 clip(s), ends 0 s  muted  hidden");
    expect(frameshell(["timeline", "show", "--timeline", "states"]).stdout).toContain("v1  video  muted  hidden");
    expect(frameshell(["track", "set", "v1", "--unmuted", "--shown", "--timeline", "states"]).code).toBe(0);
    expect(states().tracks[0]).toEqual({ id: "v1", kind: "video", clips: [] });
    const audio = frameshell(["track", "set", "a1", "--hidden", "--timeline", "states"]);
    expect(audio.code).toBe(1);
    expect(audio.stderr).toMatch(/audio tracks have no picture to hide/);
    expect(frameshell(["track", "set", "v1", "--muted", "--unmuted", "--timeline", "states"]).code).toBe(2);
    expect(frameshell(["track", "set", "v1", "--hidden", "--shown", "--timeline", "states"]).code).toBe(2);
  });

  it("track set --behind <plate> puts a track behind a lower video track's subject, list and show print it, --behind none clears it", () => {
    writeFileSync(
      join(project, "timelines", "behind.json"),
      JSON.stringify({ schemaVersion: 1, id: "behind", revision: 0, tracks: [{ id: "v1", kind: "video", clips: [] }, { id: "v2", kind: "video", clips: [] }] }),
    );
    const tracks = () => JSON.parse(readFileSync(join(project, "timelines", "behind.json"), "utf8")).tracks;
    expect(frameshell(["track", "set", "v2", "--behind", "v1", "--timeline", "behind"]).code).toBe(0);
    expect(tracks()[1]).toEqual({ id: "v2", kind: "video", behind: "v1", clips: [] });
    expect(frameshell(["track", "list", "--timeline", "behind"]).stdout).toContain("v2  video  0 clip(s), ends 0 s  behind v1");
    expect(frameshell(["timeline", "show", "--timeline", "behind"]).stdout).toContain("v2  video  behind v1");
    const above = frameshell(["track", "set", "v1", "--behind", "v2", "--timeline", "behind"]);
    expect(above.code).toBe(1);
    expect(above.stderr).toMatch(/v2 is above v1; it must be lower/);
    expect(frameshell(["track", "set", "v2", "--behind", "none", "--timeline", "behind"]).code).toBe(0);
    expect(tracks()[1]).toEqual({ id: "v2", kind: "video", clips: [] });
  });
});

describe("transitions and keyframes", () => {
  it("transition set with only --at dissolves the edge, clip key animates, and bad flags exit 2", () => {
    const track = json<{ changes: { added: string[] } }>(["track", "add", "video", "--name", "Transitions"]).changes.added[0]!;
    const first = json<{ changes: { added: string[] } }>(["clip", "add", track, "assets/take.mp4", "--start", "20", "--in", "0.5", "--out", "1"]).changes.added[0]!;
    const second = json<{ changes: { added: string[] } }>(["clip", "add", track, "assets/take.mp4", "--start", "20.5", "--in", "1", "--out", "1.5"]).changes.added[0]!;
    const clips = () => onDisk().tracks.find((t: { id: string }) => t.id === track).clips;

    const dissolved = frameshell(["transition", "set", "--at", "20.5", "--track", track]);
    expect(dissolved.code).toBe(0);
    expect(dissolved.stdout).toContain("transition.set: updated");
    expect(clips()[1]).toMatchObject({ id: second, dissolve: 0.5 });

    expect(frameshell(["transition", "remove", "--at", "20.5", "--track", track]).code).toBe(0);
    expect(clips()[1]).not.toHaveProperty("dissolve");

    expect(frameshell(["transition", "set", "--at", "21", "--kind", "fade", "--duration", "0.4", "--track", track]).code).toBe(0);
    expect(clips()[1]).toMatchObject({ fadeOut: 0.4 });

    expect(frameshell(["clip", "key", first, "--prop", "scale", "--at", "20", "--value", "1"]).code).toBe(0);
    const keyed = frameshell(["clip", "key", first, "--prop", "scale", "--at", "20.4", "--value", "1.2", "--ease", "in-out"]);
    expect(keyed.code).toBe(0);
    expect(clips()[0].keys).toEqual({ scale: [{ at: 0.5, value: 1 }, { at: 0.9, value: 1.2, ease: "in-out" }] });
    expect(frameshell(["clip", "key", first, "--prop", "scale", "--clear"]).code).toBe(0);
    expect(clips()[0]).not.toHaveProperty("keys");

    expect(frameshell(["transition", "set"]).stderr).toMatch(/needs --at/);
    expect(frameshell(["clip", "key", first, "--prop", "x"]).code).toBe(2);
    expect(frameshell(["clip", "key", first, "--prop", "x", "--clear", "--at", "1"]).stderr).toMatch(/--clear removes every key/);
    expect(frameshell(["transition", "set", "--at", "1", "--prop", "x"]).code).toBe(2);
    expect(frameshell(["transition", "set", "--at", "20.7"]).stderr).toMatch(/no clip edge at 20.7 s/);
  });
});

describe("audio effects (ADR 0031)", () => {
  it("clip set --voice writes the voice chain as explicit entries, --audio-effects replaces it, --clear-audio-effects clears it", () => {
    const track = json<{ changes: { added: string[] } }>(["track", "add", "audio", "--name", "Voice"]).changes.added[0]!;
    const clip = json<{ changes: { added: string[] } }>(["clip", "add", track, "assets/take.mp4", "--start", "30", "--in", "0", "--out", "1"]).changes.added[0]!;
    const audio = () => onDisk().tracks.find((t: { id: string }) => t.id === track).clips[0].audio;

    expect(frameshell(["clip", "set", clip, "--voice", "--gain=-2"]).code).toBe(0);
    expect(audio()).toEqual({
      gain: -2,
      effects: [
        { kind: "highpass", frequency: 85 },
        { kind: "denoise", floor: -30, reduction: 8 },
        { kind: "compressor", threshold: -20, ratio: 2.5, attack: 8, release: 140, makeup: 2 },
      ],
    });
    expect(frameshell(["clip", "set", clip, "--audio-effects", '[{"kind":"highpass","frequency":120}]']).code).toBe(0);
    expect(audio()).toEqual({ gain: -2, effects: [{ kind: "highpass", frequency: 120 }] });
    expect(frameshell(["clip", "set", clip, "--clear-audio-effects"]).code).toBe(0);
    expect(audio()).toEqual({ gain: -2 });

    // The project's style.json (sound.voice) gives the chain; a number it leaves out stays the default.
    const stylePath = join(project, "style.json");
    writeFileSync(stylePath, JSON.stringify({ schemaVersion: 1, sound: { voice: { highpass: 100, compressor: { ratio: 3, attack: 0.012 } } } }));
    try {
      expect(frameshell(["clip", "set", clip, "--voice"]).code).toBe(0);
      expect(audio().effects).toEqual([
        { kind: "highpass", frequency: 100 },
        { kind: "denoise", floor: -30, reduction: 8 },
        { kind: "compressor", threshold: -20, ratio: 3, attack: 12, release: 140, makeup: 2 },
      ]);
      writeFileSync(stylePath, "{ not json");
      expect(frameshell(["clip", "set", clip, "--voice"]).code).toBe(1);
    } finally {
      rmSync(stylePath, { force: true });
    }
    expect(frameshell(["clip", "set", clip, "--clear-audio-effects"]).code).toBe(0);

    expect(frameshell(["clip", "set", clip, "--voice", "--clear-audio-effects"]).stderr).toMatch(/one of --voice, --audio-effects or --clear-audio-effects/);
    expect(frameshell(["clip", "set", clip, "--audio-effects", '{"kind":"highpass"}']).stderr).toMatch(/expected a JSON array/);
    expect(frameshell(["clip", "set", clip, "--audio-effects", '[{"kind":"highpass","frequency":2}]']).code).not.toBe(0);
  });

  it("clip add and clip set --audio-fade-in/--audio-fade-out set a media clip's audio fades in ms; 0 removes one (#585)", () => {
    const track = json<{ changes: { added: string[] } }>(["track", "add", "audio", "--name", "Phrases"]).changes.added[0]!;
    const added = json<{ changes: { added: string[] } }>(["clip", "add", track, "assets/take.mp4", "--start", "40", "--in", "0", "--out", "1", "--audio-fade-in", "12"]);
    const clip = added.changes.added[0]!;
    const audio = () => onDisk().tracks.find((t: { id: string }) => t.id === track).clips[0].audio;
    expect(audio()).toEqual({ fadeInMs: 12 });
    expect(frameshell(["clip", "set", clip, "--audio-fade-out", "12.5", "--audio-fade-in", "0"]).code).toBe(0);
    expect(audio()).toEqual({ fadeOutMs: 12.5 });
    expect(frameshell(["clip", "set", clip, "--audio-fade-out", "-3"]).code).not.toBe(0);
    expect(frameshell(["clip", "move", clip, "--audio-fade-in", "12"]).code).toBe(2);
  });

  it("the daemon bakes a clip's chain in the background for the preview, and gc sweeps it once no clip plays it", async () => {
    const track = json<{ changes: { added: string[] } }>(["track", "add", "audio", "--name", "Baked"]).changes.added[0]!;
    const clip = json<{ changes: { added: string[] } }>(["clip", "add", track, "assets/take.mp4", "--start", "40", "--in", "0", "--out", "1"]).changes.added[0]!;
    expect(frameshell(["clip", "set", clip, "--audio-effects", '[{"kind":"highpass","frequency":95}]']).code).toBe(0);
    const daemon = await connectOrStartDaemon({ socketPath, client: "test/bakes", env: cliEnv() });
    try {
      type Bakes = { bakes: { asset: string; clips: string[]; state: string; file: string | null; error: string | null }[] };
      let bakes = (await daemon.request("audio.bakes", { cwd: project, timeline: "main" })) as Bakes;
      for (let i = 0; i < 200 && bakes.bakes.some((bake) => bake.state !== "ready" && bake.state !== "failed"); i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        bakes = (await daemon.request("audio.bakes", { cwd: project, timeline: "main" })) as Bakes;
      }
      const ours = bakes.bakes.find((bake) => bake.clips.includes(clip))!;
      expect(ours).toMatchObject({ asset: "assets/take.mp4", state: "ready", error: null });
      expect(ours.file).toMatch(/^\.frameshell\/audio-fx\/[0-9a-f]{20}-[0-9a-f]{12}-x1\.pcm$/);

      expect(frameshell(["clip", "set", clip, "--clear-audio-effects"]).code).toBe(0);
      const swept = json<{ removed: { path: string; kind: string }[] }>(["gc"]);
      expect(swept.removed).toContainEqual(expect.objectContaining({ path: ours.file, kind: "audio-fx" }));
    } finally {
      daemon.close();
    }
  }, 60_000);
});

describe("markers (ADR 0029)", () => {
  it("marker add, set, list and remove; cut ripples them and removes those inside; bad flags exit 2", () => {
    writeFileSync(
      join(project, "timelines", "marked.json"),
      JSON.stringify({ schemaVersion: 1, id: "marked", revision: 0, tracks: [{ id: "v1", kind: "video", clips: [] }] }),
    );
    const on = ["--timeline", "marked"];
    const list = () => json<{ markers: { id: string; at: number; label: string; color?: string }[] }>(["marker", "list", ...on]).markers;
    expect(frameshell(["clip", "add", "v1", "assets/take.mp4", "--start", "0", ...on]).code).toBe(0);

    const added = frameshell(["marker", "add", "--at", "1.51", "--label", "hook", "--color", "red", ...on]);
    expect(added.code).toBe(0);
    expect(added.stdout).toMatch(/^marker\.add: added m_[0-9a-f]{6}\n/);
    const hook = list()[0]!.id;
    expect(frameshell(["marker", "add", "--at", "0.5", "--label", "intro", ...on]).code).toBe(0);
    const intro = list()[0]!.id;
    expect(frameshell(["marker", "list", ...on]).stdout).toBe(
      `Timeline marked · revision 3 · 2 markers:\n  ${intro}  0.5 s  intro\n  ${hook}  1.5 s  hook  (red)\n`,
    );
    expect(frameshell(["timeline", "show", ...on]).stdout).toContain(`Markers: ${intro} 0.5 "intro", ${hook} 1.5 "hook"`);

    expect(frameshell(["marker", "set", "HOOK", "--at", "1.8", "--label", "cta", "--clear-color", ...on]).code).toBe(0);
    expect(list()[1]).toEqual({ id: hook, at: 1.8, label: "cta" });
    const cut = frameshell(["cut", "--from", "0.2", "--to", "0.8", "--no-snap", ...on]);
    expect(cut.code).toBe(0);
    expect(cut.stdout).toMatch(/warning: removed marker "intro"/);
    expect(list()).toEqual([{ id: hook, at: 1.2, label: "cta" }]);
    expect(frameshell(["marker", "remove", hook, ...on]).code).toBe(0);
    expect(frameshell(["marker", "list", ...on]).stdout).toMatch(/has no markers/);

    expect(frameshell(["marker", "add", "--label", "x", ...on]).stderr).toMatch(/needs --at <seconds\|marker> and --label <label>/);
    expect(frameshell(["marker", "set", "x", "--color", "red", "--clear-color", ...on]).code).toBe(2);
    expect(frameshell(["marker", "remove", ...on]).code).toBe(2);
    expect(frameshell(["marker", "set", "nope", "--at", "1", ...on]).stderr).toMatch(/no marker "nope"/);
  });

  it("time flags take a marker id or label with an optional offset (TimeRef, ADR 0037)", () => {
    writeFileSync(
      join(project, "timelines", "named.json"),
      JSON.stringify({ schemaVersion: 1, id: "named", revision: 0, tracks: [{ id: "v1", kind: "video", clips: [] }] }),
    );
    const on = ["--timeline", "named"];
    const list = () => json<{ markers: { id: string; at: number; label: string }[] }>(["marker", "list", ...on]).markers;
    expect(frameshell(["clip", "add", "v1", "assets/take.mp4", "--start", "0", ...on]).code).toBe(0);
    expect(frameshell(["marker", "add", "--at", "1", "--label", "hook", ...on]).code).toBe(0);

    const cta = frameshell(["marker", "add", "--at", "hook+0.5", "--label", "cta", ...on]);
    expect(cta.code).toBe(0);
    expect(list().map((marker) => [marker.label, marker.at])).toEqual([
      ["hook", 1],
      ["cta", 1.5],
    ]);

    const cut = frameshell(["cut", "--from", "hook", "--to", "hook+0.3", "--no-snap", ...on]);
    expect(cut.code).toBe(0);
    expect(list().map((marker) => [marker.label, marker.at])).toEqual([
      ["hook", 1],
      ["cta", 1.2],
    ]);

    const unknown = frameshell(["cut", "--from", "drop", "--to", "3", ...on]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toMatch(/cut: from: "drop" is neither seconds nor a marker of timeline named/);
    expect(frameshell(["cut", "--from", "hook", "--to", "beat:4", ...on]).stderr).toMatch(/to: "beat:4": the timeline has no tempo/);
    expect(frameshell(["clip", "split", "c_x", "--at", "", ...on]).code).toBe(2);
  });
});

describe("tempo and --snap-to (ADR 0029)", () => {
  it("tempo set, show and clear; --snap-to lands each time on the nearest beat or bar; bad flags exit 2", () => {
    writeFileSync(
      join(project, "timelines", "scored.json"),
      JSON.stringify({ schemaVersion: 1, id: "scored", revision: 0, tracks: [{ id: "v1", kind: "video", clips: [] }] }),
    );
    const on = ["--timeline", "scored"];
    const stored = () => JSON.parse(readFileSync(join(project, "timelines", "scored.json"), "utf8")) as { tempo?: unknown };
    const markers = () => json<{ markers: { at: number; label: string }[] }>(["marker", "list", ...on]).markers.map((marker) => [marker.label, marker.at]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(frameshell(["clip", "add", "v1", "assets/take.mp4", "--start", "0", ...on]).code).toBe(0);

    expect(frameshell(["tempo", "show", ...on]).stdout).toMatch(/has no tempo. Set one: `frameshell tempo set --clip <music clip>`/);
    expect(frameshell(["marker", "add", "--at", "1.3", "--label", "early", "--snap-to", "beat", ...on]).stderr).toMatch(/snapTo: the timeline has no tempo/);

    const set = frameshell(["tempo", "set", "--bpm", "120", "--offset", "0.5", ...on]);
    expect(set.code).toBe(0);
    expect(set.stdout).toMatch(/^tempo\.set: /);
    expect(stored().tempo).toEqual({ bpm: 120, offset: 0.5 });
    const shown = frameshell(["tempo", "show", ...on]).stdout;
    expect(shown).toMatch(/tempo: bpm 120, offset 0.5/);
    expect(shown).toMatch(/120 BPM, bars of 4, \d+ beats, nominal/);
    expect(shown).toMatch(/bar starts: 0.5 2.5 4.5/);
    expect(shown).toMatch(/beats: 0.5 1 1.5 2/);
    expect(frameshell(["timeline", "show", ...on]).stdout).toMatch(/Tempo: bpm 120, offset 0.5 \(grid: `frameshell tempo show`\)/);

    expect(frameshell(["marker", "add", "--at", "1.3", "--label", "a", "--snap-to", "beat", ...on]).code).toBe(0);
    expect(frameshell(["marker", "add", "--at", "1.3", "--label", "b", "--snap-to", "bar", ...on]).code).toBe(0);
    expect(frameshell(["marker", "add", "--at", "a+0.2", "--label", "c", "--snap-to", "beat", ...on]).code).toBe(0);
    expect(markers()).toEqual([
      ["a", 1.5],
      ["b", 0.5],
      ["c", 1.5],
    ]);
    const cut = json<{ operation: { args: Record<string, unknown> } }>(["cut", "--from", "0.9", "--to", "2.1", "--snap-to", "beat", ...on]);
    expect(cut.operation.args).toMatchObject({ from: 1, to: 2, snap: false });

    expect(frameshell(["marker", "add", "--at", "1.2", "--label", "d", "--snap-to", "marker", ...on]).code).toBe(0);
    // The cut above removed a and c (inside 1-2 s); b at 0.5 s is the only marker in reach of 1.2 s.
    expect(markers()).toContainEqual(["d", 0.5]);
    // beat:N / bar:N count from 1 on the same grid: the second bar starts at 0.5 + 2 s.
    expect(frameshell(["marker", "add", "--at", "bar:2-0.5", "--label", "e", ...on]).code).toBe(0);
    expect(markers()).toContainEqual(["e", 2]);
    expect(frameshell(["marker", "add", "--at", "beat:0", "--label", "f", ...on]).stderr).toMatch(/before the first beat/);
    expect(frameshell(["cut", "--from", "0.9", "--to", "2.1", "--snap-to", "beat", "--snap-window", "1", ...on]).stderr).toMatch(/--snap-window does nothing with --snap-to/);
    expect(frameshell(["cut", "--from", "0.9", "--to", "2.1", "--snap-to", "beat", "--snap-window", "1", ...on]).code).toBe(2);

    expect(frameshell(["tempo", "clear", ...on]).code).toBe(0);
    expect(stored()).not.toHaveProperty("tempo");
    expect(frameshell(["tempo", "show", ...on]).stdout).toMatch(/has no tempo/);
    expect(frameshell(["marker", "add", "--at", "bar:2", "--label", "g", ...on]).stderr).toMatch(/"bar:2": the timeline has no tempo/);

    expect(frameshell(["marker", "add", "--at", "1", "--label", "x", "--snap-to", "nope", ...on]).code).toBe(2);
    expect(frameshell(["track", "list", "--snap-to", "beat", ...on]).code).toBe(2);
    expect(frameshell(["tempo", "set", ...on]).stderr).toMatch(/needs --clip <music clip> or --bpm <n>/);
    expect(frameshell(["tempo", "set", "--offset", "1", ...on]).code).toBe(2);
    expect(frameshell(["tempo", "set", "--bpm", "5", ...on]).code).not.toBe(0);
    expect(frameshell(["tempo", "set", "--clip", "c_none", ...on]).stderr).toMatch(/c_none/);
    expect(frameshell(["clip", "add", "v1", "assets/take.mp4", "--bpm", "100", ...on]).code).toBe(2);
  });
});

describe("per-format overrides (ADR 0027)", () => {
  it("clip set, clip key and track set with --format change one format only; --reset drops it", () => {
    expect(frameshell(["format", "add", "9x16"]).code).toBe(0);
    try {
      const track = json<{ changes: { added: string[] } }>(["track", "add", "video", "--name", "Lower thirds"]).changes.added[0]!;
      const clip = json<{ changes: { added: string[] } }>(["clip", "add", track, "assets/take.mp4", "--start", "40", "--in", "0", "--out", "1", "--y", "300"]).changes.added[0]!;
      const stored = () => onDisk().tracks.find((t: { id: string }) => t.id === track).clips[0];

      expect(frameshell(["clip", "set", clip, "--format", "9x16", "--y", "700", "--hidden"]).code).toBe(0);
      expect(stored()).toMatchObject({ transform: { y: 300 }, formats: { "9x16": { transform: { y: 700 }, hidden: true } } });
      expect(frameshell(["clip", "key", clip, "--format", "9x16", "--prop", "x", "--at", "40.5", "--value", "12"]).code).toBe(0);
      expect(stored().formats["9x16"].keys).toEqual({ x: [{ at: 0.5, value: 12 }] });
      expect(frameshell(["clip", "set", clip, "--format", "9x16", "--reset", "--shown"]).code).toBe(0);
      expect(stored()).not.toHaveProperty("formats");

      expect(frameshell(["clip", "set", clip, "--reset"]).stderr).toMatch(/--reset drops a format's override: pass --format/);
      expect(frameshell(["clip", "set", clip, "--format", "9x16", "--gain=-3"]).stderr).toMatch(/`gain` is shared by every format/);
      expect(frameshell(["clip", "set", clip, "--format", "4x5", "--y", "1"]).stderr).toMatch(/no format "4x5"/);

      const subs = json<{ changes: { added: string[] } }>(["track", "add", "subtitles", "--follows", track]).changes.added[0]!;
      expect(frameshell(["track", "set", subs, "--format", "9x16", "--position", "center"]).code).toBe(0);
      expect(onDisk().tracks.find((t: { id: string }) => t.id === subs)).toMatchObject({ formats: { "9x16": { style: { position: "center" } } } });
      expect(frameshell(["track", "remove", subs]).code).toBe(0);
      expect(frameshell(["track", "remove", track, "--force"]).code).toBe(0);
    } finally {
      frameshell(["format", "remove", "9x16"]);
    }
  });
});
