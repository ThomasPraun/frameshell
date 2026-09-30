import { describe, expect, it } from "vitest";
import { ErrorCode, type EventParams, RpcError, type UiView } from "@frameshell/protocol";
import { UiBroker, type UiSink } from "../src/ui/broker.js";

// Seam under test: the daemon's UI broker, as the daemon's `ui.*` handlers call it. Sinks stand in for connections.

const A = { key: "/p/a", dir: "/p/a" };
const B = { key: "/p/b", dir: "/p/b" };

function view(overrides: Partial<UiView> = {}): UiView {
  return {
    timeline: "main",
    playhead: 0,
    playing: false,
    duration: 10,
    selection: { clips: [], words: [], range: null, history: null },
    editor: { active: null, tabs: [] },
    visible: { from: 0, to: 10 },
    ...overrides,
  };
}

/** A connection that records the commands it receives. */
function sink(): UiSink & { commands: EventParams<"ui.command">[] } {
  const commands: EventParams<"ui.command">[] = [];
  return { commands, notify: (_method, params) => void commands.push(params) };
}

async function failure(promise: Promise<unknown>): Promise<RpcError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(RpcError);
  return error as RpcError;
}

describe("UiBroker", () => {
  it("reports { connected: false } until a window publishes, then what it published", () => {
    const broker = new UiBroker();
    expect(broker.state(A.key)).toEqual({ connected: false });
    broker.publish(sink(), "w1", A, view({ playhead: 3.5, selection: { clips: ["c_1"], words: [], range: null, history: null } }));
    expect(broker.state(A.key)).toMatchObject({ connected: true, project: "/p/a", playhead: 3.5, selection: { clips: ["c_1"] } });
    expect(broker.state(A.key)).toHaveProperty("updatedAt", expect.stringMatching(/^\d{4}-\d\d-\d\dT/));
    expect(broker.state(B.key)).toEqual({ connected: false });
  });

  it("routes a command to the window that last published for the project, and answers with its reply's state", async () => {
    const broker = new UiBroker();
    const older = sink();
    const newer = sink();
    const elsewhere = sink();
    broker.publish(older, "w1", A, view());
    broker.publish(elsewhere, "w9", B, view());
    broker.publish(newer, "w2", A, view());

    const done = broker.command(A.key, { kind: "seek", at: 4 });
    expect(older.commands).toEqual([]);
    expect(elsewhere.commands).toEqual([]);
    expect(newer.commands).toEqual([{ project: "/p/a", view: "w2", id: expect.any(String), command: { kind: "seek", at: 4 } }]);
    broker.reply(newer, "w2", newer.commands[0]!.id, null, view({ playhead: 4 }));
    await expect(done).resolves.toMatchObject({ project: "/p/a", playhead: 4 });
    expect(broker.state(A.key)).toMatchObject({ connected: true, playhead: 4 });
  });

  it("fails a command the app refuses with its reason, and one it does not answer in time", async () => {
    const broker = new UiBroker({ timeoutMs: 20 });
    const app = sink();
    broker.publish(app, "w1", A, view());
    const refused = broker.command(A.key, { kind: "openFile", path: "nope.md" });
    broker.reply(app, "w1", app.commands[0]!.id, "Cannot read nope.md", view());
    const error = await failure(refused);
    expect(error.code).toBe(ErrorCode.UiCommandFailed);
    expect(error.message).toContain("Cannot read nope.md");
    expect(error.data).toEqual({ command: "openFile", reason: "Cannot read nope.md" });

    const silent = await failure(broker.command(A.key, { kind: "play" }));
    expect(silent.code).toBe(ErrorCode.UiCommandFailed);
    expect(silent.data).toMatchObject({ command: "play", reason: expect.stringContaining("did not answer") });
  });

  it("refuses navigation with UiNotConnected when no window shows the project", async () => {
    const error = await failure(new UiBroker().command(A.key, { kind: "pause" }));
    expect(error.code).toBe(ErrorCode.UiNotConnected);
    expect(error.data).toMatchObject({ project: "/p/a" });
  });

  it("forgets a detached window and a closed connection, failing their pending commands", async () => {
    const broker = new UiBroker();
    const first = sink();
    const second = sink();
    broker.publish(first, "w1", A, view());
    broker.publish(second, "w2", A, view());
    broker.detach(second, "w2");
    const pending = broker.command(A.key, { kind: "play" });
    expect(first.commands).toHaveLength(1);
    broker.drop(first);
    expect((await failure(pending)).code).toBe(ErrorCode.UiNotConnected);
    expect(broker.state(A.key)).toEqual({ connected: false });
  });

  it("remembers where each window registered, so a republish need not resolve its project again", () => {
    const broker = new UiBroker();
    const app = sink();
    expect(broker.registered(app, "w1")).toBeUndefined();
    broker.publish(app, "w1", { ...A, cwd: "/p/a/scripts" }, view());
    expect(broker.registered(app, "w1")).toEqual({ key: "/p/a", dir: "/p/a", cwd: "/p/a/scripts" });
  });
});
