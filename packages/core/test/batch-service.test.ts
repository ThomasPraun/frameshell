import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BatchManifest, ErrorCode, type RenderResult, type ReviewResult } from "@frameshell/protocol";
import type { Timeline } from "@frameshell/schema";
import { BatchService, type BatchServiceOptions } from "../src/batch/service.js";
import type { ReviewRequest } from "../src/review/service.js";
import { rowVariant } from "../src/batch/variant.js";
import type { DueFinal, PlannedRender, RenderRequest } from "../src/export/service.js";
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
/** The template `loadTimeline` answers with; a test swaps it to edit the template between two runs. */
let current: Timeline = template;
/** Stems of every row planned, in order. */
const planned: string[] = [];
/** Ends the oldest running render job: ok, or failed when given an error. */
const finishers: ((error?: Error) => void)[] = [];

afterEach(async () => {
  planned.length = 0;
  current = template;
  finishers.splice(0).forEach((finish) => finish());
  await queue?.close();
});

function service(options: { transcribed?: readonly string[]; review?: BatchServiceOptions["review"]; finals?: DueFinal[] } = {}): BatchService {
  queue = new JobQueue();
  return new BatchService({
    jobs: queue,
    loadTimeline: async () => ({ timeline: current, fps: 30 }),
    applyInMemory: async () => {
      throw new Error("no props slots in these tests");
    },
    source: async () => ({ duration: 5, video: false, audio: true }),
    hasTranscript: async (_root, asset) => (options.transcribed ?? ["assets/vo-es.wav", "assets/vo-fr.wav"]).includes(asset),
    resolveTime: async (_root, ref) => Number(ref),
    duration: async () => null,
    ...(options.review ? { review: options.review } : {}),
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
        finals: options.finals ?? [],
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
                run: (ctx) =>
                  new Promise<void>((resolve, reject) => {
                    // A canceled render stops, as the real one does when its ffmpeg is killed.
                    ctx.signal.addEventListener("abort", () => resolve(), { once: true });
                    finishers.push((error) => {
                      if (error) return reject(error);
                      writeFileSync(render.output, "video");
                      resolve();
                    });
                  }),
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
      root: "/project",
      fps: 30,
      apply: async () => {
        throw new Error("unused");
      },
      source: async () => ({ duration: 5, video: false, audio: true }),
      hasTranscript: async () => false,
      resolve: async (ref: number | string) => Number(ref),
      duration: async () => null,
    };
    const alone = { ...template, tracks: [template.tracks[0]!] } as Timeline;
    const file = { schemaVersion: 1 as const, template: "main", slots: { voice: "c_vo.asset" }, rows: [] };
    const { timeline: variant } = await rowVariant(alone, file, { id: "de", voice: "assets/vo-de.wav" }, context);
    expect((variant.tracks[0] as { clips: unknown[] }).clips[0]).toMatchObject({ asset: "assets/vo-de.wav", in: 0, out: 1 });
  });

  it("refuses a props slot naming a prop the clip's composition does not declare, and takes any prop when it declares none", async () => {
    const card = { ...template, tracks: [{ id: "t_v", kind: "video", clips: [{ id: "c_card", type: "card", source: "cards/a.json", start: 0, duration: 1, props: {} }] }] } as unknown as Timeline;
    const context = (declared: readonly string[] | null) => ({
      root: "/project",
      fps: 30,
      apply: async (timeline: Timeline) => ({ timeline }) as never,
      source: async () => ({ duration: 5, video: true, audio: false }),
      hasTranscript: async () => false,
      resolve: async (ref: number | string) => Number(ref),
      duration: async () => null,
      declaredProps: async () => declared,
    });
    const file = { schemaVersion: 1 as const, template: "main", slots: { title: "c_card.props.title", deep: "c_card.props.style.color", own: "c_card.props" }, rows: [] };
    await expect(rowVariant(card, file, { id: "es", title: "Hola" }, context(["title", "style"]))).resolves.toBeDefined();
    await expect(rowVariant(card, file, { id: "es", deep: "red" }, context(["title", "style"]))).resolves.toBeDefined();
    await expect(rowVariant(card, file, { id: "fr", own: "Salut" }, context(["title", "style"]))).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining("declares the props title, style, not own"),
      data: { op: "batch.render", row: "fr", slot: "own", reason: "unknown prop", prop: "own", declared: ["title", "style"] },
    });
    await expect(rowVariant(card, file, { id: "fr", title: "Salut" }, context(null))).resolves.toBeDefined();
    const { declaredProps: _declared, ...undeclared } = context(null);
    await expect(rowVariant(card, file, { id: "fr", own: "Salut" }, undeclared)).resolves.toBeDefined();
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

  it("asks before any row queues when the finals of every row are estimated over 5 minutes in all (ADR 0035)", async () => {
    const root = tempDir();
    const file = batchFile(root, { rows: [{ id: "es", voice: "assets/vo-es.wav" }, { id: "fr", voice: "assets/vo-fr.wav" }] });
    const out = join(root, "deliver");
    // 200 s per row: each row alone is under the limit, the batch is not.
    const batches = service({ finals: [{ clip: "c_3d", type: "blender", format: "1x1", seconds: 200 }] });
    await expect(batches.render(root, root, { file, out, failed: false, force: false, dryRun: false })).rejects.toMatchObject({
      code: ErrorCode.ConfirmationRequired,
      message: expect.stringContaining("This batch renders the final renders of 2 generated clips first, estimated at about 6.7 min"),
      data: { seconds: 400, limit: 300, finals: [{ clip: "c_3d", row: "es", seconds: 200 }, { clip: "c_3d", row: "fr", seconds: 200 }] },
    });
    expect(existsSync(join(out, "manifest.json"))).toBe(false);
    expect(queue.list()).toEqual([]);
    // A dry run only plans; `yes` is the person's agreement.
    expect((await batches.render(root, root, { file, out, failed: false, force: false, dryRun: true })).dryRun).toBe(true);
    const result = await batches.render(root, root, { file, out, failed: false, force: false, dryRun: false, yes: true });
    expect(result.jobs).toHaveLength(1);
    await finishNext();
    await finishNext();
    await manifestDone(out);
  });

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

  describe("re-runs", () => {
    const ids = ["a", "b", "c", "d"];
    const rows = ids.map((id) => ({ id }));

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
  describe("review column", () => {
    /** A stand-in `review` that answers per output file, in the order it is called, and can be held. */
    function reviewer(answers: Record<string, { craft?: string[]; failed?: number; error?: string }>) {
      const calls: ReviewRequest[] = [];
      const holds: (() => void)[] = [];
      let hold = false;
      const review: NonNullable<BatchServiceOptions["review"]> = async (_root, request) => {
        calls.push(request);
        if (hold) await new Promise<void>((resolve) => holds.push(resolve));
        const answer = answers[basename(request.file!)] ?? {};
        if (answer.error) throw new Error(`${answer.error}\nsecond line`);
        return {
          run: calls.length,
          metrics: { craft: (answer.craft ?? []).map((check) => ({ check, message: check, severity: "warn" })), requirements: answer.failed === undefined ? null : { failed: answer.failed } },
        } as unknown as ReviewResult;
      };
      return {
        review,
        calls,
        holds,
        hold: (on: boolean) => {
          hold = on;
        },
      };
    }

    it("reviews each rendered file while the next row renders, and says running until the last review ended", async () => {
      const root = tempDir();
      const file = batchFile(root, { rows: [{ id: "a" }, { id: "b" }, { id: "c" }] });
      const found = reviewer({ "a.mp4": { craft: ["static", "peak", "static"] }, "b.mp4": { craft: [], failed: 1 }, "c.mp4": {} });
      found.hold(true);
      const batches = service({ review: found.review });
      const out = join(root, "exports", "launch");
      await batches.render(root, root, request(file, { review: true }));
      await finishNext();
      await until(() => found.calls.length === 1);
      // The first review is held, yet the second row's render is already running.
      await until(() => finishers.length === 1);
      await until(() => statesNow(out) === "a:done,b:running,c:queued");
      expect(manifestOf(out).entries[0]!.review).toMatchObject({ state: "pending" });
      await finishNext();
      await finishNext();
      await queue.drained();
      // Every render ended, but the batch is not over: reviews are left, one at a time.
      expect(batches.active(root)).toBe(true);
      expect(found.calls).toHaveLength(1);
      found.hold(false);
      found.holds.shift()!();
      const manifest = await manifestDone(out);
      expect(found.calls.map((call) => basename(call.file!))).toEqual(["a.mp4", "b.mp4", "c.mp4"]);
      expect(manifest.entries.map((entry) => entry.review)).toEqual([
        { state: "done", verdict: "warn", warnings: 3, failed: 0, checks: ["static", "peak"], run: 1, error: null },
        { state: "done", verdict: "fail", warnings: 0, failed: 1, checks: [], run: 2, error: null },
        { state: "done", verdict: "pass", warnings: 0, failed: 0, checks: [], run: 3, error: null },
      ]);
      expect(found.calls[0]).toMatchObject({ timeline: "main", file: join(out, "a.mp4"), sheets: ["metrics"], view: "current", preset: "youtube-1080p" });
      expect(found.calls[0]).not.toHaveProperty("projectFormat");
      expect(batches.active(root)).toBe(false);
    });

    it("names the format of a listed format and leaves the preset out of a draft", async () => {
      const root = tempDir();
      const found = reviewer({});
      const batches = service({ review: found.review });
      const out = join(root, "exports", "launch");
      const listed = batchFile(root, { rows: [{ id: "a" }], formats: ["9x16"] });
      await batches.render(root, root, request(listed, { review: true }));
      await finishNext();
      await manifestDone(out);
      expect(found.calls[0]).toMatchObject({ file: join(out, "a-9x16.mp4"), preset: "youtube-1080p", projectFormat: "9x16" });

      const draft = batchFile(root, { rows: [{ id: "a" }], quality: "draft" });
      await batches.render(root, root, request(draft, { review: true, force: true }));
      await finishNext();
      await until(() => found.calls.length === 2);
      expect(found.calls[1]).not.toHaveProperty("preset");
    });

    it("leaves a failed render without a review, and a review that cannot run never fails the render", async () => {
      const root = tempDir();
      const file = batchFile(root, { rows: [{ id: "a" }, { id: "b" }] });
      const found = reviewer({ "b.mp4": { error: "ffmpeg is not ready" } });
      const batches = service({ review: found.review });
      const out = join(root, "exports", "launch");
      await batches.render(root, root, request(file, { review: true }));
      await finishNext(new Error("encoder crashed"));
      await finishNext();
      const manifest = await manifestDone(out);
      expect(manifest.entries.map((entry) => [entry.status, entry.review?.state ?? null])).toEqual([
        ["failed", null],
        ["done", "error"],
      ]);
      expect(manifest.entries[1]!.review).toMatchObject({ verdict: null, error: "ffmpeg is not ready" });
      expect(found.calls.map((call) => basename(call.file!))).toEqual(["b.mp4"]);
    });

    it("writes no review unless asked, and refuses to when the daemon cannot review", async () => {
      const root = tempDir();
      const file = batchFile(root, { rows: [{ id: "a" }] });
      const found = reviewer({});
      const out = join(root, "exports", "launch");
      const batches = service({ review: found.review });
      await batches.render(root, root, request(file));
      await finishNext();
      expect((await manifestDone(out)).entries[0]!.review).toBeNull();
      expect(found.calls).toEqual([]);
      await expect(service().render(root, root, request(file, { review: true }))).rejects.toMatchObject({ data: { reason: "review unavailable", field: "review" } });
    });

    it("reviews rows skipped as done only when they have no finished review, and starts no render for them", async () => {
      const root = tempDir();
      const file = batchFile(root, { rows: [{ id: "a" }, { id: "b" }] });
      const found = reviewer({});
      const batches = service({ review: found.review });
      const out = join(root, "exports", "launch");
      await batches.render(root, root, request(file));
      await finishNext();
      await finishNext();
      await manifestDone(out);

      const again = await batches.render(root, root, request(file, { review: true }));
      expect(again).toMatchObject({ jobs: [], skipped: ["a", "b"] });
      expect(again.entries.map((entry) => entry.review?.state)).toEqual(["pending", "pending"]);
      const reviewed = await manifestDone(out);
      expect(reviewed.entries.map((entry) => entry.review?.state)).toEqual(["done", "done"]);
      expect(found.calls).toHaveLength(2);

      // Reviewed already: nothing runs again.
      expect(await batches.render(root, root, request(file, { review: true }))).toMatchObject({ jobs: [], skipped: ["a", "b"] });
      expect(found.calls).toHaveLength(2);
    });
  });

  describe("row data hash", () => {
    const rows = [
      { id: "es", voice: "assets/vo-es.wav" },
      { id: "fr", voice: "assets/vo-fr.wav" },
    ];
    async function firstRun(batches: BatchService, root: string, file: string): Promise<string> {
      const out = join(root, "exports", "launch");
      await batches.render(root, root, request(file));
      await finishNext();
      await finishNext();
      await manifestDone(out);
      return out;
    }

    it("renders a done row again without force when its cells changed, and skips the unchanged one", async () => {
      const root = tempDir();
      const batches = service();
      const out = await firstRun(batches, root, batchFile(root, { rows }));
      expect(manifestOf(out).entries.map((entry) => entry.hash)).toEqual([expect.stringMatching(/^[0-9a-f]{32}$/), expect.stringMatching(/^[0-9a-f]{32}$/)]);
      const [es, fr] = manifestOf(out).entries.map((entry) => entry.hash);
      expect(es).not.toBe(fr);

      // Nothing edited: both skipped, no job.
      expect(await batches.render(root, root, request(batchFile(root, { rows })))).toMatchObject({ jobs: [], skipped: ["es", "fr"], changed: [] });

      // `fr` gets another voice: only it renders, and the manifest keeps `es` as it was.
      const edited = batchFile(root, { rows: [rows[0], { id: "fr", voice: "assets/vo-es.wav" }] });
      const plan = await batches.render(root, root, request(edited, { dryRun: true }));
      expect(plan).toMatchObject({ skipped: ["es"], changed: ["fr"] });
      expect(label(plan.entries)).toEqual(["es:done", "fr:planned"]);
      const result = await batches.render(root, root, request(edited));
      expect(result.jobs.map((job) => basename(job.output!))).toEqual(["fr.mp4"]);
      expect(result).toMatchObject({ skipped: ["es"], changed: ["fr"] });
      await finishNext();
      const after = await manifestDone(out);
      expect(label(after.entries)).toEqual(["es:done", "fr:done"]);
      expect(after.entries[0]!.hash).toBe(es);
      expect(after.entries[1]!.hash).not.toBe(fr);
    });

    it("sees an edit of the slots or the template, not a new revision of the same content", async () => {
      const root = tempDir();
      const batches = service({ transcribed: ["assets/vo-es.wav", "assets/vo-fr.wav", "assets/vo-en.wav"] });
      const file = batchFile(root, { rows });
      await firstRun(batches, root, file);
      current = { ...template, revision: 7 } as Timeline;
      expect(await batches.render(root, root, request(file, { dryRun: true }))).toMatchObject({ skipped: ["es", "fr"], changed: [] });
      current = { ...template, tracks: [{ ...template.tracks[0], clips: [{ ...(template.tracks[0] as { clips: object[] }).clips[0], out: 0.8 }] }, template.tracks[1]] } as unknown as Timeline;
      expect(await batches.render(root, root, request(file, { dryRun: true }))).toMatchObject({ skipped: [], changed: ["es", "fr"] });
      current = template;
      const moved = batchFile(root, { slots: { voice: "c_vo.asset", spare: "c_vo.asset" }, rows });
      expect(await batches.render(root, root, request(moved, { dryRun: true }))).toMatchObject({ skipped: [], changed: ["es", "fr"] });
    });

    it("treats a manifest from before hashes as unchanged, and `force` as no change report", async () => {
      const root = tempDir();
      const batches = service();
      const file = batchFile(root, { rows });
      const out = await firstRun(batches, root, file);
      const manifest = manifestOf(out);
      writeFileSync(join(out, "manifest.json"), JSON.stringify({ ...manifest, entries: manifest.entries.map(({ hash: _hash, ...entry }) => entry) }));
      expect(await batches.render(root, root, request(file, { dryRun: true }))).toMatchObject({ skipped: ["es", "fr"], changed: [] });
      expect(await batches.render(root, root, request(batchFile(root, { rows: [rows[0], { id: "fr", voice: "assets/vo-es.wav" }] }), { dryRun: true }))).toMatchObject({
        skipped: ["es", "fr"],
        changed: [],
      });
      const forced = await batches.render(root, root, request(batchFile(root, { rows: [rows[0], { id: "fr", voice: "assets/vo-es.wav" }] }), { dryRun: true, force: true }));
      expect(forced).toMatchObject({ skipped: [], changed: [] });
      expect(label(forced.entries)).toEqual(["es:planned", "fr:planned"]);
    });
  });

  describe("cancel", () => {
    const rows = ["a", "b", "c"].map((id) => ({ id }));

    it("stops a running batch: the running row's job is canceled, later rows are never queued, the manifest says canceled", async () => {
      const root = tempDir();
      const batches = service();
      const file = batchFile(root, { rows });
      const out = join(root, "exports", "launch");
      await batches.render(root, root, request(file));
      await finishNext();
      // Row `a` is done, `b` is rendering, `c` waits.
      await until(() => finishers.length === 1 && statesNow(out) === "a:done,b:running,c:queued");
      const result = await batches.cancel(root, root, { file });
      expect(result).toMatchObject({ dir: root, file, out, manifest: join(out, "manifest.json"), state: "canceled", canceled: ["b", "c"] });
      expect(label(result.entries)).toEqual(["a:done", "b:canceled", "c:canceled"]);
      expect(result.entries[2]).toMatchObject({ job: null, startedAt: null });
      const manifest = await ended(out);
      expect(manifest.state).toBe("canceled");
      expect(label(manifest.entries)).toEqual(["a:done", "b:canceled", "c:canceled"]);
      expect(planned.map((stem) => basename(stem))).toEqual(["a", "b", "c"]);
      // No job exists for `c`, and the project is no longer busy.
      expect(queue.list().map((job) => basename(job.output!))).toEqual(["a.mp4", "b.mp4"]);
      expect(batches.active(root)).toBe(false);
      expect(existsSync(join(out, "c.mp4"))).toBe(false);
    });

    it("lets the next call re-run what did not finish with `failed`, and reads a canceled manifest as one to re-run", async () => {
      const root = tempDir();
      const batches = service();
      const file = batchFile(root, { rows });
      const out = join(root, "exports", "launch");
      await batches.render(root, root, request(file));
      await finishNext();
      await until(() => statesNow(out) === "a:done,b:running,c:queued");
      await batches.cancel(root, root, { file });
      // The canceled render's own finisher is left over: its job already ended.
      finishers.splice(0);
      const again =await batches.render(root, root, request(file, { failed: true }));
      // `a` is done, so `failed` does not choose it at all.
      expect(again.skipped).toEqual([]);
      expect(again.jobs.map((job) => basename(job.output!))).toEqual(["b.mp4"]);
      await finishNext();
      await finishNext();
      expect(label((await manifestDone(out)).entries)).toEqual(["a:done", "b:done", "c:done"]);
    });

    it("cancels a batch whose first row is running, and refuses when none is rendering or it is another file", async () => {
      const root = tempDir();
      const batches = service();
      const file = batchFile(root, { rows });
      await expect(batches.cancel(root, root, { file })).rejects.toMatchObject({
        code: ErrorCode.InvalidOperation,
        data: { op: "batch.cancel", reason: "no batch running", field: "out" },
      });
      const out = join(root, "deliver");
      await batches.render(root, root, request(file, { out }));
      await expect(batches.cancel(root, root, { file: join(root, "other.batch.json"), out })).rejects.toMatchObject({ data: { reason: "other batch" } });
      const result = await batches.cancel(root, root, { file, out });
      expect(result.canceled).toEqual(["a", "b", "c"]);
      // A second call finds nothing running.
      await expect(batches.cancel(root, root, { file, out })).rejects.toMatchObject({ data: { reason: "no batch running" } });
    });
  });

  /** `a:done,b:running` as the manifest on disk says now; empty while it is not there or being replaced. */
  const statesNow = (out: string): string => {
    try {
      return states(out).join();
    } catch {
      return "";
    }
  };
  const ended = async (out: string): Promise<BatchManifest> => {
    await until(() => {
      try {
        return manifestOf(out).state !== "running";
      } catch {
        return false;
      }
    });
    return manifestOf(out);
  };
});
