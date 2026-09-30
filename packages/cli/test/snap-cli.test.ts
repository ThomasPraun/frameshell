import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testBinariesDir } from "../../core/test/media-tools.js";
import { speechLikeWav, voicedAt } from "../../core/test/speech-fixture.js";

// Black-box: built CLI, auto-started daemon, one imported synthetic speech-like WAV
// (tones = words, gaps = pauses; see speech-fixture.ts) on an audio track.
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-snap-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-snap-${randomUUID().slice(0, 8)}.sock`);

function frameshell(args: string[], cwd = project) {
  const result = spawnSync(process.execPath, [cliBin, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      FRAMESHELL_SOCKET: socketPath,
      FRAMESHELL_IDLE_TIMEOUT_MS: "1500",
      FRAMESHELL_DATA_DIR: testBinariesDir(),
      FRAMESHELL_CONFIG_DIR: testBinariesDir(),
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function json<T = Record<string, unknown>>(args: string[]): T {
  const result = frameshell([...args, "--json"]);
  if (result.code !== 0) throw new Error(`frameshell ${args.join(" ")} exited ${result.code}: ${result.stderr}`);
  return JSON.parse(result.stdout) as T;
}

interface Snap {
  field: string;
  clip: string | null;
  requested: number;
  applied: number;
  clean: boolean;
}
interface Result {
  revision: number;
  snaps: Snap[];
}
interface MediaClipView {
  id: string;
  start: number;
  in: number;
  out: number;
}

const onGrid = (seconds: number) => Math.abs(seconds * 30 - Math.round(seconds * 30)) < 0.02;
const clips = () => json<{ tracks: { clips: MediaClipView[] }[] }>(["timeline", "show"]).tracks[0]!.clips;

let project: string;
let daemonPid: number | undefined;

beforeAll(() => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-snap-")));
  project = join(parent, "talk");
  expect(frameshell(["init", project], parent).code).toBe(0);
  const footage = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-speech-")));
  writeFileSync(join(footage, "speech.wav"), speechLikeWav(48_000));
  // --wait: ingest writes the PCM sidecar that snapping reads.
  expect(frameshell(["import", join(footage, "speech.wav"), "--wait"]).code).toBe(0);
  daemonPid = json<{ daemon: { pid: number } }>(["status"]).daemon.pid;
  const track = json<{ changes: { added: string[] } }>(["track", "add", "audio"]).changes.added[0]!;
  expect(frameshell(["clip", "add", track, "assets/speech.wav", "--start", "0"]).code).toBe(0);
}, 120_000);

afterAll(async () => {
  for (let i = 0; daemonPid && i < 100; i++) {
    try {
      process.kill(daemonPid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

describe("cut snapping to audio energy", () => {
  it("moves both edges of a cut out of words into pauses, on the frame grid, and reports them", () => {
    // 0.7 is inside the word 0.1-0.8; 2.3 inside the word 1.7-2.5.
    const result = json<Result>(["cut", "--from", "0.7", "--to", "2.3"]);
    expect(result.snaps.map(({ field, requested, clean }) => ({ field, requested, clean }))).toEqual([
      { field: "from", requested: 0.7, clean: true },
      { field: "to", requested: 2.3, clean: true },
    ]);
    const [from, to] = result.snaps.map((snap) => snap.applied) as [number, number];
    expect(from).toBeGreaterThan(0.8);
    expect(from).toBeLessThan(1.1);
    expect(to).toBeGreaterThan(2.5);
    expect(to).toBeLessThan(3.5);
    for (const t of [from, to]) {
      expect(onGrid(t)).toBe(true);
      expect(voicedAt(t)).toBe(false);
    }
    // The timeline agrees: the kept head ends at `from`, the tail resumes at source `to`.
    expect(clips()).toEqual([
      expect.objectContaining({ start: 0, in: 0, out: from }),
      expect.objectContaining({ start: from, in: to }),
    ]);
    expect(readdirSync(join(project, ".frameshell", "energy")).filter((name) => name.endsWith(".f32"))).toHaveLength(1);
  });

  it("reports a cut with no pause in reach as unclean, and says so in the human output", () => {
    // Middle of the long word (source 3.5-7.0): no pause within ±0.5 s.
    const tail = clips()[1]!;
    const at = (source: number) => Math.round((tail.start + source - tail.in) * 1000) / 1000;
    const human = frameshell(["cut", "--from", String(at(5)), "--to", String(at(5.6))]);
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(/snapped from .* \(no pause within ±0\.5 s: quietest frame, speech may be clipped\)/);
    expect(human.stdout).toMatch(/snapped to .* \(no pause within ±0\.5 s/);
  });

  it("widens the search with --snap-window and cuts exactly with --no-snap", () => {
    // Source 6.4 is 0.6 s before the 7.0-7.4 pause: out of reach at ±0.5, in reach at ±1.
    const tail = () => clips().at(-1)!;
    const t = (source: number) => Math.round((tail().start + source - tail().in) * 1000) / 1000;
    const narrow = json<Result>(["clip", "trim", tail().id, "--end", String(t(6.4)), "--no-snap"]);
    expect(narrow.snaps).toEqual([]);
    expect(tail().out).toBeCloseTo(6.4, 2);
    const wide = json<Result>(["clip", "trim", tail().id, "--out", "6.4", "--snap-window", "1"]);
    expect(wide.snaps).toEqual([expect.objectContaining({ field: "out", requested: 6.4, clean: true })]);
    expect(wide.snaps[0]!.applied).toBeGreaterThan(7);
    expect(tail().out).toBe(wide.snaps[0]!.applied);

    const bad = frameshell(["cut", "--from", "1", "--to", "2", "--snap-window", "0.2"]);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toMatch(/snapWindow/);
    expect(frameshell(["cut", "--from", "1", "--to", "2", "--no-snap", "--snap-window", "1"]).code).toBe(2);
  });
});
