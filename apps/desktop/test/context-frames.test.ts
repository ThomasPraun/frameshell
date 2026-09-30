import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureContextFrame } from "../src/main/context-frames.js";
import type { DaemonRequest } from "../src/main/timeline-editor.js";

// Seam under test: main's "Ask agent" region capture (#49): which daemon calls it makes and the
// project-relative path it answers. The `frame` method itself (export compiler) is tested in core.

describe("context frame capture", () => {
  it("renders the frame under the playhead through the daemon's frame method into .frameshell/context/", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const request = (async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "timeline.show") return { fps: 30 };
      return { path: params["out"], frame: 1956, at: 65.2, clip: "c_a", timeline: "main", width: 1920, height: 1080 };
    }) as unknown as DaemonRequest;
    const project = join("/work", "demo");
    const path = await captureContextFrame(request, project, 65.21);
    expect(path).toBe(".frameshell/context/f_1956.png");
    expect(calls).toEqual([
      { method: "timeline.show", params: { cwd: project, timeline: "main" } },
      { method: "frame", params: { cwd: project, timeline: "main", at: 65.2, out: join(project, ".frameshell", "context", "f_1956.png") } },
    ]);
  });

  it("pads frame numbers to four digits, as SPEC §10 shows them", async () => {
    const request = (async (method: string, params: Record<string, unknown>) =>
      method === "timeline.show" ? { fps: 25 } : { path: params["out"], frame: 7 }) as unknown as DaemonRequest;
    expect(await captureContextFrame(request, "/p", 0.3)).toBe(".frameshell/context/f_0007.png");
  });
});
