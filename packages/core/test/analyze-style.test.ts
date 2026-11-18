import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ANALYSIS_DIR, type AnalyzeAudio, type AnalyzeMove, type AppDirs, type DaemonConnection, ErrorCode, type RpcError, connectToDaemon } from "@frameshell/protocol";
import { STYLE_PATHS } from "@frameshell/schema";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_JOURNAL, type Daemon, type SuggestionInput, contrastRatio, startDaemon, styleSuggestions } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// `analyze` numbers as `style.json` suggestions (#471): the pure rules on hand-made results, then `style.apply` with
// `analysis` over the daemon socket on an `analysis.json` written by the test (no video is decoded).

const move = (duration: number, fit = 0.2): AnalyzeMove => ({ startFrame: 0, endFrame: 1, start: 0, end: duration, duration, peak: 10, peakAt: 0, ease: "out", fit });

function input(over: Partial<SuggestionInput> = {}): SuggestionInput {
  return {
    palette: [],
    curve: { step: 0.1, values: [], mean: 1, peak: 10, peakAt: 0, moves: [] },
    stats: { shotCount: 6, cutsPerMinute: 12, averageLength: 2.5, medianLength: 2.5, shortest: 1, longest: 4 },
    rhythm: { shotLengthCv: 0.3, stillShare: 0.2, longestStill: 1, changeCount: 6, changesPerMinute: 12, largestGap: 3, meanActivity: 2, bursts: [] },
    audio: null,
    ...over,
  };
}

const withMusic = (median: number) => ({ speech: { overMusic: { count: 5, median, lowest: median - 3 } } }) as unknown as AnalyzeAudio;

describe("styleSuggestions", () => {
  it("reads background, ink and accent from the palette", () => {
    const palette = [
      { hex: "#101418", share: 0.6 },
      { hex: "#808080", share: 0.15 },
      { hex: "#f2f2f2", share: 0.12 },
      { hex: "#ff5a1f", share: 0.08 },
    ];
    const suggestions = styleSuggestions(input({ palette }));
    expect(suggestions.map(({ path, value, label }) => [path, value, label])).toEqual([
      ["colors.bg", "#101418", "ESTIMATED"],
      ["colors.ink", "#f2f2f2", "ESTIMATED"],
      ["colors.accent", "#ff5a1f", "ESTIMATED"],
    ]);
    expect(suggestions[0]!.from).toEqual(["palette"]);
    expect(suggestions[1]!.why).toContain(":1");
    expect(suggestions.every((suggestion) => STYLE_PATHS.includes(suggestion.path))).toBe(true);
  });

  it("suggests no colour without a ground, no ink without contrast and no accent from greys", () => {
    expect(styleSuggestions(input({ palette: [{ hex: "#101418", share: 0.2 }, { hex: "#ffffff", share: 0.2 }] }))).toEqual([]);
    const flat = styleSuggestions(input({ palette: [{ hex: "#404040", share: 0.7 }, { hex: "#606060", share: 0.2 }, { hex: "#7f7a78", share: 0.1 }] }));
    expect(flat.map((suggestion) => suggestion.path)).toEqual(["colors.bg"]);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
  });

  it("names the personality whose standard move length is nearest the median eased move", () => {
    const personality = (moves: AnalyzeMove[]) => styleSuggestions(input({ curve: { ...input().curve, moves } })).find((s) => s.path === "motion.personality");
    expect(personality([move(0.27), move(0.3), move(0.3), move(0.33), move(2, 0.9)])).toMatchObject({ value: "corporate", label: "ESTIMATED", from: ["curve.moves"] });
    expect(personality([move(0.45), move(0.5), move(0.6)])).toMatchObject({ value: "premium" });
    expect(personality([move(0.16), move(0.17), move(0.18)])).toMatchObject({ value: "energetic" });
    expect(personality([move(0.22), move(0.23), move(0.22)])).toMatchObject({ value: "playful" });
  });

  it("falls back on the pace of the cutting as a DECISION, and says nothing for middling cutting", () => {
    const fast = styleSuggestions(input({ stats: { ...input().stats, medianLength: 0.8, cutsPerMinute: 45 }, curve: { ...input().curve, moves: [move(0.3), move(0.3)] } }));
    expect(fast).toEqual([expect.objectContaining({ path: "motion.personality", value: "energetic", label: "DECISION", from: ["stats.medianLength", "stats.cutsPerMinute", "rhythm.stillShare"] })]);
    const slow = styleSuggestions(input({ stats: { ...input().stats, medianLength: 5 }, rhythm: { ...input().rhythm, stillShare: 0.7 } }));
    expect(slow).toEqual([expect.objectContaining({ path: "motion.personality", value: "calm", label: "DECISION" })]);
    expect(styleSuggestions(input())).toEqual([]);
  });

  it("puts the music as far under the voice as the film does", () => {
    expect(styleSuggestions(input({ audio: withMusic(14.2) }))).toEqual([
      expect.objectContaining({ path: "sound.musicUnderVoice", value: 14, label: "ESTIMATED", from: ["audio.speech.overMusic"] }),
    ]);
    expect(styleSuggestions(input({ audio: withMusic(-2) }))).toEqual([]);
    expect(styleSuggestions(input({ audio: withMusic(75) }))).toEqual([]);
  });
});

let daemon: Daemon | undefined;
const connections: DaemonConnection[] = [];
afterEach(async () => {
  for (const conn of connections.splice(0)) conn.close();
  await daemon?.close();
  daemon = undefined;
});

async function setup() {
  const dirs: AppDirs = { dataDir: tempDir(), configDir: tempDir() };
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs, idleTimeoutMs: Infinity, txIdleGapMs: 60_000 });
  const agent = await connectToDaemon(daemon.socketPath, { client: "cli/test", agent: null, session: "term-1" });
  connections.push(agent);
  const dir = join(tempDir(), "promo");
  await agent.request("project.init", { dir });
  const analysis = (name: string, manifest: unknown) => {
    const folder = join(dir, ...ANALYSIS_DIR.split("/"), name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "analysis.json"), JSON.stringify(manifest));
  };
  return { dir, agent, analysis };
}

async function failure(call: Promise<unknown>): Promise<RpcError> {
  try {
    await call;
  } catch (error) {
    return error as RpcError;
  }
  throw new Error("expected the request to fail");
}

const SUGGESTED = [
  { path: "colors.bg", value: "#101418", why: "", from: ["palette"], label: "ESTIMATED" },
  { path: "colors.accent", value: "#ff5a1f", why: "", from: ["palette"], label: "ESTIMATED" },
  { path: "motion.personality", value: "energetic", why: "", from: ["curve.moves"], label: "ESTIMATED" },
];

describe("style.apply with analysis", () => {
  it("applies the suggestions the person picked as one journaled change that revert undoes", async () => {
    const { dir, agent, analysis } = await setup();
    analysis("reel", { name: "reel", suggestions: SUGGESTED });
    await agent.request("style.set", { cwd: dir, path: "colors.accent", value: "#00ff00" });

    const picked = await agent.request("style.apply", { cwd: dir, analysis: "reel", paths: ["colors.accent", "motion.personality"] });
    expect(picked.changes).toEqual([
      { path: "colors.accent", before: "#00ff00", after: "#ff5a1f" },
      { path: "motion.personality", before: null, after: "energetic" },
    ]);
    const style = JSON.parse(readFileSync(join(dir, "style.json"), "utf8")) as Record<string, unknown>;
    expect(style).toMatchObject({ colors: { accent: "#ff5a1f" }, motion: { personality: "energetic" } });
    expect(style).not.toHaveProperty("from");
    const lines = readFileSync(join(dir, CONFIG_JOURNAL), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.at(-1)).toMatchObject({ id: picked.op, op: "style.apply", args: { analysis: "reel", paths: ["colors.accent", "motion.personality"] }, doc: "style" });

    await agent.request("revert", { cwd: dir, target: picked.op });
    expect(JSON.parse(readFileSync(join(dir, "style.json"), "utf8"))).toMatchObject({ colors: { accent: "#00ff00" } });

    const all = await agent.request("style.apply", { cwd: dir, analysis: "reel" });
    expect(all.changes.map((change) => change.path)).toEqual(["colors.bg", "colors.accent", "motion.personality"]);
  });

  it("says which analyses and suggestions there are when asked for others", async () => {
    const { dir, agent, analysis } = await setup();
    analysis("reel", { name: "reel", suggestions: SUGGESTED });
    analysis("old", { name: "old" });
    const missing = await failure(agent.request("style.apply", { cwd: dir, analysis: "nope" }));
    expect(missing).toMatchObject({ code: ErrorCode.InvalidOperation, data: { reason: "not found", available: ["old", "reel"] } });
    const old = await failure(agent.request("style.apply", { cwd: dir, analysis: "old" }));
    expect(old).toMatchObject({ code: ErrorCode.InvalidOperation, data: { reason: "no suggestions" } });
    const other = await failure(agent.request("style.apply", { cwd: dir, analysis: "reel", paths: ["sound.musicUnderVoice"] }));
    expect(other).toMatchObject({ code: ErrorCode.InvalidOperation, data: { reason: "not suggested", available: ["colors.bg", "colors.accent", "motion.personality"] } });
    expect(existsSync(join(dir, "style.json"))).toBe(false);
  });

  it("refuses a suggestion edited out of the schema and the wrong mix of params", async () => {
    const { dir, agent, analysis } = await setup();
    analysis("bad", { suggestions: [{ path: "colors.accent", value: "orange" }] });
    expect(await failure(agent.request("style.apply", { cwd: dir, analysis: "bad" }))).toMatchObject({ code: ErrorCode.InvalidOperation, data: { reason: "value" } });
    expect(await failure(agent.request("style.apply", { cwd: dir }))).toMatchObject({ code: ErrorCode.InvalidParams });
    expect(await failure(agent.request("style.apply", { cwd: dir, name: "calm", analysis: "bad" }))).toMatchObject({ code: ErrorCode.InvalidParams });
    expect(await failure(agent.request("style.apply", { cwd: dir, analysis: "bad", replace: true }))).toMatchObject({ code: ErrorCode.InvalidParams });
    expect(await failure(agent.request("style.apply", { cwd: dir, name: "calm", paths: ["colors.bg"] }))).toMatchObject({ code: ErrorCode.InvalidParams });
  });
});
