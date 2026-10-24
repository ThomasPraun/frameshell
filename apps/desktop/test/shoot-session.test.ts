import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import type { ShootSourceSpec } from "../src/shared/api.js";
import { contentProtectionSupport, screenSources, systemAudioSupport } from "../src/main/shoot-capture.js";
import {
  ChunkWriter,
  type FinishDeps,
  PART_SUFFIX,
  SHOOT_STATE_DIR,
  beginSession,
  fileNameOf,
  finishSession,
  groupRequest,
  isSessionId,
  markScript,
  markStarted,
  sessionSounds,
  offsetsOf,
  readSession,
  recoverable,
  removeFile,
  sessionId,
  unfinishedSessions,
} from "../src/main/shoot-session.js";

const project = () => realpathSync(mkdtempSync(join(tmpdir(), "fs-shoot-")));
const AT = new Date(2026, 9, 24, 15, 30, 12);
const SPECS: ShootSourceSpec[] = [
  { role: "camera", mime: "video/mp4;codecs=avc1.640028", label: "FaceTime HD Camera" },
  { role: "screen", mime: "video/mp4;codecs=avc1.640028", label: "Zoom Meeting" },
  { role: "mic", mime: "audio/mp4;codecs=mp4a.40.2", label: "MacBook Pro Microphone" },
  { role: "system", mime: "audio/webm;codecs=opus", label: "System audio" },
];

/** Deps that record what they were asked: remux copies bytes (or fails for `failRemux`), the daemon answers a group. */
function fakeDeps(options: { failRemux?: boolean; refuseGroup?: boolean; noFrames?: string } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const remuxed: string[] = [];
  const deps: FinishDeps = {
    request: (async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "shoot.session.end") return { timeline: "launch", group: (params["assets"] as string[]).length > 0 ? "g_2" : null, transcripts: [], tx: null, warnings: [] };
      if (method === "multicam.create") {
        if (options.refuseGroup) throw new RpcError(ErrorCode.InvalidOperation, "multicam.create: camera.mp4 has no moving picture");
        const empty = (params["assets"] as string[]).find((asset) => asset.endsWith(`/${options.noFrames}`));
        if (empty) throw new RpcError(ErrorCode.InvalidOperation, `multicam.create: ${empty} has no moving picture; each camera needs a video file.`);
        return { group: "g_1", warnings: [] };
      }
      return { dir: params["cwd"], imported: [] };
    }) as FinishDeps["request"],
    alone: (work) => work(),
    remux: async (input, output) => {
      if (options.failRemux) throw new Error("Invalid data found when processing input");
      remuxed.push(input);
      await copyFile(input, output);
    },
  };
  return { deps, calls, remuxed };
}

describe("session ids and file names", () => {
  it("names a session by its local start time, with a suffix when taken", () => {
    expect(sessionId(AT, () => false)).toBe("20261024-153012");
    const taken = new Set(["20261024-153012", "20261024-153012-2"]);
    expect(sessionId(AT, (id) => taken.has(id))).toBe("20261024-153012-3");
    expect(isSessionId("20261024-153012-3")).toBe(true);
    expect(isSessionId("../../etc")).toBe(false);
  });

  it("names files by role and container", () => {
    expect(SPECS.map((spec) => fileNameOf(spec.role, spec.mime))).toEqual(["camera.mp4", "screen.mp4", "mic.m4a", "system.webm"]);
    expect(fileNameOf("camera", "video/webm;codecs=vp9")).toBe("camera.webm");
  });
});

describe("session files", () => {
  it("writes the folder and state file, appends chunks in order and records the start times", async () => {
    const root = project();
    const state = await beginSession(root, SPECS, AT);
    expect(existsSync(join(root, "assets/shoot/20261024-153012"))).toBe(true);
    expect(await unfinishedSessions(root)).toEqual(["20261024-153012"]);
    const writer = new ChunkWriter();
    const appends = [1, 2, 3].map((n) => writer.append(root, state, "camera", new Uint8Array([n, n])));
    await Promise.all(appends);
    await writer.append(root, state, "mic", new Uint8Array([9]));
    await writer.flushed();
    expect([...readFileSync(join(root, "assets/shoot/20261024-153012/camera.mp4" + PART_SUFFIX))]).toEqual([1, 1, 2, 2, 3, 3]);
    await expect(writer.append(root, { ...state, sources: [] }, "camera", new Uint8Array([1]))).rejects.toThrow("does not record camera");
    await markStarted(root, state.id, { camera: 1000.5, screen: 1000.9, mic: 1000.2, system: 1001.4 });
    expect((await readSession(root, state.id))!.sources.map((source) => source.start)).toEqual([1000.5, 1000.9, 1000.2, 1001.4]);
  });

  it("refuses a session without a mic or with a source twice", async () => {
    const root = project();
    await expect(beginSession(root, [SPECS[0]!], AT)).rejects.toThrow("needs a microphone");
    await expect(beginSession(root, [SPECS[2]!, SPECS[2]!], AT)).rejects.toThrow("records once");
  });
});

describe("groupRequest", () => {
  it("makes camera and screen the angles (screen marked), mic and system the mics, offsets from the start times", async () => {
    const root = project();
    const state = await beginSession(root, SPECS, AT);
    const sources = state.sources.map((source, i) => ({ ...source, start: [1000.5, 1000.9, 1000.2, null][i]! }));
    expect(offsetsOf(sources)).toEqual([0, 0.001, 0, 0]);
    expect(groupRequest(root, state.id, sources)).toEqual({
      cwd: root,
      assets: ["assets/shoot/20261024-153012/camera.mp4", "assets/shoot/20261024-153012/screen.mp4"],
      names: ["FaceTime HD Camera", "Zoom Meeting"],
      mics: ["assets/shoot/20261024-153012/mic.m4a", "assets/shoot/20261024-153012/system.webm"],
      micNames: ["MacBook Pro Microphone", "System audio"],
      soundOf: ["1", "1"],
      offsets: [0, 0.001, 0, 0],
      screens: [2],
      name: "Shoot 20261024-153012",
    });
    expect(groupRequest(root, state.id, sources.filter((source) => source.role === "mic"))).toBeNull();
  });

  it("measures offsets in whole milliseconds from the earliest recorder", () => {
    const at = (start: number | null) => ({ role: "mic" as const, file: "mic.m4a", mime: "", label: "", start });
    expect(offsetsOf([at(5000.4), at(5012.6), at(null)])).toEqual([0, 0.012, 0]);
    expect(offsetsOf([at(null)])).toEqual([0]);
  });
});

describe("finishSession", () => {
  async function recorded(root: string, specs = SPECS) {
    const state = await beginSession(root, specs, AT);
    const folder = join(root, "assets/shoot", state.id);
    for (const source of state.sources) writeFileSync(join(folder, source.file + PART_SUFFIX), Buffer.from(source.role));
    await markStarted(root, state.id, { camera: 10, screen: 12, mic: 11, system: 10 });
    return { state, folder };
  }

  it("on End renames MP4 parts, remuxes WebM, imports the files, makes the group and drops the state file", async () => {
    const root = project();
    const { state, folder } = await recorded(root);
    const { deps, calls, remuxed } = fakeDeps();
    const finish = await finishSession(root, state.id, false, deps);
    expect(finish).toEqual({
      id: state.id,
      folder: `assets/shoot/${state.id}`,
      files: ["camera.mp4", "screen.mp4", "mic.m4a", "system.webm"].map((file) => `assets/shoot/${state.id}/${file}`),
      group: "g_1",
      recovered: false,
      warnings: [],
    });
    expect(remuxed).toEqual([join(folder, "system.webm.part")]);
    expect(readdirSync(folder).sort()).toEqual(["camera.mp4", "mic.m4a", "screen.mp4", "system.webm"]);
    expect(calls.map((call) => call.method)).toEqual(["asset.import", "multicam.create"]);
    expect(calls[0]!.params["files"]).toEqual(finish.files.map((file) => join(root, file)));
    expect(calls[1]!.params).toMatchObject({ timeline: "main", offsets: [0, 0.002, 0.001, 0], screens: [2] });
    expect(await unfinishedSessions(root)).toEqual([]);
    expect(existsSync(join(root, SHOOT_STATE_DIR, `${state.id}.json`))).toBe(false);
  });

  it("after a crash remuxes every file, leaves out empty ones, and keeps the bytes of a file it cannot repair", async () => {
    const root = project();
    const { state, folder } = await recorded(root);
    writeFileSync(join(folder, "screen.mp4.part"), "");
    const repaired = fakeDeps();
    const finish = await finishSession(root, state.id, true, repaired.deps);
    expect(repaired.remuxed.map((path) => path.slice(folder.length + 1))).toEqual(["camera.mp4.part", "mic.m4a.part", "system.webm.part"]);
    expect(finish.recovered).toBe(true);
    expect(finish.files.map((file) => file.split("/").pop())).toEqual(["camera.mp4", "mic.m4a", "system.webm"]);
    expect(finish.warnings).toEqual(["screen.mp4: nothing was recorded."]);
    expect(repaired.calls[1]!.params).toMatchObject({ assets: [`assets/shoot/${state.id}/camera.mp4`], offsets: [0, 0.001, 0] });
    expect(repaired.calls[1]!.params["screens"]).toBeUndefined();

    const other = project();
    const broken = await recorded(other);
    const failing = fakeDeps({ failRemux: true });
    const kept = await finishSession(other, broken.state.id, true, failing.deps);
    expect(kept.files).toHaveLength(4);
    expect(readFileSync(join(broken.folder, "camera.mp4"), "utf8")).toBe("camera");
    expect(kept.warnings[0]).toContain("camera.mp4: could not be repaired (Invalid data found when processing input)");
    expect(readdirSync(broken.folder).filter((name) => name.endsWith(".tmp") || name.endsWith(".part"))).toEqual([]);
  });

  it("makes no group for a mic alone, and keeps the files when the daemon refuses the group", async () => {
    const root = project();
    const { state } = await recorded(root, [SPECS[2]!]);
    const { deps, calls } = fakeDeps();
    const finish = await finishSession(root, state.id, false, deps);
    expect(finish.group).toBeNull();
    expect(calls.map((call) => call.method)).toEqual(["asset.import"]);

    const other = project();
    const refused = await recorded(other);
    const finishRefused = await finishSession(other, refused.state.id, false, fakeDeps({ refuseGroup: true }).deps);
    expect(finishRefused.group).toBeNull();
    expect(finishRefused.warnings).toEqual(["No multicam group: multicam.create: camera.mp4 has no moving picture"]);
    expect(await unfinishedSessions(other)).toEqual([]);

    const third = project();
    const early = await recorded(third);
    const withoutCamera = fakeDeps({ noFrames: "camera.mp4" });
    const finishEarly = await finishSession(third, early.state.id, true, withoutCamera.deps);
    expect(finishEarly.group).toBe("g_1");
    expect(finishEarly.files).toHaveLength(4);
    expect(finishEarly.warnings).toEqual([expect.stringMatching(/^camera\.mp4: left out of the group \(multicam\.create: .*no moving picture/)]);
    expect(withoutCamera.calls.at(-1)!.params).toMatchObject({ assets: [`assets/shoot/${early.state.id}/screen.mp4`], screens: [1] });
  });

  it("keeps the state file when the daemon cannot be reached, and a retry finishes from where it stopped", async () => {
    const root = project();
    const { state, folder } = await recorded(root);
    const { deps } = fakeDeps();
    const offline: FinishDeps = { ...deps, request: (async () => Promise.reject(new Error("connect ENOENT"))) as FinishDeps["request"] };
    await expect(finishSession(root, state.id, true, offline)).rejects.toThrow("connect ENOENT");
    expect(await unfinishedSessions(root)).toEqual([state.id]);
    const retry = fakeDeps();
    const finish = await finishSession(root, state.id, true, retry.deps);
    expect(retry.remuxed).toEqual([]);
    expect(finish.files).toHaveLength(4);
    expect(readdirSync(folder).sort()).toEqual(["camera.mp4", "mic.m4a", "screen.mp4", "system.webm"]);
    expect(await unfinishedSessions(root)).toEqual([]);
  });
});

describe("sessions with takes", () => {
  it("names the session's sound files with their offsets, as a Cut sends them", async () => {
    const root = project();
    const state = await beginSession(root, SPECS, AT);
    await markStarted(root, state.id, { camera: 10, screen: 12, mic: 11, system: 10 });
    expect(sessionSounds((await readSession(root, state.id))!)).toEqual([
      { asset: `assets/shoot/${state.id}/mic.m4a`, offset: 0.001 },
      { asset: `assets/shoot/${state.id}/system.webm`, offset: 0 },
    ]);
  });

  it("ends a session with takes through shoot.session.end, with the group's files, offsets and script", async () => {
    const root = project();
    const state = await beginSession(root, SPECS, AT);
    const folder = join(root, "assets/shoot", state.id);
    for (const source of state.sources) writeFileSync(join(folder, source.file + PART_SUFFIX), Buffer.from(source.role));
    await markStarted(root, state.id, { camera: 10, screen: 12, mic: 11, system: 10 });
    await markScript(root, state.id, "scripts/launch.md");
    const { deps, calls } = fakeDeps();
    const finish = await finishSession(root, state.id, false, deps);
    expect(finish.group).toBe("g_2");
    expect(calls.map((call) => call.method)).toEqual(["asset.import", "shoot.session.end"]);
    expect(calls[1]!.params).toMatchObject({
      script: "scripts/launch.md",
      session: state.id,
      assets: [`assets/shoot/${state.id}/camera.mp4`, `assets/shoot/${state.id}/screen.mp4`],
      offsets: [0, 0.002, 0.001, 0],
      screens: [2],
    });

    const micOnly = project();
    const alone = await beginSession(micOnly, [SPECS[2]!], AT);
    writeFileSync(join(micOnly, "assets/shoot", alone.id, "mic.m4a.part"), "mic");
    await markScript(micOnly, alone.id, "scripts/launch.md");
    const quiet = fakeDeps();
    expect((await finishSession(micOnly, alone.id, false, quiet.deps)).group).toBeNull();
    expect(quiet.calls[1]).toMatchObject({ method: "shoot.session.end", params: { assets: [], offsets: [] } });
  });
});

describe("recoverable", () => {
  it("leaves a session alone while the process recording it runs, and takes it once that process is gone", async () => {
    const root = project();
    const state = await beginSession(root, SPECS, AT);
    expect((await readSession(root, state.id))!.pid).toBe(process.pid);
    expect(await recoverable(root, state.id)).toBe(true);
    const file = join(root, SHOOT_STATE_DIR, `${state.id}.json`);
    writeFileSync(file, JSON.stringify({ ...state, pid: 999_999 }));
    expect(await recoverable(root, state.id, () => true)).toBe(false);
    expect(await recoverable(root, state.id, () => false)).toBe(true);
    const { pid: _pid, ...older } = state;
    writeFileSync(file, JSON.stringify(older));
    expect(await recoverable(root, state.id, () => true)).toBe(true);
    expect(await recoverable(root, "20200101-000000")).toBe(false);
  });
});

describe("removeFile", () => {
  it("deletes a file and is fine with one already gone", async () => {
    const root = project();
    const file = join(root, "camera.mp4.part");
    writeFileSync(file, "x");
    await removeFile(file);
    expect(existsSync(file)).toBe(false);
    await removeFile(file);
  });
});

describe("capture support", () => {
  it("offers system audio on macOS 14.2+ and Windows, not on older macOS or Linux", () => {
    expect(systemAudioSupport("darwin", "26.3.0")).toBe("available");
    expect(systemAudioSupport("darwin", "14.2")).toBe("available");
    expect(systemAudioSupport("darwin", "14.1.2")).toBe("macos-old");
    expect(systemAudioSupport("darwin", "13.6")).toBe("macos-old");
    expect(systemAudioSupport("win32", "10.0.22631")).toBe("available");
    expect(systemAudioSupport("linux", "6.8.0")).toBe("linux");
    expect(["darwin", "win32", "linux"].map((platform) => contentProtectionSupport(platform as NodeJS.Platform))).toEqual([true, true, false]);
  });

  it("lists screens before windows, without Frameshell's own windows", () => {
    const thumb = (data: string) => ({ isEmpty: () => data === "", toDataURL: () => data });
    const sources = [
      { id: "window:12:0", name: "Zoom Meeting", thumbnail: thumb("data:image/png;base64,AA") },
      { id: "window:7:0", name: "Frameshell", thumbnail: thumb("data:image/png;base64,BB") },
      { id: "screen:1:0", name: "Entire screen", thumbnail: thumb("") },
    ];
    expect(screenSources(sources, new Set(["window:7:0"]))).toEqual([
      { id: "screen:1:0", name: "Entire screen", kind: "screen", thumbnail: "" },
      { id: "window:12:0", name: "Zoom Meeting", kind: "window", thumbnail: "data:image/png;base64,AA" },
    ]);
  });
});
