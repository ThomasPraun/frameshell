import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FRAME_IMAGE_SIZES, clockName, imageFromFrame } from "../src/main/frame-image.js";
import type { ImageLayersDeps } from "../src/main/image-layers.js";
import { coverScale } from "../src/main/image-layers.js";

// Seam under test: the steps main takes to make an image project from a video frame (ADR 0017), against a
// recording stand-in for the daemon. The size dialog and the new window need Electron (e2e).

function harness() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const request = (async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === "asset.import") return { imported: [{ asset: "assets/frame-01-05.png" }] };
    if (method === "track.add") return { changes: { added: ["t_1"] } };
    return {};
  }) as unknown as ImageLayersDeps["request"];
  const layers = async (): Promise<ImageLayersDeps> => ({
    request,
    alone: (work) => work(),
    resolution: FRAME_IMAGE_SIZES.square,
    imageSize: () => ({ width: 1920, height: 1080 }),
  });
  return { calls, deps: { request, layers, tempDir: realpathSync(tmpdir()) } };
}

describe("imageFromFrame", () => {
  it("captures the frame, makes an image project beside the video's, and covers it with the frame", async () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-frame-image-")));
    const source = { dir: join(parent, "interview"), name: "interview" };
    mkdirSync(join(parent, "interview frame 01-05"));
    const { calls, deps } = harness();

    const dir = await imageFromFrame(source, "main", 65.4, FRAME_IMAGE_SIZES.square, deps);

    expect(dir).toBe(join(parent, "interview frame 01-05 (2)"));
    const methods = calls.map((call) => call.method);
    expect(methods).toEqual(["frame", "project.init", "asset.import", "tx.begin", "track.add", "clip.add", "tx.commit"]);
    expect(calls[0]?.params).toMatchObject({ cwd: source.dir, timeline: "main", at: 65.4 });
    expect(String(calls[0]?.params["out"])).toMatch(/frame-01-05\.png$/);
    expect(calls[1]?.params).toEqual({ dir, name: "interview frame 01-05 (2)", kind: "image", resolution: { width: 1080, height: 1080 } });
    // A 16:9 frame covering a square: 1.7778 times the fitted size, the sides cropped.
    expect(calls[5]?.params).toMatchObject({ asset: "assets/frame-01-05.png", transform: { scale: 1.7778 } });
  });
});

describe("clockName", () => {
  it("names a time by minutes and seconds, with hours when there are some", () => {
    expect(clockName(0)).toBe("00-00");
    expect(clockName(65.9)).toBe("01-05");
    expect(clockName(3723)).toBe("1-02-03");
  });
});

describe("coverScale", () => {
  it("fills the frame with no bars, and leaves matching or unknown sizes alone", () => {
    expect(coverScale({ width: 1920, height: 1080 }, { width: 1080, height: 1920 })).toBe(3.1605);
    expect(coverScale({ width: 1920, height: 1080 }, { width: 1280, height: 720 })).toBe(1);
    expect(coverScale(null, { width: 1280, height: 720 })).toBe(1);
  });
});
