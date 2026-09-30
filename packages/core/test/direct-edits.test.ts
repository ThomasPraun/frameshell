import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorCode, type MediaProbe, RpcError } from "@frameshell/protocol";
import { createProjectConfig, createTimeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { TimelineService, type TimelineChange, type TimelineRejection } from "../src/timeline/service.js";
import { tempDir } from "./helpers.js";

// Seam under test: TimelineService.reconcile (what the daemon's watcher calls
// when a timeline file changes) and TimelineService.writeFile (`file.write` of
// a timeline), on a real project directory. Observed through the file on
// disk, `history`, `.frameshell/rejected/` and the onChanged/onRejected feeds.

const PROBE: MediaProbe = {
  duration: 10,
  format: "mov,mp4",
  video: { codec: "h264", width: 320, height: 240, fps: 30, vfr: false, still: false },
  audio: null,
};

function setup() {
  const root = tempDir();
  mkdirSync(join(root, "timelines"));
  writeFileSync(join(root, "frameshell.json"), JSON.stringify(createProjectConfig("Test")));
  const timeline = { ...createTimeline("main"), tracks: [{ id: "t_v", kind: "video", clips: [] }] };
  writeFileSync(join(root, "timelines", "main.json"), JSON.stringify(timeline));
  const changed: TimelineChange[] = [];
  const rejected: TimelineRejection[] = [];
  let next = 0;
  /** A fresh service on the same project: what a restarted daemon holds (nothing in memory). */
  const restart = () =>
    new TimelineService({
      probe: async () => PROBE,
      clipTypes: async () => new Map(),
      newId: (prefix) => `${prefix}_${++next}`,
      onChanged: (change) => changed.push(change),
      onRejected: (rejection) => rejected.push(rejection),
    });
  const timelines = restart();
  const path = join(root, "timelines", "main.json");
  const read = () => JSON.parse(readFileSync(path, "utf8"));
  /** Hand edit of the file on disk, as an editor or agent would do it. */
  const edit = (change: (timeline: ReturnType<typeof read>) => void) => {
    const timeline = read();
    change(timeline);
    writeFileSync(path, JSON.stringify(timeline, null, 2));
  };
  const addClip = (start: number) =>
    timelines.apply({
      root,
      cwd: root,
      timeline: "main",
      author: "cli:agent",
      tx: { id: `tx_0000000${start}`, label: null },
      request: { op: "clip.add", args: { track: "t_v", type: "media", asset: "assets/a.mp4", start, in: 0, out: 2 } },
    });
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "a.mp4"), "stub");
  return { root, path, timelines, restart, read, edit, addClip, changed, rejected };
}

async function rejection(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("direct edit with the current revision", () => {
  it("is journaled as a `file` operation with an inverse, bumps the revision and reports the change", async () => {
    const { root, timelines, read, edit, changed } = setup();
    await timelines.reconcile(root, "main");
    edit((timeline) => {
      timeline.tracks[0].name = "Camera";
    });

    await timelines.reconcile(root, "main");

    expect(read()).toMatchObject({ revision: 1, tracks: [{ id: "t_v", name: "Camera" }] });
    const history = await timelines.history(root, "main", {});
    expect(history.transactions).toHaveLength(1);
    expect(history.transactions[0]).toMatchObject({
      author: "file",
      operations: [{ op: "timeline.patch", author: "file", revisionBefore: 0, revision: 1, touched: ["t_v"] }],
    });
    expect(changed).toEqual([
      { root: expect.any(String), timeline: "main", revision: 1, author: "file", changes: expect.objectContaining({ updated: ["t_v"] }) },
    ]);

    // The inverse undoes it like any operation.
    await timelines.revert({
      root,
      cwd: root,
      timeline: "main",
      author: "ui",
      tx: { id: "tx_000000f1", label: null },
      target: history.transactions[0]!.tx,
    });
    expect(read().tracks[0].name).toBeUndefined();
  });
});

describe("direct edit with a stale revision", () => {
  it("is rejected: the daemon's version is restored, the edit kept under .frameshell/rejected/ and reported", async () => {
    const { root, path, timelines, read, edit, addClip, changed, rejected } = setup();
    await addClip(0); // revision 1
    const daemonVersion = readFileSync(path, "utf8");
    edit((timeline) => {
      timeline.revision = 0; // edited from a copy read before the clip was added
      timeline.tracks[0].clips = [];
    });
    const incoming = readFileSync(path, "utf8");

    await timelines.reconcile(root, "main");

    expect(readFileSync(path, "utf8")).toBe(daemonVersion);
    const kept = readdirSync(join(root, ".frameshell", "rejected"));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-main\.json$/);
    expect(readFileSync(join(root, ".frameshell", "rejected", kept[0]!), "utf8")).toBe(incoming);
    expect(rejected).toEqual([
      {
        root: expect.any(String),
        timeline: "main",
        reason: "stale",
        message: expect.stringMatching(/revision 0.*revision 1/),
        preserved: `.frameshell/rejected/${kept[0]}`,
        revision: 0,
        current: 1,
        at: expect.any(String),
      },
    ]);
    expect(await timelines.rejections(root)).toEqual(rejected.map(({ root: _root, ...listed }) => listed));
    // Nothing journaled or announced beyond the clip.add.
    expect(changed.map((change) => change.author)).toEqual(["cli:agent"]);
    expect((await timelines.history(root, "main", {})).transactions).toHaveLength(1);
    expect(read().revision).toBe(1);
  });

  it("is also rejected when the edit raised the revision itself", async () => {
    const { root, timelines, read, edit, rejected } = setup();
    await timelines.reconcile(root, "main");
    edit((timeline) => {
      timeline.revision += 1;
      timeline.tracks[0].name = "Camera";
    });
    await timelines.reconcile(root, "main");
    expect(rejected.map((r) => [r.reason, r.revision, r.current])).toEqual([["stale", 1, 0]]);
    expect(read()).toMatchObject({ revision: 0, tracks: [{ id: "t_v" }] });
    expect(read().tracks[0].name).toBeUndefined();
  });

  it("is taken in before the next operation, even when the watcher has not reported it yet", async () => {
    const { path, edit, addClip, rejected } = setup();
    await addClip(0);
    edit((timeline) => {
      timeline.revision = 0;
    });
    const result = await addClip(4);
    expect(rejected).toHaveLength(1);
    expect(result.revision).toBe(2);
    expect(JSON.parse(readFileSync(path, "utf8")).tracks[0].clips).toHaveLength(2);
  });
});

describe("direct edit with invalid content", () => {
  it("is rejected with the schema error, restored and preserved", async () => {
    const { root, path, timelines, edit, rejected } = setup();
    await timelines.reconcile(root, "main");
    const daemonVersion = readFileSync(path, "utf8");
    edit((timeline) => {
      timeline.tracks[0].kind = "vidoe";
    });

    await timelines.reconcile(root, "main");

    expect(readFileSync(path, "utf8")).toBe(daemonVersion);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: "invalid", revision: 0, current: 0 });
    // Precise: names the field that failed.
    expect(rejected[0]!.message).toMatch(/tracks\.0\.kind/);
    expect(existsSync(join(root, rejected[0]!.preserved))).toBe(true);
  });

  it("is rejected when it is not JSON at all", async () => {
    const { root, path, timelines, rejected } = setup();
    await timelines.reconcile(root, "main");
    writeFileSync(path, '{ "revision": 0, ');
    await timelines.reconcile(root, "main");
    expect(rejected).toMatchObject([{ reason: "invalid", revision: null, message: expect.stringMatching(/JSON/) }]);
    expect(readFileSync(join(root, rejected[0]!.preserved), "utf8")).toBe('{ "revision": 0, ');
  });

  it("is rejected when it breaks a timeline rule, naming the clips", async () => {
    const { root, path, timelines, edit, addClip, rejected } = setup();
    await addClip(0);
    await addClip(4);
    const daemonVersion = readFileSync(path, "utf8");
    edit((timeline) => {
      timeline.tracks[0].clips[1].start = 1; // overlaps the first clip (0 to 2)
    });
    await timelines.reconcile(root, "main");
    expect(readFileSync(path, "utf8")).toBe(daemonVersion);
    expect(rejected).toMatchObject([{ reason: "invalid", message: expect.stringMatching(/c_1.*c_2.*overlap/) }]);
  });
});

describe("rejections listed for status", () => {
  const staleEdit = async (project: ReturnType<typeof setup>) => {
    const { root, timelines, edit, addClip } = project;
    await addClip(0);
    edit((timeline) => {
      timeline.revision = 0;
      timeline.tracks[0].clips = [];
    });
    await timelines.reconcile(root, "main");
  };

  it("survive a restart: they are read from .frameshell/ on disk, newest first", async () => {
    const project = setup();
    const { root, restart, edit, rejected } = project;
    await staleEdit(project);
    edit((timeline) => {
      timeline.tracks = "none";
    });
    await project.timelines.reconcile(root, "main");
    expect(rejected.map((r) => r.reason)).toEqual(["stale", "invalid"]);

    const listed = await restart().rejections(root);
    expect(listed).toEqual(rejected.map(({ root: _root, ...rejection }) => rejection).reverse());
  });

  it("drop a rejection once its preserved copy is deleted", async () => {
    const project = setup();
    await staleEdit(project);
    const [kept] = await project.timelines.rejections(project.root);
    rmSync(join(project.root, kept!.preserved));
    expect(await project.restart().rejections(project.root)).toEqual([]);
  });

  it("list a preserved copy with no recorded details as reason `unknown`", async () => {
    const { root, restart, read } = setup();
    mkdirSync(join(root, ".frameshell", "rejected"), { recursive: true });
    const name = "2026-01-02T03-04-05-678Z-main.json";
    writeFileSync(join(root, ".frameshell", "rejected", name), JSON.stringify({ ...read(), revision: 7 }));

    expect(await restart().rejections(root)).toEqual([
      {
        timeline: "main",
        reason: "unknown",
        message: expect.stringMatching(/no recorded reason/i),
        preserved: `.frameshell/rejected/${name}`,
        revision: 7,
        current: null,
        at: "2026-01-02T03:04:05.678Z",
      },
    ]);
  });
});

describe("the service's own writes", () => {
  it("never count as direct edits", async () => {
    const { root, timelines, addClip, changed, rejected } = setup();
    await addClip(0);
    await addClip(4);
    // What the watcher does after each of the daemon's atomic writes.
    await timelines.reconcile(root, "main");
    await timelines.reconcile(root, "main");
    const history = await timelines.history(root, "main", {});
    expect(history.transactions.flatMap((t) => t.operations.map((o) => o.author))).toEqual(["cli:agent", "cli:agent"]);
    expect(changed).toHaveLength(2);
    expect(rejected).toEqual([]);
    expect(existsSync(join(root, ".frameshell", "rejected"))).toBe(false);
  });

  it("do not journal a reformat that keeps every track and clip", async () => {
    const { root, path, timelines, read, changed } = setup();
    await timelines.reconcile(root, "main");
    writeFileSync(path, JSON.stringify(read()));
    await timelines.reconcile(root, "main");
    expect(changed).toEqual([]);
    expect((await timelines.history(root, "main", {})).transactions).toEqual([]);
  });
});

describe("writeFile (file.write of a timeline)", () => {
  it("journals a save with the current revision as a `file` operation", async () => {
    const { root, timelines, read } = setup();
    const timeline = read();
    timeline.tracks[0].name = "Camera";
    await timelines.writeFile(root, "main", JSON.stringify(timeline));
    expect(read()).toMatchObject({ revision: 1, tracks: [{ name: "Camera" }] });
    const history = await timelines.history(root, "main", {});
    expect(history.transactions[0]).toMatchObject({ author: "file", operations: [{ op: "timeline.patch" }] });
  });

  it("refuses a stale save with StaleRevision and leaves the file alone", async () => {
    const { root, path, timelines, read, addClip, rejected } = setup();
    const old = read();
    await addClip(0);
    const daemonVersion = readFileSync(path, "utf8");
    const error = await rejection(timelines.writeFile(root, "main", JSON.stringify(old)));
    expect(error.code).toBe(ErrorCode.StaleRevision);
    expect(error.data).toMatchObject({ timeline: "main", revision: 0, current: 1 });
    expect(readFileSync(path, "utf8")).toBe(daemonVersion);
    // The caller still holds its content: nothing to preserve.
    expect(rejected).toEqual([]);
  });

  it("refuses invalid content with InvalidProjectFile", async () => {
    const { root, timelines } = setup();
    const error = await rejection(timelines.writeFile(root, "main", "{}"));
    expect(error.code).toBe(ErrorCode.InvalidProjectFile);
  });

  it("writes a new timeline file as is", async () => {
    const { root, timelines } = setup();
    await timelines.writeFile(root, "intro", JSON.stringify({ ...createTimeline("intro"), revision: 7 }));
    expect((await timelines.show(root, "intro")).revision).toBe(7);
  });
});
