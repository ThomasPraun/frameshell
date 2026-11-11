import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AppDirs, type DaemonConnection, ErrorCode, type RpcError, connectToDaemon } from "@frameshell/protocol";
import { SAFE_ZONES } from "@frameshell/schema";
import { afterEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// Seam under test: `style.show` over the daemon socket (ADR 0028) and `file.write` refusing an invalid style.json.

let daemon: Daemon | undefined;
let conn: DaemonConnection | undefined;
afterEach(async () => {
  conn?.close();
  conn = undefined;
  await daemon?.close();
  daemon = undefined;
});

async function setup() {
  const dirs: AppDirs = { dataDir: tempDir(), configDir: tempDir() };
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs, txIdleGapMs: 60_000 });
  conn = await connectToDaemon(daemon.socketPath, { client: "cli/test", agent: null });
  const dir = join(tempDir(), "promo");
  await conn.request("project.init", { dir });
  return { dir, app: conn };
}

async function failure(call: Promise<unknown>): Promise<RpcError> {
  try {
    await call;
  } catch (error) {
    return error as RpcError;
  }
  throw new Error("expected the request to fail");
}

describe("style.show", () => {
  it("is null while the project has no style.json", async () => {
    const { dir, app } = await setup();
    expect(await app.request("style.show", { cwd: join(dir, "timelines") })).toEqual({ dir, path: "style.json", style: null, from: null, safeZones: [] });
  });

  it("resolves a hand-written file with the source of each value and the safe zones it names", async () => {
    const { dir, app } = await setup();
    const sha256 = "a".repeat(64);
    writeFileSync(
      join(dir, "style.json"),
      JSON.stringify({ schemaVersion: 1, from: { id: "house", sha256 }, motion: { personality: "calm", stagger: 0.12 }, colors: { accent: "#ff3300" }, platforms: ["youtube-shorts", "instagram-reels"] }),
    );
    const shown = await app.request("style.show", { cwd: dir });
    expect(shown.from).toEqual({ id: "house", sha256 });
    expect(shown.style?.motion.personality).toEqual({ value: "calm", source: "file" });
    expect(shown.style?.motion.highlight).toEqual({ value: false, source: "personality" });
    expect(shown.style?.motion.stagger).toEqual({ value: 0.12, source: "file" });
    expect(shown.style?.colors.accent).toEqual({ value: "#ff3300", source: "file" });
    expect(shown.style?.type.minReadable).toEqual({ value: 28, source: "default" });
    expect(shown.safeZones).toEqual([SAFE_ZONES["youtube-shorts"], SAFE_ZONES["instagram-reels"]]);
  });

  it("fails with InvalidProjectFile on an invalid file, and file.write refuses one before it lands", async () => {
    const { dir, app } = await setup();
    writeFileSync(join(dir, "style.json"), JSON.stringify({ schemaVersion: 1, colors: { accent: "orange" } }));
    const error = await failure(app.request("style.show", { cwd: dir }));
    expect(error.code).toBe(ErrorCode.InvalidProjectFile);
    expect(error.message).toContain("colors.accent");

    writeFileSync(join(dir, "style.json"), "{ not json");
    expect((await failure(app.request("style.show", { cwd: dir }))).code).toBe(ErrorCode.InvalidProjectFile);

    const refused = await failure(app.request("file.write", { path: join(dir, "style.json"), content: JSON.stringify({ schemaVersion: 1, motion: { personality: "loud" } }) }));
    expect(refused.code).toBe(ErrorCode.InvalidProjectFile);
    await app.request("file.write", { path: join(dir, "style.json"), content: JSON.stringify({ schemaVersion: 1, motion: { personality: "premium" } }) });
    expect((await app.request("style.show", { cwd: dir })).style?.motion.personality.value).toBe("premium");
  });
});
