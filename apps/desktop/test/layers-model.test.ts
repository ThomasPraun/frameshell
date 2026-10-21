import type { TimelineView } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { layerLabel, layersOf, moveLayer } from "../src/renderer/src/layers/model.js";

type Track = TimelineView["tracks"][number];

function track(id: string, kind: Track["kind"], clips: Record<string, unknown>[] = [], name: string | null = null): Track {
  return { id, kind, name, follows: null, clips: clips as Track["clips"] };
}

function view(tracks: Track[]): TimelineView {
  return { timeline: "main", path: "timelines/main.json", revision: 1, fps: 30, duration: 0.033, tracks, problems: [] } as unknown as TimelineView;
}

const still = (id: string, asset: string) => ({ id, type: "media", asset, start: 0, in: 0, out: 0.033, end: 0.033 });

describe("layersOf", () => {
  it("lists video tracks topmost first, each with the clip showing at frame 0", () => {
    const layers = layersOf(
      view([
        track("t_back", "video", [still("c_back", "assets/back.jpg")], "Background"),
        track("t_music", "audio"),
        track("t_card", "video", [{ id: "c_card", type: "hyperframes", source: "compositions/card.html", start: 0, duration: 0.033, end: 0.033 }]),
        track("t_late", "video", [{ ...still("c_late", "assets/late.png"), start: 1, end: 1.033 }]),
      ]),
    );
    expect(layers.map((layer) => [layer.track, layer.clip?.id ?? null, layer.up, layer.down])).toEqual([
      ["t_late", null, false, true],
      ["t_card", "c_card", true, true],
      ["t_back", "c_back", true, false],
    ]);
    expect(layers.map(layerLabel)).toEqual([null, "card.html", "Background"]);
    expect(layers[2]).toMatchObject({ asset: "assets/back.jpg", type: "media" });
  });
});

describe("moveLayer", () => {
  const tracks = view([track("t_a", "video"), track("t_music", "audio"), track("t_b", "video"), track("t_c", "video")]);

  it("moves a layer past the next video track that way, whatever lies between", () => {
    expect(moveLayer(tracks, "t_a", 1)).toEqual({ op: "track.set", args: { track: "t_a", index: 2 } });
    expect(moveLayer(tracks, "t_b", -1)).toEqual({ op: "track.set", args: { track: "t_b", index: 0 } });
    expect(moveLayer(tracks, "t_b", 1)).toEqual({ op: "track.set", args: { track: "t_b", index: 3 } });
  });

  it("has no move past the top or bottom layer, or for an unknown track", () => {
    expect(moveLayer(tracks, "t_c", 1)).toBeNull();
    expect(moveLayer(tracks, "t_a", -1)).toBeNull();
    expect(moveLayer(tracks, "t_x", 1)).toBeNull();
  });
});
