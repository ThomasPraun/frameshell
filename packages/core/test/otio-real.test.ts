import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Clip, Timeline } from "@frameshell/schema";
import { timelineToOtio } from "../src/index.js";
import { tempDir } from "./helpers.js";
import { otioProblems } from "./otio-check.js";

// The export read back by OpenTimelineIO itself. Opt in: `pip install opentimelineio`, then
// `FRAMESHELL_TEST_OTIO=1 pnpm test packages/core/test/otio` (FRAMESHELL_TEST_PYTHON picks the interpreter).
// Never required: without the variable this file only reports itself skipped.
const ENABLED = process.env["FRAMESHELL_TEST_OTIO"] === "1";

const READ = `
import json, sys
import opentimelineio as otio

timeline = otio.adapters.read_from_file(sys.argv[1])
tracks = []
for track in timeline.tracks:
    children = []
    for child in track:
        entry = {"type": type(child).__name__}
        if isinstance(child, otio.schema.Transition):
            entry.update(kind=child.transition_type, inOffset=child.in_offset.value, outOffset=child.out_offset.value)
        else:
            entry.update(start=child.source_range.start_time.value, duration=child.source_range.duration.value)
        if isinstance(child, otio.schema.Clip):
            entry["reference"] = type(child.media_reference).__name__
            entry["enabled"] = child.enabled
            entry["clipId"] = child.metadata.get("frameshell", {}).get("clipId")
        children.append(entry)
    tracks.append({"name": track.name, "kind": track.kind, "enabled": track.enabled, "duration": track.duration().value, "children": children})
markers = [[marker.name, marker.marked_range.start_time.value] for marker in timeline.tracks.markers]
print(json.dumps({"tracks": tracks, "markers": markers, "duration": timeline.duration().value}))
`;

interface Read {
  tracks: { name: string; kind: string; enabled: boolean; duration: number; children: Record<string, unknown>[] }[];
  markers: [string, number][];
  duration: number;
}

/** Runs the first interpreter that can import `opentimelineio`; throws with what it tried otherwise. */
function readWithOtio(path: string): Read {
  const candidates = [process.env["FRAMESHELL_TEST_PYTHON"], "python3", "python", "py -3"].filter((candidate): candidate is string => Boolean(candidate));
  const failures: string[] = [];
  for (const candidate of candidates) {
    const [command, ...prefix] = candidate.split(" ");
    try {
      return JSON.parse(execFileSync(command!, [...prefix, "-I", "-c", READ, path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as Read;
    } catch (error) {
      failures.push(`${candidate}: ${(error as Error).message.split("\n").slice(-2).join(" ").trim()}`);
    }
  }
  throw new Error(`no Python can read the file with opentimelineio (pip install opentimelineio):\n${failures.join("\n")}`);
}

const media = (id: string, start: number, from: number, to: number, extra: Record<string, unknown> = {}): Clip =>
  ({ id, type: "media", asset: "assets/take.mp4", start, in: from, out: to, ...extra }) as Clip;

describe.skipIf(!ENABLED)("OpenTimelineIO reads the export", () => {
  it("a cut, a dissolve, a gap, speed 2, a generated clip and a marker", () => {
    const timeline = {
      schemaVersion: 1,
      id: "main",
      revision: 1,
      tracks: [
        {
          id: "t_v1",
          kind: "video",
          clips: [
            media("c_a", 0, 2, 4),
            media("c_b", 2, 5, 7, { dissolve: 1 }),
            media("c_fast", 5, 10, 14, { speed: 2 }),
            { id: "c_gen", type: "hyperframes", start: 7, duration: 2, source: "compositions/hyperframes/intro/index.html" },
          ],
        },
        { id: "t_a1", kind: "audio", clips: [{ id: "c_m", type: "media", asset: "assets/music.wav", start: 0, in: 0, out: 9 }] },
      ],
      markers: [{ id: "m_1", at: 5, label: "hook", color: "orange" }],
    } as Timeline;
    const { otio, warnings } = timelineToOtio(timeline, { fps: 30, assetUrl: (asset) => `../${asset}`, sourceDuration: () => 100 });
    expect(otioProblems(otio)).toEqual([]);
    expect(warnings.some((warning) => warning.startsWith("dips and fades"))).toBe(false);
    const path = join(tempDir(), "main.otio");
    writeFileSync(path, JSON.stringify(otio, null, 2));

    const read = readWithOtio(path);
    const [video, audio, mirror] = read.tracks;
    expect(read.tracks.map((track) => [track.name, track.kind])).toEqual([
      ["V1", "Video"],
      ["A1", "Audio"],
      ["V1 sound", "Audio"],
    ]);
    // 30 fps frames: c_a 0-60, c_b 60-120 (dissolve of 15 frames each side of the cut), gap 120-150, c_fast 150-210, c_gen 210-270.
    expect(video!.duration).toBe(270);
    expect(audio!.duration).toBe(270);
    // The mirror stops after c_fast: the generated clip has no sound to mirror, so it ends 60 frames before the picture.
    expect(mirror!.duration).toBe(210);
    expect(read.duration).toBe(270);
    expect(video!.children.map((child) => child["type"])).toEqual(["Clip", "Transition", "Clip", "Gap", "Clip", "Clip"]);
    expect(video!.children[1]).toMatchObject({ kind: "SMPTE_Dissolve", inOffset: 15, outOffset: 15 });
    expect(video!.children[0]).toMatchObject({ start: 60, duration: 60, reference: "ExternalReference" });
    expect(video!.children[2]).toMatchObject({ start: 150, duration: 60 });
    expect(video!.children[4]).toMatchObject({ start: 300, duration: 60 });
    expect(video!.children[5]).toMatchObject({ start: 0, duration: 60, reference: "MissingReference" });
    expect(read.markers).toEqual([["hook", 150]]);
  });

  it("the sound mirror of a video track: same layout and crossfade, a muted clip and a muted track disabled", () => {
    const timeline = {
      schemaVersion: 1,
      id: "main",
      revision: 1,
      tracks: [
        { id: "t_v1", kind: "video", clips: [media("c_a", 0, 2, 4), media("c_b", 2, 5, 7, { dissolve: 1, audio: { muted: true } }), media("c_c", 5, 0, 2, { speed: 2 })] },
        { id: "t_v2", kind: "video", name: "Cam", muted: true, clips: [media("c_d", 1, 0, 3)] },
      ],
    } as Timeline;
    const { otio } = timelineToOtio(timeline, { fps: 30, assetUrl: (asset) => `../${asset}`, sourceDuration: () => 100 });
    expect(otioProblems(otio)).toEqual([]);
    const path = join(tempDir(), "mirror.otio");
    writeFileSync(path, JSON.stringify(otio, null, 2));

    const read = readWithOtio(path);
    expect(read.tracks.map((track) => [track.name, track.kind, track.enabled])).toEqual([
      ["V1", "Video", true],
      ["Cam", "Video", true],
      ["V1 sound", "Audio", true],
      ["Cam sound", "Audio", false],
    ]);
    const [video, , sound, camSound] = read.tracks;
    expect(sound!.duration).toBe(video!.duration);
    expect(sound!.children.map((child) => child["type"])).toEqual(video!.children.map((child) => child["type"]));
    expect(sound!.children.map((child) => [child["start"], child["duration"]])).toEqual(video!.children.map((child) => [child["start"], child["duration"]]));
    expect(sound!.children.filter((child) => child["type"] === "Clip").map((child) => [child["clipId"], child["enabled"]])).toEqual([
      ["c_a", true],
      ["c_b", false],
      ["c_c", true],
    ]);
    expect(camSound!.children.map((child) => child["type"])).toEqual(["Gap", "Clip"]);
  });
});
