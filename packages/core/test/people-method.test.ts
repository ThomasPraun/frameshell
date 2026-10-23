import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AppDirs,
  type DaemonConnection,
  ErrorCode,
  type EventParams,
  RpcError,
  connectToDaemon,
} from "@frameshell/protocol";
import { SCHEMA_VERSION } from "@frameshell/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// Seam under test: the `people.*` methods over the daemon socket (ADR 0020). Transcripts, the timeline with a multicam
// group and the face asset are written by hand: nothing here needs media.

let daemon: Daemon | undefined;
const connections: DaemonConnection[] = [];
afterEach(async () => {
  for (const conn of connections.splice(0)) conn.close();
  await daemon?.close();
  daemon = undefined;
});

const EP1 = "transcripts/ep1.words.json";
const EP2 = "transcripts/ep2.words.json";

function transcript(asset: string, speakers: { id: string; name: string }[]) {
  return {
    schemaVersion: SCHEMA_VERSION,
    asset,
    assetHash: `sha256:${"a".repeat(64)}`,
    provider: "test",
    model: "test",
    words: [{ id: "w_000001", text: "hola", start: 0, end: 0.5, ...(speakers[0] ? { speaker: speakers[0].id } : {}) }],
    edits: {},
    ...(speakers.length > 0 ? { speakers } : {}),
  };
}

async function setup() {
  const dirs: AppDirs = { dataDir: tempDir(), configDir: tempDir() };
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs, txIdleGapMs: 60_000 });
  const dir = join(tempDir(), "talk");
  const connect = async (client: string, options: { session?: string; agent?: string | null } = {}) => {
    const conn = await connectToDaemon(daemon!.socketPath, { client, agent: null, ...options });
    connections.push(conn);
    return conn;
  };
  const app = await connect("desktop/test");
  await app.request("project.init", { dir });
  const write = async (rel: string, value: unknown) => app.request("file.write", { path: join(dir, rel), content: JSON.stringify(value) });
  await write(EP1, transcript("assets/ep1.mp4", [{ id: "s1", name: "Speaker 1" }, { id: "s2", name: "Speaker 2" }]));
  await write(EP2, transcript("assets/ep2.mp4", [{ id: "s1", name: "Speaker 1" }]));
  await write("timelines/talk.json", {
    schemaVersion: SCHEMA_VERSION,
    id: "talk",
    revision: 0,
    tracks: [],
    groups: [{ id: "g_talk", angles: [{ id: "juan", name: "Juan", asset: "assets/juan.mp4", offset: 0 }] }],
  });
  await write("footage/ep1.mp4", "x");
  const read = (rel: string) => JSON.parse(readFileSync(join(dir, rel), "utf8")) as Record<string, unknown> & { people: { speakers: unknown[] }[]; speakers: { id: string; name: string }[] };
  const speakerName = (rel: string, id: string) => (read(rel).speakers as { id: string; name: string }[]).find((speaker) => speaker.id === id)?.name;
  return { dir, app, connect, write, read, speakerName };
}

async function failure(call: Promise<unknown>): Promise<RpcError> {
  try {
    await call;
  } catch (error) {
    return error as RpcError;
  }
  throw new Error("expected the request to fail");
}

describe("people.json", () => {
  it("lists nobody and writes no file while the project has none", async () => {
    const { dir, app } = await setup();
    expect(await app.request("people.list", { cwd: dir })).toMatchObject({ dir, people: [], dismissed: [] });
    expect(existsSync(join(dir, "people.json"))).toBe(false);
  });

  it("adds a person with a generated id, written to people.json, and keeps names unique ignoring case", async () => {
    const { dir, app, read } = await setup();
    const { person } = await app.request("people.add", { cwd: dir, name: "  Juan " });
    expect(person).toMatchObject({ name: "Juan", speakers: [], angles: [], faces: [] });
    expect(person.id).toMatch(/^p_[0-9a-f]{6}$/);
    expect(read("people.json")).toMatchObject({ schemaVersion: 1, people: [{ id: person.id, name: "Juan" }], dismissed: [] });

    const clash = await failure(app.request("people.add", { cwd: dir, name: "JUAN" }));
    expect(clash.code).toBe(ErrorCode.InvalidOperation);
    expect(clash.data).toMatchObject({ reason: "name taken" });
    expect((await app.request("people.list", { cwd: dir })).people).toHaveLength(1);
  });

  it("takes a person by id or by exact name ignoring case, and refuses an unknown one with who exists", async () => {
    const { dir, app } = await setup();
    const { person } = await app.request("people.add", { cwd: dir, name: "Juan" });
    await app.request("people.rename", { cwd: dir, person: person.id, name: "Juan P" });
    await app.request("people.rename", { cwd: dir, person: "juan p", name: "Juan Pérez" });
    const error = await failure(app.request("people.remove", { cwd: dir, person: "Ana" }));
    expect(error.data).toMatchObject({ reason: "unknown person" });
    expect(error.message).toContain("Juan Pérez");
    expect((await app.request("people.remove", { cwd: dir, person: person.id })).removed.name).toBe("Juan Pérez");
    expect((await app.request("people.list", { cwd: dir })).people).toEqual([]);
  });

  it("refuses renaming to a name another person has, but allows changing the case of one's own", async () => {
    const { dir, app } = await setup();
    await app.request("people.add", { cwd: dir, name: "Juan" });
    await app.request("people.add", { cwd: dir, name: "Ana" });
    const error = await failure(app.request("people.rename", { cwd: dir, person: "Ana", name: "juan" }));
    expect(error.data).toMatchObject({ reason: "name taken" });
    expect((await app.request("people.rename", { cwd: dir, person: "Ana", name: "ANA" })).person.name).toBe("ANA");
  });

  it("reads a hand-written file with a hand-written id, and refuses to touch an invalid one", async () => {
    const { dir, app } = await setup();
    writeFileSync(join(dir, "people.json"), JSON.stringify({ schemaVersion: 1, people: [{ id: "p_juan", name: "Juan" }] }));
    const listed = await app.request("people.list", { cwd: dir });
    expect(listed.people).toMatchObject([{ id: "p_juan", name: "Juan", speakers: [], angles: [], faces: [] }]);

    writeFileSync(join(dir, "people.json"), JSON.stringify({ schemaVersion: 1, people: [{ id: "p_a", name: "Juan" }, { id: "p_b", name: "juan" }] }));
    const error = await failure(app.request("people.list", { cwd: dir }));
    expect(error.code).toBe(ErrorCode.InvalidProjectFile);
    expect(error.message).toContain("already taken");
    expect((await failure(app.request("people.add", { cwd: dir, name: "Ana" }))).code).toBe(ErrorCode.InvalidProjectFile);
    // Everything else still works.
    expect((await app.request("status", { cwd: dir })).project?.dir).toBe(dir);
    // Writing an invalid people.json through file.write is refused before it lands.
    const refused = await failure(app.request("file.write", { path: join(dir, "people.json"), content: "{}" }));
    expect(refused.code).toBe(ErrorCode.InvalidProjectFile);
  });
});

describe("links", () => {
  it("links a transcript speaker and writes the person's name into the transcript; rename follows", async () => {
    const { dir, app, speakerName } = await setup();
    await app.request("people.add", { cwd: dir, name: "Juan" });
    const linked = await app.request("people.link", { cwd: dir, person: "Juan", speaker: { transcript: join(dir, EP1), speaker: "s1" } });
    expect(linked).toMatchObject({ linked: true, transcripts: [EP1] });
    expect(linked.person.speakers).toEqual([{ transcript: EP1, speaker: "s1", missing: false }]);
    expect(speakerName(EP1, "s1")).toBe("Juan");
    expect(speakerName(EP1, "s2")).toBe("Speaker 2");

    // A second transcript, spelled relative to the project root.
    await app.request("people.link", { cwd: dir, person: "Juan", speaker: { transcript: EP2, speaker: "s1" } });
    expect(speakerName(EP2, "s1")).toBe("Juan");

    const renamed = await app.request("people.rename", { cwd: dir, person: "Juan", name: "Juan Pérez" });
    expect(renamed).toMatchObject({ previous: "Juan", skipped: [] });
    expect(renamed.transcripts.sort()).toEqual([EP1, EP2]);
    expect(speakerName(EP1, "s1")).toBe("Juan Pérez");
    expect(speakerName(EP2, "s1")).toBe("Juan Pérez");
  });

  it("keeps the rest of the transcript as it was", async () => {
    const { dir, app, read } = await setup();
    const before = read(EP1);
    await app.request("people.add", { cwd: dir, name: "Juan" });
    await app.request("people.link", { cwd: dir, person: "Juan", speaker: { transcript: EP1, speaker: "s2" } });
    const after = read(EP1);
    expect({ ...after, speakers: undefined }).toEqual({ ...before, speakers: undefined });
    expect(after.speakers).toEqual([{ id: "s1", name: "Speaker 1" }, { id: "s2", name: "Juan" }]);
  });

  it("links a whole transcript without writing a name, an angle and a face anchor", async () => {
    const { dir, app, read } = await setup();
    await app.request("people.add", { cwd: dir, name: "Juan" });
    const whole = await app.request("people.link", { cwd: dir, person: "Juan", speaker: { transcript: EP2 } });
    expect(whole.transcripts).toEqual([]);
    expect(read(EP2).speakers).toEqual([{ id: "s1", name: "Speaker 1" }]);
    await app.request("people.link", { cwd: dir, person: "Juan", angle: { timeline: "talk", group: "g_talk", angle: "juan" } });
    const face = await app.request("people.link", { cwd: dir, person: "Juan", face: { asset: "footage/ep1.mp4", at: 12.5, x: 0.41, y: 0.33 } });
    expect(face.person).toMatchObject({
      speakers: [{ transcript: EP2, missing: false }],
      angles: [{ timeline: "talk", group: "g_talk", angle: "juan", missing: false }],
      faces: [{ asset: "footage/ep1.mp4", at: 12.5, x: 0.41, y: 0.33, missing: false }],
    });
    expect(read("people.json").people[0]).toMatchObject({ faces: [{ asset: "footage/ep1.mp4", at: 12.5, x: 0.41, y: 0.33 }] });
  });

  it("defaults a face anchor to the center of the picture", async () => {
    const { dir, app } = await setup();
    await app.request("people.add", { cwd: dir, name: "Juan" });
    const { person } = await app.request("people.link", { cwd: dir, person: "Juan", face: { asset: "footage/ep1.mp4", at: 3 } });
    expect(person.faces[0]).toMatchObject({ x: 0.5, y: 0.5 });
  });

  it("changes nothing when the link is already the person's", async () => {
    const { dir, app } = await setup();
    await app.request("people.add", { cwd: dir, name: "Juan" });
    const target = { person: "Juan", speaker: { transcript: EP1, speaker: "s1" } };
    expect((await app.request("people.link", { cwd: dir, ...target })).linked).toBe(true);
    expect(await app.request("people.link", { cwd: dir, ...target })).toMatchObject({ linked: false, transcripts: [] });
  });

  it("gives a speaker, an angle or an anchor to one person only, and a whole transcript excludes other people's speakers", async () => {
    const { dir, app, speakerName } = await setup();
    await app.request("people.add", { cwd: dir, name: "Juan" });
    await app.request("people.add", { cwd: dir, name: "Ana" });
    await app.request("people.link", { cwd: dir, person: "Juan", speaker: { transcript: EP1, speaker: "s1" } });
    await app.request("people.link", { cwd: dir, person: "Juan", angle: { timeline: "talk", group: "g_talk", angle: "juan" } });
    const speaker = await failure(app.request("people.link", { cwd: dir, person: "Ana", speaker: { transcript: EP1, speaker: "s1" } }));
    expect(speaker.data).toMatchObject({ reason: "already linked" });
    expect(speaker.message).toContain("Juan");
    expect((await failure(app.request("people.link", { cwd: dir, person: "Ana", angle: { timeline: "talk", group: "g_talk", angle: "juan" } }))).data).toMatchObject({
      reason: "already linked",
    });
    expect((await failure(app.request("people.link", { cwd: dir, person: "Ana", speaker: { transcript: EP1 } }))).data).toMatchObject({ reason: "already linked" });
    // Another speaker of that transcript is free, and the refused ones changed nothing.
    await app.request("people.link", { cwd: dir, person: "Ana", speaker: { transcript: EP1, speaker: "s2" } });
    expect(speakerName(EP1, "s1")).toBe("Juan");
    expect(speakerName(EP1, "s2")).toBe("Ana");
  });

  it("refuses a target that does not exist now, and a path outside the project", async () => {
    const { dir, app } = await setup();
    await app.request("people.add", { cwd: dir, name: "Juan" });
    const refusal = async (params: Record<string, unknown>) => failure(app.request("people.link", { cwd: dir, person: "Juan", ...params } as never));
    for (const params of [
      { speaker: { transcript: "transcripts/none.words.json" } },
      { speaker: { transcript: EP1, speaker: "s9" } },
      { angle: { timeline: "nope", group: "g_talk", angle: "juan" } },
      { angle: { timeline: "talk", group: "g_none", angle: "juan" } },
      { angle: { timeline: "talk", group: "g_talk", angle: "zoe" } },
      { face: { asset: "footage/none.mp4", at: 1 } },
    ]) {
      const error = await refusal(params);
      expect(error.data, JSON.stringify(params)).toMatchObject({ reason: "target missing" });
    }
    expect((await refusal({ speaker: { transcript: join(tempDir(), "x.words.json") } })).data).toMatchObject({ reason: "bad target" });
    expect((await refusal({})).code).toBe(ErrorCode.InvalidParams);
    expect((await refusal({ speaker: { transcript: EP1 }, angle: { timeline: "talk", group: "g_talk", angle: "juan" } })).code).toBe(ErrorCode.InvalidParams);
    expect((await app.request("people.list", { cwd: dir })).people[0]!.speakers).toEqual([]);
  });

  it("unlinks one link, leaving the name already written in the transcript", async () => {
    const { dir, app, speakerName } = await setup();
    await app.request("people.add", { cwd: dir, name: "Juan" });
    await app.request("people.link", { cwd: dir, person: "Juan", speaker: { transcript: EP1, speaker: "s1" } });
    await app.request("people.link", { cwd: dir, person: "Juan", face: { asset: "footage/ep1.mp4", at: 3 } });
    const { person } = await app.request("people.unlink", { cwd: dir, person: "Juan", speaker: { transcript: join(dir, EP1), speaker: "s1" } });
    expect(person.speakers).toEqual([]);
    expect(person.faces).toHaveLength(1);
    expect(speakerName(EP1, "s1")).toBe("Juan");
    // The default point of the anchor is enough to name it.
    expect((await app.request("people.unlink", { cwd: dir, person: "Juan", face: { asset: "footage/ep1.mp4", at: 3 } })).person.faces).toEqual([]);

    const error = await failure(app.request("people.unlink", { cwd: dir, person: "Juan", speaker: { transcript: EP1, speaker: "s1" } }));
    expect(error.data).toMatchObject({ reason: "not linked" });
  });

  it("records an agent's link in `by` and leaves a person's own link unmarked", async () => {
    const { dir, app, connect, read } = await setup();
    await app.request("people.add", { cwd: dir, name: "Juan" });
    const agent = await connect("cli/test", { session: "term-1", agent: "claude" });
    await agent.request("people.link", { cwd: dir, person: "Juan", speaker: { transcript: EP1, speaker: "s1" } });
    await app.request("people.link", { cwd: dir, person: "Juan", speaker: { transcript: EP1, speaker: "s2" } });
    expect(read("people.json").people[0]!.speakers).toEqual([
      { transcript: EP1, speaker: "s1", by: "agent:claude:term-1" },
      { transcript: EP1, speaker: "s2" },
    ]);
  });
});

describe("missing links", () => {
  it("reports a link whose target is gone as missing, never deletes it, and sees it again when it returns", async () => {
    const { dir, app, write, read } = await setup();
    await app.request("people.add", { cwd: dir, name: "Juan" });
    await app.request("people.link", { cwd: dir, person: "Juan", speaker: { transcript: EP1, speaker: "s2" } });
    await app.request("people.link", { cwd: dir, person: "Juan", speaker: { transcript: EP2, speaker: "s1" } });
    await app.request("people.link", { cwd: dir, person: "Juan", angle: { timeline: "talk", group: "g_talk", angle: "juan" } });
    await app.request("people.link", { cwd: dir, person: "Juan", face: { asset: "footage/ep1.mp4", at: 1 } });
    const before = read("people.json");

    // A re-diarization dropped s2; a transcript, a group and an asset are gone.
    await write(EP1, transcript("assets/ep1.mp4", [{ id: "s1", name: "Speaker 1" }]));
    rmSync(join(dir, EP2));
    await write("timelines/talk.json", { schemaVersion: 1, id: "talk", revision: 0, tracks: [], groups: [] });
    rmSync(join(dir, "footage", "ep1.mp4"));

    const { people } = await app.request("people.list", { cwd: dir });
    const [juan] = people;
    expect(juan!.speakers[0]).toMatchObject({ transcript: EP1, speaker: "s2", missing: true });
    expect(juan!.speakers[0]!.reason).toContain("no speaker s2");
    expect(juan!.speakers[1]).toMatchObject({ transcript: EP2, missing: true });
    expect(juan!.angles[0]!.missing).toBe(true);
    expect(juan!.faces[0]).toMatchObject({ missing: true, reason: "footage/ep1.mp4 does not exist" });
    expect(read("people.json")).toEqual(before);

    // Back it comes: the link is live again.
    await write(EP1, transcript("assets/ep1.mp4", [{ id: "s1", name: "Speaker 1" }, { id: "s2", name: "Speaker 2" }]));
    expect((await app.request("people.list", { cwd: dir })).people[0]!.speakers[0]!.missing).toBe(false);
  });

  it("renames a person whose linked transcript is gone, reporting it as skipped", async () => {
    const { dir, app, speakerName } = await setup();
    await app.request("people.add", { cwd: dir, name: "Juan" });
    await app.request("people.link", { cwd: dir, person: "Juan", speaker: { transcript: EP1, speaker: "s1" } });
    await app.request("people.link", { cwd: dir, person: "Juan", speaker: { transcript: EP2, speaker: "s1" } });
    rmSync(join(dir, EP2));
    const renamed = await app.request("people.rename", { cwd: dir, person: "Juan", name: "Juanito" });
    expect(renamed.transcripts).toEqual([EP1]);
    expect(renamed.skipped).toEqual([{ transcript: EP2, reason: "the transcript file is missing" }]);
    expect(speakerName(EP1, "s1")).toBe("Juanito");
    expect(renamed.person.name).toBe("Juanito");
  });

  it("unlinks a link whose target is gone", async () => {
    const { dir, app } = await setup();
    await app.request("people.add", { cwd: dir, name: "Juan" });
    await app.request("people.link", { cwd: dir, person: "Juan", speaker: { transcript: EP2, speaker: "s1" } });
    rmSync(join(dir, EP2));
    expect((await app.request("people.unlink", { cwd: dir, person: "Juan", speaker: { transcript: EP2, speaker: "s1" } })).person.speakers).toEqual([]);
  });
});

describe("replays and notifications", () => {
  it("applies a replayed people.add once", async () => {
    const { dir, app } = await setup();
    const key = "people-add-0123456789";
    const first = await app.request("people.add", { cwd: dir, name: "Juan" }, { idempotencyKey: key });
    const replay = await app.request("people.add", { cwd: dir, name: "Juan" }, { idempotencyKey: key });
    expect(replay).toEqual(first);
    expect((await app.request("people.list", { cwd: dir })).people).toHaveLength(1);
    // The key belongs to that change: another one under it is refused.
    const reuse = await failure(app.request("people.add", { cwd: dir, name: "Ana" }, { idempotencyKey: key }));
    expect(reuse.code).toBe(ErrorCode.InvalidParams);
  });

  it("applies a replayed people.link once, and does not lose changes made at the same time", async () => {
    const { dir, app } = await setup();
    await app.request("people.add", { cwd: dir, name: "Juan" });
    const params = { cwd: dir, person: "Juan", speaker: { transcript: EP1, speaker: "s1" } };
    const [a, b] = await Promise.all([
      app.request("people.link", params, { idempotencyKey: "people-link-0123456789" }),
      app.request("people.link", params, { idempotencyKey: "people-link-0123456789" }),
    ]);
    expect(a).toEqual(b);
    const adds = await Promise.all(["Ana", "Ben", "Zoe", "Eva"].map((name) => app.request("people.add", { cwd: dir, name })));
    expect(adds).toHaveLength(4);
    const { people } = await app.request("people.list", { cwd: dir });
    expect(people.map((person) => person.name).sort()).toEqual(["Ana", "Ben", "Eva", "Juan", "Zoe"]);
    expect(people.find((person) => person.name === "Juan")!.speakers).toHaveLength(1);
  });

  it("sends people.changed to subscribers for each change, and nothing for a read", async () => {
    const { dir, app, connect } = await setup();
    const watcher = await connect("desktop/watch");
    await watcher.request("events.subscribe", { cwd: dir, events: ["people.changed"] });
    const seen: EventParams<"people.changed">[] = [];
    watcher.on("people.changed", (params) => seen.push(params));
    const { person } = await app.request("people.add", { cwd: dir, name: "Juan" });
    await app.request("people.list", { cwd: dir });
    await app.request("people.link", { cwd: dir, person: "Juan", speaker: { transcript: EP1, speaker: "s1" } });
    await app.request("people.rename", { cwd: dir, person: "Juan", name: "Juanito" });
    await app.request("people.unlink", { cwd: dir, person: "Juanito", speaker: { transcript: EP1, speaker: "s1" } });
    await app.request("people.remove", { cwd: dir, person: "Juanito" });
    await app.request("status", { cwd: dir });
    await vi.waitFor(() => expect(seen).toHaveLength(5));
    expect(seen.map((event) => [event.change, event.person])).toEqual(["add", "link", "rename", "unlink", "remove"].map((change) => [change, person.id]));
    expect(seen[0]!.project).toBe(dir);
  });
});
