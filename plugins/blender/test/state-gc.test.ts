import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { AdapterGcContext } from "@frameshell/plugin-api";
import { BlendDeps, listingPath, sweepState } from "../src/index.js";
import { tempDir, writeBlend } from "./stub.js";

// The state `gc` cleans is plain files under `.frameshell/blender/`, so none of this needs a Blender (or a POSIX shell).
describe("gc of .frameshell/blender", () => {
  const STATE = ".frameshell/blender";
  const HOUR = 3_600_000;
  const OLD = new Date(Date.now() - HOUR);
  let project: string;

  /** A file of `content` that was last written `at` (default an hour ago, well before any grace floor), and so was its folder. */
  const put = (rel: string, content = "x", at: Date = OLD) => {
    const file = join(project, ...rel.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    utimesSync(file, at, at);
    utimesSync(dirname(file), at, at);
  };
  const exists = (rel: string) => existsSync(join(project, ...rel.split("/")));
  const context = (inputs: string[], overrides: Partial<AdapterGcContext> = {}): AdapterGcContext => ({
    projectDir: project,
    inputs: new Set(inputs),
    dryRun: false,
    keepNewerThan: Date.now() - 60_000,
    signal: new AbortController().signal,
    ...overrides,
  });

  const live = `${STATE}/aaaaaaaaaaaaaaaa-11111111`;
  const stale = `${STATE}/bbbbbbbbbbbbbbbb-22222222`;
  const onlyOutside = `${STATE}/cccccccccccccccc-33333333`;

  beforeEach(() => {
    project = tempDir();
    put(`${live}/deps.json`, "live");
    put(`${stale}/deps.json`, "stale-deps");
    put(`${stale}/outside.json`, "stale-outside");
    put(`${onlyOutside}/deps.json`, "d");
    put(`${onlyOutside}/outside.json`, "o");
    put(`${STATE}/range/0-500ms.json`, "{}");
    put(`${STATE}/range/0-900ms.json`, "{}");
    put(`${STATE}/version/4.5.3.json`, "{}");
    put(`${STATE}/version/5.0.1.json`, "{}");
    put(`${STATE}/finals.json`, "{}");
  });

  const inUse = [`${live}/deps.json`, `${onlyOutside}/outside.json`, `${STATE}/range/0-500ms.json`, `${STATE}/version/4.5.3.json`];

  it("deletes listing folders, length markers and version markers no clip names, and keeps what one does", async () => {
    const removed = await sweepState(context(inUse));
    expect(removed).toEqual([
      { path: `${stale}/`, bytes: "stale-deps".length + "stale-outside".length },
      { path: `${STATE}/range/0-900ms.json`, bytes: 2 },
      { path: `${STATE}/version/5.0.1.json`, bytes: 2 },
    ]);
    for (const kept of [...inUse, `${live}/deps.json`, `${onlyOutside}/deps.json`, `${STATE}/finals.json`]) expect(exists(kept)).toBe(true);
    for (const gone of [stale, `${STATE}/range/0-900ms.json`, `${STATE}/version/5.0.1.json`]) expect(exists(gone)).toBe(false);
  });

  it("keeps a listing folder when either of its two key inputs is in use", async () => {
    expect(await sweepState(context([`${stale}/deps.json`]))).not.toContainEqual(expect.objectContaining({ path: `${stale}/` }));
    expect(exists(`${stale}/outside.json`)).toBe(true);
    expect(await sweepState(context([`${stale}/outside.json`]))).not.toContainEqual(expect.objectContaining({ path: `${stale}/` }));
  });

  it("lists the same entries on a dry run and deletes nothing", async () => {
    const would = await sweepState(context(inUse, { dryRun: true }));
    expect(would.map((entry) => entry.path)).toEqual([`${stale}/`, `${STATE}/range/0-900ms.json`, `${STATE}/version/5.0.1.json`]);
    expect(exists(`${stale}/deps.json`) && exists(`${STATE}/range/0-900ms.json`) && exists(`${STATE}/version/5.0.1.json`)).toBe(true);
    expect(await sweepState(context(inUse))).toEqual(would);
  });

  it("recognises entries by name only: finals.json, unknown names, other folders and symlinks stay", async () => {
    put(`${STATE}/notes.txt`);
    put(`${STATE}/range/readme.json`);
    put(`${STATE}/range/12ms.json.123.tmp`);
    put(`${STATE}/version/latest.json`);
    put(`${STATE}/other/deps.json`);
    put(`${STATE}/EEEEEEEEEEEEEEEE-55555555/deps.json`);
    put(`${STATE}/bbbbbbbbbbbbbbbb-2222222/deps.json`);
    put(`${STATE}/outside-target/deps.json`);
    let linked = false;
    try {
      symlinkSync(join(project, ...`${STATE}/outside-target`.split("/")), join(project, ...`${STATE}/dddddddddddddddd-44444444`.split("/")), "junction");
      linked = true;
    } catch {
      // No right to make links here: the other cases still run.
    }
    await sweepState(context(inUse));
    for (const kept of [`${STATE}/notes.txt`, `${STATE}/range/readme.json`, `${STATE}/range/12ms.json.123.tmp`, `${STATE}/version/latest.json`, `${STATE}/finals.json`, `${STATE}/other/deps.json`])
      expect(exists(kept)).toBe(true);
    expect(exists(`${STATE}/EEEEEEEEEEEEEEEE-55555555/deps.json`)).toBe(true);
    expect(exists(`${STATE}/bbbbbbbbbbbbbbbb-2222222/deps.json`)).toBe(true);
    if (linked) {
      expect(exists(`${STATE}/dddddddddddddddd-44444444`)).toBe(true);
      expect(exists(`${STATE}/outside-target/deps.json`)).toBe(true);
    }
  });

  it("keeps whatever was written at or after the grace floor, however it is named: a listing a key check just wrote survives", async () => {
    const floor = Date.now() - 60_000;
    // A fresh outside.json in an otherwise old, unused folder keeps the whole folder.
    put(`${stale}/outside.json`, "fresh", new Date(Date.now() - 1000));
    put(`${STATE}/range/0-700ms.json`, "{}", new Date(Date.now() - 1000));
    const removed = await sweepState(context(inUse, { keepNewerThan: floor }));
    expect(removed.map((entry) => entry.path)).toEqual([`${STATE}/range/0-900ms.json`, `${STATE}/version/5.0.1.json`]);
    expect(exists(`${stale}/deps.json`)).toBe(true);
    expect(exists(`${STATE}/range/0-700ms.json`)).toBe(true);
    // The same files are old against a later floor: only what the inputs name stays.
    const later = await sweepState(context(inUse, { keepNewerThan: Date.now() + HOUR }));
    expect(later.map((entry) => entry.path)).toEqual([`${stale}/`, `${STATE}/range/0-700ms.json`]);
  });

  it("recognises range markers with a start (<inMs>-<endMs>ms.json) and those an older plugin wrote (<endMs>ms.json)", async () => {
    put(`${STATE}/range/300-900ms.json`, "{}");
    put(`${STATE}/range/700ms.json`, "{}");
    const removed = await sweepState(context([...inUse, `${STATE}/range/300-900ms.json`]));
    expect(removed.map((entry) => entry.path)).toEqual([`${stale}/`, `${STATE}/range/0-900ms.json`, `${STATE}/range/700ms.json`, `${STATE}/version/5.0.1.json`]);
    expect(exists(`${STATE}/range/300-900ms.json`)).toBe(true);
  });

  describe("finals.json", () => {
    const FINALS = `${STATE}/finals.json`;
    const body = JSON.stringify({ sources: { "scenes/used.blend": 4.5, "scenes/gone.blend": 7 }, last: 7 }, null, 2) + "\n";
    /** What a sweep reports about finals.json alone (the project also has the stale entries the cases above delete). */
    const sweptFinals = async (gc: AdapterGcContext) => (await sweepState(gc)).filter((entry) => entry.path === FINALS);
    const read = () => JSON.parse(readFileSync(join(project, ...FINALS.split("/")), "utf8")) as { sources: Record<string, number>; last: number | null };

    it("drops the rate of a .blend no clip uses, keeps the one in use and `last`, and reports the bytes it shrank by", async () => {
      put(FINALS, body);
      const removed = await sweptFinals(context(["scenes/used.blend"]));
      const after = readFileSync(join(project, ...FINALS.split("/")), "utf8");
      expect(removed).toEqual([{ path: FINALS, bytes: body.length - after.length }]);
      expect(removed[0]!.bytes).toBeGreaterThan(0);
      expect(read()).toEqual({ sources: { "scenes/used.blend": 4.5 }, last: 7 });
    });

    it("leaves the file as it is on a dry run, and reports the same entry", async () => {
      put(FINALS, body);
      const would = await sweptFinals(context(["scenes/used.blend"], { dryRun: true }));
      expect(would.map((entry) => entry.path)).toEqual([FINALS]);
      expect(readFileSync(join(project, ...FINALS.split("/")), "utf8")).toBe(body);
      expect(await sweptFinals(context(["scenes/used.blend"]))).toEqual(would);
    });

    it("keeps a file written at or after the grace floor", async () => {
      put(FINALS, body, new Date(Date.now() - 1000));
      expect(await sweptFinals(context([]))).toEqual([]);
      expect(readFileSync(join(project, ...FINALS.split("/")), "utf8")).toBe(body);
    });

    it("keeps a file whose .blend files are all in use", async () => {
      put(FINALS, body);
      expect(await sweptFinals(context(["scenes/used.blend", "scenes/gone.blend"]))).toEqual([]);
      expect(readFileSync(join(project, ...FINALS.split("/")), "utf8")).toBe(body);
    });

    it("is harmless when the file is missing or not JSON", async () => {
      rmSync(join(project, ...FINALS.split("/")), { force: true });
      expect(await sweptFinals(context([]))).toEqual([]);
      expect(exists(FINALS)).toBe(false);
      put(FINALS, "not json {");
      expect(await sweptFinals(context([]))).toEqual([]);
      expect(readFileSync(join(project, ...FINALS.split("/")), "utf8")).toBe("not json {");
    });
  });

  it("finds nothing to do in a project that never ran Blender", async () => {
    expect(await sweepState({ ...context([]), projectDir: tempDir() })).toEqual([]);
  });

  describe("with the listings the adapter remembers", () => {
    const SOURCE = "scenes/intro.blend";

    it("forgets a deleted listing, so a .blend saved back to that version is listed again, not served a missing file", async () => {
      const deps = new BlendDeps(project);
      writeBlend(project, SOURCE, { fps: 10 });
      const info = await deps.hash(SOURCE);
      const listing = listingPath(SOURCE, info);
      put(listing, `${JSON.stringify({ blend: SOURCE, paths: [], outside: 0 })}\n`);
      const noBlender = join(project, "no-such-blender");
      // Read from disk, and remembered: no Blender is needed.
      expect(await deps.list(SOURCE, noBlender, info)).toEqual({ inside: [], outside: [] });
      await sweepAndForget(deps, context([]));
      expect(exists(listing)).toBe(false);
      // Without `forget` this would resolve from memory with a path to the deleted file.
      await expect(deps.list(SOURCE, noBlender, info)).rejects.toThrow();
    });

    it("keeps the memory of a listing that stays", async () => {
      const deps = new BlendDeps(project);
      writeBlend(project, SOURCE, { fps: 10 });
      const info = await deps.hash(SOURCE);
      const listing = listingPath(SOURCE, info);
      put(listing, `${JSON.stringify({ blend: SOURCE, paths: ["tex.png"], outside: 0 })}\n`);
      const noBlender = join(project, "no-such-blender");
      await deps.list(SOURCE, noBlender, info);
      await sweepAndForget(deps, context([listing]));
      expect(await deps.list(SOURCE, noBlender, info)).toEqual({ inside: ["tex.png"], outside: [] });
    });

    it("does not remember a listing an abort ended, and starts no Blender for a signal already aborted", async () => {
      const deps = new BlendDeps(project);
      writeBlend(project, SOURCE, { fps: 10 });
      const info = await deps.hash(SOURCE);
      const noBlender = join(project, "no-such-blender");
      const aborted = new AbortController();
      aborted.abort();
      await expect(deps.list(SOURCE, noBlender, info, aborted.signal)).rejects.toMatchObject({ name: "AbortError" });
      // The next key check, with a live signal, tries again: once the listing exists on disk it is served.
      put(listingPath(SOURCE, info), `${JSON.stringify({ blend: SOURCE, paths: [], outside: 0 })}\n`);
      expect(await deps.list(SOURCE, noBlender, info, new AbortController().signal)).toEqual({ inside: [], outside: [] });
    });

    /** What the adapter's `gc` does: sweep, then `forget` what went. */
    async function sweepAndForget(deps: BlendDeps, gc: AdapterGcContext): Promise<void> {
      deps.forget((await sweepState(gc)).map((entry) => entry.path));
    }
  });
});
