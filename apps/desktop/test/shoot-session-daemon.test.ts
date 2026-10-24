import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, statSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "@frameshell/core";
import { connectToDaemon } from "@frameshell/protocol";
import { ffmpegRun, testFfmpeg, useTestBinaries } from "../e2e/media.js";
import { PART_SUFFIX, beginSession, ffmpegRemux, finishSession, markStarted, unfinishedSessions } from "../src/main/shoot-session.js";
import { TimelineEditor } from "../src/main/timeline-editor.js";

// Crash recovery against a real daemon and the managed ffmpeg: fragmented MP4 like MediaRecorder writes, cut off
// mid-fragment as a kill leaves it, remuxed and made one multicam group with the recorders' offsets.

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("finishSession against the daemon", () => {
  it("repairs a session a crash cut short and makes it a multicam group with the recorded offsets", async () => {
    const work = realpathSync(mkdtempSync(join(tmpdir(), "fs-shoot-daemon-")));
    const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\frameshell-shoot-${randomUUID().slice(0, 8)}` : join(work, "d.sock");
    const configDir = join(work, "config");
    await useTestBinaries(configDir);
    const daemon = await startDaemon({ socketPath, dirs: { dataDir: join(work, "data"), configDir } });
    cleanups.push(() => daemon.close());
    const app = await connectToDaemon(socketPath, { client: "desktop/test" });
    cleanups.push(() => app.close());
    const root = join(work, "talk");
    await app.request("project.init", { dir: root });

    const state = await beginSession(root, [
      { role: "camera", mime: "video/mp4;codecs=avc1.640028", label: "Camera" },
      { role: "mic", mime: "audio/mp4;codecs=mp4a.40.2", label: "Mic" },
    ]);
    const folder = join(root, "assets/shoot", state.id);
    const ffmpeg = await testFfmpeg();
    const fragmented = ["-movflags", "frag_keyframe+empty_moov+default_base_moof"];
    await ffmpegRun(ffmpeg, [
      ...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=4"],
      ...["-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-pix_fmt", "yuv420p", ...fragmented, "-f", "mp4"],
      join(folder, "camera.mp4" + PART_SUFFIX),
    ]);
    await ffmpegRun(ffmpeg, [
      ...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=4"],
      ...["-c:a", "aac", ...fragmented, "-f", "mp4"],
      join(folder, "mic.m4a" + PART_SUFFIX),
    ]);
    // The kill: the last fragment of the camera file is half written.
    const part = join(folder, "camera.mp4" + PART_SUFFIX);
    truncateSync(part, Math.floor(statSync(part).size * 0.8));
    await markStarted(root, state.id, { camera: 5000.4, mic: 5012.6 });

    const editor = new TimelineEditor((method, params) => app.request(method, params));
    const finish = await finishSession(root, state.id, true, {
      request: (method, params, options) => app.request(method, params, options),
      alone: (work) => editor.alone(work),
      remux: ffmpegRemux(async () => ffmpeg),
    });

    expect(finish).toMatchObject({ recovered: true, files: [`assets/shoot/${state.id}/camera.mp4`, `assets/shoot/${state.id}/mic.m4a`] });
    expect(finish.group).toMatch(/^g_/);
    expect(await unfinishedSessions(root)).toEqual([]);
    const shown = await app.request("timeline.show", { cwd: root });
    const group = shown.groups!.find((candidate) => candidate.id === finish.group)!;
    expect(group.angles).toEqual([expect.objectContaining({ name: "Camera", asset: `assets/shoot/${state.id}/camera.mp4`, offset: 0 })]);
    expect(group.angles[0]!["mic"]).toBe(group.mics![0]!.id);
    expect(group.mics).toEqual([expect.objectContaining({ name: "Mic", asset: `assets/shoot/${state.id}/mic.m4a`, offset: 0.012 })]);
    const program = shown.tracks.find((track) => track.kind === "program" && track.group === group.id)!;
    expect(program.clips).toEqual([expect.objectContaining({ shot: "solo" })]);
    // The repaired camera file reads to its last whole fragment: about 3 of its 4 seconds.
    const out = program.clips[0]!["out"] as number;
    expect(out).toBeGreaterThan(2);
    expect(out).toBeLessThan(4);
    const assets = await app.request("asset.list", { cwd: root });
    expect(assets.assets.map((asset) => asset.path)).toEqual([`assets/shoot/${state.id}/camera.mp4`, `assets/shoot/${state.id}/mic.m4a`]);
    expect(readFileSync(join(folder, "camera.mp4")).length).toBeGreaterThan(0);
  }, 120_000);
});
