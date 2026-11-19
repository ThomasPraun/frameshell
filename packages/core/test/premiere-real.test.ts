import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Clip, Timeline } from "@frameshell/schema";
import { premiereAssetUrl, timelineToPremiereXml } from "../src/index.js";
import { tempDir } from "./helpers.js";
import { readWithPython } from "./otio-python.js";
import { premiereProblems } from "./premiere-check.js";

// The export read back by the OpenTimelineIO `fcp_xml` adapter, a reader of the Final Cut Pro 7 xmeml format. Opt in:
// `pip install opentimelineio==0.18.1 otio-fcp-adapter==1.0.0`, then
// `FRAMESHELL_TEST_OTIO=1 pnpm test packages/core/test/premiere-real` (FRAMESHELL_TEST_PYTHON picks the interpreter).
// Never required: without the variable this file only reports itself skipped. It is not Premiere Pro (ADR 0047).
const ENABLED = process.env["FRAMESHELL_TEST_OTIO"] === "1";

const READ = `
import json, sys
import opentimelineio as otio

def listed(value):
    if value is None:
        return []
    return [value] if hasattr(value, "get") else list(value)

timeline = otio.adapters.read_from_file(sys.argv[1], adapter_name="fcp_xml")
tracks = []
for track in timeline.tracks:
    children = []
    for child in track:
        entry = {"type": type(child).__name__}
        meta = child.metadata.get("fcp_xml", {})
        if isinstance(child, otio.schema.Transition):
            entry.update(kind=child.transition_type, inOffset=child.in_offset.value, outOffset=child.out_offset.value, name=child.name)
        else:
            entry.update(start=child.source_range.start_time.value, duration=child.source_range.duration.value)
        if isinstance(child, otio.schema.Clip):
            entry["name"] = child.name
            entry["reference"] = type(child.media_reference).__name__
            if isinstance(child.media_reference, otio.schema.ExternalReference):
                entry["url"] = child.media_reference.target_url
            entry["enabled"] = meta.get("enabled")
            entry["id"] = meta.get("@id")
            entry["effects"] = [effect.name for effect in child.effects]
            entry["links"] = [[link.get("linkclipref"), link.get("mediatype")] for link in listed(meta.get("link"))]
        children.append(entry)
    tracks.append({"kind": track.kind, "enabled": track.metadata.get("fcp_xml", {}).get("enabled"), "duration": track.duration().value, "children": children})
markers = [[marker.name, marker.marked_range.start_time.value] for marker in timeline.tracks.markers]
print(json.dumps({"tracks": tracks, "markers": markers, "duration": timeline.duration().value}))
`;

interface Read {
  tracks: { kind: string; enabled: string | undefined; duration: number; children: Record<string, unknown>[] }[];
  markers: [string, number][];
  duration: number;
}

const readWithAdapter = (path: string): Read => readWithPython<Read>(READ, path, "pip install opentimelineio==0.18.1 otio-fcp-adapter==1.0.0");

const media = (id: string, start: number, from: number, to: number, extra: Record<string, unknown> = {}): Clip =>
  ({ id, type: "media", asset: "assets/take.mp4", start, in: from, out: to, ...extra }) as Clip;

function written(timeline: Timeline, name: string): string {
  const { xml } = timelineToPremiereXml(timeline, {
    fps: 30,
    size: { width: 1920, height: 1080 },
    assetUrl: (asset) => premiereAssetUrl({ root: "/p/video", flavour: "posix" }, asset),
    sourceDuration: () => 100,
  });
  expect(premiereProblems(xml)).toEqual([]);
  const path = join(tempDir(), name);
  writeFileSync(path, xml);
  return path;
}

const clips = (children: Record<string, unknown>[]) => children.filter((child) => child["type"] === "Clip");

describe.skipIf(!ENABLED)("the OpenTimelineIO fcp_xml adapter reads the export", () => {
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
            media("c_fast", 5, 10, 14, { speed: 2, audio: { gain: -6 } }),
            { id: "c_gen", type: "hyperframes", start: 7, duration: 2, source: "compositions/hyperframes/intro/index.html" },
          ],
        },
        { id: "t_a1", kind: "audio", clips: [{ id: "c_m", type: "media", asset: "assets/music.wav", start: 0, in: 0, out: 9 }] },
      ],
      markers: [{ id: "m_1", at: 5, label: "hook", color: "orange" }],
    } as Timeline;

    const read = readWithAdapter(written(timeline, "main.xml"));
    const [video, audio, mirror] = read.tracks;
    expect(read.tracks.map((track) => track.kind)).toEqual(["Video", "Audio", "Audio"]);
    // 30 fps frames: c_a 0-60, c_b 60-120 (dissolve of 15 frames each side of the cut), gap 120-150, c_fast 150-210, c_gen 210-270.
    expect(video!.duration).toBe(270);
    expect(audio!.duration).toBe(270);
    // The sound mirror stops after c_fast: the generated clip has no sound to mirror.
    expect(mirror!.duration).toBe(210);
    expect(read.duration).toBe(270);
    expect(video!.children.map((child) => child["type"])).toEqual(["Clip", "Transition", "Clip", "Gap", "Clip", "Clip"]);
    expect(video!.children[1]).toMatchObject({ kind: "SMPTE_Dissolve", name: "Cross Dissolve", inOffset: 15, outOffset: 15 });
    // The in point is the source start as written: no widening by the dissolve (ADR 0047).
    expect(video!.children[0]).toMatchObject({ start: 60, duration: 60, reference: "ExternalReference", url: "file://localhost/p/video/assets/take.mp4" });
    expect(video!.children[2]).toMatchObject({ start: 150, duration: 60 });
    expect(video!.children[4]).toMatchObject({ start: 300, duration: 60, effects: ["Time Remap"] });
    expect(video!.children[5]).toMatchObject({ start: 0, duration: 60, reference: "MissingReference" });
    expect(audio!.children).toMatchObject([{ type: "Clip", start: 0, duration: 270, reference: "ExternalReference" }]);
    expect(mirror!.children.map((child) => child["type"])).toEqual(["Clip", "Transition", "Clip", "Gap", "Clip"]);
    expect(mirror!.children[1]).toMatchObject({ kind: "SMPTE_Dissolve", inOffset: 15, outOffset: 15 });
    expect(mirror!.children[4]).toMatchObject({ start: 300, duration: 60, effects: ["Time Remap", "Audio Levels"] });
    expect(read.markers).toEqual([["hook", 150]]);
  });

  it("the sound mirror of a video track: linked to its pictures, a muted clip, a muted track and a hidden track disabled", () => {
    const timeline = {
      schemaVersion: 1,
      id: "main",
      revision: 1,
      tracks: [
        { id: "t_v1", kind: "video", clips: [media("c_a", 0, 2, 4), media("c_b", 2, 5, 7, { dissolve: 1, audio: { muted: true } }), media("c_c", 5, 0, 2, { speed: 2 })] },
        { id: "t_v2", kind: "video", name: "Cam", muted: true, clips: [media("c_d", 1, 0, 3)] },
        { id: "t_v3", kind: "video", hidden: true, clips: [media("c_e", 0, 0, 1)] },
      ],
    } as Timeline;

    const read = readWithAdapter(written(timeline, "mirror.xml"));
    expect(read.tracks.map((track) => [track.kind, track.enabled])).toEqual([
      ["Video", "TRUE"],
      ["Video", "TRUE"],
      ["Video", "FALSE"],
      ["Audio", "TRUE"],
      ["Audio", "FALSE"],
      ["Audio", "TRUE"],
    ]);
    const [video, , , sound, camSound] = read.tracks;
    expect(sound!.duration).toBe(video!.duration);
    expect(sound!.children.map((child) => child["type"])).toEqual(video!.children.map((child) => child["type"]));
    expect(sound!.children.map((child) => [child["start"], child["duration"]])).toEqual(video!.children.map((child) => [child["start"], child["duration"]]));
    expect(clips(sound!.children).map((child) => child["enabled"])).toEqual(["TRUE", "FALSE", "TRUE"]);
    expect(clips(video!.children).map((child) => child["enabled"])).toEqual(["TRUE", "TRUE", "TRUE"]);
    // Each sound clip links to its own picture and to itself, as Premiere links a picture and its sound.
    clips(sound!.children).forEach((child, index) => {
      const picture = clips(video!.children)[index]!;
      expect(child["links"]).toEqual([
        [picture["id"], "video"],
        [child["id"], "audio"],
      ]);
    });
    expect(camSound!.children.map((child) => child["type"])).toEqual(["Gap", "Clip"]);
  });
});
