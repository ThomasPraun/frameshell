import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BatchManifest, ErrorCode, type RenderResult } from "@frameshell/protocol";
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
/** Stems of every row planned, in order. */
const planned: string[] = [];
/** Ends the oldest running render job: ok, or failed when given an error. */
const finishers: ((error?: Error) => void)[] = [];

afterEach(async () => {
  planned.length = 0;
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
      planned.push(params.stem ?? "");
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
                run: () =>
                  new Promise<void>((resolve, reject) =>
                    finishers.push((error) => {
                      if (error) return reject(error);
                      writeFileSync(render.output, "video");
                      resolve();
                    }),
                  ),
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
    await expect(service().render(root, root, { file, failed: false, force: false, dryRun: true })).rejects.toMatchObject({
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
    await expect(service().render(root, root, { file, formats: ["web-1x1", "1x1"], failed: false, force: false, dryRun: true })).rejects.toMatchObject({
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
    const result = await batches.render(root, root, { file, out, failed: false, force: false, dryRun: false });
    expect(result.jobs).toHaveLength(1);
    expect(batches.active(root)).toBe(true);
    await expect(batches.render(root, root, { file, out: link, failed: false, force: false, dryRun: false })).rejects.toMatchObject({
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

  describe("re-runs", () => {
    const ids = ["a", "b", "c", "d"];
    const rows = ids.map((id) => ({ id }));

    const manifestOf = (out: string): BatchManifest => JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as BatchManifest;
    const states = (out: string) => manifestOf(out).entries.map((entry) => `${entry.row}:${entry.status}`);
    const label = (entries: readonly { row: string; status: string }[]) => entries.map((entry) => `${entry.row}:${entry.status}`);
    async function finishNext(error?: Error): Promise<void> {
      await until(() => finishers.length > 0);
      finishers.shift()!(error);
    }
    async function manifestDone(out: string): Promise<BatchManifest> {
      await until(() => {
        try {
          return manifestOf(out).state === "done";
        } catch {
          return false;
        }
      });
      return manifestOf(out);
    }
    const request = (file: string, more: Record<string, unknown> = {}) => ({ file, failed: false, force: false, dryRun: false, ...more });
    /** A first run of all four rows where `b` fails. */
    async function firstRun(batches: BatchService, root: string, file: string): Promise<string> {
      const out = join(root, "exports", "launch");
      await batches.render(root, root, request(file));
      await finishNext();
      await finishNext(new Error("encoder crashed"));
      await finishNext();
      await finishNext();
      await manifestDone(out);
      return out;
    }
    /** A manifest entry as a run of the daemon would leave it. */
    const entry = (out: string, row: string, status: string) => ({
      row,
      format: "1x1",
      output: join(out, `${row}.mp4`),
      status,
      job: `j_${row}`,
      error: null,
      startedAt: status === "queued" ? null : "2026-11-13T10:00:00.000Z",
      finishedAt: status === "done" ? "2026-11-13T10:00:05.000Z" : null,
      duration: status === "done" ? 5 : null,
      warnings: [],
    });
    const writeManifest = (out: string, batch: string, entries: unknown[], state = "running") => {
      mkdirSync(out, { recursive: true });
      writeFileSync(
        join(out, "manifest.json"),
        JSON.stringify({ batch, template: "main", out, state, startedAt: "2026-11-13T10:00:00.000Z", finishedAt: state === "done" ? "2026-11-13T10:01:00.000Z" : null, entries }),
      );
    };

    it("renders only the rows named, as ids or a range in file order, and refuses a row the file lacks", async () => {
      const root = tempDir();
      const file = batchFile(root, { rows });
      const batches = service();
      const plan = await batches.render(root, root, request(file, { rows: ["d", "b..c"], dryRun: true }));
      expect(label(plan.entries)).toEqual(["b:planned", "c:planned", "d:planned"]);
      expect(planned.map((stem) => stem.slice(-1))).toEqual(["b", "c", "d"]);
      await expect(batches.render(root, root, request(file, { rows: ["a", "zz"], dryRun: true }))).rejects.toMatchObject({
        code: ErrorCode.InvalidOperation,
        data: { op: "batch.render", row: "zz", reason: "unknown row", field: "rows" },
      });
      await expect(batches.render(root, root, request(file, { rows: ["c..a"], dryRun: true }))).rejects.toMatchObject({
        data: { reason: "range order", spec: "c..a" },
      });
      await expect(batches.render(root, root, request(file, { rows: ["a..b..c"], dryRun: true }))).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    });

    it("re-runs only the failed row and keeps the others' entries and files", async () => {
      const root = tempDir();
      const file = batchFile(root, { rows });
      const batches = service();
      const out = await firstRun(batches, root, file);
      expect(states(out)).toEqual(["a:done", "b:failed", "c:done", "d:done"]);
      expect(manifestOf(out).entries[1]!.error).toContain("encoder crashed");
      planned.length = 0;

      const dry = await batches.render(root, root, request(file, { failed: true, dryRun: true }));
      expect(label(dry.entries)).toEqual(["a:done", "b:planned", "c:done", "d:done"]);
      expect(dry.skipped).toEqual([]);

      const again = await batches.render(root, root, request(file, { failed: true }));
      expect(again.jobs.map((job) => job.output)).toEqual([join(out, "b.mp4")]);
      expect(label(again.entries)).toEqual(["a:done", "b:running", "c:done", "d:done"]);
      // Only the failed row is planned (and rendered): the others are neither re-validated nor queued.
      expect(planned.map((stem) => stem.slice(-1))).toEqual(["b", "b"]);
      await finishNext();
      const manifest = await manifestDone(out);
      expect(manifest.entries.map((e) => `${e.row}:${e.status}:${e.error}`)).toEqual(["a:done:null", "b:done:null", "c:done:null", "d:done:null"]);

      const none = await batches.render(root, root, request(file, { failed: true }));
      expect(none).toMatchObject({ jobs: [], skipped: [] });
      expect(none.entries.every((e) => e.status === "done")).toBe(true);
      expect(batches.active(root)).toBe(false);
    });

    it("skips rows that are done with their files in place unless forced, and renders one whose file is gone", async () => {
      const root = tempDir();
      const file = batchFile(root, { rows });
      const batches = service();
      const out = await firstRun(batches, root, file);
      // b failed: a plain re-run renders just b; a, c and d are done and in place.
      const rerun = await batches.render(root, root, request(file));
      expect(rerun.skipped).toEqual(["a", "c", "d"]);
      expect(rerun.jobs.map((job) => job.output)).toEqual([join(out, "b.mp4")]);
      await finishNext();
      await manifestDone(out);

      expect(await batches.render(root, root, request(file))).toMatchObject({ jobs: [], skipped: ids });
      expect(await batches.render(root, root, request(file, { rows: ["c"] }))).toMatchObject({ jobs: [], skipped: ["c"] });

      rmSync(join(out, "c.mp4"));
      const lost = await batches.render(root, root, request(file));
      expect(lost.skipped).toEqual(["a", "b", "d"]);
      expect(lost.jobs.map((job) => job.output)).toEqual([join(out, "c.mp4")]);
      await finishNext();
      await manifestDone(out);

      const forced = await batches.render(root, root, request(file, { rows: ["a", "d"], force: true }));
      expect(forced.skipped).toEqual([]);
      expect(forced.jobs.map((job) => job.output)).toEqual([join(out, "a.mp4")]);
      await finishNext();
      await finishNext();
      const manifest = await manifestDone(out);
      expect(manifest.entries.map((e) => e.status)).toEqual(["done", "done", "done", "done"]);
    });

    it("has no rows left, and takes a re-run, as soon as the last job ends, before the manifest says done", async () => {
      const root = tempDir();
      const file = batchFile(root, { rows: [{ id: "a" }] });
      const batches = service();
      const out = join(root, "exports", "launch");
      await batches.render(root, root, request(file));
      expect(batches.active(root)).toBe(true);
      await finishNext();
      await queue.drained();
      // The manifest write that says `done` is still in flight here.
      expect(batches.active(root)).toBe(false);
      expect(await batches.render(root, root, request(file))).toMatchObject({ jobs: [], skipped: ["a"] });
      expect(manifestOf(out).state).toBe("done");
    });

    it("counts rows a stopped daemon left queued or running as failed, and settles the ones it leaves alone", async () => {
      const root = tempDir();
      const file = batchFile(root, { rows });
      const out = join(root, "exports", "launch");
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "a.mp4"), "video");
      writeManifest(out, file, [entry(out, "a", "done"), entry(out, "b", "running"), entry(out, "c", "queued")]);
      const batches = service();
      // d has no entry, so it is not done either, but it lies outside `rows`.
      const only = await batches.render(root, root, request(file, { failed: true, rows: ["a..c"] }));
      expect(only.jobs.map((job) => job.output)).toEqual([join(out, "b.mp4")]);
      expect(label(only.entries)).toEqual(["a:done", "b:running", "c:queued"]);
      await finishNext();
      await finishNext();
      expect((await manifestDone(out)).entries.map((e) => e.status)).toEqual(["done", "done", "done"]);

      writeManifest(out, file, [entry(out, "a", "done"), entry(out, "b", "running"), entry(out, "c", "queued")]);
      const b = await batches.render(root, root, request(file, { rows: ["b"] }));
      // Nothing runs c any more, so the manifest no longer says queued.
      expect(label(b.entries)).toEqual(["a:done", "b:running", "c:canceled"]);
      expect(b.entries[2]!.error).toContain("daemon stopped");
      await finishNext();
      await manifestDone(out);
    });

    it("needs the manifest of this batch file for failed, and ignores another batch's otherwise", async () => {
      const root = tempDir();
      const file = batchFile(root, { rows });
      const out = join(root, "exports", "launch");
      const batches = service();
      await expect(batches.render(root, root, request(file, { failed: true }))).rejects.toMatchObject({
        code: ErrorCode.InvalidOperation,
        data: { op: "batch.render", reason: "no manifest", field: "failed" },
      });
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "a.mp4"), "video");
      writeManifest(out, join(root, "other.batch.json"), [entry(out, "a", "done")], "done");
      await expect(batches.render(root, root, request(file, { failed: true }))).rejects.toMatchObject({ data: { reason: "manifest of another batch" } });
      // The other batch's done entry for `a` says nothing about this batch: `a` renders.
      const plain = await batches.render(root, root, request(file, { dryRun: true }));
      expect(plain.skipped).toEqual([]);
      expect(label(plain.entries)).toEqual(["a:planned", "b:planned", "c:planned", "d:planned"]);
      writeFileSync(join(out, "manifest.json"), "{ not json");
      await expect(batches.render(root, root, request(file, { failed: true }))).rejects.toMatchObject({ data: { reason: "manifest unreadable" } });
    });
  });
});
