import { describe, expect, it } from "vitest";
import { STILL_SECONDS, type TimelineMediaDeps, addMediaClips, trackKindOf } from "../src/main/timeline-media.js";

// Seam under test (`main/timeline-media.ts`): how main puts project media on a video timeline from Files (#738), against a recording stand-in for
// the daemon.

type Track = { id: string; kind: "video" | "audio" | "subtitles" };

function harness(tracks: Track[], options: { refuse?: string } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let next = 0;
  let end = 10;
  const request = (async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === "track.list") return { tracks };
    if (method === "track.add") return { changes: { added: [`t_new${++next}`] } };
    if (method === "clip.add") {
      if (params["asset"] === options.refuse) throw new Error("clips overlap on the track");
      const from = (params["start"] as number | undefined) ?? end;
      end = from + 4;
      return { changes: { added: [`c_${++next}`], range: { from, to: end } } };
    }
    return {};
  }) as unknown as TimelineMediaDeps["request"];
  const deps: TimelineMediaDeps = { request, alone: (work) => work() };
  const of = (method: string) => calls.filter((call) => call.method === method).map((call) => call.params);
  return { calls, deps, of, methods: () => calls.map((call) => call.method) };
}

describe("trackKindOf", () => {
  it("puts sound on audio tracks and pictures on video tracks, nothing else", () => {
    expect(["mic.m4a", "take.MP4", "logo.png", "notes.md"].map((file) => trackKindOf(`assets/${file}`))).toEqual(["audio", "video", "video", null]);
  });
});

describe("addMediaClips", () => {
  it("adds a Video or Audio track to an empty timeline and appends each file there, in one transaction", async () => {
    const { deps, of, methods } = harness([]);
    const added = await addMediaClips("/p", "main", ["assets/shoot/k1/mic.m4a", "assets/shoot/k1/camera.mp4", "scripts/a.md"], deps);
    expect(added).toEqual({ clips: ["c_2", "c_4"], refused: [] });
    expect(methods()).toEqual(["tx.begin", "track.list", "track.add", "clip.add", "track.add", "clip.add", "tx.commit"]);
    expect(of("tx.begin")[0]).toMatchObject({ label: "Add 2 clips" });
    expect(of("track.add")).toEqual([
      { cwd: "/p", timeline: "main", kind: "audio", name: "Audio" },
      { cwd: "/p", timeline: "main", kind: "video", name: "Video" },
    ]);
    expect(of("clip.add")).toEqual([
      { cwd: "/p", timeline: "main", track: "t_new1", asset: "assets/shoot/k1/mic.m4a" },
      { cwd: "/p", timeline: "main", track: "t_new3", asset: "assets/shoot/k1/camera.mp4" },
    ]);
  });

  it("uses the first existing track of each kind, and gives a still image a length", async () => {
    const { deps, of } = harness([
      { id: "t_sub", kind: "subtitles" },
      { id: "t_v1", kind: "video" },
      { id: "t_v2", kind: "video" },
      { id: "t_a1", kind: "audio" },
    ]);
    await addMediaClips("/p", "main", ["assets/logo.png", "assets/song.wav"], deps);
    expect(of("track.add")).toEqual([]);
    expect(of("clip.add")).toEqual([
      { cwd: "/p", timeline: "main", track: "t_v1", asset: "assets/logo.png", duration: STILL_SECONDS },
      { cwd: "/p", timeline: "main", track: "t_a1", asset: "assets/song.wav" },
    ]);
  });

  it("drops on a track from the time there, one after the other; a file of the other kind goes to its own track", async () => {
    const { deps, of } = harness([
      { id: "t_v1", kind: "video" },
      { id: "t_a1", kind: "audio" },
    ]);
    await addMediaClips("/p", "main", ["assets/a.wav", "assets/b.wav", "assets/c.mp4"], deps, { track: "t_a1", start: 2 });
    expect(of("clip.add")).toEqual([
      { cwd: "/p", timeline: "main", track: "t_a1", asset: "assets/a.wav", start: 2 },
      { cwd: "/p", timeline: "main", track: "t_a1", asset: "assets/b.wav", start: 6 },
      { cwd: "/p", timeline: "main", track: "t_v1", asset: "assets/c.mp4" },
    ]);
  });

  it("reports a file the daemon refuses and still places the others", async () => {
    const { deps, methods } = harness([{ id: "t_a1", kind: "audio" }], { refuse: "assets/a.wav" });
    const added = await addMediaClips("/p", "main", ["assets/a.wav", "assets/b.wav"], deps);
    expect(added).toEqual({ clips: ["c_1"], refused: [{ asset: "assets/a.wav", message: "clips overlap on the track" }] });
    expect(methods().at(-1)).toBe("tx.commit");
  });

  it("does nothing without media", async () => {
    const { deps, methods } = harness([]);
    expect(await addMediaClips("/p", "main", ["scripts/a.md"], deps)).toEqual({ clips: [], refused: [] });
    expect(methods()).toEqual([]);
  });
});
