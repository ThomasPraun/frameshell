import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type BackgroundDeps, addAudioBackground, backgroundHtml } from "../src/main/audio-background.js";

// Seam under test: the steps main takes after the transcript of an audio project exists (ADR 0015),
// against a recording stand-in for the daemon. Chromium rendering itself needs Electron.

type Track = { id: string; kind: "video" | "audio" | "subtitles"; clips: number; end: number | null };

function harness(tracks: Track[], options: { failAt?: string; listAfter?: Track[] } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let scratchFile = "";
  const request = (async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === options.failAt) throw new Error(`${method} failed`);
    switch (method) {
      case "track.list":
        return { tracks: calls.some((call) => call.method === "tx.begin") && options.listAfter ? options.listAfter : tracks };
      case "asset.import":
        return { imported: [{ asset: "assets/background.png" }] };
      case "track.add":
        return { changes: { added: ["t_new"] } };
      default:
        return {};
    }
  }) as unknown as BackgroundDeps["request"];
  const deps: BackgroundDeps = {
    request,
    alone: (work) => work(),
    render: async (_title, _size, path) => {
      scratchFile = path;
    },
  };
  return { calls, deps, methods: () => calls.map((call) => call.method), scratchFile: () => scratchFile };
}

const audioOnly: Track[] = [{ id: "t_audio", kind: "audio", clips: 1, end: 30 }];

describe("addAudioBackground", () => {
  it("adds the background over the audio and a subtitle track following it, in one transaction", async () => {
    const { calls, deps, methods } = harness(audioOnly);
    expect(await addAudioBackground("/p", "Episode", { width: 1920, height: 1080 }, deps)).toBe(true);
    expect(methods()).toEqual(["track.list", "asset.import", "tx.begin", "track.list", "track.add", "clip.add", "track.add", "tx.commit"]);
    expect(calls[4]?.params).toMatchObject({ kind: "video" });
    expect(calls[5]?.params).toMatchObject({ track: "t_new", asset: "assets/background.png", start: 0, duration: 30 });
    expect(calls[6]?.params).toMatchObject({ kind: "subtitles", follows: "t_audio" });
  });

  it("reuses an empty video track instead of adding one", async () => {
    const { calls, deps } = harness([{ id: "t_v", kind: "video", clips: 0, end: 0 }, ...audioOnly]);
    expect(await addAudioBackground("/p", "Episode", { width: 1080, height: 1920 }, deps)).toBe(true);
    expect(calls.filter((call) => call.method === "track.add")).toHaveLength(1);
    expect(calls.find((call) => call.method === "clip.add")?.params).toMatchObject({ track: "t_v" });
  });

  it("leaves a project that already has clips on a video track alone", async () => {
    const { deps, methods } = harness([{ id: "t_v", kind: "video", clips: 1, end: 5 }, ...audioOnly]);
    expect(await addAudioBackground("/p", "Episode", { width: 1920, height: 1080 }, deps)).toBe(false);
    expect(methods()).toEqual(["track.list"]);
  });

  it("leaves the project alone when a video clip appears between the first look and the transaction", async () => {
    const { deps, methods } = harness(audioOnly, { listAfter: [{ id: "t_v", kind: "video", clips: 1, end: 5 }, ...audioOnly] });
    expect(await addAudioBackground("/p", "Episode", { width: 1920, height: 1080 }, deps)).toBe(false);
    expect(methods()).toEqual(["track.list", "asset.import", "tx.begin", "track.list", "tx.abort"]);
  });

  it("leaves a project with no audio clip alone", async () => {
    const { deps, methods } = harness([{ id: "t_audio", kind: "audio", clips: 0, end: 0 }]);
    expect(await addAudioBackground("/p", "Episode", { width: 1920, height: 1080 }, deps)).toBe(false);
    expect(methods()).toEqual(["track.list"]);
  });

  it("aborts the transaction when a step fails, and removes the scratch image", async () => {
    const { deps, methods, scratchFile } = harness(audioOnly, { failAt: "clip.add" });
    await expect(addAudioBackground("/p", "Episode", { width: 1920, height: 1080 }, deps)).rejects.toThrow("clip.add failed");
    expect(methods().slice(-1)).toEqual(["tx.abort"]);
    expect(methods()).not.toContain("tx.commit");
    expect(existsSync(scratchFile())).toBe(false);
  });
});

describe("backgroundHtml", () => {
  it("escapes the title and fixes the page to the frame size", () => {
    const html = backgroundHtml(`<b>"Q&A"</b>`, { width: 1080, height: 1920 });
    expect(html).toContain("&#60;b&#62;&#34;Q&#38;A&#34;&#60;/b&#62;");
    expect(html).not.toContain("<b>");
    expect(html).toContain("width:1080px;height:1920px");
  });
});
