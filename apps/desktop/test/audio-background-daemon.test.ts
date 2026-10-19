import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "@frameshell/core";
import { type DaemonConnection, connectToDaemon } from "@frameshell/protocol";
import { ffmpegRun, makeAudio, testFfmpeg, useTestBinaries } from "../e2e/media.js";
import { addAudioBackground } from "../src/main/audio-background.js";
import { replaceClipImage } from "../src/main/replace-image.js";
import { TimelineEditor } from "../src/main/timeline-editor.js";

// Seam under test: the audio project's background step and the image swap, against a real daemon and
// the app's real editor (the `ui` author), so one Undo is checked end to end.

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Daemon, a project with a one-second audio clip on an audio track, and the app's connection. */
async function setup() {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "fs-background-")));
  const socketPath =
    process.platform === "win32" ? `\\\\.\\pipe\\frameshell-bg-${randomUUID().slice(0, 8)}` : join(work, "d.sock");
  const configDir = join(work, "config");
  await useTestBinaries(configDir);
  const daemon = await startDaemon({ socketPath, dirs: { dataDir: join(work, "data"), configDir } });
  cleanups.push(() => daemon.close());
  const connect = async (client: string, session?: string): Promise<DaemonConnection> => {
    const connection = await connectToDaemon(socketPath, { client, ...(session ? { session } : {}) });
    cleanups.push(() => connection.close());
    return connection;
  };
  const app = await connect("desktop/test");
  const cli = await connect("cli/test", "term-1");
  const dir = join(work, "talk");
  await app.request("project.init", { dir });
  const sine = join(work, "voice.wav");
  await makeAudio(sine);
  const { imported } = await cli.request("asset.import", { cwd: dir, files: [sine], mode: "copy" });
  const track = (await cli.request("track.add", { cwd: dir, timeline: "main", kind: "audio" })).changes.added[0]!;
  await cli.request("clip.add", { cwd: dir, timeline: "main", track, asset: imported[0]!.asset });
  const editor = new TimelineEditor((method, params) => app.request(method, params));
  const ffmpeg = await testFfmpeg();
  const image = async (path: string, colour: string) =>
    ffmpegRun(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=64x36:d=1`, "-frames:v", "1", path]);
  const render = (_title: string, _size: unknown, path: string) => image(path, "navy");
  return { app, cli, dir, editor, track, work, image, render };
}

describe("addAudioBackground against the daemon", () => {
  it("adds a background clip and a following subtitle track, and one Undo removes both", async () => {
    const { app, dir, editor, track, render } = await setup();
    const done = await addAudioBackground(dir, "Episode", { width: 64, height: 36 }, {
      request: (method, params, options) => app.request(method, params, options),
      alone: (work) => editor.alone(work),
      render,
    });
    expect(done).toBe(true);

    const after = await app.request("track.list", { cwd: dir, timeline: "main" });
    const video = after.tracks.find((candidate) => candidate.kind === "video");
    expect(video?.clips).toBe(1);
    expect(video?.end).toBeCloseTo(1, 1);
    expect(after.tracks.find((candidate) => candidate.kind === "subtitles")?.follows).toBe(track);

    const shown = await app.request("timeline.show", { cwd: dir, timeline: "main" });
    const clip = shown.tracks.find((candidate) => candidate.kind === "video")!.clips[0]!;
    const frame = await app.request("frame", { cwd: dir, timeline: "main", at: 0.5, out: join(dir, "exports", "f.png") });
    expect(frame.clip).toBe(clip.id);
    expect(existsSync(frame.path)).toBe(true);

    expect(await editor.undo(dir, "main")).not.toBeNull();
    const undone = await app.request("track.list", { cwd: dir, timeline: "main" });
    expect(undone.tracks.map((candidate) => candidate.kind)).toEqual(["audio"]);
  });

  it("swaps the picture for another image as one step that Undo takes back", async () => {
    const { app, dir, editor, render, image, work } = await setup();
    const request = (method: never, params: never, options?: never) => app.request(method, params, options);
    await addAudioBackground(dir, "Episode", { width: 64, height: 36 }, { request, alone: (work) => editor.alone(work), render });
    const before = await app.request("timeline.show", { cwd: dir, timeline: "main" });
    const original = before.tracks.find((candidate) => candidate.kind === "video")!.clips[0]!;

    const picked = join(work, "cover.png");
    await image(picked, "red");
    await replaceClipImage(dir, "main", original.id, picked, {
      request,
      apply: (edits, label) => editor.apply(dir, "main", edits, { label }),
    });
    const swapped = (await app.request("timeline.show", { cwd: dir, timeline: "main" })).tracks.find((candidate) => candidate.kind === "video")!.clips;
    expect(swapped).toHaveLength(1);
    expect(swapped[0]).toMatchObject({ start: original.start, end: original.end });
    expect(swapped[0]?.["asset"]).not.toBe(original["asset"]);

    await editor.undo(dir, "main");
    const restored = (await app.request("timeline.show", { cwd: dir, timeline: "main" })).tracks.find((candidate) => candidate.kind === "video")!.clips;
    expect(restored[0]?.["asset"]).toBe(original["asset"]);
  });

  it("refuses a file that is not an image", async () => {
    const { app, dir, editor } = await setup();
    writeFileSync(join(dir, "notes.txt"), "x");
    const request = (method: never, params: never, options?: never) => app.request(method, params, options);
    await expect(
      replaceClipImage(dir, "main", "c_none", join(dir, "notes.txt"), { request, apply: (edits, label) => editor.apply(dir, "main", edits, { label }) }),
    ).rejects.toThrow("not an image");
  });
});
