import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCode, type RenderResult } from "@frameshell/protocol";
import type { Timeline } from "@frameshell/schema";
import { BatchService } from "../src/batch/service.js";
import { rowVariant } from "../src/batch/variant.js";
import type { PlannedRender, RenderRequest } from "../src/export/service.js";
import { JobQueue } from "../src/jobs/queue.js";
import { tempDir } from "./helpers.js";

// BatchService with a real job queue and a stand-in export: render jobs that end when the test says so.
const template: Timeline = {
  schemaVersion: 1,
  id: "main",
  revision: 1,
  tracks: [
    { id: "t_a", kind: "audio", clips: [{ id: "c_vo", type: "media", asset: "assets/vo-en.wav", start: 0, in: 0, out: 1 }] },
    { id: "t_s", kind: "subtitles", follows: "t_a", style: {} },
  ],
} as unknown as Timeline;

let queue: JobQueue;
const finishers: (() => void)[] = [];

afterEach(async () => {
  finishers.splice(0).forEach((finish) => finish());
  await queue?.close();
});

function service(options: { transcribed?: readonly string[] } = {}): BatchService {
  queue = new JobQueue();
  return new BatchService({
    jobs: queue,
    loadTimeline: async () => ({ timeline: template, fps: 30 }),
    applyInMemory: async () => {
      throw new Error("no props slots in these tests");
    },
    source: async () => ({ duration: 5, video: false, audio: true }),
    hasTranscript: async (_root, asset) => (options.transcribed ?? ["assets/vo-es.wav", "assets/vo-fr.wav"]).includes(asset),
    planRender: async (root: string, params: RenderRequest): Promise<PlannedRender> => {
      const renders = (params.formats ?? ["1x1"]).map((format) => ({
        format,
        output: params.formats ? `${params.stem}-${format}.mp4` : `${params.stem}.mp4`,
        warnings: [] as string[],
      }));
      const result = { renders, preset: "youtube-1080p", quality: "final", warnings: [] } as unknown as PlannedRender["result"];
      return {
        result,
        provenance: [],
        start: () =>
          ({
            ...result,
            renders: renders.map((render) => ({
              ...render,
              job: queue.enqueue({
                kind: "render",
                project: root,
                asset: "timelines/main.json",
                output: render.output,
                run: () => new Promise<void>((resolve) => finishers.push(resolve)),
              }),
            })),
          }) as unknown as RenderResult,
      };
    },
  });
}

function batchFile(dir: string, content: Record<string, unknown>): string {
  const path = join(dir, "launch.batch.json");
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, slots: { voice: "c_vo.asset" }, ...content }));
  return path;
}

async function until(condition: () => boolean): Promise<void> {
  for (const deadline = Date.now() + 5_000; !condition(); ) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("BatchService", () => {
  it("refuses a voice swap under a following subtitle track when the new asset has no transcript", async () => {
    const root = tempDir();
    const file = batchFile(root, { rows: [{ id: "es", voice: "assets/vo-es.wav" }, { id: "de", voice: "assets/vo-de.wav" }] });
    await expect(service().render(root, root, { file, dryRun: true })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining("subtitle track t_s follows track t_a, but assets/vo-de.wav has no transcript"),
      data: { op: "batch.render", row: "de", slot: "voice", reason: "no transcript", asset: "assets/vo-de.wav" },
    });
  });

  it("swaps the asset without a transcript when no subtitle track follows the clip's track", async () => {
    const context = {
      fps: 30,
      apply: async () => {
        throw new Error("unused");
      },
      source: async () => ({ duration: 5, video: false, audio: true }),
      hasTranscript: async () => false,
    };
    const alone = { ...template, tracks: [template.tracks[0]!] } as Timeline;
    const file = { schemaVersion: 1 as const, template: "main", slots: { voice: "c_vo.asset" }, rows: [] };
    const variant = await rowVariant(alone, file, { id: "de", voice: "assets/vo-de.wav" }, context);
    expect((variant.tracks[0] as { clips: unknown[] }).clips[0]).toMatchObject({ asset: "assets/vo-de.wav", in: 0, out: 1 });
  });

  it("refuses two rows that write the same output file", async () => {
    const root = tempDir();
    const file = batchFile(root, { rows: [{ id: "a" }, { id: "a-web" }] });
    // Row `a` in format `web-1x1` and row `a-web` in `1x1` both write `a-web-1x1.mp4`.
    await expect(service().render(root, root, { file, formats: ["web-1x1", "1x1"], dryRun: true })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      data: { op: "batch.render", row: "a-web", reason: "output clash", output: join(root, "exports", "launch", "a-web-1x1.mp4"), other: "a" },
    });
  });

  it("keeps the project busy until its last row ends, and refuses a second batch into the same out through a symlink", async () => {
    const root = tempDir();
    const batches = service();
    const file = batchFile(root, { rows: [{ id: "es", voice: "assets/vo-es.wav" }, { id: "fr", voice: "assets/vo-fr.wav" }] });
    const out = join(root, "deliver");
    mkdirSync(out);
    const link = join(root, "link");
    symlinkSync(out, link);
    const result = await batches.render(root, root, { file, out, dryRun: false });
    expect(result.jobs).toHaveLength(1);
    expect(batches.active(root)).toBe(true);
    await expect(batches.render(root, root, { file, out: link, dryRun: false })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      data: { reason: "batch running", field: "out" },
    });

    await until(() => finishers.length === 1);
    finishers.shift()!();
    await until(() => finishers.length === 1);
    // Between rows and during the last one the batch still counts.
    expect(batches.active(root)).toBe(true);
    finishers.shift()!();
    await until(() => !batches.active(root));
  });
});
