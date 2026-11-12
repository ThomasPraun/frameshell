import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BeatsWatcher, type BeatsFileChange } from "../src/media/beats-watcher.js";
import { formatBeatsFile } from "../src/media/beats-store.js";
import { tempDir } from "./helpers.js";

// Seam under test: BeatsWatcher reports a beats file written, hand-edited, broken or deleted once its write settled
// (ADR 0029 slice 3), so the app's grid follows a hand edit live. Real files, real chokidar.

const FILE = {
  schemaVersion: 1 as const,
  asset: "assets/song.wav",
  assetHash: `sha256:${"b".repeat(64)}`,
  detector: "onset-flux@1",
  bpm: 120,
  meter: 4,
  downbeat: 0,
  confidence: 0.9,
  beats: [0.2, 0.7, 1.2, 1.7],
  edits: {},
};

let watcher: BeatsWatcher | undefined;

afterEach(async () => {
  await watcher?.close();
  watcher = undefined;
});

/** Collect changes; resolves a promise for the n-th report. */
function collect() {
  const seen: BeatsFileChange[] = [];
  const waiting: { count: number; done: () => void }[] = [];
  const onChange = (change: BeatsFileChange) => {
    seen.push(change);
    for (const wait of waiting) if (seen.length >= wait.count) wait.done();
  };
  const until = (count: number) =>
    new Promise<void>((resolve, reject) => {
      if (seen.length >= count) return resolve();
      const timer = setTimeout(() => reject(new Error(`expected ${count} reports, got ${JSON.stringify(seen)}`)), 8_000);
      waiting.push({ count, done: () => (clearTimeout(timer), resolve()) });
    });
  return { seen, onChange, until };
}

/** Let chokidar finish its initial scan, so what follows is a change and not a first listing. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

describe("BeatsWatcher", () => {
  it("reports a file written into a beats/ folder that did not exist, a valid hand edit, a broken one and a deletion", async () => {
    const root = tempDir();
    const { seen, onChange, until } = collect();
    watcher = new BeatsWatcher({ onChange, stabilityMs: 30 });
    watcher.attach(root);
    await settle();

    mkdirSync(join(root, "beats"), { recursive: true });
    const path = join(root, "beats", "song.beats.json");
    writeFileSync(path, formatBeatsFile(FILE));
    await until(1);
    expect(seen[0]).toEqual({ root, file: "beats/song.beats.json", change: "written" });

    writeFileSync(path, formatBeatsFile({ ...FILE, edits: { tempo: "double" } }));
    await until(2);
    expect(seen[1]).toEqual({ root, file: "beats/song.beats.json", change: "written" });

    writeFileSync(path, '{ "schemaVersion": 1, "beats": "nope" }');
    await until(3);
    expect(seen[2]).toMatchObject({ file: "beats/song.beats.json", change: "invalid", message: expect.stringContaining("Invalid") });

    writeFileSync(path, formatBeatsFile(FILE));
    await until(4);
    expect(seen[3]).toMatchObject({ change: "written" });

    rmSync(path);
    await until(5);
    expect(seen[4]).toEqual({ root, file: "beats/song.beats.json", change: "removed" });
  }, 30_000);

  it("ignores files that are not beats files, and names nested files with their folder", async () => {
    const root = tempDir();
    mkdirSync(join(root, "beats", "albums"), { recursive: true });
    const { seen, onChange, until } = collect();
    watcher = new BeatsWatcher({ onChange, stabilityMs: 30 });
    watcher.attach(root);
    await settle();

    writeFileSync(join(root, "beats", "notes.txt"), "not a grid");
    writeFileSync(join(root, "beats", "song.beats.json.123.abc.tmp"), "{}");
    writeFileSync(join(root, "beats", "albums", "one.beats.json"), formatBeatsFile(FILE));
    await until(1);
    await settle();
    expect(seen).toEqual([{ root, file: "beats/albums/one.beats.json", change: "written" }]);
  }, 30_000);

  it("does not report what was already there when it attached", async () => {
    const root = tempDir();
    mkdirSync(join(root, "beats"), { recursive: true });
    writeFileSync(join(root, "beats", "old.beats.json"), formatBeatsFile(FILE));
    const { seen, onChange } = collect();
    watcher = new BeatsWatcher({ onChange, stabilityMs: 30 });
    watcher.attach(root);
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    expect(seen).toEqual([]);
  }, 30_000);
});
